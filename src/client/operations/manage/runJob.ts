/**
 * 这一页的"长动作"在界面这一侧的生命周期：确认之后弹一个状态窗，可以转后台，跑完在那扇窗口里看结果。
 *
 * 为什么要有这么一份东西：删除、迁移、导入、恢复、整理远端、重算名称原来各管各的——组件自己存
 * `busy` 与 `progress`，做完把结果丢给页面顶部一条横幅，弹窗当场消失。于是用户看不到"正在做什么"，
 * 也看不到"做完了什么"，只能去横幅上找那一句话；关掉弹窗就等于把进度藏起来。
 *
 * 现在统一成一条：**确认 → 状态窗（进度 + 转到后台）→ 同一个窗口换成结果 → 「完成」关掉**。
 * 状态放在**模块级**，理由与 `syncJob.ts` 一样：弹窗关掉（或者用户点「转到后台」）之后，活儿还在
 * 宿主那边跑，这一份不能跟着组件卸载而消失。
 *
 * 一次只跑一件：同一时刻再点另一个动作时，按钮那边本来就按不动（见各面板的 `busy`），这里再挡一次，
 * 免得两份状态互相覆盖。
 *
 * 边界写在明处：**刷新页面之后这份状态就没了**（宿主那边还在跑，但没有接口能问"跑到哪了"），
 * 这一点与后台同步不同（那一趟能从 `GET /panel/events` 认领回来）。
 *
 * @module dsh-session-manager/client/operations/manage/runJob
 */

import type * as React from 'react'

import type { ProgressEvent } from '../../api.ts'

/** 走这一套的动作（同步另有一套，见 `syncJob.ts`：它的进度还能从长连接认领回来）。 */
export type RunKind = 'delete' | 'migrate' | 'retitle' | 'import' | 'rollback' | 'tidy'

/** 一趟结束之后的结论。 */
export interface RunDone {
  /** 成没成。 */
  ok: boolean
  /**
   * 宿主回的完整结果（各动作自己的类型）。
   *
   * 只有"请求走通了"才有它：请求本身失败（网络、HTTP 参数）时只有 `error`。
   */
  result?: unknown
  /** 失败原因（请求本身没走通时的那句话）。 */
  error?: string
}

/** 界面读的那一份状态。每次变化换一个新对象（订阅者据此判"变了没有"）。 */
export interface RunState {
  kind: RunKind
  /** 还在跑。 */
  running: boolean
  /** 最后一条进度事件；一条都还没收到就是 `null`。 */
  progress: ProgressEvent | null
  /** 状态窗开着（`false` = 用户把它转到后台了）。 */
  dialog: boolean
  /** 跑完之后的那份结论，直到用户按「完成」把它取走。 */
  done: RunDone | null
  /** 结果页怎么画（各动作在发起时给的，闭包里带着那个面板要用的回调）。 */
  render: (done: RunDone) => React.ReactNode
  /**
   * 宽的那一档（1080）。
   *
   * 一条流程从头到尾一个宽度：从「做事那一面」（导入面、备份与回滚、同步面，都是 1080）发起的动作，
   * 状态窗与结果页也停在 1080；从确认弹窗（640）发起的就停在 640。否则同一条流程里窗口会先宽后窄，
   * 看着像换了一件事（口径见 design.md 的「执行与结果」）。
   */
  wide: boolean
}

let current: RunState | null = null
const listeners = new Set<() => void>()

/** 通知所有订阅者（状态对象已经换过了）。 */
function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * 当下这一趟。
 *
 * @returns 没有在跑、也没有未取走的结论时是 `null`。
 */
export function getRun(): RunState | null {
  return current
}

/**
 * 订阅状态变化。
 *
 * @param listener 变化时调一次（参数请自己读 `getRun()`）。
 * @returns 退订。
 */
export function subscribeRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 发起一趟：状态窗立刻打开，进度一条条进来，跑完换成结果。
 *
 * @param kind 这是哪一件事。
 * @param work 真干活（就是原来那个请求函数，`report` 是它的进度回调）。
 * @param render 结果页怎么画（拿宿主回的整份结果，各动作自己拼）。
 * @param options.onChange 状态变了再调一次（面板借它做"跑完之后重读列表"这类收尾）。
 * @returns 是否真的发起了（已经有一趟在跑时不发起）。
 */
export function startRun<T>(
  kind: RunKind,
  work: (report: (event: ProgressEvent) => void) => Promise<T>,
  render: (done: RunDone) => React.ReactNode,
  options: { onChange?: (done: RunDone) => void; wide?: boolean } = {},
): boolean {
  if (current?.running === true) return false
  current = { kind, running: true, progress: null, dialog: true, done: null, render, wide: options.wide === true }
  emit()
  /**
   * 收尾：把结论挂上去，让状态窗换成结果页。
   *
   * 先判 kind 再写：极端情况下（用户在同一页里又发起了另一趟）不该把新的那一份盖掉。
   */
  const settle = (done: RunDone): void => {
    if (current === null || current.kind !== kind) return
    current = { ...current, running: false, done }
    emit()
    options.onChange?.(done)
  }
  void work((progress) => {
    // 只认还在跑的那一趟：请求那边已经给了结论之后，迟到的进度不该把界面改回"在跑"（与 syncJob 同一个口径）。
    if (current === null || current.kind !== kind || !current.running) return
    current = { ...current, progress }
    emit()
  }).then(
    (result) => settle({ ok: true, result }),
    (error: unknown) => settle({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
  return true
}

/** 转到后台：状态窗关掉，活儿照跑；状态栏那一格接着报进度。 */
export function backgroundRun(): void {
  if (current === null || !current.running || !current.dialog) return
  current = { ...current, dialog: false }
  emit()
}

/** 从状态栏那一格回到状态窗（跑着或已跑完都能回去）。 */
export function openRunDialog(): void {
  if (current === null || current.dialog) return
  current = { ...current, dialog: true }
  emit()
}

/** 取走结论：结果页上按「完成」（或关掉它）时调，之后不再有任何状态。 */
export function dismissRun(): void {
  if (current === null || current.running || current.done === null) return
  current = null
  emit()
}
