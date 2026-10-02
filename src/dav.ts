// src/dav.ts — 本插件用到的那一小片 WebDAV 客户端（PROPFIND / GET / PUT / MKCOL）。
//
// 为什么自己写而不是拉一个 webdav 库：本插件只用到四种方法、一种鉴权（Basic），而多一个运行期依赖
// 就要跟着它的安全更新与 Node 版本走。代码量在这里换得到。
//
// 为什么把 `fetch` 做成可注入：同步的端到端测试要打一个真的 HTTP 服务（test/dav.test.ts 起一个
// 只实现这四种方法的夹具），而不是打桩——PROPFIND 的多状态响应、409 建目录这些**协议层**的行为，
// 打桩是测不出来的。
//
// 与 DSH 解耦：本模块零 DSH 依赖，只用全局 fetch（engines 要求 node ^22.19 || >=24，全局 fetch 在）。
import { dirname } from 'node:path'

/** 一次请求的失败（非成功状态码，或传输层错误）。 */
export class DavError extends Error {
  /** HTTP 状态码；传输层错误（超时、DNS、连接被拒）为 0。 */
  readonly status: number
  readonly method: string
  /** 出错的资源路径（相对资源根）。 */
  readonly path: string

  // 显式赋值而不是构造函数参数属性：测试由 node 的类型擦除直接跑（见 test/run-all.mjs），
  // 参数属性那种"要改写、不只是擦掉"的语法它不支持。
  constructor(message: string, status: number, method: string, path: string) {
    super(message)
    this.name = 'DavError'
    this.status = status
    this.method = method
    this.path = path
  }
}

/** 一个远端条目（`list()` 的结果，只取本插件用得到的两个属性）。 */
export interface DavEntry {
  /** 相对当前集合的名称（文件不带扩展名处理，目录不带尾斜杠）。 */
  name: string
  kind: 'collection' | 'file'
  /** `getcontentlength`；服务器不给就是 undefined。 */
  bytes?: number
}

/** 远端资源的最小面。测试用夹具实现它，`createDavClient()` 也实现它。 */
export interface DavPort {
  /** 资源根地址（报告里显示用）。 */
  readonly baseUrl: string
  /** 列一个集合的直接子项；集合不存在返回空数组。 */
  list(collection: string): Promise<DavEntry[]>
  /** 读一个文件；不存在抛 `DavError`（status 404）。 */
  get(path: string): Promise<Buffer>
  /** 写一个文件；父集合不存在会先建出来。 */
  put(path: string, bytes: Buffer): Promise<void>
  /** 保证一个集合存在（逐层 MKCOL，已存在不算错）。 */
  ensure(collection: string): Promise<void>
}

/** `createDavClient()` 的选项。 */
export interface DavOptions {
  /** 资源根地址（不含结尾斜杠也照收，内部会归一化）。 */
  baseUrl: string
  username?: string
  password?: string
  /** 注入点：默认 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch
  /** 单次请求超时（毫秒），默认 30000。 */
  timeoutMs?: number
}

/** PROPFIND 请求体：只要比"存在"多一点点的三样东西。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/>' +
  '</d:prop></d:propfind>'

// 命名空间前缀由服务器自选（`d:` / `D:` / 无前缀都合法），所以下面这些正则一律把前缀当可选部分。
const TAG = '(?:[A-Za-z0-9_.-]+:)?'
const RESPONSE_RE = new RegExp(`<${TAG}response\\b[^>]*>([\\s\\S]*?)</${TAG}response>`, 'gi')
const HREF_RE = new RegExp(`<${TAG}href\\b[^>]*>([\\s\\S]*?)</${TAG}href>`, 'i')
const COLLECTION_RE = new RegExp(`<${TAG}collection\\b`, 'i')
const LENGTH_RE = new RegExp(`<${TAG}getcontentlength\\b[^>]*>([\\s\\S]*?)</${TAG}getcontentlength>`, 'i')

/** 解 XML 里那五个实体与数字实体（href 里 `&` 会被转义）。 */
function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * href → 解码后的路径。
 *
 * href 可能是绝对 URL（`https://host/dav/x/`）也可能是绝对路径（`/dav/x/`），两种都用 `URL` 归一；
 * 拿不到就按原样处理——宁可名称难看点，也不要因为一个畸形 href 把整次列出打挂。
 */
function hrefPath(href: string): string {
  const raw = decodeXml(href.trim())
  try {
    return decodeURIComponent(new URL(raw, 'http://dav.invalid').pathname)
  } catch {
    return raw
  }
}

/** 路径的最后一段（去掉尾斜杠；根路径返回空串）。 */
function lastSegment(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length === 0 ? '' : (parts[parts.length - 1] as string)
}

/** 去掉结尾斜杠（根路径保留）。 */
function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * 解析 207 多状态响应。
 * @param xml 响应体。
 * @param self 请求的那个集合：`path` 是它在服务器上的绝对路径（由客户端从 URL 得到，带资源根前缀），
 *   `relative` 是相对资源根的路径——**两种都要给**：多数服务器回绝对路径的 href，但这是约定不是保证，
 *   少判一种就会把"它自己"当成一个子项（同步表现在就会多出一台叫 `machines` 的假机器）。
 * @returns 直接子项；解析不出任何 `<response>` 时返回空数组。
 */
export function parseMultiStatus(xml: string, self: { path: string; relative: string }): DavEntry[] {
  const selfPaths = new Set([stripTrailingSlash(self.path), stripTrailingSlash(`/${self.relative}`)])
  const out: DavEntry[] = []
  for (const match of xml.matchAll(RESPONSE_RE)) {
    const block = match[1] ?? ''
    const href = HREF_RE.exec(block)?.[1]
    if (href === undefined) continue
    const path = hrefPath(href)
    if (selfPaths.has(stripTrailingSlash(path))) continue
    const name = lastSegment(path)
    if (name === '') continue
    const isCollection = COLLECTION_RE.test(block)
    const lengthRaw = LENGTH_RE.exec(block)?.[1]
    const bytes = lengthRaw === undefined ? undefined : Number.parseInt(lengthRaw.trim(), 10)
    out.push({
      name,
      kind: isCollection ? 'collection' : 'file',
      ...(bytes === undefined || Number.isNaN(bytes) ? {} : { bytes }),
    })
  }
  return out
}

/** 拼接资源路径（集合路径与名字都用 `/`；调用方传进来的名字已由 `encodeSegment()` 保证无分隔符）。 */
function joinPath(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part !== '')
    .join('/')
}

/**
 * 建一个 WebDAV 客户端。
 * @param options 资源根、Basic 凭据与超时。
 * @returns 远端资源面。
 */
export function createDavClient(options: DavOptions): DavPort {
  const base = stripTrailingSlash(options.baseUrl.replace(/\/+$/, ''))
  const timeoutMs = options.timeoutMs ?? 30_000
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const auth =
    options.username === undefined
      ? undefined
      : `Basic ${Buffer.from(`${options.username}:${options.password ?? ''}`, 'utf8').toString('base64')}`

  const urlOf = (path: string): string => `${base}/${joinPath(path)}`

  async function request(
    method: string,
    path: string,
    init: { body?: Buffer | string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers }
    if (auth !== undefined) headers['authorization'] = auth
    let response: Response
    try {
      response = await doFetch(urlOf(path), {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new DavError(
        `${method} ${urlOf(path)} 失败：${error instanceof Error ? error.message : String(error)}`,
        0,
        method,
        path,
      )
    }
    return response
  }

  async function ensure(collection: string): Promise<void> {
    const segments = joinPath(collection).split('/').filter((part) => part !== '')
    for (let index = 1; index <= segments.length; index++) {
      const target = segments.slice(0, index).join('/')
      const response = await request('MKCOL', target)
      // 201 = 建好了；405 = 已经有了。其余（401 / 403 / 507……）如实抛。
      if (response.status === 405) continue
      if (response.status !== 201 && response.status !== 200 && response.status !== 204) {
        throw new DavError(
          `MKCOL ${urlOf(target)} 返回 ${response.status} ${response.statusText}`,
          response.status,
          'MKCOL',
          target,
        )
      }
    }
  }

  return {
    baseUrl: base,

    async list(collection: string): Promise<DavEntry[]> {
      const response = await request('PROPFIND', collection, {
        headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      })
      if (response.status === 404) return []
      if (response.status !== 207) {
        throw new DavError(
          `PROPFIND ${urlOf(collection)} 返回 ${response.status} ${response.statusText}`,
          response.status,
          'PROPFIND',
          collection,
        )
      }
      const relative = joinPath(collection)
      return parseMultiStatus(await response.text(), {
        path: decodeURIComponent(new URL(urlOf(collection)).pathname),
        relative,
      })
    },

    async get(path: string): Promise<Buffer> {
      const response = await request('GET', path)
      if (response.status !== 200) {
        throw new DavError(
          `GET ${urlOf(path)} 返回 ${response.status} ${response.statusText}`,
          response.status,
          'GET',
          path,
        )
      }
      return Buffer.from(await response.arrayBuffer())
    },

    async put(path: string, bytes: Buffer): Promise<void> {
      const parent = dirname(joinPath(path))
      if (parent !== '' && parent !== '.') await ensure(parent)
      const response = await request('PUT', path, {
        body: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      })
      if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
        throw new DavError(
          `PUT ${urlOf(path)} 返回 ${response.status} ${response.statusText}`,
          response.status,
          'PUT',
          path,
        )
      }
    },

    ensure,
  }
}
