/**
 * 上一次手动同步落在磁盘上的那条记录。
 *
 * 为什么要有它：同步是这一页唯一"不点也会自己跑"的事，用户关掉窗口、重启 DSH 之后再打开，页头那枚
 * 状态如果只能说"配没配"，就答不了"昨晚那趟成没成"。宿主原来只在内存里记（`web.ts` 的 `lastApply`），
 * 进程一重启就没了。
 *
 * 存在插件自己的目录里（`<DSH_HOME>/dsh-session-manager/state.json`），与备份根是同一个父目录：那是
 * 这个插件唯一向用户的 `$DSH_HOME` 要的一层。**不写进插件配置**——配置是用户的东西，每次同步都改一遍
 * 会在设置页里攒出一串"已修改"的噪音。
 *
 * 记录只是**给界面看的一句话**：读不出来、写不进去都不该影响同步本身，所以读对坏数据宽容（当没有），
 * 写失败静默（下一次成功会覆盖它）。
 *
 * @module dsh-session-manager/sync-state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 一条同步记录。`at` 是 ISO 时间戳，`error` 只在失败时有。 */
export interface SyncRunRecord {
  /** 这一趟结束的时刻（ISO 8601，带时区）。 */
  at: string
  /** 成没成。 */
  ok: boolean
  /** 拉进来几条（失败那趟是 0）。 */
  pulled: number
  /** 推上去几条（失败那趟是 0）。 */
  pushed: number
  /** 失败原因（宿主或远端的原话）。 */
  error?: string
}

/** 这个插件在 `$DSH_HOME` 下那一层。 */
function pluginDir(home: string): string {
  return join(home, 'dsh-session-manager')
}

/** 状态文件的位置：`<DSH_HOME>/dsh-session-manager/state.json`。 */
export function syncStatePath(home: string): string {
  return join(pluginDir(home), 'state.json')
}

/** 一条记录读回来时能信到什么程度：形状不对就当没有。 */
function isRecord(value: unknown): value is SyncRunRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record['at'] !== 'string' || record['at'] === '') return false
  if (typeof record['ok'] !== 'boolean') return false
  if (typeof record['pulled'] !== 'number' || typeof record['pushed'] !== 'number') return false
  if (record['error'] !== undefined && typeof record['error'] !== 'string') return false
  // 时间要能被 Date 认出来：界面要拿它算"多久以前"，一个解不出来的字符串只会变成 NaN。
  return Number.isFinite(Date.parse(record['at']))
}

/**
 * 读上一次同步的记录。
 *
 * 文件不在、JSON 坏了、字段缺了都返回 `undefined`——这一条只是页头上的一句话，不该让页面读库失败。
 *
 * @param home DSH 家目录（`$DSH_HOME`）。
 * @returns 上次同步的记录；没有或读不懂时 undefined。
 */
export function readSyncRun(home: string): SyncRunRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(syncStatePath(home), 'utf8')) as { sync?: unknown } | null
    const run = parsed?.sync
    return isRecord(run) ? run : undefined
  } catch {
    return undefined
  }
}

/**
 * 记下这一趟同步。
 *
 * 先写临时文件再 rename：读者（同一个宿主的另一个请求）不会读到写了一半的 JSON。写不进去就什么都不做，
 * 下一次成功的那趟会再写一遍；同步本身不该因为记不下来这一句而失败。
 *
 * @param home DSH 家目录（`$DSH_HOME`）。
 * @param run 这一趟的结论。
 */
export function writeSyncRun(home: string, run: SyncRunRecord): void {
  const path = syncStatePath(home)
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ sync: run }, null, 2) + '\n')
    renameSync(tmp, path)
  } catch {
    // 记不下来就算了：界面上少一句"上次同步在几点"，同步本身已经做完了。
  }
}
