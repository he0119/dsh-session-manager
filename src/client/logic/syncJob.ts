/**
 * 一轮同步（拉取 + 推送）在界面这一侧的生命周期：关掉弹窗之后它还在跑，回到这一页还能看见。
 *
 * 为什么要有这么一份东西：落地是这一页最长的动作（一次整库同步要读远端索引、逐条走网络）。原先它挂在
 * 同步弹窗那个组件上——弹窗一关、页签一切、"设置"窗口一关，那棵组件树就卸载了，进度与结果全丢；
 * 而宿主那一侧的活儿还在继续（实测：客户端中途断开之后，服务端的 handler 照旧把整趟跑完）。用户看到
 * 的却是"什么都没发生"，回来也只能靠自己猜。
 *
 * 所以把状态搬到**模块级**：组件挂不挂载都不影响它，谁渲染谁读。三件事：
 *
 * 1. 这一页发起的那一趟：走事件流，进度最细；
 * 2. 关掉弹窗 / 切页签 / 关掉整个设置窗口：都不影响它，回到这一页横幅上照样是它；
 * 3. 刷新了整个页面（或者从另一个页签发起）：那一趟还在宿主里跑，但这一份内存已经没了——于是向宿主
 *    的 `GET /sync?mode=status` 认领：横幅上说"还在跑"，每 3 秒问一次，跑完把"搬了几条"补上。
 *
 * 边界写在明处：**认领来的那一趟没有逐条进度，也没有完整结果**（宿主那边只留"跑没跑、搬了几条"），
 * 细节要以发起它的那个页面为准。
 *
 * @module dsh-session-manager/client/logic/syncJob
 */

import {
  applySync,
  fetchSyncStatus,
  type ProgressEvent,
  type SyncResponse,
  type SyncStatusResponse,
} from '../api.ts'
import type { SyncDecision } from '../api.ts'

/** 一趟结束之后的结论。 */
export interface SyncJobDone {
  /** 这趟成没成。 */
  ok: boolean
  /**
   * 这一页自己发起的那一趟带着完整结果（界面据此说已拉取 / 已推送、覆盖了几条、附件对象搬了几个）。
   *
   * 认领来的那一趟没有它——宿主只留下几条计数（见 `adopted`）。
   */
  result?: SyncResponse
  /** 认领来的那一趟：宿主记下的几条计数（没有完整结果）。 */
  adopted?: { pulled: number; pushed: number }
  /** 失败原因（异常消息，或宿主事件流里那条 `error`）。 */
  error?: string
}

/** 界面读的那一份状态。只读、每次变化换一个新对象（订阅者据此判"变了没有"）。 */
export interface SyncJobSnapshot {
  /** 现在有一趟在跑。 */
  running: boolean
  /** 在跑的这一趟不是这一页发起的（刷新之后认领来的）。 */
  adopted: boolean
  /** 这一趟从什么时候开始（宿主给的毫秒时间戳）；不知道就是 `null`。 */
  startedAt: number | null
  /** 最后一条进度事件；一条都还没收到就是 `null`。 */
  progress: ProgressEvent | null
  /** 刚结束、还没被界面取走 / 关掉的结论。 */
  done: SyncJobDone | null
}

/** 一次落地的入口（生产上就是 `applySync()`；测试换成一个假的即可）。 */
export type SyncJobApply = (
  planId: string | undefined,
  onProgress: (event: ProgressEvent) => void,
  decisions: ReadonlyMap<string, SyncDecision> | undefined,
) => Promise<SyncResponse>

/** 造一份 store 时给的依赖。 */
export interface SyncJobDeps {
  /** 真跑一趟。 */
  apply: SyncJobApply
  /** 问宿主"后台有没有一趟在跑"（`GET /sync?mode=status`）。 */
  status: () => Promise<SyncStatusResponse>
  /** 认领来的那一趟隔多久问一次宿主（毫秒，缺省 3000）。 */
  pollMs?: number
}

/** 界面用的那几个口子。 */
export interface SyncJob {
  /** 现在这一份状态。 */
  snapshot(): SyncJobSnapshot
  /**
   * 订阅状态变化。
   *
   * @param listener 每次变化调一次（拿到新快照）。
   * @returns 退订函数（组件卸载时调）。
   */
  subscribe(listener: (snapshot: SyncJobSnapshot) => void): () => void
  /**
   * 开一趟落地。
   *
   * @param input 预演给的 `planId` 与这一趟的裁决；都没有就是"从零算一遍"。
   * @returns 已经有一趟在跑时返回 `false`（这一趟没开）。
   */
  start(input: { planId?: string; decisions?: ReadonlyMap<string, SyncDecision> }): boolean
  /**
   * 取走**这一页发起的**那一趟的结论（取走即清空，免得两个入口各说一遍）。
   *
   * 认领来的结论不在这条路上：它没有完整结果，由页面级横幅自己说、自己关（见 `dismiss()`）。
   *
   * @returns 结论；没有（或者只有认领来的那一条）就是 `null`。
   */
  takeResult(): SyncJobDone | null
  /** 关掉结束结论（横幅上那枚「关闭」）。正在跑的那一趟不受影响。 */
  dismiss(): void
  /**
   * 问一次宿主，认领后台还在跑的那一趟（页面打开时调一次）。
   *
   * 这一页自己发起的、正在跑的那一趟不会被它打乱：已经有主的那一份进度更细，不拿粗的盖掉它。
   */
  refresh(): void
}

/**
 * 造一份同步任务状态。
 *
 * @param deps 落地入口、状态查询与轮询间隔。
 * @returns 那几个口子（见 {@link SyncJob}）。
 */
export function createSyncJob(deps: SyncJobDeps): SyncJob {
  const pollMs = deps.pollMs ?? 3000
  const listeners = new Set<(snapshot: SyncJobSnapshot) => void>()
  let current: SyncJobSnapshot = { running: false, adopted: false, startedAt: null, progress: null, done: null }
  /** 认领来的那一趟的轮询定时器。 */
  let timer: ReturnType<typeof setInterval> | null = null

  const emit = (patch: Partial<SyncJobSnapshot>): void => {
    current = { ...current, ...patch }
    for (const listener of [...listeners]) listener(current)
  }

  const stopPolling = (): void => {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  /** 把宿主给的"跑完了"折成结论：有结果说结果，只有计数就说计数。 */
  const finishAdopted = (last: SyncStatusResponse['last']): void => {
    stopPolling()
    if (last === null) {
      // 宿主那边没有留下结论（进程重启过）：如实说"这一轮结束了"，但不编一个数字。
      emit({ running: false, adopted: false, startedAt: null, progress: null, done: { ok: true } })
      return
    }
    emit({
      running: false,
      adopted: false,
      startedAt: null,
      progress: null,
      done: {
        ok: last.ok,
        adopted: { pulled: last.pulled, pushed: last.pushed },
        ...(last.error === undefined ? {} : { error: last.error }),
      },
    })
  }

  /**
   * 问一次宿主。
   *
   * 三种结果各走一条：还在跑（没主就认领、有主就更新进度）、跑完了（认领来的那一趟收尾）、
   * 本来就没有（什么都不做——不能把上一次的旧结论重新摆出来）。
   */
  const poll = async (): Promise<void> => {
    let status: SyncStatusResponse
    try {
      status = await deps.status()
    } catch {
      // 问不到就当这一轮还不知道：保持现状，下一次再问。断开连接这类错不该把横幅清掉。
      return
    }
    if (status.applying !== null) {
      if (current.running) {
        // 自己发起的那一趟进度更细（事件流），不拿这份粗的盖掉；认领来的那一趟就用这份更新。
        if (current.adopted) emit({ progress: status.applying.progress })
        return
      }
      emit({
        running: true,
        adopted: true,
        startedAt: status.applying.startedAt,
        progress: status.applying.progress,
        done: null,
      })
      startPolling()
      return
    }
    if (current.running && current.adopted) finishAdopted(status.last)
  }

  const startPolling = (): void => {
    if (timer !== null) return
    timer = setInterval(() => void poll(), pollMs)
    // 浏览器里 `setInterval` 回的是数字、没有 unref；Node 里有（测试跑在 Node 上，别把进程钉住）。
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start(input) {
      if (current.running) return false
      // 新的一轮：上一轮的结论让位（不然横幅刚清掉又冒出来）。
      emit({ running: true, adopted: false, startedAt: Date.now(), progress: null, done: null })
      const onProgress = (progress: ProgressEvent): void => {
        // 只认还在跑的那一趟：万一它已经结束（比如宿主那边立刻失败），迟到的进度不该把状态改回去。
        if (!current.running) return
        emit({ progress })
      }
      void deps.apply(input.planId, onProgress, input.decisions).then(
        (result) => {
          stopPolling()
          emit({ running: false, adopted: false, startedAt: null, progress: null, done: { ok: true, result } })
        },
        (cause: unknown) => {
          stopPolling()
          emit({
            running: false,
            adopted: false,
            startedAt: null,
            progress: null,
            done: { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
          })
        },
      )
      return true
    },
    takeResult() {
      const done = current.done
      if (done === null || done.adopted !== undefined) return null
      emit({ done: null })
      return done
    },
    dismiss() {
      stopPolling()
      emit({ done: null })
    },
    refresh() {
      void poll()
    },
  }
}

/**
 * 这一页共用的那一份（模块级：组件卸载不影响它，见模块开头的说明）。
 *
 * 生产上直接用它；测试要换掉落地入口时用 {@link createSyncJob} 造一份自己的。
 */
export const syncJob: SyncJob = createSyncJob({
  apply: (planId, onProgress, decisions) => applySync(planId, onProgress, decisions),
  status: () => fetchSyncStatus(),
})
