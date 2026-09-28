// src/session-title.ts — 会话标题：从日志事件与宿主的投影缓存里读出来（只读，零 DSH 依赖）。
//
// 为什么需要这一层：界面上一条会话原本只有 uuid，而用户认得出的是标题。标题在 DSH 里是**日志事件**
// （`session/title`，最新一条生效），**不在** header 里——"顺手读 header"这条便宜路（见 discovery.ts）
// 上拿不到它；整份解码又太贵（实测一条 6MB 日志 ≈1.7 秒，而列表要读几十条）。所以这里按代价从低到高
// 给两条路：
//
//   1. `readCachedTitle()`：宿主把折叠好的标题写进了投影缓存
//      `<storages>/session_projcache/sessions/<id>.json`（宿主自己列会话也读它）。零解码，而且里面
//      一定是**最新**那条（用户改名也在里面）。
//   2. `readLogTitle()`：缓存缺席时（那个域没挂、还没检查点、或这条会话刚被本插件导入），在日志
//      **开头**的有界前缀里逐帧找 `session/title`，取其中最后一条。实测标题都落在前 ~26KB：宿主在
//      首条可用的人类消息之后就落一条 fallback 标题，LLM 标题紧随其后。256KB 的预算已经是它的十倍，
//      仍然只解一小段，**绝不**为此解整份日志。
//
// 两条路都读不到就返回 undefined——标题是装饰，界面此时退回显示 id，绝不该让一条会话列不出来。
//
// 缓存那条路是对宿主**内部**文件格式的复刻（与 project-key.ts 复刻宿主的 projectKey 同一性质）：
// 只认字段**形状**、不认版本号。宿主要哪天换了格式，这里自然读不到而回落到日志，页面不受影响。
//
// @module dsh-session-manager/session-title
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

import { encodeSegment } from './paths.ts'
import type { DecodeAll } from './types.ts'
import { ZSTD_MAGIC } from './zstd-frame.ts'

/**
 * 在日志开头多少字节以内找标题。
 *
 * 不是"越小越好"：这个预算同时是**最坏情况**的解码量（标题在很后面的会话会把这 256KB 都解掉，
 * 实测 ≈70ms）。256KB 相对实测的 ~26KB 有十倍余量，而最坏情况仍然只是一次列表请求里的几十毫秒。
 */
export const DEFAULT_TITLE_BUDGET_BYTES = 256 * 1024

/** 定位一条会话需要的最小信息（日志文件按代次升序）。 */
export interface TitleQuery {
  id: string
  createdAt: number
  /** 缺省表示这条会话没有 cwd（落 `_no-cwd` 项目目录）。 */
  cwd?: string
  /** 该会话的日志文件；只有最新一代会被读。 */
  files: ReadonlyArray<{ path: string; version: number }>
}

/**
 * 从**已解开**的日志文本里折叠标题：最新一条 `session/title` 生效。
 *
 * 判据是解析出来的 `type` 而不是子串：`session/title-llm-request` 这类事件也含 "session/title"，
 * 子串判据会把它们当标题。子串只用作**廉价预筛**（带引号的 `"session/title"` 恰好排除掉那些后缀），
 * 命中后再 JSON 解析定夺——这样整段文本不必逐行 JSON.parse。
 *
 * @param text 日志明文（整份，或开头的一段）。
 * @returns 标题；一条都没有则 undefined。
 */
export function foldTitle(text: string): string | undefined {
  let title: string | undefined
  for (const line of text.split('\n')) {
    if (!line.includes('"session/title"')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // 截断的最后一行：不是标题
    }
    const event = parsed as { type?: unknown; data?: { title?: unknown } }
    if (event.type !== 'session/title') continue
    if (typeof event.data?.title !== 'string') continue
    const value = event.data.title.trim()
    if (value !== '') title = value
  }
  return title
}

/**
 * 在一段日志字节的**开头**逐帧折叠标题。
 *
 * 帧边界靠魔数找，判据是"这个候选能解出一段合法文本"：载荷里凑巧出现的魔数会让候选切出一个
 * 截断的帧，解码必然抛错，此时**不推进帧头**、换下一个候选当帧尾继续——于是假边界只是白试一次。
 * 同理，前缀被截断时最后那个不完整的帧也会解码失败而被跳过，不需要额外的"是否完整"参数。
 *
 * @param buf 日志字节（整份，或它的有界前缀）。
 * @param decodeAll 多帧感知解码器。
 * @param options.maxBytes 最多看 buf 的前多少字节。
 * @returns 这段字节里最后一条标题；没有则 undefined。
 */
export function foldTitleInFrames(
  buf: Buffer,
  decodeAll: DecodeAll,
  options: { maxBytes?: number } = {},
): string | undefined {
  const maxBytes = options.maxBytes ?? DEFAULT_TITLE_BUDGET_BYTES
  const window = buf.subarray(0, Math.min(buf.length, maxBytes))
  const ends: number[] = []
  for (let i = 1; i + 3 < window.length; i++) {
    if (
      window[i] === ZSTD_MAGIC[0] &&
      window[i + 1] === ZSTD_MAGIC[1] &&
      window[i + 2] === ZSTD_MAGIC[2] &&
      window[i + 3] === ZSTD_MAGIC[3]
    ) {
      ends.push(i)
    }
  }
  ends.push(window.length)

  let title: string | undefined
  let from = 0
  for (const to of ends) {
    if (to <= from) continue
    let text: string
    try {
      text = decodeAll(window.subarray(from, to))
    } catch {
      continue // 假边界，或前缀被截断的最后一帧：换个候选当帧尾
    }
    from = to
    const found = foldTitle(text)
    if (found !== undefined) title = found
  }
  return title
}

/**
 * 从磁盘上的一个日志文件读标题（只读开头 `budgetBytes`）。
 *
 * 读不到（文件没了、权限不对、帧坏了）一律当"没有标题"：标题是装饰，不该让"列出会话"这件事失败。
 *
 * @param path 日志文件路径。
 * @param decodeAll 多帧感知解码器。
 * @param options.budgetBytes 读取与解码的字节上限。
 * @returns 标题，或 undefined。
 */
export function readLogTitle(
  path: string,
  decodeAll: DecodeAll,
  options: { budgetBytes?: number } = {},
): string | undefined {
  const budget = options.budgetBytes ?? DEFAULT_TITLE_BUDGET_BYTES
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const size = fstatSync(fd).size
    const want = Math.min(size, budget)
    if (want <= 0) return undefined
    const buf = Buffer.allocUnsafe(want)
    let filled = 0
    while (filled < want) {
      const read = readSync(fd, buf, filled, want - filled, filled)
      if (read <= 0) break
      filled += read
    }
    return foldTitleInFrames(filled === want ? buf : buf.subarray(0, filled), decodeAll)
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * 从宿主的投影缓存记录里读标题。
 *
 * 只认形状：`{ record: { identity: { createdAt, cwd }, rows: { title: { val } } } }`。identity 必须与
 * 磁盘上这条会话对得上（createdAt + cwd）——id 相同但属于另一条生命周期的记录（删了重建、缓存残留）
 * 会被这份校验挡掉，宁可不给标题，也不显示别人的标题。
 *
 * @param cacheDir 缓存目录（见 paths.projectionCacheDir）。
 * @param query 会话身份。
 * @returns 标题，或 undefined（文件不在、格式不认识、身份对不上）。
 */
export function readCachedTitle(cacheDir: string, query: { id: string; createdAt: number; cwd?: string }): string | undefined {
  let raw: string
  try {
    raw = readFileSync(join(cacheDir, `${encodeSegment(query.id)}.json`), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const record = (parsed as { record?: unknown } | null)?.record as
    | { identity?: { createdAt?: unknown; cwd?: unknown }; rows?: { title?: { val?: unknown } } }
    | undefined
  const identity = record?.identity
  if (identity === undefined || identity === null || typeof identity !== 'object') return undefined
  if (identity.createdAt !== query.createdAt) return undefined
  if ((identity.cwd ?? undefined) !== (query.cwd ?? undefined)) return undefined
  const value = record?.rows?.title?.val
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  return title === '' ? undefined : title
}

/** `createTitleResolver()` 的入参。 */
export interface TitleResolverOptions {
  /** 宿主投影缓存目录；缺省只走日志那条路。 */
  cacheDir?: string
  decodeAll: DecodeAll
  /** 单条会话在日志里最多看多少字节（见 DEFAULT_TITLE_BUDGET_BYTES）。 */
  budgetBytes?: number
}

/**
 * 造一个"给我一条会话，我给你标题"的读取器：先缓存、后日志（见模块头）。
 * @param options 缓存目录与解码器。
 * @returns 读取器；读不到时返回 undefined。
 */
export function createTitleResolver(options: TitleResolverOptions): (query: TitleQuery) => string | undefined {
  const { cacheDir, decodeAll, budgetBytes } = options
  return (query) => {
    if (cacheDir !== undefined) {
      const cached = readCachedTitle(cacheDir, query)
      if (cached !== undefined) return cached
    }
    let newest: { path: string; version: number } | undefined
    for (const file of query.files) {
      if (newest === undefined || file.version > newest.version) newest = file
    }
    if (newest === undefined) return undefined
    return readLogTitle(newest.path, decodeAll, budgetBytes === undefined ? {} : { budgetBytes })
  }
}
