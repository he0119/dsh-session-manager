/**
 * 页头那枚同步状态点哪一档颜色。
 *
 * 五个档里只用四个（官方 `StateDot` 的 `warning` 我们借来当"跑完了但有遗留"），判据全部来自**本地已知
 * 的事实**，不联网：
 *
 * 1. `ongoing`：正跑着（这一页发起的，或认领来的那一趟）——转圈；
 * 2. `error`：失败——这一页刚跑的那趟没成，或磁盘上记着的上一次没成；
 * 3. `warning`：跑完了，但有几条没做到、或者改动要重启才生效——有东西等人再看一眼；
 * 4. `done`：自动推送开着——这台机器会自己推，"绿色的意思是通道开着、在替你干活"；
 * 5. `idle`：以上都不是（没配、没跑过、跑得干净且没开自动推送）。
 *
 * 为什么绿点给"自动推送开着"而不是"上次成功"：成功这件事在按钮文字里已经写着（「同步 · 3 小时前」），
 * 而一条三天前的绿点会被读成"刚刚同步过"。配置事实稳定、运行事实会过期——绿的那一档留给前者。
 *
 * @module dsh-session-manager/client/logic/syncChipDot
 */

/** 点哪一档（官方 `StateDotState` 的子集，见模块说明）。 */
export type SyncChipDot = 'ongoing' | 'error' | 'warning' | 'done' | 'idle'

/** 判这一档要看的事实。 */
export interface SyncChipFacts {
  /** 有一趟在跑（这一页发起的，或刷新之后认领来的）。 */
  running: boolean
  /**
   * 这一页刚跑完的那一趟（`syncJob.done`）。
   *
   * 带着完整结果时判"有遗留"最准；认领来的那一趟没有 `result`（宿主只留了计数）。
   */
  done?:
    | { ok: boolean; error?: string | undefined; result?: { problems?: readonly string[] } | undefined }
    | null
    | undefined
  /** 磁盘上记着的上一次手动同步（跨进程重启还在）。 */
  lastRun?:
    | {
        ok: boolean
        error?: string | undefined
        problems?: readonly string[] | undefined
        pendingRestart?: boolean | undefined
      }
    | null
    | undefined
  /** 自动推送开着（宿主给了那个字段就是开着）。 */
  autoPush: boolean
}

/** 那一趟有没有留下要人看的东西。 */
function leftovers(problems: readonly string[] | undefined, pendingRestart: boolean | undefined): boolean {
  return (problems !== undefined && problems.length > 0) || pendingRestart === true
}

/**
 * 这一档该点哪个状态。
 *
 * 次序即优先级：跑着 > 失败 > 有遗留 > 自动推送开着 > 什么都没有。
 * 失败压过"自动推送开着"是必须的——否则一趟没成的同步会被一枚绿点盖住。
 *
 * @param facts 本地已知的事实（见 {@link SyncChipFacts}）。
 * @returns 官方 `StateDot` 的状态名。
 */
export function syncChipDot(facts: SyncChipFacts): SyncChipDot {
  if (facts.running) return 'ongoing'
  const done = facts.done ?? null
  const lastRun = facts.lastRun ?? null
  // 这一页刚跑完的那趟最准；它被关掉之后退回磁盘上那条记录——两处写的是同一份结论。
  if (done !== null) {
    if (!done.ok) return 'error'
    if (leftovers(done.result?.problems, false)) return 'warning'
  } else if (lastRun !== null && !lastRun.ok) {
    return 'error'
  }
  if (lastRun !== null && lastRun.ok && leftovers(lastRun.problems, lastRun.pendingRestart)) return 'warning'
  if (facts.autoPush) return 'done'
  return 'idle'
}

/**
 * 那枚点**自己**的悬浮提示：这一档是什么状态。
 *
 * 与上一句（`syncChipNote`，挂在整枚按钮上）分开：鼠标落在那个 10px 的点上时，回答的是"这个颜色是什么意思"；
 * 落在按钮其余部分时，回答的是"这个按钮干什么"。同一个按钮上两级提示，内层（点）压过外层（按钮）。
 */
export type SyncChipDotTitle =
  | { key: 'sync.chip.dot.ongoing' }
  | { key: 'sync.chip.dot.error'; params: { reason: string } }
  | { key: 'sync.chip.dot.errorPlain' }
  | { key: 'sync.chip.dot.problems'; params: { count: number } }
  | { key: 'sync.chip.dot.restart' }
  | { key: 'sync.chip.dot.auto' }
  | { key: 'sync.chip.dot.idle' }

/**
 * 这一档要说的那句话。
 *
 * 失败那档带上宿主/远端的原话（「上次同步没成：401 Unauthorized」）——红点最常被问的就是"为什么红了"，
 * 而那句话正躺在记录里（`error`）。其余几档各说一句自己的事。
 *
 * @param facts 与 {@link syncChipDot} 同一份事实。
 * @returns 字典键与参数。
 */
export function syncChipDotTitle(facts: SyncChipFacts): SyncChipDotTitle {
  const state = syncChipDot(facts)
  const done = facts.done ?? null
  const lastRun = facts.lastRun ?? null
  if (state === 'ongoing') return { key: 'sync.chip.dot.ongoing' }
  if (state === 'error') {
    // 这一页刚跑的那趟优先（它的 `error` 最新）；否则读磁盘上那条记录里的原话。
    const reason =
      (done !== null && !done.ok ? done.error : undefined) ??
      (lastRun !== null && !lastRun.ok ? lastRun.error : undefined)
    return reason === undefined
      ? { key: 'sync.chip.dot.errorPlain' }
      : { key: 'sync.chip.dot.error', params: { reason } }
  }
  if (state === 'warning') {
    const problems = done !== null && done.ok ? done.result?.problems : lastRun?.problems
    if (problems !== undefined && problems.length > 0) return { key: 'sync.chip.dot.problems', params: { count: problems.length } }
    return { key: 'sync.chip.dot.restart' }
  }
  if (state === 'done') return { key: 'sync.chip.dot.auto' }
  return { key: 'sync.chip.dot.idle' }
}

/** 那枚点的悬浮提示要多说的那一句（没有就是 null，提示只有「打开同步…」那一句）。 */
export type SyncChipNote =
  | { key: 'sync.chip.noteProblems'; params: { count: number } }
  | { key: 'sync.chip.noteRestart' }

/**
 * 黄点要解释自己在说什么。
 *
 * 颜色不是所有人都读得懂、读屏软件也读不到（那枚点是 `aria-hidden`），所以"为什么是黄的"必须有一句话
 * 挂在这枚按钮的悬浮提示上：几条没做到、或者要重启。
 *
 * @param facts 与 {@link syncChipDot} 同一份事实。
 * @returns 要补的那一句；不需要补时 null。
 */
export function syncChipNote(facts: SyncChipFacts): SyncChipNote | null {
  const done = facts.done ?? null
  const lastRun = facts.lastRun ?? null
  const problems = done !== null && done.ok ? done.result?.problems : lastRun?.ok === true ? lastRun.problems : undefined
  if (problems !== undefined && problems.length > 0) return { key: 'sync.chip.noteProblems', params: { count: problems.length } }
  if (lastRun !== null && lastRun.ok && lastRun.pendingRestart === true) return { key: 'sync.chip.noteRestart' }
  return null
}
