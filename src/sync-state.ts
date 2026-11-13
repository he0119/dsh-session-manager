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
  /**
   * 这一趟**没做到**的事（宿主 `SyncOutcome.problems` 的原话：某条缺映射、某条目标目录不存在……）。
   *
   * 失败那趟不写（那一整趟都没成，`error` 已经说了）。留着它是因为"跑完了、但有几条没做到"既不是成功
   * 也不是失败：页头上那枚状态为它单独留了一档黄点（见 `lastRunView()` 与 `client/logic/syncChipDot.ts`）。
   */
  problems?: string[]
  /**
   * 这一趟拉进来的改动什么时候生效：`immediate` 立刻，`restart-required` 要重启 DSH。
   *
   * 存的是**宿主当时的判断**，不是"现在还算不算"——那要看这台宿主之后有没有重启过，由 `lastRunView()`
   * 拿进程启动时刻比一次。
   */
  takesEffect?: 'immediate' | 'restart-required'
}

/** 一条记录摊给界面看的样子：原始记录 + 一条**现在**才成立的事实。 */
export interface SyncRunView extends SyncRunRecord {
  /**
   * 这一趟的改动要重启才算数，而这台宿主从那一趟之后还没重启过。
   *
   * 为什么不在记录里存这个：记录是死的，重启之后它就过期了；"重启过没有"只有当前的进程知道。
   */
  pendingRestart: boolean
}

/**
 * 把一条记录读成界面要的那份：补上"还要不要重启"这一条。
 *
 * 判据：`takesEffect` 是 restart-required，且那趟是在**这个进程里**跑的（`at` 不早于 `bootedAt`）。
 * 反过来说，记录比进程还早 = 中间已经重启过，那一趟早就生效了。
 *
 * @param run 读回来的记录。
 * @param bootedAt 这个宿主进程起来的时刻（毫秒）。
 * @returns 记录本身 + `pendingRestart`。
 */
export function lastRunView(run: SyncRunRecord, bootedAt: number): SyncRunView {
  const at = Date.parse(run.at)
  const pendingRestart =
    run.takesEffect === 'restart-required' && Number.isFinite(at) && at >= bootedAt
  return { ...run, pendingRestart }
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
  const problems = record['problems']
  if (problems !== undefined && (!Array.isArray(problems) || problems.some((item) => typeof item !== 'string'))) {
    return false
  }
  const effect = record['takesEffect']
  if (effect !== undefined && effect !== 'immediate' && effect !== 'restart-required') return false
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
