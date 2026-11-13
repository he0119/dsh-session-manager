/**
 * 同步那一趟在**状态栏**上说的那一句。
 *
 * 为什么单独一个纯函数：状态栏是 39px 的单行（12px/18px），只装得下一句短的；而"说哪一句"要按
 * 跑到哪儿、成没成、有没有逐条进度分三支，这三分支写进组件里就只能靠肉眼验。抽出来之后
 * `test/sync-job-label.test.ts` 把四支各钉一条。
 *
 * 字号说了算的那一层是设计：[design.md](../../../docs/design.md) 里状态栏那一格只说"这一页在看
 * 哪个库 / 有哪些备份 / 是哪个构建"，另外加一条**会自己动**的：同步跑着、刚跑完。更细的东西
 * （字节、正在处理的那条会话、失败原因）留在弹窗里，不往 39px 里挤。
 *
 * @module dsh-session-manager/client/logic/syncJobLabel
 */

/** 状态栏那一格要说的话：字典键 + 参数。`null` = 这一格不出现。 */
export type SyncBarLabel =
  | { key: 'sync.bar.running'; params: { done: number; total: number } }
  | { key: 'sync.bar.runningUnknown' }
  | { key: 'sync.bar.done'; params: { count: number } }
  | { key: 'sync.bar.donePlain' }
  | { key: 'sync.bar.failed' }

/** 只用到这几格（结构化的类型：测试传普通对象即可，不必造一份完整快照）。 */
export interface SyncBarSource {
  running: boolean
  progress: { done: number; total: number } | null
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
 * @param job 那一趟的快照（见 `logic/syncJob.ts`）。
 * @returns 键与参数；没有要说的就是 `null`（那一格不出现，占位归 `spacer`）。
 */
export function syncBarLabel(job: SyncBarSource): SyncBarLabel | null {
  if (job.running) {
    // 认领来的那一趟没有逐条事件（宿主只留"跑没跑"），所以分母可能是 0——那时只说"同步中"。
    const progress = job.progress
    return progress !== null && progress.total > 0
      ? { key: 'sync.bar.running', params: { done: progress.done, total: progress.total } }
      : { key: 'sync.bar.runningUnknown' }
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
