// src/projection-cache.ts — 读宿主投影缓存里的一条会话记录（只读，零 DSH 依赖）。
//
// 宿主把每条会话折叠出来的投影写进 `<storages>/session_projcache/sessions/<encodeSegment(id)>.json`，
// 它自己列会话时也读这份缓存。本插件本来只借它取标题（session-title.ts），现在还要借它取
// `sessionListMetadata.blank`——那是宿主"这条会话还没开始过一轮"的判据，决定侧边栏要不要把它藏起来
// （见 visibility.ts）。
//
// 为什么把"读文件"独立成一层：标题与空白是两个字段，但**文件格式、身份校验、坏数据兜底**是同一套。
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
          sessionListMetadata?: { val?: { blank?: unknown } }
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
  return out
}
