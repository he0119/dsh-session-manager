// 宿主那几件**可选**服务的探测：认形状不认实现，少一件就当"这个宿主没有这套动作"。
//
// 为什么都要走 `ctx.get(name)` 而不是属性访问：Cordis 的 Context 是个 Proxy，服务属性只有在该 fiber 的
// `inject` 里声明过才可读，否则同步抛 `cannot get property "X" without inject`——即使那个服务确实存在。
// 可选服务（声明了就会把插件变成硬依赖）因此只能这样读，缺席即 `undefined`。
//
// 这一层零 DSH 依赖：只把宿主对象收成 ports.ts / take-effect.ts / retitle.ts / remove.ts 认的形状。
//
// @module dsh-session-manager/shared/host/ports
import type { AttachmentPort } from '../attachments.ts'
import type {
  CheckpointWarmPort,
  EffectMode,
  HostRegistryPort,
  RetitleOutcome,
  TitleRefreshOptions,
  TitleRefreshPort,
} from '../types.ts'

/**
 * 探测一个**可选**宿主服务。
 *
 * 必须走 `ctx.get(name)`，**不能**写 `ctx.someService`：Cordis 的 Context 是个 Proxy，服务属性只有
 * 在该 fiber 的 `inject` 里声明过才可读，否则同步抛 `cannot get property "X" without inject`——
 * **即使那个服务确实存在**。可选服务（声明了就会把插件变成硬依赖）因此只能这样读，缺席即
 * `undefined`。
 *
 * 纯对象假 ctx 上两种写法都"能跑"：根 context（fiber 没有 runtime）走的是非严格路径。这条差异
 * 正是本插件曾经在真实 profile 里整个起不来的原因，`test/artifact.test.mjs` 与
 * `test/tools.test.ts` 现在都在真实 fiber 上跑，就是为了让这类错误在测试里就暴露。
 *
 * @param ctx - 宿主上下文（形状未知时按"没有这个服务"处理）。
 * @param name - 服务名。
 * @returns 服务实例，或 undefined。
 */
export function optionalService(ctx: unknown, name: string): unknown {
  const get = (ctx as { get?: (serviceName: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name)
  } catch {
    // 读服务本身失败（旧版 cordis 没有 get、或服务提供方装配中）：按"没有"处理，
    // 这个探测只用来决定"何时生效"的措辞，不该让它把工具调用整个打挂。
    return undefined
  }
}

/**
 * 迁移何时生效：这个宿主能不能当场把注册表改掉。
 *
 * 能（`hostRegistryPort()` 拿得到宿主那套动作）就报 `immediate`——插件把活儿交给宿主自己做；
 * 不能就如实报 `restart-required`，由调用方告诉用户重启。
 * @param ctx 宿主上下文。
 * @returns 生效模式。
 */
export function effectMode(ctx: unknown): EffectMode {
  return hostRegistryPort(ctx) === undefined ? 'restart-required' : 'immediate'
}

/** 宿主的"一个工作区"：只声明我们用得到的那几件。 */
interface HostWorkspaceEntity {
  id: string
  sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
  insertSessionBefore(sessionId: string, beforeSessionId?: string): Promise<unknown>
  detachSession(sessionId: string): Promise<void>
}

/**
 * 宿主的 `workspaceRegistry`：只声明我们用得到的那几件。
 *
 * `replaceHeaderIndex` / `indexLiveSessions` 在宿主的类型面里标着 `private`——那只是它对外不给用的
 * 说法，运行期就是普通原型方法。插件用它们做的正是宿主自己 `[Service.init]()` 在"表里已经有工作区"
 * 时做的那两步：按磁盘重建 header 缓存，再把活着的会话补进索引。
 */
interface HostWorkspaceService {
  create(path: string, title?: string): Promise<{ id: string }>
  get(id: string): unknown
  delete(id: string): Promise<boolean>
  replaceHeaderIndex(headers: readonly unknown[]): Promise<void>
  indexLiveSessions(): Promise<void>
}

/** 宿主的 `sessionPersistence`：只要"现在磁盘上有哪些会话、各自的 header 是什么"。 */
interface HostSessionPersistence {
  list(): Promise<Array<{ header: unknown }>>
}

/**
 * 探测宿主那套"改注册表"的动作，收成一个端口交给核心层。
 *
 * 为什么不自己写文件：宿主内存里那份注册表才是权威（单单元契约：写入才改它，绝不从磁盘重读），
 * 文件改完它不认——侧边栏还是旧归属，之后任何一次工作区改动还会把这次写盘盖掉。宿主那套动作
 * （复用/新建工作区、挂会话、摘会话、删工作区）自己会落盘、也会通知界面，交给它做最省事也最稳。
 *
 * 认形状不认实现：少一件就当"这个宿主没有这套动作"，绝不半套上场。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有这套动作时 undefined。
 */
export function hostRegistryPort(ctx: unknown): HostRegistryPort | undefined {
  const registry = optionalService(ctx, 'workspaceRegistry') as Partial<HostWorkspaceService> | undefined
  const persistence = optionalService(ctx, 'sessionPersistence') as Partial<HostSessionPersistence> | undefined
  if (registry === undefined || persistence === undefined) return undefined
  if (
    typeof registry.create !== 'function' ||
    typeof registry.get !== 'function' ||
    typeof registry.delete !== 'function' ||
    typeof registry.replaceHeaderIndex !== 'function' ||
    typeof registry.indexLiveSessions !== 'function' ||
    typeof persistence.list !== 'function'
  ) {
    return undefined
  }

  const entityOf = (workspaceId: string): HostWorkspaceEntity | undefined => {
    const found = registry.get?.call(registry, workspaceId) as Partial<HostWorkspaceEntity> | undefined
    if (found === undefined || found === null) return undefined
    if (typeof found.attachSession !== 'function' || typeof found.detachSession !== 'function') return undefined
    if (typeof found.insertSessionBefore !== 'function') return undefined
    return found as HostWorkspaceEntity
  }

  const need = (workspaceId: string): HostWorkspaceEntity => {
    const entity = entityOf(workspaceId)
    if (entity === undefined) throw new Error(`宿主里没有工作区 ${workspaceId}`)
    return entity
  }

  return {
    // 跟宿主启动时做的两步一致：先按磁盘重建 header 缓存，再把活着的会话补进索引。
    refreshIndex: async () => {
      const sessions = await persistence.list!.call(persistence)
      await registry.replaceHeaderIndex!.call(registry, sessions.map((s) => s.header))
      await registry.indexLiveSessions!.call(registry)
    },
    ensureWorkspace: async (path, title) => {
      const workspace = (await registry.create!.call(registry, path, title)) as { id: string }
      return workspace.id
    },
    // 挂靠是**前插**，而计划是**追加**：挂完再挪到末尾，顺序才跟预演里看到的一致。
    attachSession: async (workspaceId, sessionId) => {
      const entity = need(workspaceId)
      await entity.attachSession(sessionId)
      await entity.insertSessionBefore(sessionId)
    },
    // 工作区已经不在了也当成功：摘除本来就幂等，真正的一致性由落盘后的复核盯着。
    detachSession: async (workspaceId, sessionId) => {
      await entityOf(workspaceId)?.detachSession(sessionId)
    },
    members: async (workspaceId) => [...(entityOf(workspaceId)?.sessionIds ?? [])],
    removeWorkspace: async (workspaceId) => {
      await registry.delete!.call(registry, workspaceId)
    },
  }
}

/** 宿主的 `sessionQuery`：只要"读一条已存会话的完整日志（不建活会话）"这一件。 */
interface HostSessionQuery {
  readSession(sessionId: string): Promise<{
    session: unknown
    inheritedEventCount: unknown
    events: readonly unknown[]
  }>
}

/** 宿主的 `sessionProjectionCache`：只要"冷读一条并写回检查点"这一件。 */
interface HostProjectionCache {
  coldSnapshot(meta: unknown, inheritedEventCount: unknown, events: readonly unknown[]): unknown
}

/**
 * 探测宿主那套"补齐列表元数据"的服务，收成一个端口交给核心层（见 checkpoint-warm.ts）。
 *
 * 为什么不自己写那份检查点文件：它是折叠的**种子**——`identity`（formatVersion/createdAt/cwd/isSeeded/
 * inheritedEventCount）与每行的 `ver`、`seq` 都归宿主，`ver` 对不上会被它静默丢弃、`seq` 写错会让它跳过
 * 真事件。宿主自己的两个服务正好做这件事：`readSession()` 读完校验，`coldSnapshot()` 折叠并写回。
 *
 * 认形状不认实现：少一件就当"这个宿主没有这套动作"，绝不半套上场。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有这套动作时 undefined。
 */
export function hostCheckpointPort(ctx: unknown): CheckpointWarmPort | undefined {
  const query = optionalService(ctx, 'sessionQuery') as Partial<HostSessionQuery> | undefined
  const cache = optionalService(ctx, 'sessionProjectionCache') as Partial<HostProjectionCache> | undefined
  if (query === undefined || cache === undefined) return undefined
  if (typeof query.readSession !== 'function' || typeof cache.coldSnapshot !== 'function') return undefined

  return {
    warm: async (sessionId) => {
      // 宿主自己那两步：整份日志读完校验（不建活会话）→ 折叠所有投影单元并写回检查点（它自己 fail-soft）。
      const loaded = await query.readSession!.call(query, sessionId)
      cache.coldSnapshot!.call(cache, loaded.session, loaded.inheritedEventCount, loaded.events)
    },
  }
}

/** 宿主的 `sessions` 服务：本端口只用到"取活的 / 准备 / 入册 / 公告"这四件。 */
interface HostSessionStore {
  get(id: string): unknown
  prepare(id: string, options: unknown): unknown
  enter(session: unknown): () => void
  announce(session: unknown): void
}

/** 宿主的 `sessionTitle` 服务：读当前标题 + 显式重算（它只认活会话，见 titleRefreshPort()）。 */
interface HostSessionTitle {
  get(session: unknown): { title?: unknown; source?: { kind?: unknown } } | undefined
  refresh(session: unknown): Promise<{ title?: unknown; source?: { kind?: unknown } } | undefined>
}

/** 临时挂载出来的会话上，端口只要"把从某条开始的事件取出来"这一件（宿主 `Session.snapshotEvents()` 的形状）。 */
interface HostSessionLog {
  snapshotEvents(fromSeq?: number): readonly HostSessionEvent[]
}

/** 事件上端口只认类型名：用来认 `prepare()` 还原时自己补的那条 `session/end-seed`。 */
interface HostSessionEvent {
  type: string
}

/** 宿主的写句柄：追加一段连续事件 + 关掉。 */
interface HostSessionHandle {
  append(events: readonly HostSessionEvent[]): Promise<void>
  close(): Promise<void>
}

/**
 * 宿主的 `sessionPersistence` 的写入口：要"开一个写句柄"，以及句柄上的"追加一段 / 关掉"。
 *
 * 这一件是**必须**的，不是可选：写盘得由这个句柄做。会话自己的 `append()` 只按 id 路由给"已登记写
 * 句柄"的那一条（见 `dsh-session-persistence-jsonl` 的 `install()`：
 * `this.writers.get(session.id)?.enqueueLive(...)`），而路由出去的事件带的是**内存日志里的 seq**。
 * 可是 `prepare()` 还原会话时会自己补一条 `session/end-seed`（见下），内存副本因此比磁盘多一条、
 * 后面每条事件的 seq 都比磁盘游标大 1，路由出去必然被宿主的 `assertContiguous` 挡住
 * （报错原文 `append seq mismatch …: expected N at index 0, got N+1`）。
 *
 * 所以端口不用那条路由，而是自己开句柄、把新产生的那几条**按磁盘游标原样追加**：它们的 seq 正好从
 * 磁盘上的条数开始逐条递增，接得上。宿主自己的 resume 也是这么写构造期那几条的
 * （`dsh-agent-loop` 的 `appendUnstoredSuffix()`——构造期 append 的事件不会经 `session/event` 再发一遍，
 * 必须由句柄写下去）。
 */
interface HostSessionWritePort {
  open(id: string, access: 'write'): Promise<HostSessionHandle>
}

/**
 * 探测宿主"重算一条会话名称"的能力，收成一个端口交给编排层（见 retitle.ts）。
 *
 * 为什么不能只调一次 `sessionTitle.refresh()` 了事：**名称服务只认活会话**
 * （`refresh()` 第一件事就是 `sessions.get(id) !== session` 就抛），而这里是拿整库的 id 逐条重算，
 * 那些会话早就不在宿主内存里了。所以这条端口自己完成一次"临时挂载"：
 *
 *   1. `sessionQuery.readSession()` 把日志整份读完并校验，拿到 header 与全部事件（**不建活会话**，
 *      与 checkpoint-warm 那条路同一个调用）；
 *   2. `sessions.prepare(..., { eventState: 'detached' })` 按宿主自己的重放构造器还原出 Session。
 *      **还原出来的副本可能比磁盘多一条**：`Session.fromRestore` 只要发现 seed 的最后一条不是
 *      `session/end-seed`，构造时就自己补一条，于是后面每条事件的 seq 都比磁盘游标大 1；
 *   3. `sessions.enter()` + `sessions.announce()` —— `enter()` 返回的正是**卸载用的那个 disposer**，
 *      两者是宿主公开成对的挂载原语（`dsh-agent-loop` 的会话创建事务也是这么用的）；
 *   4. `sessionTitle.refresh()` 重算（标题事件进的是内存副本；此时没有写句柄，路由无人接）；
 *   5. 自己 `sessionPersistence.open(id, 'write')` 开句柄，把内存副本里"磁盘上还没有"的那几条
 *      ——从第 2 步补的那条标记开始，seq 正好接上磁盘游标——原样 `append()` 下去，然后关掉；
 *   6. 无论成败，`detach()` 把它摘掉，宿主内存里不留痕迹。
 *
 * 代价是每条会话要整份解一次日志（实测 6MB ≈1.7 秒），所以编排层顺序跑并报进度——**不并发**，那等于
 * 同时挂 N 条会话并发 N 个模型请求。
 *
 * 会话**已经在宿主内存里**（比如用户正开着的这条）时走另一条路：直接用那条活会话重算，不挂不摘、
 * 也不碰写句柄（它归宿主的 agent loop 所有，抢来开第二个会直接抛 AlreadyOwned）。
 *
 * 认形状不认实现：四件里少一件就当"这个宿主没有这套能力"（界面据此禁用按钮并说明原因）。
 *
 * `options.includePinned` 由调用方显式打开时才连 `user` 源（用户改过名 / 脚本或导入写下的）一起重算
 * ——默认跳过，理由见 `TitleRefreshOptions`。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有名称服务 / 读日志 / 持久化里任何一件时 undefined。
 */
export function titleRefreshPort(ctx: unknown): TitleRefreshPort | undefined {
  const store = optionalService(ctx, 'sessions') as Partial<HostSessionStore> | undefined
  const query = optionalService(ctx, 'sessionQuery') as Partial<HostSessionQuery> | undefined
  const titles = optionalService(ctx, 'sessionTitle') as Partial<HostSessionTitle> | undefined
  const persistence = optionalService(ctx, 'sessionPersistence') as Partial<HostSessionWritePort> | undefined
  if (store === undefined || query === undefined || titles === undefined || persistence === undefined) return undefined
  if (
    typeof store.get !== 'function' ||
    typeof store.prepare !== 'function' ||
    typeof store.enter !== 'function' ||
    typeof store.announce !== 'function' ||
    typeof query.readSession !== 'function' ||
    typeof titles.get !== 'function' ||
    typeof titles.refresh !== 'function' ||
    typeof persistence.open !== 'function'
  ) {
    return undefined
  }

  /** 把一份标题快照收成"标题 + 来源种类"两样（缺哪个就是哪个不在）。 */
  const normalize = (
    snapshot: { title?: unknown; source?: { kind?: unknown } } | undefined,
  ): { title?: string; kind?: unknown } => ({
    ...(typeof snapshot?.title === 'string' ? { title: snapshot.title } : {}),
    ...(snapshot?.source === undefined ? {} : { kind: snapshot.source.kind }),
  })

  /** 读一条会话当前的标题快照（活会话与临时挂载的会话同一条路）。 */
  const snapshotOf = (session: unknown): { title?: string; kind?: unknown } =>
    normalize(titles.get!.call(titles, session))

  /**
   * 对一条**活会话**做判定与重算。
   *
   * 判定的顺序是刻意的：先看用户有没有手动改过名（`source.kind === 'user'`）——那种标题是用户的，
   * 一次批量动作不该把它抹掉，所以在**发模型请求之前**就返回（`includePinned` 是给一次性清理留的
   * 显式口子，见 `TitleRefreshOptions`）；再看重算之后标题还在不在（没有用户消息的会话连兜底名称都
   * 没有）、provider 有没有真的接过去（没有 provider 时 `refresh()` 只会把兜底名称原样返回，那不是
   * "算过"）。
   */
  const settle = async (session: unknown, options?: TitleRefreshOptions): Promise<RetitleOutcome> => {
    const before = snapshotOf(session)
    if (before.kind === 'user' && options?.includePinned !== true) {
      return { status: 'skipped', reason: 'pinned' }
    }

    let after: { title?: string; kind?: unknown }
    try {
      // `refresh()` 返回的正是它折叠出的最新快照（没有标题时是 undefined），所以不必再读一次。
      // 对 `user` 源的标题它也是那条**显式重算**的路：宿主把"显式 refresh 覆盖掉钉住的标题"当作
      // unpin 的设计意图（自动修订那条路才会见到 user 源就短路），provider 端也只把 **provider** 源
      // 的旧标题当锚点，所以这里一定会重算出一个新标题。
      after = normalize(await titles.refresh!.call(titles, session))
    } catch (error) {
      // 没有路由不是失败：这条会话从来没有过主模型请求（比如从别的工具导进来的），名称 provider
      // （跟随会话主模型那套）因此无从下手。
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('no logged request route')) return { status: 'skipped', reason: 'no-request-route' }
      throw error
    }

    if (after.title === undefined) return { status: 'skipped', reason: 'no-human-message' }
    if (after.kind !== 'provider') return { status: 'skipped', reason: 'no-title-provider' }
    return before.kind === 'provider' && before.title === after.title
      ? { status: 'unchanged', title: after.title }
      : { status: 'retitled', title: after.title }
  }

  return {
    refresh: async (sessionId, options) => {
      const live = store.get!.call(store, sessionId)
      // 已经在内存里：直接用那条活会话重算，不挂不摘也不碰写句柄（它归宿主自己所有）。
      if (live !== undefined) return settle(live, options)

      const loaded = await query.readSession!.call(query, sessionId)
      const session = store.prepare!.call(store, sessionId, {
        seed: loaded.events,
        meta: loaded.session,
        inheritedEventCount: loaded.inheritedEventCount,
        eventState: 'detached',
      })
      /**
       * 磁盘上已有的条数，也就是写句柄的游标。
       *
       * `prepare()` 可能已经在这之上补了一条 `session/end-seed`（见上），所以"新事件"要从这一条
       * 开始取——它的 seq 正好等于游标，整批写下去才连得上。
       */
      const stored = loaded.events.length

      const detach = store.enter!.call(store, session)
      try {
        store.announce!.call(store, session)
        const outcome = await settle(session, options)

        // 自己开句柄写盘：不用 `sessions.flush()`，那条路按 id 路由出去的事件带的是内存副本里的
        // seq，而内存副本比磁盘多一条，写盘会被宿主的连续性校验挡住（见 `HostSessionWritePort`）。
        const produced = (session as HostSessionLog).snapshotEvents(stored)
        // 头一条就是 `prepare()` 补的那条标记时，它不算"改了东西"：只有它、没有别的新事件时不写，
        // 免得给日志添一条什么都没发生的记号。
        const marker = produced[0]?.type === 'session/end-seed' ? 1 : 0
        if (produced.length > marker) {
          const handle = await persistence.open!.call(persistence, sessionId, 'write')
          try {
            await handle.append(produced)
          } finally {
            // 句柄按 id 独占（第二个 open 会抛 AlreadyOwned），无论追加成败都要还回去。
            await handle.close()
          }
        }
        return outcome
      } finally {
        // 卸载放在最外层：开句柄失败、追加失败、close 失败都不能把它留在宿主内存里。漏一条的后果是
        // 它在会话列表里一直挂着"活动中"、还删不掉（宿主拒绝删除活会话），要到重启宿主才清得掉。
        detach()
      }
    },
  }
}

/**
 * 宿主目录选择器的能力种类。
 *
 * 宿主的 `directoryPicker` 是个"能力位"服务：`capability()` 返回带 `kind` 的对象，
 * `native` 那只提供 `pick()`（在**宿主显示器**上弹系统对话框），`browse` 那只提供
 * `list()`/`createDirectory()`（页面内浏览，路径必须宿主自己够得着）。两者互斥——
 * 拿 `native` 的能力去 `list()` 会被宿主拒绝，反之亦然。
 *
 * 界面因此不能假设"选目录"= 弹对话框：它得先知道这个宿主给的是哪一种，再决定
 * 「浏览…」按钮到底干什么。种类由宿主报给界面（`GET /state` 的 `pickerKind`），
 * 而不是让界面去试错——试探在 `native` 宿主上会真的弹出对话框。
 */
export type PickerKind = 'browse' | 'native' | null

/**
 * 宿主附件服务里我们要的那两件（`ctx.attachments`）。
 *
 * 两个方法都是**纯路径计算**：宿主的文档写着"returns provider-local path without reading the
 * object"，对象不存在也给得出路径。本插件因此既能用它在导出侧定位对象，也能用它在导入侧算出"该往
 * 哪儿写"——不必复刻附件库的目录形状（那是宿主的实现细节，换 provider 就变）。
 */
interface HostAttachmentStore {
  imageHostPath?: (ref: { attachmentId: string }) => string
  fileHostPath?: (ref: { attachmentId: string }) => string
}

/**
 * 探测宿主的附件库，收成一个端口交给核心层（见 attachments.ts）。
 *
 * 认形状不认实现：两件少一件就当"这个宿主没有附件服务"（半套上场只会让图片对象落一半）。缺席时核心
 * 层的行为与升级前完全一致——包只带日志，导入只落日志。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有附件服务时 undefined。
 */
export function attachmentPort(ctx: unknown): AttachmentPort | undefined {
  const store = optionalService(ctx, 'attachments') as HostAttachmentStore | undefined
  const image = store?.imageHostPath
  const file = store?.fileHostPath
  if (typeof image !== 'function' || typeof file !== 'function') return undefined
  return {
    pathOf: (ref) => {
      try {
        // 图片只认 attachmentId（引用里的媒体类型/尺寸是给别的用途的）；**文件还认名字**——宿主把文件
        // 摆在 `files/<sha 前两位>/<sha>/<名字>`，`fileHostPath()` 缺名字直接抛错。
        const wanted: { attachmentId: string; name?: string } = { attachmentId: ref.id }
        if (ref.name !== undefined) wanted.name = ref.name
        return (ref.kind === 'image' ? image : file).call(store, wanted)
      } catch {
        // 形状不认（引用不是内容寻址 id、宿主换了 provider）：这一个对象落不了，由调用方如实报出去。
        return undefined
      }
    },
  }
}

/**
 * 读宿主目录选择器的能力种类。
 * @param ctx - 宿主上下文。
 * @returns `browse` / `native`；没有该服务或形状不认时 `null`（界面据此隐藏选择入口）。
 */
export function directoryPickerKind(ctx: unknown): PickerKind {
  const picker = optionalService(ctx, 'directoryPicker') as
    | { capability?: () => { kind?: unknown } }
    | undefined
  try {
    const kind = picker?.capability?.()?.kind
    return kind === 'browse' || kind === 'native' ? kind : null
  } catch {
    // 能力位还没装配好时会抛：按"没有选择器"处理，界面退回到手输路径。
    return null
  }
}
/**
 * 宿主的归档能力（`ctx.workspaceRegistry` 的 `archiveSession` / `unarchiveSession`）。
 *
 * 单独收成一个端口：归档是**宿主的能力**（它一次做完"落盘 + 改内存 + 广播"，侧边栏即时跟着变），
 * 而本插件的界面层只认形状、不读服务。服务不在（`workspaceRegistry` 挂在 Web profile 上）时
 * 端口为 `undefined`，界面据此禁用按钮并说明原因，而不是绕过宿主去写注册表文件。
 */
export interface RegistryOps {
  archive(sessionId: string): Promise<void>
  unarchive(sessionId: string): Promise<void>
}

/**
 * 探测宿主的归档能力。
 * @param ctx - 宿主上下文。
 * @returns 端口；服务不在或形状不认时 `undefined`。
 */
export function archiveOps(ctx: unknown): RegistryOps | undefined {
  const registry = optionalService(ctx, 'workspaceRegistry') as
    | { archiveSession?: unknown; unarchiveSession?: unknown }
    | undefined
  const archive = registry?.archiveSession
  const unarchive = registry?.unarchiveSession
  if (typeof archive !== 'function' || typeof unarchive !== 'function') return undefined
  return {
    archive: (sessionId) => Promise.resolve((archive as (id: string) => unknown).call(registry, sessionId)).then(() => undefined),
    unarchive: (sessionId) =>
      Promise.resolve((unarchive as (id: string) => unknown).call(registry, sessionId)).then(() => undefined),
  }
}

/**
 * 宿主内存里活着的会话 id（`ctx.sessions.list()`）。
 *
 * 删除会拒掉这些会话：宿主手里还有它们的**内存副本与写句柄**，日志被搬走之后它照样会往里写，
 * 于是磁盘上会出现一条"半条会话"。这与宿主自己拒绝归档一条正在跑的会话是同一件事。
 *
 * @param ctx - 宿主上下文。
 * @returns 活着的会话 id；服务不在或形状不认时是空集（＝判断不了，不是"都不活着"）。
 */
export function liveSessionIds(ctx: unknown): ReadonlySet<string> {
  const store = optionalService(ctx, 'sessions') as { list?: unknown } | undefined
  const list = store?.list
  if (typeof list !== 'function') return new Set<string>()
  try {
    const ids = new Set<string>()
    for (const session of (list as () => unknown[]).call(store) ?? []) {
      const id = (session as { id?: unknown } | null)?.id
      if (typeof id === 'string') ids.add(id)
    }
    return ids
  } catch {
    // 列会话不该把"删除"这条路径整个打挂：判断不了就当空集，预演那边也不会谎称它们一定没在跑。
    return new Set<string>()
  }
}
