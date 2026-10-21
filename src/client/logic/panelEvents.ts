/**
 * 「会话管理」这一页的唯一一条长连接，以及它上面各种状态的那一份内存。
 *
 * 为什么是**一条**：这一页要盯四件事——整库清单、落地那一趟、自动推送那一轮、以及"库被改过了"。
 * 原先它们各走各的（打开页面两个请求、落地那趟一个状态口子、自动推送一个状态口子加一条流），结果是
 * 四份重连逻辑、四份看门狗，而且**没在听的那些事永远看不到**：定时器发起的一轮、另一个页签点的同步，
 * 页面只能靠"进页面时问一次"去撞。
 *
 * 为什么状态放在模块级：横幅要挂在**页面**这一级（切页签、关掉设置再回来都还在），而这条连接也必须
 * 比任何一个分页活得久——挂进组件里，切个页签就断了，重连一次就得重新扫库。
 *
 * 边界写在明处：
 * - 这里不管"动作的进度"。用户点一次同步 / 迁移 / 导入，那一次请求本身就带着它的进度与结果（它天然
 *   属于那次点击），不需要再从这条流上转一手；这条流只负责**别的页面也能看见**的那部分状态。
 * - 断了不重放事件：重连就是重新连一次，宿主先发 `ready` 与两种后台状态的当下，再发一份新清单。
 *   所以"断了之后缺了哪几条进度"不是问题——清单与状态都是新的。
 *
 * @module dsh-session-manager/client/logic/panelEvents
 */

import {
  openPanelStream,
  type AutoPushRoundStatus,
  type MetaResponse,
  type PanelEvent,
  type ProgressEvent,
  type StateResponse,
  type SyncRoundStatus,
} from '../api.ts'

/** 界面读的那一份状态。只读、每次变化换一个新对象（订阅者据此判"变了没有"）。 */
export interface PanelSnapshot {
  /**
   * 这条连接现在什么样。
   *
   * `connecting` 是"正在连 / 正在重连"，`open` 是"握手过了（收到 `ready`）"，`closed` 是"自己关的
   * （页面走了），不会再连"。
   */
  connection: 'connecting' | 'open' | 'closed'
  /** 宿主事实（`ready` 那一条）。还没到就是 `null`。 */
  meta: MetaResponse | null
  /** 整库清单（`snapshot` 那一条）。还没到就是 `null`。 */
  state: StateResponse | null
  /** 扫库那一段的最后一条进度；清单到了就清成 `null`。 */
  scan: ProgressEvent | null
  /** 落地那一趟现在什么样。 */
  sync: SyncRoundStatus
  /** 自动推送那一轮现在什么样。 */
  autoPush: AutoPushRoundStatus
  /**
   * 收到过一条"库变了"（`stale`）。界面不必读它——重连由这里负责，它只是留个痕，便于测试与排查。
   */
  staleAt: number | null
  /** 这一页要说的最后一条错（连不上、扫库失败）。连上之后清空。 */
  error: string | null
}

/** 造一份 store 时给的依赖（生产上是 `openPanelStream`，测试换成假的）。 */
export interface PanelEventsDeps {
  /** 开一条面板事件流。 */
  open: (onEvent: (event: PanelEvent) => void, onEnd: () => void) => () => void
  /** 重连的退避（毫秒），按次数往后取，取完停在最后一个。缺省与官方那条连接同一套节奏。 */
  retryMs?: readonly number[]
  /** 「库变了」之后隔多久重连（毫秒，缺省 600）：一次落地会连着改好几处，攒一下只重连一次。 */
  staleDelayMs?: number
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** 界面用的那几个口子。 */
export interface PanelEvents {
  /** 现在这一份状态。 */
  snapshot(): PanelSnapshot
  /** 订阅变化（返回退订）。 */
  subscribe(listener: (snapshot: PanelSnapshot) => void): () => void
  /** 连上（已经有连接就什么都不做）。页面挂载时调。 */
  start(): void
  /** 重连一次要一份新清单（手动「刷新」、库变了、一次动作落地之后）。 */
  refresh(): void
  /**
   * 重连一次，并等到**新**清单落地再 resolve（手动「刷新」、一次动作落地之后要接着读新数据时用）。
   *
   * 超时就 resolve（缺省 30 秒）：宿主一直不回来时按钮不能永远转着。
   */
  reload(): Promise<void>
  /** 断开、不再重连（页面卸载时调）。 */
  stop(): void
}

/** 缺省的重连节奏：与官方那条连接同一套（500ms 起，翻倍到 10 秒封顶）。 */
const DEFAULT_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000] as const

/** `reload()` 等新清单的上限（毫秒）：宿主一直不回来时不能让界面的按钮永远转着。 */
const RELOAD_CAP_MS = 30_000

/**
 * 刚重连过多久之内，一条 `stale` 不再引发第二次重连（毫秒）。
 *
 * 一次动作（导入、迁移、回滚、一次落地）既会让发起它的这一页自己 `reload()`，也会在面板流上推一条
 * `stale`。不拦一下就是同一份清单扫两遍——而扫库正是这一页最贵的那一步（实测 468 条 / 232 MB 约
 * 0.2～0.45 秒，冷缓存与大库上几秒）。所以"刚连上过"就当作这条 `stale` 已经被这次重连接住了；
 * 别的页面（它们的上一次重连在很久以前）照旧会重读。
 */
const STALE_AFTER_RECONNECT_MS = 1_500

/**
 * 造一份面板状态的 store。
 *
 * @param deps 开流的办法、重连节奏与定时器（都可注入，便于测试）。
 * @returns store 本体。
 */
export function createPanelEvents(deps: PanelEventsDeps): PanelEvents {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS
  const staleDelayMs = deps.staleDelayMs ?? 600
  const now = deps.now ?? ((): number => Date.now())
  const setTimer = deps.setTimer ?? ((handler: () => void, ms: number): unknown => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const listeners = new Set<(snapshot: PanelSnapshot) => void>()
  let current: PanelSnapshot = {
    connection: 'closed',
    meta: null,
    state: null,
    scan: null,
    sync: { applying: null, last: null },
    autoPush: { running: null, last: null },
    staleAt: null,
    error: null,
  }
  /** 关掉当前那条流（没有就是 `null`）。 */
  let close: (() => void) | null = null
  /** 重连计时器。 */
  let retry: unknown
  /** 「库变了」之后那一次重连的计时器。 */
  let stale: unknown
  /** 连了几次没成：退避取第几档。握手成功就归零。 */
  let attempt = 0
  /** 页面走了（`stop()`）：之后任何"该重连了"的判断都不做。 */
  let stopped = true
  /** 这一次断开是**我们自己关的**（重连 / 刷新）：别当成"断了"去退避重试。 */
  let closing = false
  /** 上一次连上（或重连）的时刻：用来把"刚重连过"与一条迟到的 `stale` 对一下。 */
  let lastConnectAt = Number.NEGATIVE_INFINITY

  const publish = (next: Partial<PanelSnapshot>): void => {
    current = { ...current, ...next }
    for (const listener of listeners) {
      try {
        listener(current)
      } catch {
        // 一个订阅者画崩了不该让别的订阅者收不到。
      }
    }
  }

  const cancelRetry = (): void => {
    if (retry !== undefined) {
      clearTimer(retry)
      retry = undefined
    }
  }

  const cancelStale = (): void => {
    if (stale !== undefined) {
      clearTimer(stale)
      stale = undefined
    }
  }

  /** 关掉当前那条流（不触发重连）。 */
  const closeStream = (): void => {
    const dispose = close
    close = null
    closing = true
    dispose?.()
    closing = false
  }

  /** 排一次重连；`attempt` 决定等多久。 */
  const scheduleRetry = (): void => {
    if (stopped || retry !== undefined) return
    const wait = retryMs[Math.min(attempt, retryMs.length - 1)] ?? 1_000
    attempt += 1
    publish({ connection: 'connecting' })
    retry = setTimer(() => {
      retry = undefined
      connect()
    }, wait)
  }

  const handle = (event: PanelEvent): void => {
    switch (event.type) {
      case 'ready':
        // 握手成功：退避归零、清掉上一次的错。到这里才算"连上了"。
        attempt = 0
        publish({ connection: 'open', meta: event.meta, error: null })
        return
      case 'progress':
        publish({ scan: event.progress })
        return
      case 'snapshot':
        publish({ state: event.state, scan: null })
        return
      case 'sync':
        publish({ sync: { applying: event.applying, last: event.last } })
        return
      case 'auto-push':
        publish({ autoPush: { running: event.running, last: event.last } })
        return
      case 'stale':
        /*
         * 库被改过了（某个动作落地、或一次同步拉取下来）：攒一下再重连，要一份新清单。
         *
         * 为什么重连而不是"再发一个请求读清单"：这一页只有这一条连接，清单就是这条连接发来的那一条
         * ——两条路读同一份数据迟早会分叉（"刷新之后少一条"那类错）。
         */
        publish({ staleAt: now() })
        if (stale === undefined && !stopped) {
          stale = setTimer(() => {
            stale = undefined
            if (stopped) return
            // 刚重连过：这次重连已经把这条 `stale` 要的那份清单拿回来了，不再多扫一遍。
            if (now() - lastConnectAt < STALE_AFTER_RECONNECT_MS) return
            refresh()
          }, staleDelayMs)
        }
        return
      case 'error':
        publish({ error: event.error === '' ? '面板事件流报错' : event.error })
        return
      case 'ping':
        return
    }
  }

  /** 连一次。 */
  const connect = (): void => {
    if (stopped || close !== null) return
    lastConnectAt = now()
    close = deps.open(
      (event) => {
        if (!stopped) handle(event)
      },
      () => {
        if (close === null) return
        close = null
        // 自己关的（重连 / 刷新 / 页面走了）：不是"断了"。
        if (closing || stopped) return
        publish({ connection: 'connecting' })
        scheduleRetry()
      },
    )
  }

  /** 断开再连一次：重连回来第一件事就是宿主发一份新清单。 */
  const refresh = (): void => {
    if (stopped) return
    cancelRetry()
    cancelStale()
    closeStream()
    // 连上之后要重新扫库：旧清单先留着（屏幕上是上一次的内容），`scan` 从下一条进度重新走。
    publish({ connection: 'connecting', scan: null })
    connect()
  }

  /**
   * 重连一次，等**新**的一份清单。
   *
   * "新"按对象身份判：每条 `snapshot` 事件都是 JSON 解出来的新对象，所以只要与订阅那一刻不是同一个
   * （且不是 null），就是这一趟回来的。这样上一次留下的那份清单不会让 `reload()` 立刻 resolve。
   */
  const reload = (): Promise<void> => {
    // 这一页根本没连着（还没 start，或者已经 stop）：没有"新清单"可等，别让调用方吊在那儿。
    if (stopped) return Promise.resolve()
    const before = current.state
    return new Promise<void>((resolve) => {
      let settled = false
      let handle: unknown
      const finish = (): void => {
        if (settled) return
        settled = true
        if (handle !== undefined) clearTimer(handle)
        listeners.delete(check)
        resolve()
      }
      const check = (snapshot: PanelSnapshot): void => {
        if (snapshot.state !== null && snapshot.state !== before) finish()
      }
      listeners.add(check)
      handle = setTimer(finish, RELOAD_CAP_MS)
      refresh()
    })
  }

  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      close = null
      publish({ connection: 'connecting' })
      connect()
    },
    refresh,
    reload,
    stop() {
      stopped = true
      cancelRetry()
      cancelStale()
      closeStream()
      publish({ connection: 'closed', scan: null })
    },
  }
}

/**
 * 生产上那一份：整个页面共用一条连接。
 *
 * 它是模块级的，所以切页签、关掉设置再打开都还是同一条——清单也还在（不必重新扫库）。
 */
export const panelEvents = createPanelEvents({ open: openPanelStream })
