// 比对两份日志要的指纹：整文件 sha256（推送前）与内容指纹（两边各自写过时），以及"谁是谁的前缀"。
//
// 指纹缓存按进程活（键是路径，`size:mtimeMs` 作失效判据）：一次同步要问几百个文件，重算一遍是几百次
// 整文件读。内容关系另有一份小缓存（512 对），存的是"这两份日志到底哪边多了什么"。
//
// @module dsh-session-manager/operations/sync/fingerprint

import { createHash } from 'node:crypto'
import type { DiffRelation } from './session-diff.ts'
import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DiscoveredSession } from '../../shared/library/discovery.ts'
import { decodeLogTextChunked } from '../../shared/log/log-decode.ts'
import type { DecodeAll } from '../../shared/types.ts'
import { relocateHeaderCwdShallow, relocateHeaderCwdText } from '../../shared/log/session-log.ts'

/** 一条会话里某个代次日志的指纹。 */
export interface FileFingerprint {
  version: number
  bytes: number
  sha256: string
}

/** 默认的文件指纹：整文件 sha256。 */
export function fileFingerprint(path: string, version: number): FileFingerprint {
  const bytes = readFileSync(path)
  return { version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * 会话各代次日志的指纹。
 *
 * `hashFile` 收 `compression` 是因为"与 cwd 无关的内容指纹"要先按压缩形态解出首帧（见
 * [contentFingerprint]）；只按字节哈希的实现忽略这个参数即可。
 */
export function fingerprints(
  session: DiscoveredSession,
  hashFile: (path: string, version: number, compression: string | null) => FileFingerprint,
): FileFingerprint[] {
  return session.files.map((file) => hashFile(file.path, file.version, file.compression))
}

/** 用来比较的内容指纹里，header 的 cwd 归一化成的占位符（NUL 不可能出现在真实路径里）。 */
export const CWD_PLACEHOLDER = '\u0000dsm-sync-cwd'

/** 把 header 的 cwd 抹成占位符之后的内容字节；认不出的形态原样返回（退回按字节比）。 */
function contentBytes(bytes: Buffer, compression: string | null, decodeAll: DecodeAll): Buffer {
  try {
    return compression === 'zstd'
      ? relocateHeaderCwdShallow(bytes, { to: CWD_PLACEHOLDER, decodeAll }).buffer
      : Buffer.from(relocateHeaderCwdText(bytes.toString('utf8'), CWD_PLACEHOLDER).text, 'utf8')
  } catch {
    return bytes
  }
}

/**
 * 与"这台机器上的 cwd"无关的内容指纹。
 *
 * 落地会把别人的 cwd 改写成这台机器的路径（库目录名与 header 的 `cwd` 绑死，不改写就落不下来），
 * 于是同一份会话在两台机器上的**字节不同**。判据要是按字节比，拉取来的那份会被判成"各自写了对方没有的条目"：
 * 报告里的理由是错的（其实是同一份），更要紧的是它在那台机器上**继续写之后也无法再推送回远端**——新代次永远
 * 留在本机。所以索引里存的是把 cwd 归一化之后的哈希：cwd 是"这份会话在这台机器上落在哪儿"，不是
 * "这是哪份会话"。
 *
 * `bytes` 仍然是文件的真实字节数（报告里的体积得是真数）。
 *
 * @param path 日志文件路径。
 * @param version 代次。
 * @param compression 压缩形态（`zstd` 走保结构的帧改写，明文走同义的行改写）。
 * @param decodeAll 多帧感知解码器。
 * @returns 指纹。
 */
export function contentFingerprint(
  path: string,
  version: number,
  compression: string | null,
  decodeAll: DecodeAll,
): FileFingerprint {
  const bytes = readFileSync(path)
  const content = contentBytes(bytes, compression, decodeAll)
  return { version, bytes: bytes.length, sha256: createHash('sha256').update(content).digest('hex') }
}

/**
 * 与 {@link contentFingerprint} 同一份判据，只是**分块哈希、块间让出事件循环**。
 *
 * 为什么需要它：算一次整库计划要为两边都有的每条会话的每个日志算指纹，本机 1.2 GB 的库一次 3.1 秒。
 * sha256 本身没法切得更细，但可以每 8 MB 让出一轮宏任务，别的请求就轮得上——与 `decodeLogTextChunked()`
 * 同一条做法（那里按 128 KB 解压块让出，因为解压更慢、单块停顿更明显）。
 *
 * 分块大小按"一次哈希 8 MB 约 15 毫秒"量：再小收益不明显，再大会把单次停顿推到 100 毫秒以上。
 *
 * @param path 日志文件路径。
 * @param version 代次。
 * @param compression 压缩形态。
 * @param decodeAll 多帧感知解码器（指纹要折掉首帧的 cwd）。
 * @returns 与 `contentFingerprint()` 逐字段相同的指纹。
 */
export async function contentFingerprintChunked(
  path: string,
  version: number,
  compression: string | null,
  decodeAll: DecodeAll,
): Promise<FileFingerprint> {
  const bytes = await readFile(path)
  const content = contentBytes(bytes, compression, decodeAll)
  const hash = createHash('sha256')
  /** 一次哈希多少字节；见上面的说明。 */
  const CHUNK = 8 * 1024 * 1024
  for (let offset = 0; offset < content.length; offset += CHUNK) {
    hash.update(content.subarray(offset, offset + CHUNK))
    if (offset + CHUNK < content.length) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { version, bytes: bytes.length, sha256: hash.digest('hex') }
}

/** 带缓存的异步指纹（键与失效判据同 {@link fingerprintCached}）。 */
export async function fingerprintChunkedCached(
  cache: Map<string, { stamp: string; value: FileFingerprint }>,
  decodeAll: DecodeAll,
  path: string,
  version: number,
  compression: string | null,
): Promise<FileFingerprint> {
  let stamp: string
  try {
    const info = statSync(path)
    stamp = `${String(info.size)}:${String(info.mtimeMs)}`
  } catch {
    return contentFingerprintChunked(path, version, compression, decodeAll)
  }
  const hit = cache.get(path)
  if (hit !== undefined && hit.stamp === stamp) return hit.value
  const value = await contentFingerprintChunked(path, version, compression, decodeAll)
  if (cache.size >= FINGERPRINT_CACHE_MAX && !cache.has(path)) cache.clear()
  cache.set(path, { stamp, value })
  return value
}

/** 算一条文件的内容指纹（见 `createFingerprintCache()` 与 `contentFingerprint()`）。 */
export type FingerprintOf = (path: string, version: number, compression: string | null) => FileFingerprint

/** 进程里那份"文件内容指纹"缓存：键是路径，值带 `size:mtimeMs` 作为失效判据。 */
export const sharedFingerprintCache = new Map<string, { stamp: string; value: FileFingerprint }>()

/** 缓存最多记多少个文件（整库的日志文件数量级，超了就整份丢掉重来）。 */
export const FINGERPRINT_CACHE_MAX = 4096

/**
 * 按"文件戳"记住内容指纹：同一个路径的 `size + mtimeMs` 没变就不再读、不再解、不再哈希。
 *
 * 算一次同步计划要为**两边都有**的每条会话的每个日志算一次指纹（读整份、解压、按归一化 cwd 哈希），
 * 整库时这是比对那一段的全部开销（实测 2.6 秒 / 1285 个文件）；而日志文件只在会话被写时才变，两次预演
 * 之间绝大多数文件一个字节都没动。键里带上 `size + mtimeMs`，写过的文件自然换键。
 *
 * @param decodeAll 多帧感知解码器（指纹要折掉每帧的 cwd，见 `contentFingerprint()`）。
 * @returns 带缓存的指纹函数；同一个路径只要戳没变就返回同一个值。
 */
export function createFingerprintCache(decodeAll: DecodeAll): FingerprintOf {
  const cache = new Map<string, { stamp: string; value: FileFingerprint }>()
  return (path, version, compression) => fingerprintCached(cache, decodeAll, path, version, compression)
}

export function fingerprintCached(
  cache: Map<string, { stamp: string; value: FileFingerprint }>,
  decodeAll: DecodeAll,
  path: string,
  version: number,
  compression: string | null,
): FileFingerprint {
  let stamp: string
  try {
    const info = statSync(path)
    stamp = `${String(info.size)}:${String(info.mtimeMs)}`
  } catch {
    // 文件刚被删/换掉：直接算（会抛出与原来同一个错误），别让缓存替它编一个答案。
    return contentFingerprint(path, version, compression, decodeAll)
  }
  const hit = cache.get(path)
  if (hit !== undefined && hit.stamp === stamp) return hit.value
  const value = contentFingerprint(path, version, compression, decodeAll)
  if (cache.size >= FINGERPRINT_CACHE_MAX && !cache.has(path)) cache.clear()
  cache.set(path, { stamp, value })
  return value
}

/**
 * 一对会话的缓存键：两边所有代次的 `代次:哈希:字节` 按代次排序拼起来。
 *
 * 本机那侧只要有一个代次没拿到指纹就返回 `undefined`（不缓存）：缺了哈希的键可能把两份不同的内容
 * 认成同一对，宁可白算一次。
 */
export function relationKey(
  mine: readonly (FileFingerprint | undefined)[],
  theirs: readonly FileFingerprint[],
): string | undefined {
  const line = (files: readonly (FileFingerprint | undefined)[]): string | undefined => {
    const parts: string[] = []
    for (const file of files) {
      if (file === undefined) return undefined
      parts.push(`${file.version}:${file.sha256}:${file.bytes}`)
    }
    return parts.sort().join(',')
  }
  const left = line(mine)
  const right = line(theirs)
  if (left === undefined || right === undefined) return undefined
  return `${left}|${right}`
}

/** 记一对（超上限就丢最早的；`Map` 的插入顺序就够用，不必再维护 LRU 链表）。 */
export function remember(
  cache: Map<string, ContentRelation>,
  key: string,
  relation: ContentRelation,
): void {
  cache.set(key, relation)
  if (cache.size <= CONTENT_RELATION_CACHE_MAX) return
  const oldest = cache.keys().next()
  if (oldest.done !== true) cache.delete(oldest.value)
}

/** 两条会话的代次集合是否完全一样。 */
function sameVersions(left: readonly FileFingerprint[], right: readonly FileFingerprint[]): boolean {
  if (left.length !== right.length) return false
  const versions = new Set(right.map((file) => file.version))
  return left.every((file) => versions.has(file.version))
}

/** `left` 的代次是不是 `right` 的严格超集（相等不算）。 */
function versionsAhead(left: readonly FileFingerprint[], right: readonly FileFingerprint[]): boolean {
  const mine = new Set(left.map((file) => file.version))
  const theirs = new Set(right.map((file) => file.version))
  if (mine.size <= theirs.size) return false
  for (const version of theirs) if (!mine.has(version)) return false
  return true
}

/** 共有代次的内容是否逐条一致（"这两份是不是同一个东西"）。 */
function sameContent(left: readonly FileFingerprint[], right: readonly FileFingerprint[]): boolean {
  const theirs = new Map(right.map((file) => [file.version, file.sha256]))
  for (const file of left) {
    const other = theirs.get(file.version)
    if (other !== undefined && other !== file.sha256) return false
  }
  return true
}

/** 同一 id 在两边的关系。 */
export type SyncRelation = 'identical' | 'local-ahead' | 'remote-ahead' | 'diverged'

/**
 * 内容级的关系（`src/operations/sync/session-diff.ts` 那把尺子），外加两边尾巴的条数——计划说明里"续写了几条"用它。
 */
export interface ContentRelation {
  relation: DiffRelation
  /** 本机比远端多出来的条数。 */
  localTail: number
  /** 远端比本机多出来的条数。 */
  remoteTail: number
}

/** 内容关系 → 这一层的四种关系（判据只有一条：谁是谁的前缀）。 */
function contentSyncRelation(content: ContentRelation | undefined): SyncRelation {
  switch (content?.relation) {
    case 'same':
      return 'identical'
    case 'local-extends':
      return 'local-ahead'
    case 'remote-extends':
      return 'remote-ahead'
    default:
      return 'diverged' // 真分叉，或这一对没算出内容关系
  }
}

/**
 * 判两个副本的关系。
 *
 * 判据只有一条：**谁是谁的前缀**。代次与哈希只是快筛——能确定就直接下结论（同哈希 = 同一份、共有
 * 代次同哈希且代次领先 = 领先），筛不动的问 `content`（内容关系，由编排那条异步路取两边日志算好传
 * 进来，见 `prepareSync()`）。快筛与内容说的必须是同一件事，所以两处共用 `session-diff.ts` 那套
 * `local-extends`/`remote-extends`/`forked`/`same`，不另写判据。
 *
 * @param mine 本机这份的代次指纹。
 * @param theirs 远端那份的代次指纹。
 * @param content 内容关系（缺席 = 这一对没算，筛不动的归 `diverged`，两条都不动）。
 * @returns 四种关系之一。
 */
export function relation(
  mine: readonly FileFingerprint[],
  theirs: readonly FileFingerprint[],
  content?: ContentRelation,
): SyncRelation {
  if (sameVersions(mine, theirs)) {
    if (sameContent(mine, theirs)) return 'identical'
    return contentSyncRelation(content)
  }
  if (sameContent(mine, theirs)) {
    if (versionsAhead(mine, theirs)) return 'local-ahead'
    if (versionsAhead(theirs, mine)) return 'remote-ahead'
  }
  return contentSyncRelation(content)
}

/** 代次列表的可读描述（报告里用）。 */
export function versionsText(files: readonly FileFingerprint[]): string {
  const versions = files.map((file) => file.version).sort((a, b) => a - b)
  if (versions.length === 0) return '无日志'
  const first = versions[0] as number
  const last = versions[versions.length - 1] as number
  return first === last ? `v${first}` : `v${first}–v${last}`
}

/**
 * 进程里那份"内容关系"缓存：键是两边全部代次的 sha256，值是对出来的关系。
 *
 * 为什么放在进程级：自动推送每写完一轮就走一遍（见 `runAutoPush()`），而"两边各自写过、谁也没再动"
 * 的那几对每一轮都一模一样——不缓存的话，同一份几十 MB 的日志每一轮都从 NAS 重下一次、重解一遍、
 * 重比一遍。键里带着两边**每一个代次**的哈希，任何一边动一个字节都会换键，所以它只省重复劳动。
 *
 * 上限按条数（不是字节）：对数是"两边各自写过"的那些会话，量级几十到几百，一条几十字节。
 */
export const contentRelationCache = new Map<string, ContentRelation>()

/** 缓存最多记多少对（超了就丢最早记进来的那一对）。 */
export const CONTENT_RELATION_CACHE_MAX = 512
