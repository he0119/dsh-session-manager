// test/dav-fixture.ts — 一个**真的** WebDAV 夹具：只实现同步用到的那四种方法，外加一个"往远端放一条
// 会话"的播种函数。
//
// 为什么不用打桩的 fetch：PROPFIND 的多状态响应、MKCOL 的 405、"先建父集合再 PUT"这些是协议层的
// 行为，打桩等于把被测的那部分自己写一遍。这里起一个真的 `node:http` 服务、落到真的临时目录，
// 客户端那一侧走真的 HTTP。
//
// 文件名不以 `.test.ts` 结尾，所以 test/run-all.mjs 不会把它当测试文件加载——它是给
// dav.test.ts、sync.test.ts 与 tools.test.ts 共用的夹具。
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { DavPort } from '../src/dav.ts'
import { remoteBundlePath, remoteIndexPath, SYNC_INDEX_UNIT, SYNC_INDEX_VERSION } from '../src/sync.ts'
import { buildBundle } from '../src/transfer.ts'

/** 夹具句柄。 */
export interface DavFixture {
  /** 资源根地址（形如 `http://127.0.0.1:port/dav`）。 */
  url: string
  /** 落到磁盘的那个目录。 */
  root: string
  /** 收到的请求（`METHOD 路径`），供断言用。 */
  requests: string[]
  /** 关掉服务。 */
  close(): Promise<void>
}

/** 转义 XML 文本。 */
function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 起一个 WebDAV 夹具。
 * @param options.root 落盘目录（调用方保证先清干净）。
 * @param options.auth 给了就校验 Basic 凭据，不匹配一律 401。
 * @param options.prefix 资源根路径，默认 `/dav`。
 * @returns 夹具句柄。
 */
export async function startDavFixture(options: {
  root: string
  auth?: { username: string; password: string }
  prefix?: string
}): Promise<DavFixture> {
  const prefix = options.prefix ?? '/dav'
  const root = options.root
  mkdirSync(root, { recursive: true })
  const requests: string[] = []
  const expected =
    options.auth === undefined
      ? undefined
      : `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`, 'utf8').toString('base64')}`

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res)
  })

  /** 请求路径 → 磁盘路径；不在资源根下返回 undefined。 */
  function diskPath(pathname: string): string | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      decoded = pathname
    }
    if (decoded !== prefix && !decoded.startsWith(`${prefix}/`)) return undefined
    const rest = decoded.slice(prefix.length).replace(/^\/+/, '')
    return rest === '' ? root : join(root, rest)
  }

  function multiStatus(res: ServerResponse, disk: string, pathname: string): void {
    const body = (child: string): string => {
      const full = `${pathname.replace(/\/+$/, '')}/${encodeURIComponent(child)}`
      const isDir = statSync(join(disk, child)).isDirectory()
      return (
        '<D:response>' +
        `<D:href>${xml(full)}${isDir ? '/' : ''}</D:href>` +
        '<D:propstat><D:prop>' +
        `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
        (isDir ? '' : `<D:getcontentlength>${statSync(join(disk, child)).size}</D:getcontentlength>`) +
        '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
        '</D:response>'
      )
    }
    const self =
      '<D:response>' +
      `<D:href>${xml(pathname.replace(/\/+$/, ''))}/</D:href>` +
      '<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>' +
      '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
    const children = readdirSync(disk)
      .map((child) => body(child))
      .join('')
    res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
    res.end(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:multistatus xmlns:D="DAV:">' +
        self +
        children +
        '</D:multistatus>',
    )
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const pathname = new URL(req.url ?? '/', 'http://dav.invalid').pathname
    requests.push(`${method} ${pathname}`)
    if (expected !== undefined && req.headers['authorization'] !== expected) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="dav-fixture"' })
      res.end('unauthorized')
      return
    }
    const disk = diskPath(pathname)
    if (disk === undefined) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
    const body = Buffer.concat(chunks)

    if (method === 'GET') {
      if (!existsSync(disk) || statSync(disk).isDirectory()) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(readFileSync(disk))
      return
    }
    if (method === 'PUT') {
      mkdirSync(dirname(disk), { recursive: true })
      writeFileSync(disk, body)
      res.writeHead(201).end()
      return
    }
    if (method === 'MKCOL') {
      if (existsSync(disk)) {
        res.writeHead(405).end()
        return
      }
      mkdirSync(disk, { recursive: true })
      res.writeHead(201).end()
      return
    }
    if (method === 'PROPFIND') {
      if (!existsSync(disk) || !statSync(disk).isDirectory()) {
        res.writeHead(404).end()
        return
      }
      multiStatus(res, disk, pathname)
      return
    }
    res.writeHead(405).end()
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}${prefix}`,
    root,
    requests,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}

/**
 * 往远端某个机器格里播种一条会话：一个 `.dshsess` 包（与「导出」同格式）+ 一份索引。
 *
 * 拉取那一侧的用例都需要"远端已经有一条本机没有的会话"，而这个形状（包 + 索引里的代次指纹）
 * 正是同步真正读的东西；让每个用例自己拼一遍等于把格式契约复述三遍。
 *
 * @param dav 远端。
 * @param machineId 贡献这条会话的机器。
 * @param session 会话：日志文件的路径/名字/代次，以及 cwd 与创建时间。
 */
export async function putRemoteSession(
  dav: DavPort,
  machineId: string,
  session: {
    id: string
    createdAt: number
    logPath: string
    logName: string
    logVersion: number
    cwd?: string
    title?: string
  },
): Promise<void> {
  const bytes = readFileSync(session.logPath)
  await dav.put(
    remoteBundlePath(machineId, session.id),
    buildBundle(
      [
        {
          id: session.id,
          ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
          createdAt: session.createdAt,
          dir: dirname(session.logPath),
          files: [
            {
              name: session.logName,
              path: session.logPath,
              version: session.logVersion,
              compression: 'zstd',
              bytes: bytes.length,
            },
          ],
        },
      ],
      { now: '2026-10-01T00:00:00.000Z' },
    ),
  )

  const index: { entries: Array<Record<string, unknown>> } = { entries: [] }
  try {
    index.entries = JSON.parse((await dav.get(remoteIndexPath(machineId))).toString('utf8')).entries ?? []
  } catch {
    // 这个格子还没有索引：从空的开始（与首次推送同一条路径）。
  }
  index.entries = index.entries.filter((entry) => entry['id'] !== session.id)
  index.entries.push({
    id: session.id,
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.title === undefined ? {} : { title: session.title }),
    createdAt: session.createdAt,
    files: [{ version: session.logVersion, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  })
  await dav.put(
    remoteIndexPath(machineId),
    Buffer.from(
      JSON.stringify({
        unit: SYNC_INDEX_UNIT,
        version: SYNC_INDEX_VERSION,
        machineId,
        updatedAt: '2026-10-01T00:00:00.000Z',
        entries: index.entries,
      }),
    ),
  )
}
