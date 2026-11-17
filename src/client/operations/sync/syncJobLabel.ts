/**
 * 同步那一趟在**状态栏**上说的那一句。
 *
 * 为什么单独一个纯函数：状态栏是 39px 的单行（12px/18px），只装得下一句短的；而"说哪一句"要按
 * 跑到哪儿、成没成、有没有逐条进度分三支，这三分支写进组件里就只能靠肉眼验。抽出来之后
 * `test/client/operations/sync/sync-job-label.test.ts` 把每一支各钉一条。
 *
 * 跑着时那串数说的是**会话**，不是"最后那条事件数的东西"：宿主那一路事件里 `repo` 数的是本机仓库
 * 目录、`tidy` 数的是远端包、`attach` 数的是附件对象，随手拣最后一条画出来就成了「同步中 20/21」
 * ——21 可能是 21 个目录（见 `syncBarTally.ts`）。所以那两串数由那个纯函数折，这里只管怎么念：
 *
 * - 会话 + 附件对象都在动 → 「同步中 · 3/7 条会话 · 附件 1/2」
 * - 只有会话（大多数时候） → 「同步中 · 3/7 条会话」
 * - 只有附件对象（补对象那一趟，整库尺度） → 「同步中 · 附件 1/2」
 * - 都还没开始（算计划那几段） → 「同步中…」
 *
 * 字号说了算的那一层是设计：[design.md](../../../../docs/design.md) 里状态栏那一格只说"这一页在看
 * 哪个库 / 有哪些备份 / 是哪个构建"，另外加一条**会自己动**的：同步跑着、刚跑完。更细的东西
 * （字节、正在处理的那条会话、失败原因）留在悬浮提示与弹窗里，不往 39px 里挤。
 *
 * @module dsh-session-manager/client/operations/sync/syncJobLabel
 */

import { attachmentTallyOf, type SyncBarTally } from './syncBarTally.ts'

/** 状态栏那一格要说的话：字典键 + 参数。`null` = 这一格不出现。 */
export type SyncBarLabel =
  /** 会话搬到第几条 / 共几条。 */
  | { key: 'sync.bar.runningSessions'; params: { done: number; total: number } }
  /** 会话 + 附件对象两串数（附件只在这一趟真要搬对象时才出现）。 */
  | {
      key: 'sync.bar.runningBoth'
      params: { done: number; total: number; objectsDone: number; objectsTotal: number }
    }
  /** 只有附件对象在动（补对象那一趟：没有会话要搬，但整库的对象要核一遍）。 */
  | { key: 'sync.bar.runningObjects'; params: { objectsDone: number; objectsTotal: number } }
  | { key: 'sync.bar.runningUnknown' }
  | { key: 'sync.bar.done'; params: { count: number } }
  | { key: 'sync.bar.donePlain' }
  | { key: 'sync.bar.failed' }

/** 只用到这几格（结构化的类型：测试传普通对象即可，不必造一份完整快照）。 */
export interface SyncBarSource {
  running: boolean
  /** 这一趟折出来的两串数（见 `syncBarTally.ts`）。 */
  tally: SyncBarTally
  done: {
    ok: boolean
    /** 这一页自己发起的那一趟：完整结果（只用到条数）。 */
    result?: { pulled: readonly unknown[]; pushed: readonly unknown[] }
    /** 认领来的那一趟：宿主记下的几条计数。 */
    adopted?: { pulled: number; pushed: number }
    /** 失败原因（这一格只用到"成没成"，它跟着悬浮提示与同步那一面走）。 */
    error?: string
  } | null
}

/**
 * 判断这一格现在是"跑着"、"刚跑完"还是"没它的事"。
 *
 * @param job 那一趟的快照（见 `operations/sync/syncJob.ts`）。
 * @returns 键与参数；没有要说的就是 `null`（那一格不出现，占位归 `spacer`）。
 */
export function syncBarLabel(job: SyncBarSource): SyncBarLabel | null {
  if (job.running) {
    const sessions = job.tally.sessions
    const objects = attachmentTallyOf(job.tally)
    // 分母是 0 的那几段没有"第几条"可讲：宁可只说"同步中…"，也不编一个 0/0。
    const hasSessions = sessions !== null && sessions.total > 0
    const hasObjects = objects !== null && objects.total > 0
    if (hasSessions && hasObjects) {
      return {
        key: 'sync.bar.runningBoth',
        params: {
          done: sessions.done,
          total: sessions.total,
          objectsDone: objects.done,
          objectsTotal: objects.total,
        },
      }
    }
    if (hasSessions) return { key: 'sync.bar.runningSessions', params: { done: sessions.done, total: sessions.total } }
    if (hasObjects) {
      return { key: 'sync.bar.runningObjects', params: { objectsDone: objects.done, objectsTotal: objects.total } }
    }
    // 算计划那几段（扫库、读远端索引、认本机仓库、比对内容）没有会话在搬：只说"同步中…"。
    return { key: 'sync.bar.runningUnknown' }
  }
  const done = job.done
  if (done === null) return null
  if (!done.ok) return { key: 'sync.bar.failed' }
  // 这一页自己跑的那一趟给的是完整结果（两条数组），认领来的只有计数。
  if (done.result !== undefined) {
    return {
      key: 'sync.bar.done',
      params: { count: done.result.pulled.length + done.result.pushed.length },
    }
  }
  if (done.adopted !== undefined) {
    return { key: 'sync.bar.done', params: { count: done.adopted.pulled + done.adopted.pushed } }
  }
  // 宿主那边连"搬了几条"都没留下（进程重启过）：说结束，不编一个 0。
  return { key: 'sync.bar.donePlain' }
}
