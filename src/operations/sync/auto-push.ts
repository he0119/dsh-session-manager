// 自动推送：安静窗口的调度器与"跑一轮"。
//
// 它只推不拉（`pushOnly`），一轮的输入仍是 `prepareSync()` 那份计划；触发源是"本机安静下来"，
// 不是"隔多久"。两条发起路（写完一轮、界面那枚「立即推送一次」）都经过同一个调度器，界面因此只需
// 订阅一处。
//
// @module dsh-session-manager/operations/sync/auto-push

import { machineDirName } from './index.ts'
import { planTidy } from './tidy.ts'
import { type SyncOutcome, type SyncProgress, type SyncPrepared, type SyncDeps, prepareSync, applyPreparedSync } from './sync.ts'
import type { ProgressReporter } from '../../shared/types.ts'
import { type RemoteWriteGate, createRemoteWriteGate } from './remote-write.ts'

/**
 * 自动推送这一轮跑没跑、跑成了什么。
 *
 * 形状刻意分两层：`ran` / `skip` 说"这一轮**动了没有、为什么没动**"，`outcome` 才是真跑之后那份
 * 落地结果（与手动同步同一个形状，界面因此能复用同一套解析）。不把两者揉成一个可选字段，是因为
 * "没跑"有三种完全不同的原因（没开、没到点、上一轮还在跑），界面上那三句话也不一样。
 */
export interface AutoPushOutcome {
  /** 这一轮真的算过 / 推过（false 时看 `skip`）。 */
  ran: boolean
  /** 没跑的原因（机器可读，句子在浏览器半侧）。 */
  skip?: AutoPushSkip
  /** 真跑了的落地结果。 */
  outcome?: SyncOutcome
  /** 真跑的开始与结束时刻（毫秒）；没跑就没有。 */
  startedAt?: number
  finishedAt?: number
  /** 已经连续失败几次（跑成功清零）。界面据此在连续失败时说一句。 */
  failures: number
  /** 最近一次失败的原话（跑成功时清空）。 */
  problem?: string
}

/** 自动推送"现在在跑的那一轮"：开始时刻与最后一条进度（还没报过就是 null）。 */
export interface AutoPushRunning {
  startedAt: number
  progress: SyncProgress | null
}

/** `AutoPushTimer.status()` 的回答：跑着的那一轮（没有就是 null）与上一轮的结论。 */
export interface AutoPushStatus {
  running: AutoPushRunning | null
  last: AutoPushOutcome | undefined
}

/**
 * 自动推送那一轮的进展：一条条进度，跑完一条结论。
 *
 * 订阅者是面板那条唯一的长连接（`GET /panel/events`，见 `src/web.ts`）。事件里带的是原始形状
 * （`SyncProgress` / `AutoPushOutcome`），怎么摊平由收的那一侧决定。
 */
export type AutoPushEvent =
  | { type: 'progress'; progress: SyncProgress }
  | { type: 'done'; outcome: AutoPushOutcome }

/**
 * 会话事件的安静窗口（毫秒）：末尾那个会话事件之后安静满这么久，才推一轮。5 分钟。
 *
 * 它既是"攒连发"也是"等人停手"：一轮对话不是只发一次事件（`turn/start`、`step/end`、工具派发、
 * `turn/end`、goal 自动续轮、子智能体起停都会各发一次），用户连着问更是连着来。每个事件都只做一件事
 * ——**把计时重置**。
 *
 * 为什么是 5 分钟而不是十几秒：一轮整库推送在这台机器的真实库上实测要 **20～90 秒**（1024 条会话 /
 * 670 MB，其中上行几十 MB），而"写完一轮 10 秒后就推"会把这段重活儿插在用户下一次说话中间。取 5 分钟
 * 是"用户多半已经转头去干别的"的量级；代价是最后一轮之后最多晚 5 分钟才上云。依据见
 * [让自动推送等安静之后再跑](../../../.agents/notes/implemented/bug-fix/2026-10-22-auto-push-waits-for-quiet.md)。
 *
 * 落盘不靠这个窗口等：宿主侧在调 `touched()` 之前已经 `await sessions.flush(session)` 过了（见
 * `src/tools.ts` 的 `attachAutoPushToSessions()`），窗口纯粹是"别在人还在的时候抢资源"。
 */
export const AUTO_PUSH_QUIET_MS = 300_000

/**
 * 自动推送没跑的原因。
 *
 * - `disabled`：这个宿主/profile 没开自动推送（配置里 `sync.autoPush` 不是 true）；
 * - `busy`：上一轮还在跑（网络慢、条数多），这一轮直接让开——不排队：排队会让积压的轮次一个接一个
 *   跑完，而每一轮读的都是同一份"最新"，重复跑没有意义；
 * - `idle`：有得算但一条都不用推，而且连要撤下的空白会话都没有——这一轮连收尾都不必做。
 *
 * **没有"正在攒连发"这个码**：空闲窗口只**推迟**推送，不会让任何一次询问得到"没跑"——`touched()` 与
 * 界面那枚「立即推送一次」都是"现在就跑"，窗口里照样当场推。所以"在攒"不是一种 `skip`（那是"这次
 * 没跑"的原因），它只是"还没到"。给一个没有消费者的码会有害：它会看起来像一套不存在的机制
 * （同一类问题见 [自动推送那篇](../../../.agents/notes/implemented/feature/2026-10-14-auto-push-is-push-only.md)
 * 里记的那个没有消费者的 `minIntervalMs`）。
 */
export type AutoPushSkip = 'disabled' | 'busy' | 'idle'

/**
 * 调度器的配置读法：每次都现读一眼（`sync` 那一节是活引用，改完不必重启）。
 *
 * 只剩"开不开"：什么时候跑由事件决定（本机写完一轮），没有"隔多久跑一次"这回事了。
 */
export interface AutoPushClock {
  /** 自动推送此刻开着吗。 */
  enabled(): boolean
}

/** `createAutoPushTimer()` 的依赖。 */
export interface AutoPushTimerDeps {
  /**
   * 跑一轮（`runAutoPush()` 的真身由调用方注入；测试注入一个记账的假实现）。
   */
  run: (options?: { onProgress?: ProgressReporter }) => Promise<AutoPushOutcome>
  /** 当前配置（活引用现读）。 */
  clock: AutoPushClock
  now?: () => number
  /** 定时器工厂；缺省用全局的 `setTimeout` / `clearTimeout`（测试注入假的，不必真等）。 */
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /**
   * 写远端格子的互斥锁（与界面端点、工具共用同一把）。
   *
   * 缺省自己造一把：只测调度器时够用；生产由 `src/index.ts` 造一份交给所有入口。
   */
  remoteWrite?: RemoteWriteGate
}

/** 自动推送调度器的对外形状。 */
export interface AutoPushTimer {
  /** 自动推送此刻开着吗。 */
  enabled(): boolean
  /**
   * 当场跑一轮。
   *
   * 两条来路都走它：本机写完一轮（空闲窗口到点，见 `touched()`）与界面那枚「立即推送一次」。
   */
  tick(options?: { onProgress?: ProgressReporter }): Promise<AutoPushOutcome>
  /**
   * 又有会话活动了——起（或续）一个安静窗口，安静 {@link AUTO_PUSH_QUIET_MS} 毫秒之后推一轮。
   *
   * 由宿主侧在**每一个**会话事件之后调（见 `src/tools.ts` 的 `attachAutoPushToSessions()`：`turn/end`
   * 那一次是在 `await sessions.flush(session)` 之后调的，其余事件只算"还在活动"）。窗口内再来事件就
   * 把计时**重置**，所以一整段连着写的时间里一次都不推。
   *
   * 关着的时候什么都不做：不排队、不记账——打开之后写的下一轮会照常触发，没有"欠着一次"这回事。
   */
  touched(): void
  /** 最近一次结论（不碰网络）。 */
  last(): { enabled: boolean; outcome?: AutoPushOutcome }
  /**
   * 这一轮**现在**跑到哪了。
   *
   * 与 `last()` 分开：`last()` 说的是"上一轮结论"，这一份说的是"正跑着的那一轮到了第几条"——界面
   * 进入同步页时拿它接上进度条，而不是让用户只看到一句"上一轮还在跑"（见 `AutoPushRunning`）。
   */
  status(): AutoPushStatus
  /**
   * 订阅"之后的进展"（进度一条条、跑完一条结论）。
   *
   * 只推**订阅之后**发生的事：刚连上来那一轮现在跑到哪，先由 `status()` 说一次（见
   * `GET /panel/events` 开头那条 `auto-push` 事件）。
   *
   * @param listener 收到事件时调一次。
   * @returns 退订函数（连接断了/组件卸了就得调，不然事件一直往死连接上写）。
   */
  subscribe(listener: (event: AutoPushEvent) => void): () => void
  /** 这一次跑完了/已经知道了的结论（`tick()` 自己调，也供外部记一笔）。 */
  note(outcome: AutoPushOutcome): void
  /** 停掉（卸载时）：不再起新的空闲窗口；`tick()` 仍可用（界面那枚按钮不依赖它）。 */
  stop(): void
}

/**
 * 造一个自动推送的调度器。
 *
 * 它只干一件事：收到"本机写完一轮"之后起一个空闲窗口，空下来就推一轮（见 `touched()`）。**没有
 * 周期唤醒**——什么时候推完全由事件决定（见
 * [只在写完一轮之后推](../../../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)）。
 *
 * 要守的只有两件：同一时间只跑一轮（`busy`），以及跑着的时候又来了事件就记一笔、跑完补一次
 * （`settleAgain`）。两份状态都留在这个闭包里，所以它**每个宿主只造一个**。
 *
 * @param deps 跑一轮的动作、配置读法与定时器工厂。
 * @returns 调度器；关着的时候不挂任何定时器，但仍可 `tick()`。
 */
export function createAutoPushTimer(deps: AutoPushTimerDeps): AutoPushTimer {
  const now = deps.now ?? ((): number => Date.now())
  const setTimer = deps.setTimer ?? ((handler: () => void, ms: number): unknown => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout))
  let stopped = false
  /** 正在跑（`busy` 那条判据）：一次只允许一轮，且**由调度器**把关，不指望 `run()` 自己重入安全。 */
  let running: Promise<AutoPushOutcome> | undefined
  let lastOutcome: AutoPushOutcome | undefined
  /** 空闲窗口那个计时器（见 `touched()`）。 */
  let settleHandle: unknown
  /** 上一轮还在跑的时候又来事件：记下来，跑完立刻补一次（不丢用户的这一轮）。 */
  let settleAgain = false
  /**
   * 正跑着的那一轮（`undefined` = 没有）。
   *
   * 为什么由调度器记：一轮可能由两条路发起（本机写完一轮、界面那枚「立即推送一次」），而界面要知道的
   * 是"**不管谁发起的**，现在这一轮跑到哪了"。进度回调在这里包一层，谁发起都记得下。
   */
  let runningState: AutoPushRunning | undefined
  /** 正在听进展的人（界面那条长连接；没人听时是个空集合，广播什么都不做）。 */
  const listeners = new Set<(event: AutoPushEvent) => void>()
  /** 把一条事件发给所有订阅者；订阅者自己的异常吞掉——一个连接坏了不该让这一轮推送失败。 */
  const broadcast = (event: AutoPushEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // 谁坏了就少收一条；退订由它自己的连接负责。
      }
    }
  }

  const note = (outcome: AutoPushOutcome): void => {
    lastOutcome = outcome
  }
  /** 写自己那一格的闸；与手动同步、整理、删除远端、模型工具共用同一把（生产由入口注入）。 */
  const gate = deps.remoteWrite ?? createRemoteWriteGate(now)

  const tick = async (options: { onProgress?: ProgressReporter } = {}): Promise<AutoPushOutcome> => {
    /*
     * 上一轮还在跑：这一轮让开。
     *
     * 报的是**上一轮**那份结论（`lastOutcome`）：`busy` 说的是"这一次请求没被受理"，不是"同步失败了"——
     * 造一条合成的结论会把上一轮真跑出来的结果盖掉，界面上就只剩一句"刚才在忙"。
     */
    if (running !== undefined) return { ran: false, skip: 'busy', failures: failuresOf(lastOutcome) }
    if (!deps.clock.enabled()) return { ran: false, skip: 'disabled', failures: failuresOf(lastOutcome) }
    /*
     * 别的入口正在写远端（手动同步落地、整理、删除远端、工具）：这一轮直接跳过，不排队。排队会让它
     * 拿着读于排队之前的快照去写，反而更容易盖掉别人刚写进去的东西；下一轮安静窗口会自己再来。
     */
    const release = gate.tryAcquire('自动推送')
    if (release === undefined) return { ran: false, skip: 'busy', failures: failuresOf(lastOutcome) }
    const pending = (async (): Promise<AutoPushOutcome> => {
      const startedAt = now()
      runningState = { startedAt, progress: null }
      const outcome = await deps.run({
        // 谁要看这条流都行：调用方给的那一份照旧收到，同时记进 `runningState` 供界面读。
        onProgress: (progress: SyncProgress): void => {
          if (runningState !== undefined) runningState.progress = progress
          options.onProgress?.(progress)
          broadcast({ type: 'progress', progress })
        },
      })
      // `run()` 自己会带 `failures` 与 `problem`（它知道这一轮是失败还是空跑）；这里只补时刻。
      const stamped: AutoPushOutcome = { ...outcome, ...(outcome.ran ? { startedAt, finishedAt: now() } : {}) }
      note(stamped)
      broadcast({ type: 'done', outcome: stamped })
      return stamped
    })()
    running = pending
    try {
      return await pending
    } finally {
      release()
      running = undefined
      runningState = undefined
      // 跑着的时候又来事件：这一轮读的是它开始之前的快照，那一轮得再补一次。
      if (settleAgain) {
        settleAgain = false
        touched()
      }
    }
  }

  /**
   * 又有会话活动了：重置安静窗口。
   *
   * 攒连发与"等人停手"的全部实现就是"重置计时"这一句——每来一个事件，旧的计时器被清掉、重新起一个，
   * 于是"末尾那个事件之后安静满 {@link AUTO_PUSH_QUIET_MS}"才会真跑。所以用户连着问、或者子智能体
   * 还在跑，都推不动它。
   *
   * 正在跑时不重置、也不排队，只记一个"跑完补一次"：这一轮读的快照里没有刚写完的那一笔，直接丢掉
   * 会让用户觉得"我写完了它没推"。
   */
  const touched = (): void => {
    if (stopped || !deps.clock.enabled()) return
    if (running !== undefined) {
      settleAgain = true
      return
    }
    if (settleHandle !== undefined) clearTimer(settleHandle)
    settleHandle = setTimer(() => {
      settleHandle = undefined
      void tick()
    }, Math.max(1, AUTO_PUSH_QUIET_MS))
  }

  return {
    enabled: () => deps.clock.enabled(),
    tick: (options = {}) => tick(options),
    touched,
    last() {
      return {
        enabled: deps.clock.enabled(),
        ...(lastOutcome === undefined ? {} : { outcome: lastOutcome }),
      }
    },
    status() {
      return {
        running:
          runningState === undefined ? null : { startedAt: runningState.startedAt, progress: runningState.progress },
        last: lastOutcome,
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    note,
    stop() {
      stopped = true
      if (settleHandle !== undefined) {
        clearTimer(settleHandle)
        settleHandle = undefined
      }
    },
  }
}

/** 一条结论里记着的连续失败次数（没有结论时是 0）。 */
function failuresOf(outcome: AutoPushOutcome | undefined): number {
  return outcome?.failures ?? 0
}

/**
 * 跑一轮自动推送：**只推不拉**。
 *
 * 与手动同步那条路（`runSync()` / `prepareSync()` + `syncPrepared()`）的三处不同，每一处都是
 * "无人在场"推出来的：
 *
 *   1. **只推不拉**（`pushOnly`）：计划里没有拉取、没有"覆盖本机"，所以这一轮**永远不改本机任何
 *      会话**。这不是省钱，是安全边界——覆盖本机那份要动本机已有内容，界面上那道动作前面挡着一个
 *      确认弹窗，后台不该绕过它。也正因为没有落地那一段，这一轮不必问宿主"这条还活着吗"、不必
 *      备份、不写注册表、不请宿主重折投影检查点：那几件事全都挂在"真有东西落到本机"那条路上。
 *   2. **没有预演与确认**：一次调用算完就落地（`runSync()` 那条单次调用路），而**不是**
 *      `syncPrepared()`——那个是"照着用户确认过的那份计划落地"，后台没有用户确认过的东西。
 *   3. **没得推也要收尾一次**：本机删掉的会话得从**自己那一格的索引**里消失，而今天那一步只在
 *      `applyPreparedSync()` 里（且总是会走到）。所以"计划里一条都不推"时仍要走一次落地——一份空的
 *      计划，落下去只会重写索引。不这么做的话，删掉的会话会永远留在自己的格子索引里，别的机器照着
 *      它去取包时取到一个不存在的对象。
 *
 * 没有速度闸：两条来路（写完一轮、用户手点一次）都是"现在就该跑"，而"隔多久跑一次"这个旋钮已经跟着
 * 兜底定时器一起删掉了（见
 * [只在写完一轮之后推](../../../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)）。
 *
 * @param deps 远端、设置与本地库的位置；`settings.autoPush` 说这次开没开。
 * @param options.failures 这一层维护的连续失败计数（成功清零）。
 * @param options.onProgress 每开始处理一条调一次（与手动那条路同一套事件）。
 * @returns 这一轮的结论；**不抛**——后台任务抛出去没人接，失败进 `failures` 与 `problem`。
 */
/**
 * 本机那格的索引里是不是还留着眼下**已经没有**的会话（见 `runAutoPush()` 的 `idle` 判据）。
 *
 * 判据是集合包含：索引里记着的每个 id 都得在本机现在的库里。本机删掉一条会话之后那个 id 就不在了，
 * 于是这一项为真——值得走一趟落地把索引刷新掉。反过来"本机新加了一条"不算（那时 `pushIds` 里有它，
 * 走不到这个判据）。
 *
 * 只看**自己那一格**：别的机器的格子由它们自己维护，那些记录本来就不该由这里撤。
 *
 * @param prepared 这一轮算出来的数据（`remote.indexes` 是读回来的各机器索引）。
 * @param machineId 这台机器的标识（它那一格的目录名按 `machineDirName()` 折算）。
 * @returns 索引里有本机已经没有的会话时为 true。
 */
function indexNeedsSettling(prepared: SyncPrepared, machineId: string): boolean {
  const own = prepared.remote.indexes.get(machineDirName(machineId))
  if (own === undefined) return false
  const present = new Set(prepared.local.map((session) => session.id))
  return own.entries.some((entry) => !present.has(entry.id))
}

export async function runAutoPush(
  deps: SyncDeps,
  options: {
    failures?: number
    now?: () => number
    onProgress?: ProgressReporter
  } = {},
): Promise<AutoPushOutcome> {
  const now = options.now ?? ((): number => Date.now())
  const failures = options.failures ?? 0
  const config = deps.settings.autoPush
  if (config === undefined || !config.enabled) return { ran: false, skip: 'disabled', failures }
  /*
   * 两档在这一处分岔，其余完全相同（同一个 quiet 窗口、同一套进度、同一份 `AutoPushOutcome`）：
   *
   * - `push`：只推。`pushOnly` 让计划里没有拉取那半，于是这一轮**永远不改本机任何会话**；
   * - `sync`：双向 + 收尾整理自己那一格（只删重复与被取代的包，孤儿包留着）。这一档会动本机：远端
   *   更新时先备份、再顶掉本机那份，正在本机开着的会话仍被跳过——所以它要求用户在设置里明确选了
   *   "双向"才可能发生（见 [那篇决策](../../../.agents/notes/implemented/feature/2026-11-13-auto-sync-runs-both-ways.md)）。
   */
  const mode = config.mode
  const startedAt = now()
  /*
   * 三个条件都成立才是"真的没事干"（`idle`），此时连落地都不走：索引里要写的东西与远端那份逐字节
   * 相同，再 PUT 一次只是白跑一趟网络。三条各自挡一种"看着没事、其实要收尾"的情形：
   *
   *   1. `pushIds` 非空 → 有会话要推；
   *   2. `blank` 非空 → 那几条空白会话要从**远端那份索引**里撤下来（它们本机不上传）；
   *   3. `indexNeedsSettling()` → 本机**删掉**的会话还挂在自己那格索引里。它们不在这一轮的
   *      `plan.local` 里，所以推送表里连 `identical` 行都没有——只看前两条会整类漏掉，而被删的会话
   *      留在索引里，别的机器就会照着它去取一个不存在的包。
   */
  try {
    const roundDeps: SyncDeps =
      mode === 'push'
        ? { ...deps, pushOnly: true, progressWhat: deps.progressWhat ?? 'auto-push' }
        : { ...deps, progressWhat: deps.progressWhat ?? 'auto-push' }
    const prepared = await prepareSync(roundDeps, {
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(mode === 'push' ? { pushOnly: true } : {}),
    })
    /*
     * "真的没事干"要连**整理**一起算：双向那一档即使一条都不用搬，自己那一格里可能躺着几份重复的包，
     * 那一趟仍然值得跑（否则那些包永远没人清）。只推那一档没有整理，条件与原来一样。
     */
    const tidyPlan = mode === 'sync' ? planTidy(prepared.remote, deps.settings.machineId) : undefined
    const idle =
      prepared.plan.pushIds.length === 0 &&
      prepared.plan.blank.length === 0 &&
      (mode === 'push' || prepared.plan.pullIds.length === 0) &&
      !indexNeedsSettling(prepared, deps.settings.machineId) &&
      (tidyPlan === undefined || tidyPlan.entries.length === 0)
    if (idle) {
      const finishedAt = now()
      return { ran: true, skip: 'idle', startedAt, finishedAt, failures }
    }
    const outcome = await applyPreparedSync(roundDeps, prepared, {
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(mode === 'sync' ? { tidy: true, tidyOrphans: false } : {}),
    })
    const finishedAt = now()
    const failed = outcome.problems.length > 0
    return {
      ran: true,
      outcome,
      startedAt,
      finishedAt,
      failures: failed ? failures + 1 : 0,
      ...(failed ? { problem: outcome.problems[0] as string } : {}),
    }
  } catch (error) {
    return {
      ran: false,
      failures: failures + 1,
      problem: error instanceof Error ? error.message : String(error),
    }
  }
}
