// src/projection-cache.ts — 读宿主投影缓存里的一条会话记录（只读，零 DSH 依赖）。
//
// 宿主把每条会话折叠出来的投影写进 `<storages>/session_projcache/sessions/<encodeSegment(id)>.json`，
// 它自己列会话时也读这份缓存。本插件本来只借它取标题（session-title.ts），现在还要借它取
// 两行里的四件事：`sessionListMetadata` 的 `blank`（宿主"这条会话还没开始过一轮"的判据，决定侧边栏
// 要不要把它藏起来，见 visibility.ts）与 `lastPromptAt`（最后一次提问），以及 `timeContext` 的
// `lastMessageTime`（最后一条消息，含 agent 自己写进去的那些）。后两枚都是"这条会话最后一次动"的钟，
// 跨机器比"谁更新"时取晚的那枚（见 src/sync.ts）。
//
// 为什么把"读文件"独立成一层：标题与这几枚判据是不同字段，但**文件格式、身份校验、坏数据兜底**是同一套。
// 分成两份实现就会出现"标题这条路认得新格式、空白那条路不认得"，而两者本该同生共死。
//
// 身份校验（`createdAt` + `cwd` 必须与磁盘上这条会话对得上）是刻意的：id 相同但属于另一条生命周期的
// 记录（删了重建、缓存残留）会被挡掉。宁可不给标题、不判空白，也不要拿别人的记录当真。
//
// 这是对宿主**内部**文件格式的复刻（与 project-key.ts 复刻宿主的 projectKey 同一性质）：只认字段
// **形状**、不认版本号。宿主要哪天换了格式，这里自然读不到，各调用方按"缓存缺席"处理。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { encodeSegment } from './paths.ts'

/** 定位一条缓存记录需要的最小身份信息。 */
export interface ProjectionCacheQuery {
  id: string
  createdAt: number
  /** 缺省表示这条会话没有 cwd（落 `_no-cwd` 项目目录）。 */
  cwd?: string
}

/** 缓存记录里本插件用得上的字段；读不到就没有那个键。 */
export interface ProjectionCacheRecord {
  /** 折叠出的标题；空串按"没有"处理。 */
  title?: string
  /** 宿主判定的"空白会话"（`sessionListMetadata.blank`）；字段不是布尔就没有。 */
  blank?: boolean
  /**
   * 最后一次**提问**的时间（`sessionListMetadata.lastPromptAt`，毫秒时间戳）；不是有限数就没有。
   *
   * 它由宿主从日志事件里折出来，因此**跟着内容走**——文件复制、cwd 改写都不影响它。
   */
  lastPromptAt?: number
  /**
   * 最后一条**消息**的时间（`timeContext.lastMessageTime`，毫秒时间戳）；不是有限数就没有。
   *
   * 比 {@link lastPromptAt} 细：agent 自己写进去的那些也算"动过"。推上去之后本机又跑了几轮、两边
   * 内容各自长出来时，两边的提问时间往往一样，靠这枚钟才分得出高下（见 src/sync.ts 的「谁更新」）。
   */
  lastMessageAt?: number
}

/**
 * 读一条缓存记录。
 *
 * @param cacheDir 缓存目录（见 paths.projectionCacheDir）。
 * @param query 会话身份。
 * @returns 记录里认识的字段；文件不在、不是 JSON、形状不认识、身份对不上都返回 undefined（不抛）。
 */
export function readProjectionCache(
  cacheDir: string,
  query: ProjectionCacheQuery,
): ProjectionCacheRecord | undefined {
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
    | {
        identity?: { createdAt?: unknown; cwd?: unknown }
        rows?: {
          title?: { val?: unknown }
          sessionListMetadata?: { val?: { blank?: unknown; lastPromptAt?: unknown } }
          timeContext?: { val?: { lastMessageTime?: unknown } }
        }
      }
    | undefined
  const identity = record?.identity
  if (identity === undefined || identity === null || typeof identity !== 'object') return undefined
  if (identity.createdAt !== query.createdAt) return undefined
  if ((identity.cwd ?? undefined) !== (query.cwd ?? undefined)) return undefined

  const out: ProjectionCacheRecord = {}
  const titleValue = record?.rows?.title?.val
  if (typeof titleValue === 'string') {
    const title = titleValue.trim()
    if (title !== '') out.title = title
  }
  const blankValue = record?.rows?.sessionListMetadata?.val?.blank
  if (typeof blankValue === 'boolean') out.blank = blankValue
  const lastPromptAt = record?.rows?.sessionListMetadata?.val?.lastPromptAt
  if (typeof lastPromptAt === 'number' && Number.isFinite(lastPromptAt)) out.lastPromptAt = lastPromptAt
  const lastMessageAt = record?.rows?.timeContext?.val?.lastMessageTime
  if (typeof lastMessageAt === 'number' && Number.isFinite(lastMessageAt)) out.lastMessageAt = lastMessageAt
  return out
}
