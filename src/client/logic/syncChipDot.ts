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

import type { SyncLeftover } from '../api.ts'
import { leftoversOf, type LeftoverSource } from './syncLeftovers.ts'

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
    | {
        ok: boolean
        error?: string | undefined
        result?: { problems?: readonly string[]; leftovers?: readonly SyncLeftover[] } | undefined
      }
    | null
    | undefined
  /** 磁盘上记着的上一次手动同步（跨进程重启还在）。 */
  lastRun?:
    | {
        ok: boolean
        error?: string | undefined
        problems?: readonly string[] | undefined
        /** 点名版（见 `syncLeftovers.ts`）：有新宿主给这一项，条数按它算才对得上弹窗里那张清单。 */
        leftovers?: readonly SyncLeftover[] | undefined
        pendingRestart?: boolean | undefined
      }
    | null
    | undefined
  /** 自动开着（宿主给了那个字段就是开着）。 */
  autoPush: boolean
  /** 开着的那一档是**双向**（`sync`），不是只推。缺省 = 只推。 */
  autoPushSync?: boolean
}

/** 那一趟有没有留下要人看的东西。 */
function hasLeftover(source: LeftoverSource, pendingRestart: boolean | undefined): boolean {
  return leftoversOf(source).length > 0 || pendingRestart === true
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
    if (hasLeftover({ leftovers: done.result?.leftovers, problems: done.result?.problems }, false)) return 'warning'
  } else if (lastRun !== null && !lastRun.ok) {
    return 'error'
  }
  if (lastRun !== null && lastRun.ok && hasLeftover(lastRun, lastRun.pendingRestart)) return 'warning'
  if (facts.autoPush) return 'done'
  return 'idle'
}

/** 那枚按钮的悬浮提示：这一档是什么状态（没有就是 null，那枚按钮整个不出提示）。 */
export type SyncChipNote =
  | { key: 'sync.chip.noteRunning' }
  | { key: 'sync.chip.noteFailed'; params: { reason: string } }
  | { key: 'sync.chip.noteFailedPlain' }
  | { key: 'sync.chip.noteProblems'; params: { count: number } }
  | { key: 'sync.chip.noteRestart' }
  | { key: 'sync.chip.noteAuto' }
  | { key: 'sync.chip.noteAutoSync' }

/**
 * 那枚按钮的悬浮提示：这一档用一句短话说清。
 *
 * 颜色本身读屏读不到、也常被一眼扫过，所以按钮上必须有一句理由。原来这条理由分成两级（点上一句、
 * 按钮上一句）再加"没做到的原话最多三条"，一个按钮最多摊成五行；现在合成一句短的，明细（哪条会话、
 * 为什么）留在点开后的「上次同步」里。
 *
 * @param facts 与 {@link syncChipDot} 同一份事实。
 * @returns 要补的那一句；这一档没什么可说时 null（干净、还没跑过）。
 */
export function syncChipNote(facts: SyncChipFacts): SyncChipNote | null {
  const state = syncChipDot(facts)
  const done = facts.done ?? null
  const lastRun = facts.lastRun ?? null
  if (state === 'ongoing') return { key: 'sync.chip.noteRunning' }
  if (state === 'error') {
    // 这一页刚跑的那趟优先（它的 `error` 最新）；否则读磁盘上那条记录里的原话。
    const reason =
      (done !== null && !done.ok ? done.error : undefined) ??
      (lastRun !== null && !lastRun.ok ? lastRun.error : undefined)
    return reason === undefined
      ? { key: 'sync.chip.noteFailedPlain' }
      : { key: 'sync.chip.noteFailed', params: { reason } }
  }
  if (state === 'warning') {
    const source =
      done !== null && done.ok
        ? { leftovers: done.result?.leftovers, problems: done.result?.problems }
        : lastRun
    const count = leftoversOf(source).length
    if (count > 0) return { key: 'sync.chip.noteProblems', params: { count } }
    return { key: 'sync.chip.noteRestart' }
  }
  if (state === 'done') {
    // 绿点说的"自动"有两档：只推、双向。两句不同——双向会动本机，用户该知道。
    return { key: facts.autoPushSync === true ? 'sync.chip.noteAutoSync' : 'sync.chip.noteAuto' }
  }
  return null
}
