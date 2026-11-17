// src/web.ts — 浏览器界面用的宿主路由（插件设置页的数据面）。
//
// 界面在 Web 端，真正的读写必须在宿主进程里做：会话库在磁盘上、注册表由宿主持有内存副本，
// 浏览器那一侧既没有权限也不该有。因此这一层只做三件事——**列**、**迁移**、**传输**——
// 并把每次写入的边界条件（目标目录必须真实存在、包必须自校验通过、冲突只跳过不覆盖、回滚只能
// 回滚自己写下的备份）挡在宿主这一侧，而不是指望界面传对参数。
//
// 编排本身在 `src/operations/migrate/migrate.ts`（工具层与这一层共用一份），本模块只负责 HTTP 形状：
// 读参数、翻译成那边认识的请求、把结果按 JSON 回给界面。
//
// 与 webServer 服务解耦：本模块只要求一个 `{ register(route) }`，测试里用假 req/res 直接打
// handler，不必起 HTTP 服务。路由路径固定在本插件命名空间下，`(kind, path)` 与别的插件不会撞。

import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { migrationHandlers } from './operations/migrate/http.ts'
import { removeHandlers } from './operations/remove/http.ts'
import { retitleHandlers } from './operations/retitle/http.ts'
import { autoPushLastPayload, syncHandlers } from './operations/sync/http.ts'
import { transcriptHandlers } from './operations/transcript/http.ts'
import { transferHandlers } from './operations/transfer/http.ts'
import { accountedOwners } from './shared/accounting.ts'
import type { DiscoveredSession } from './shared/library/discovery.ts'
import type { MigrateDeps } from './operations/migrate/migrate.ts'
import type { AttachmentPort } from './shared/attachments.ts'
import { projectionCacheDir } from './shared/paths.ts'
import { createProjectionReader, type ProjectionCacheQuery, type ProjectionCacheReader } from './shared/library/projection-cache.ts'
import { createScanCache } from './shared/library/scan-cache.ts'
import { createLogTextCache, type LogTextCache } from './shared/log/log-text-cache.ts'
import { effectOf } from './shared/host/take-effect.ts'
import type { RepoLocationLookup } from './shared/repo.ts'
import { createTitleResolver, type TitleQuery } from './shared/log/session-title.ts'
import type { AutoPushTimer, SyncOutcome } from './operations/sync/sync.ts'
import type { SyncInfo, SyncRuntime } from './operations/sync/runtime.ts'
import type { PickerKind, RegistryOps } from './shared/host/ports.ts'
import type { ResolvedPaths } from './shared/plugin-paths.ts'
import type { EffectMode, CheckpointWarmPort, DecodeAll, HostRegistryPort, ProgressReporter, TitleRefreshPort } from './shared/types.ts'
import { lastRunView, type SyncRunRecord } from './operations/sync/sync-state.ts'
import { createRemoteWriteGate, type RemoteWriteGate } from './operations/sync/remote-write.ts'
import { readBody, sendEvent, sendEventStream, sendJson, streamResult } from './shared/http/respond.ts'
import { loadRegistry, summarizeSessions, summarizeWorkspaces } from './shared/http/view.ts'
import { createSessionMetaResolver, type SessionMeta } from './shared/visibility.ts'

/** 本插件占用的路由前缀。 */
export { MAX_BODY_BYTES, readBody } from './shared/http/respond.ts'
export type { Handler } from './shared/http/respond.ts'

/** 本插件占用的路由前缀。 */
export const API_PREFIX = '/dsh-session-manager/api'

/** `webServer.register()` 接受的形状（只取本模块用得到的那部分）。 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** webServer 服务的最小面。 */
export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

/**
 * 端点处理要用的那一组东西：位置、几个口径单一的读取器、宿主能力位与面板广播口。
 *
 * 为什么汇成一个对象：处理逻辑按操作搬到了 `src/operations/<操作>/http.ts`，它们不直接碰
 * `createApiHandlers()` 的闭包——那样只能整段复制；汇成一个只读面之后，各端点拿到的仍是**同一份**
 * 缓存与同一把闸（`scanForAction` 的库缓存、`logs` 的解压缓存、`remoteWrite` 的写锁）。
 */
export interface WebContext {
  deps: ApiDeps
  paths: ResolvedPaths
  decodeAll: DecodeAll
  now: () => Date
  remoteWrite: RemoteWriteGate
  /** 读会话名称（投影缓存优先，缺了退到日志前缀）。 */
  resolveTitle: (query: TitleQuery) => string | undefined
  /** 同一份投影记录里的空白与最后活动时间（同步要的那两枚）。 */
  sessionMeta: (query: ProjectionCacheQuery) => SessionMeta | undefined
  /** 扫库时每条会话读一次的那份投影记录。 */
  projection: ProjectionCacheReader
  /** 按整库动作的扫描（带库指纹缓存，见 scan-cache.ts）。 */
  scanForAction: (options?: { titles?: boolean }) => Promise<DiscoveredSession[]>
  /** 会话内容的分页读取缓存（同一条会话连着读几页只解一次）。 */
  logs: LogTextCache
  liveSessionIds: () => ReadonlySet<string>
  hostRegistry: () => HostRegistryPort | undefined
  hostCheckpoints: () => CheckpointWarmPort | undefined
  attachmentPort: () => AttachmentPort | undefined
  /** 把一条事件广播给所有开着的面板连接（落地那一趟、自动推送、库变了都走它）。 */
  panelEmit: (event: Record<string, unknown>) => void
  /** 迁移编排的依赖（工具层与端点共用同一份形状）。 */
  migrateDeps: MigrateDeps
  /** 这个宿主的生效模式：改完注册表要不要重启。 */
  takesEffect: () => EffectMode
}

/**
 * 界面**先**要的那几项：会话库在哪、宿主有哪些能力位。
 *
 * 不碰会话库就能答出来（`paths` 是配置解析的结果，能力位是宿主服务的探测），所以它跟着 `GET /meta`
 * 单独先回一份；`GET /state` 的响应是它的**超集**（同样这几个字段 + 扫库扫出来的清单）。
 */
interface MetaFacts {
  sessionsRoot: string
  registryPath: string
  pickerKind: PickerKind | null
  archiveAvailable: boolean
  /** 这个宿主能不能重新生成会话名称（`sessionTitle` 在不在，见 ApiDeps.titleRefresh）。 */
  retitleAvailable: boolean
  /**
   * 这个宿主有没有附件库服务（`ctx.attachments`，见 attachmentPort()）。有它的机器手动同步时会顺带
   * 把附件对象对一遍（本机缺的取回、远端缺的补上），界面据此在"没有会话要搬"时补一句——那一趟真正
   * 会做的事不在会话计划里，光看"没有要同步的"会以为确认了也没意义。
   */
  attachments: boolean
  /**
   * 同步那一栏：没配置时是 null；配了的话带上 `lastRun`（上一次手动同步的结论，没有就不带）。
   *
   * 为什么把 `lastRun` 塞进这一栏而不是单开一栏：页头那枚状态读的正是它，两处分的越细，界面越要
   * 记着"这几栏合起来才是同一个东西"。
   */
  sync: (SyncInfo & { lastRun?: SyncRunRecord }) | null
}

/** 依赖（都可注入，便于测试）。 */
export interface ApiDeps {
  paths: ResolvedPaths
  /**
   * 上一次手动同步的记录（读 / 写）。由入口注入：文件位置属于 `$DSH_HOME`，本模块不解析家目录。
   *
   * 缺席 = 不记也不报（测试与纯工具前端就是这样），页头那枚同步状态于是只说"配没配"。
   */
  syncRun?: {
    read: () => SyncRunRecord | undefined
    write: (run: SyncRunRecord) => void
  }
  decodeAll: DecodeAll
  /** 生成清单时间戳与文件名，便于测试注入。 */
  now?: () => Date
  /** 插件版本，写进包的来源信息。 */
  pluginVersion?: string
  /**
   * 写远端格子的互斥锁（手动同步落地、整理远端、删除远端共用）。
   *
   * 由入口注入，与自动推送、模型工具共用同一把；缺席时本模块自己造一把，只够覆盖本端口里的三处。
   */
  remoteWrite?: RemoteWriteGate
  /**
   * 宿主注册表动作的探测（`immediate` 还是 `restart-required` 由它推出来）。
   *
   * 由入口注入而不是在这里探测：那要读宿主服务，属于 DSH 边界（`src/index.ts`），
   * 本模块只认 `{ register() }` 形状，不该知道 Cordis 的存在。
   *
   * 生效模式**不单独注入**：界面能说的"无需重启"必须与执行路径真能做到的事一致，所以两者
   * 同源——拿不到这个端口就是"需要重启"。
   */
  hostRegistry?: () => HostRegistryPort | undefined
  /**
   * 宿主"补齐列表元数据"的端口（`sessionQuery` + `sessionProjectionCache`，见 checkpoint-warm.ts）。
   *
   * 同 `hostRegistry`：要读宿主服务，所以由入口探测后注入；缺席 = 这个宿主补不了，落地照旧成功，
   * 只是那些会话在侧边栏要等第一次点开才有标题。
   */
  hostCheckpoints?: () => CheckpointWarmPort | undefined
  /**
   * 宿主的附件库端口（`ctx.attachments` 的两个 host-path 方法，见 attachments.ts 与 tools.ts 的
   * `attachmentPort()`）。
   *
   * 同 `hostRegistry`：要读宿主服务，所以由入口探测后注入。缺席 = 这个宿主没有附件服务，导出照旧
   * 只带日志、导入照旧只落日志（与升级前一致），界面上那两处附件条数就不出现。
   */
  attachments?: () => AttachmentPort | undefined
  /**
   * 宿主目录选择器的能力种类（`browse` / `native` / `null`）。
   *
   * 同 `effectMode`：要读宿主服务，所以由入口探测后注入。界面拿它决定目录字段上的
   * 「浏览…」是开页面内浏览器还是弹宿主的系统对话框；`null` 时那个按钮根本不出现。
   */
  pickerKind?: () => PickerKind
  /**
   * 读会话名称（界面要显示的东西，见 session-title.ts）。
   *
   * 缺省按 `paths.registryPath` 反推宿主的投影缓存目录、缓存没有就折日志开头的有界前缀；
   * 这里留出口子是为了测试能钉住"标题坏了也不影响列出会话"这条边界。
   */
  resolveTitle?: (query: TitleQuery) => string | undefined
  /**
   * 读"宿主判这条会话空白吗"（见 visibility.ts）。
   *
   * 同 `resolveTitle`：缺省按 `paths.registryPath` 反推投影缓存目录。界面上的「管理」页据此把
   * 空白会话标出来，迁移页据此把它们排除在候选之外。
   */
  resolveBlank?: (query: { id: string; createdAt: number; cwd?: string }) => boolean | undefined
  /**
   * 读同一条缓存记录里的空白与最后活动时间（见 visibility.ts 的 `SessionMeta`）。
   *
   * 与 `resolveBlank` 分开是因为问的不是同一件事：那一条问"侧边栏显示不显示"，这一条问"同步时这条
   * 要不要搬运、两边各自写过时谁更新"。缺省同样按 `paths.registryPath` 反推投影缓存目录。
   */
  sessionMeta?: (query: { id: string; createdAt: number; cwd?: string }) => SessionMeta | undefined
  /**
   * 扫库时每条会话读一次的投影记录（见 projection-cache.ts）。
   *
   * 给了它，标题、空白判据与同步要的两枚活动时间就那么一次读出齐——同一个文件因此不会每条会话读两遍
   * （本机 994 条实测一趟 680～770 ms）。缺省按 `paths.registryPath` 反推宿主投影缓存目录。
   */
  projection?: ProjectionCacheReader
  /**
   * 宿主内存里活着的会话 id（`ctx.sessions.list()`，见 src/index.ts）。
   *
   * 删除会拒掉这些：宿主手里有内存副本与写句柄，日志被搬走后它还会继续写。缺席 = 判断不了。
   */
  liveSessionIds?: () => ReadonlySet<string>
  /** 宿主的归档能力；缺席 = 这个宿主改不了归档（界面据此禁用那两个按钮）。 */
  registryOps?: () => RegistryOps | undefined
  /**
   * 宿主"重算一条会话名称"的能力（`sessions` + `sessionQuery` + `sessionTitle` + `sessionPersistence`，
   * 见 tools.ts 的 `titleRefreshPort()`）。
   *
   * 同 `registryOps`：缺席 = 这个宿主算不了标题（没有名称服务，或者不是 Web profile），界面据此禁用
   * 「重新生成名称」并说明原因，而不是让按钮点下去之后报一个从服务里抛出来的错。
   */
  titleRefresh?: () => TitleRefreshPort | undefined
  /**
   * 目录 → 项目身份的缓存（见 repo.ts 的 `createRepoLocationCache()`）。
   *
   * 由入口注入：`/state` 与同步共用同一份，一次同步计划因此不必为每个候选目录重新起三个 git 进程。
   * 缺席 = 每次预演现问一遍 git（结论不变，只是慢）。
   */
  repoLocations?: RepoLocationLookup
  /**
   * 造一次 WebDAV 同步的运行时（远端 + 设置）；没配置同步时返回 undefined。
   *
   * 每次调用都重新解析密码引用：DSH 的口径是"每次操作解析一次引用"，换了环境变量不必重启插件。
   * 要读宿主服务（credentials），所以同 `effectMode` 一样由入口注入。
   */
  sync?: () => Promise<SyncRuntime | undefined>
  /**
   * 同步配置里的非敏感字段（界面用来显示"同步到哪儿、这台机器叫什么"）。
   *
   * 与 `sync` 分开：`/state` 每帧都要看它一眼，而 `sync()` 会去解析凭据引用（还可能发网络请求前的
   * 准备工作），不该被列一次会话就触发。
   */
  syncInfo?: () => SyncInfo | undefined
  /**
   * 自动推送的调度器（`src/index.ts` 造一个挂在插件生命周期上，见那里的说明）。
   *
   * 一个 thunk 而不是调度器本身：它得先解析配置与凭据（异步），而 `apply()` 必须保持同步。返回的
   * promise 在这些情形下解出 `undefined`——这个 profile 没配 `sync.url`、或者造的时候出错了——界面
   * 据此说明"这个宿主没有自动推送"，而不是点一个没反应的按钮。
   */
  autoPush?: () => Promise<AutoPushTimer | undefined>
  /**
   * 认一批目录的项目身份（git remote，见 repo.ts）——界面据此把"本机路径"那一格换成`host/owner/repo`。
   *
   * 要跑 git，所以由入口注入（`src/index.ts` 造一份带缓存的实现，一个插件实例只问每个目录一次）。
   * 缺省不认：没有这个入口的宿主（测试、没装 git 的机器）界面照旧显示路径。
   */
  repos?: (dirs: readonly string[]) => Promise<ReadonlyMap<string, string>>
}

/** 界面要展示的一条会话。 */

/** "写远端那把锁被谁拿着"的一句话；没人拿着时给一句通用的。 */

/**
 * 自动推送那一轮的响应体。
 *
 * 真跑了的时候把那份 `SyncOutcome` **摊平**进来（`plan` / `pulled` / `pushed` / `bytesIn` / `bytesOut`
 * / `problems` / `planSource` / `takesEffect`），形状与 `/sync` 落地那次逐字段同源——界面因此能复用
 * 同一套解析，不必为"后台跑的那一轮"再写一遍。没跑（`skip`）时那几项一个都不给：那条路上没有计划、
 * 没有结果，给一份空的只会让界面去猜哪个字段是真的。
 *
 * @param outcome 这一轮的结论。
 * @param info 同步配置里的非敏感字段（远端地址与机器名）；界面拿来在横幅上说"推到哪儿了"。
 * @returns 响应体。
 */

/**
 * 上一轮自动推送的**计数**（推了几条、搬了多少字节）。
 *
 * 不回整份计划：这一份是给"进页面先看一眼""跑完了说一句"用的，上千行的计划不该跟着每次快照/每条
 * 收尾事件搬过去（计划的正文由发起那一轮的界面自己拿，见 `autoPushPayload()`）。
 *
 * @param outcome 上一轮的结论；还没有就是 `undefined`。
 * @returns 摊平的那几项；没跑过是 null。
 */

/** 界面用的全部 handler，键是 `METHOD 路径后缀`；方法可以写成 `GET|POST`（`/sync` 两种都要）。 */

export function createApiHandlers(deps: ApiDeps): Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const { paths, decodeAll } = deps
  const now = deps.now ?? ((): Date => new Date())
  /** 写远端格子的闸；生产由入口注入同一把，测试缺席时自己造。 */
  const remoteWrite = deps.remoteWrite ?? createRemoteWriteGate()
  // 标题只给界面看（`/state`）与导入预演看（包自己带着日志）。导出那条路上没人读它，
  // 所以那里扫库时刻意不传 resolveTitle——别为用不上的东西花钱。
  const resolveTitle =
    deps.resolveTitle ?? createTitleResolver({ cacheDir: projectionCacheDir(paths.registryPath), decodeAll })
  // 同步要的那两件事（空白、最后活动时间）同源同文件，但问的不是同一个问题（见 ApiDeps.sessionMeta）。
  const sessionMeta =
    deps.sessionMeta ?? createSessionMetaResolver({ cacheDir: projectionCacheDir(paths.registryPath) })
  // 扫库时读一次就够的那份记录（标题、空白、活动时间共用它；见 discovery.ts 的 `ScanOptions.projection`）。
  const projection = deps.projection ?? createProjectionReader(projectionCacheDir(paths.registryPath))
  /*
   * 库没变就把上一次的扫描结果直接交出去（见 scan-cache.ts）。
   *
   * 它是**按这个 handler 实例**活的（随服务启动建一次），所以只在同一台宿主、同一份配置下复用：库里
   * 任何一个日志或投影缓存文件变了，指纹就对不上，自然重扫。
   */
  const scans = createScanCache()
  /*
   * 导出、归档、重算名称这三处都要"按整库判断"（展开子智能体族、查同名、按标题认人），但它们原先直接
   * 调 `scanAllAsync()`：整库 1400 多条冷扫要 1 秒以上，这期间 SSE 长连接与别的请求都排着队，而且
   * 每次动作都重扫一遍。这里统一走缓存扫描（库没变就直接交上一次那份）与 `scanAsync()`（每个项目目录
   * 之间让出事件循环）。
   *
   * `titles` 只给重算名称开：它按标题认人；导出与归档只在拒绝一条孤立子智能体时才去读父会话标题，
   * 不值得为整库先折一遍。两组选项各自缓存，库变了都会重扫。
   */
  const scanForAction = (options: { titles?: boolean } = {}): Promise<DiscoveredSession[]> =>
    scans.scanAsync(
      paths.sessionsRoot,
      decodeAll,
      options.titles === true
        ? { resolveTitle, projection, projectionDir: projectionCacheDir(paths.registryPath) }
        : {},
    )
  /*
   * 同一条会话的日志被连着读好几页时只解压一次（见 log-text-cache.ts）。
   *
   * 与 `scans` 一样按 handler 实例活：内容视图一页 80 条事件，翻页与「查看全文」都走同一个文件；留一份
   * 解开的行，够用且不影响别的会话（换一条会话就把它顶掉）。
   */
  const logs = createLogTextCache()
  // 宿主内存里活着的会话：删除会拒掉它们。端口缺席时按空集（判断不了）——预演的输出里没有
  // 任何一处声称"这些一定没在跑"，界面上那句说明也是这么写的。
  const liveSessionIds = (): ReadonlySet<string> => deps.liveSessionIds?.() ?? new Set<string>()
  // 宿主注册表动作的探测：迁移 / 导入 / 同步拉取共用这一个；探测本身在宿主那一侧，
  // 界面这一层只转手（见 ApiDeps.hostRegistry）。
  const hostRegistry = (): HostRegistryPort | undefined => deps.hostRegistry?.()
  // 同理：把宿主的两个冷读服务转手给编排层（迁移 / 导入 / 同步拉取三个落地口共用，见 ApiDeps.hostCheckpoints）。
  const hostCheckpoints = (): CheckpointWarmPort | undefined => deps.hostCheckpoints?.()
  // 附件库的探测（导出往里收对象、导入往外补对象，见 ApiDeps.attach）。缺席 = 这个宿主没有附件服务：
  // 包照旧只带日志，导入也照旧只落日志——与升级前完全一致。
  const attachmentPort = (): AttachmentPort | undefined => deps.attachments?.()

  /**
   * 面板事件流的订阅者（每一条 SSE 响应就是一个）。
   *
   * 为什么是"广播"而不是"每个请求各查一次"：这一页打开之后要盯的东西有好几种——整库清单、落地那一趟、
   * 自动推送那一轮、以及"某个动作改完了，重读一次"。它们都发生在宿主这一侧，而且**多数不是这一页发起
   * 的**（定时器发起的一轮、另一个页签点的同步、工具层调的动作）。所以由宿主推、页面只订一条流。
   */
  const panelListeners = new Set<(event: Record<string, unknown>) => void>()
  /**
   * 给所有订着的页面发一条事件。
   *
   * 订阅者自己的异常吞掉：一个连不上（用户关了页签、网断了）不该让这一轮推送跟着失败——退订由那条
   * 连接自己的 `close` 负责。
   */
  const panelEmit = (event: Record<string, unknown>): void => {
    for (const listener of panelListeners) {
      try {
        listener(event)
      } catch {
        // 少发一条而已。
      }
    }
  }

  /**
   * 这个宿主进程起来的时刻：只用来判"上次那趟要求的重启有没有发生"（见 `lastRunView()`）。
   *
   * 放在这个工厂里而不是模块顶层：一个进程里可能造多份端点（测试就是），每份各记自己的起点，判据才
   * 说得清"这一份之后有没有重启过"。
   */
  const bootedAt = Date.now()
  /** 把"上一次手动同步"拼进同步那一栏：没配置同步时那一栏仍是 null。 */
  const withLastRun = (info: SyncInfo | undefined, lastRun: SyncRunRecord | undefined): MetaFacts['sync'] => {
    if (info === undefined) return null
    // 记录摊成"现在看到的"那份：多一条 `pendingRestart`，页头那枚黄点读的就是它。
    return lastRun === undefined ? { ...info } : { ...info, lastRun: lastRunView(lastRun, bootedAt) }
  }

  const metaFacts = (): MetaFacts => ({
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    // 目录字段能不能「浏览…」由宿主的能力位决定，界面不试错（见 ApiDeps.pickerKind）。
    pickerKind: deps.pickerKind?.() ?? null,
    // 归档按钮能不能点：这个宿主的 workspaceRegistry 在不在（只有 Web profile 才有它）。
    archiveAvailable: deps.registryOps?.() !== undefined,
    // 重新生成名称同理：这个宿主的会话名称服务与读日志 / 持久化几件凑不齐就点不了（见 titleRefreshPort）。
    retitleAvailable: deps.titleRefresh?.() !== undefined,
    // 附件库服务：它决定"没有会话要搬"时那一句要不要提附件对象（见 MetaFacts.attachments）。
    attachments: attachmentPort() !== undefined,
    // 同步卡片：没有配置就是 null（界面据此说明"没配置 sync.url"，而不是画一个点了没反应的按钮）。
    // 配了的话顺手带上上一次手动同步的结论——页头那枚状态据此说"多久以前、成没成"。
    sync: withLastRun(deps.syncInfo?.(), deps.syncRun?.read()),
  })

  const meta = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, metaFacts())
  }

  /**
   * 整库清单。走事件流：这一份要**扫完整库**（每条会话读 header、还要折标题，实测 468 条 / 232 MB
   * 约 0.2～0.45 秒，冷缓存与大库上就是几秒），而它是这一页打开时等的第一件事——那段时间只有
   * 一句「读取中…」加一条"扫到第几条"。
   *
   * 界面走的是面板那条连接上的 `snapshot`（同一个 `readState()`）；这一条留着是不开浏览器也能读一眼
   * 库的一次性入口。
   */
  const state = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await streamResult(res, (report) => readState(report))
  }

  /**
   * 扫一遍整库，交出界面要的那一份清单（`/state` 与面板事件流的 `snapshot` 读同一个函数）。
   *
   * 抽出来而不是各写一遍：这两处对"清单是什么"必须逐字相同——面板流那一份就是这一份，两处各抄一遍
   * 迟早会分叉，而分叉的表现是"刚打开时列表少了一条"这类没人查得出来的错。
   *
   * @param report 进度回调（扫描那一段逐条报）。
   * @returns 清单本身（形状与 `StateResponse` 一致）。
   */
  const readState = async (report: ProgressReporter): Promise<Record<string, unknown>> => {
    const { registry, problems } = loadRegistry(paths.registryPath)
    const sessions = await scans.scanAsync(paths.sessionsRoot, decodeAll, {
      resolveTitle,
      projection,
      // 标题与空白都从这些文件里读，它们变了结果就得重算。
      projectionDir: projectionCacheDir(paths.registryPath),
      onProgress: (done, total) => report({ phase: 'scan', done, total }),
    })
    // 「认领」算一次，会话列表那栏与工作区那栏读同一份：宿主发给渲染层的也是同一个取值
    // （`Workspace.sessionIds` 的过滤，见 accounting.ts），两处各算一遍迟早会分叉。
    const accounted = accountedOwners(registry, sessions)
    const workspaces = summarizeWorkspaces(registry, accounted)
    // 项目身份只认"界面上真会出现的那些目录"：每条会话的 cwd + 注册表登记的工作区路径。别的一律不问
    // ——`git rev-parse` 是每个目录一次进程，列表页的热路径上多问一个都是白花。
    const directories = new Set<string>()
    for (const session of sessions) if (session.cwd !== undefined && session.cwd !== '') directories.add(session.cwd)
    for (const workspace of workspaces) if (workspace.path !== '') directories.add(workspace.path)
    const repos = deps.repos === undefined ? new Map<string, string>() : await deps.repos([...directories])
    return {
      // 位置与能力位与 `/meta` 同一份取值，不在这里重算（见 metaFacts）。
      ...metaFacts(),
      problems,
      // 目录 → 项目身份（`host/owner/repo`）：界面把它显示在原来印本机路径的地方。认不出来的目录不在
      // 表里，界面退回显示路径。
      repos: Object.fromEntries(repos),
      sessions: summarizeSessions(sessions, {
        accounted,
        archived: new Set(registry?.global.archivedSessionIds ?? []),
        // 空白判据默认从扫描时读到的 `session.meta` 取（同一个文件不再读第二遍）；只有显式注入了
        // 读取器时才走它（测试用它钉"读不到空白"的边界）。
        ...(deps.resolveBlank === undefined ? {} : { resolveBlank: deps.resolveBlank }),
        live: liveSessionIds(),
      }),
      workspaces,
    }
  }

  /**
   * 面板事件流：这一页打开期间**只有这一条长连接**，各种状态都从它来。
   *
   * 它替掉的是原来四件事：打开页面时的 `GET /meta` + `GET /state` 两个请求、落地那一趟的
   * `GET /sync?mode=status` 轮询、以及自动推送的 `GET /auto-push?mode=status` 轮询 +
   * `mode=watch` 那条"在跑才开"的流。四处各问一次的时候，问题不只是省几个请求——**没在听的那些
   * 事永远看不到**：后台自己跑的一轮、另一个页签点的同步，页面都得靠"进页面时问一次"去撞。
   *
   * 事件（每条都是一行 JSON，`type` 说明是哪一种）：
   *
   * - `ready`：宿主事实（与 `GET /meta` 同一份取值），连上就先发，页头不必等扫库；
   * - `progress`：扫库那一段逐条报（`phase: 'scan'`）；
   * - `snapshot`：整库清单（与 `GET /state` 同一份取值，见 `readState()`）；
   * - `sync`：落地那一趟的当前状态 + 上一轮结论（`applying` 为 null 就是没在跑）；
   * - `auto-push`：自动推送那一轮同理（`running` 为 null 就是没在跑）；
   * - `stale`：本机的会话库被改过了（某个动作落地、或一次同步拉取下来），页面据此重连要一份新清单；
   * - `ping`：心跳，15 秒一次。
   *
   * 为什么开头先来一份"当前状态"再跟着推：从连上到第一条事件之间有可能正好有一轮跑完（那是几十毫秒
   * 的窗口，但"正好错过"是最难查的那类 bug）。所以每条状态都先说一遍当下，之后才是增量。
   */
  const panelEvents = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    sendEventStream(res)
    /** 这条连接自己的写出口；`sendEvent()` 内部会跳过已经关掉的响应。 */
    const listener = (event: Record<string, unknown>): void => sendEvent(res, event)
    /*
     * 先挂上订阅、再发"当下"那几条：反过来的话，从读到当下状态到挂上订阅之间那几十毫秒里发生的事
     * （比如另一个页签点的同步正好跑完）会被漏掉，而且之后没有任何一次补问能把它捡回来。
     */
    panelListeners.add(listener)
    // ① 宿主事实：位置、能力位、同步配置。这一条不扫库，所以页头立刻能画出来。
    sendEvent(res, { type: 'ready', meta: metaFacts() })
    /*
     * ② 后台那两种状态的当下：落地那一趟与自动推送那一轮。
     *
     * 自动推送的调度器要等配置与凭据解析完才存在（`deps.autoPush()` 是个挂起的 promise），所以这一条
     * 可能比别的晚一点；拿不到就说明这个宿主没有自动推送，`running` / `last` 都是 null。
     */
    const timer = await deps.autoPush?.()
    const autoPushNow = (): Record<string, unknown> => {
      const status = timer?.status()
      return {
        running:
          status?.running === null || status?.running === undefined
            ? null
            : { startedAt: status.running.startedAt, progress: status.running.progress },
        last: autoPushLastPayload(status?.last),
      }
    }
    sendEvent(res, { type: 'sync', ...sync.applyStatus() })
    sendEvent(res, { type: 'auto-push', ...autoPushNow() })
    /*
     * ③ 之后跟着推。
     *
     * 自动推送那一轮用调度器自己的 `subscribe()`：两条发起路（写完一轮、界面那枚按钮）都会
     * 经过它，所以"谁发起的一轮"这里都看得见。退订跟着这条连接走（`close` 时）。
     */
    const unsubscribe = timer?.subscribe((event) => {
      if (event.type === 'progress') {
        // 开始时刻从调度器那一份取：这一轮可能是别处发起的，不能拿"现在"当它的起点。
        const startedAt = timer.status().running?.startedAt ?? Date.now()
        sendEvent(res, { type: 'auto-push', running: { startedAt, progress: event.progress }, last: null })
      } else {
        sendEvent(res, { type: 'auto-push', running: null, last: autoPushLastPayload(event.outcome) })
      }
    })
    /*
     * ④ 清单：这一条要真扫库（冷缓存与大库上几秒），所以放在最后，边扫边报进度。
     *
     * 扫库是**同步**的一大段（读每条会话的 header、折标题），中间没有 `await` 的地方，所以它跑起来之后
     * 这条连接上的别的推送也会被挡住——这正是把清单放最后、而不是穿插在状态之间的原因：状态先到，
     * 用户至少能看出"后台在跑"，而不是干等一份清单。
     */
    try {
      const snapshot = await readState((progress) => sendEvent(res, { type: 'progress', progress }))
      sendEvent(res, { type: 'snapshot', state: snapshot })
    } catch (error) {
      sendEvent(res, { type: 'error', error: error instanceof Error ? error.message : String(error) })
      panelListeners.delete(listener)
      unsubscribe?.()
      res.end()
      return
    }
    /*
     * 心跳：一轮自动推送或一次扫库可能几十秒没有新事件，中间任何一层代理都可能把"什么都没发"的连接
     * 掐掉。它同时让页面能分辨"还连着"与"断了"。
     */
    const heartbeat = setInterval(() => sendEvent(res, { type: 'ping' }), 15_000)
    await new Promise<void>((resolve) => {
      res.on('close', resolve)
    })
    clearInterval(heartbeat)
    panelListeners.delete(listener)
    unsubscribe?.()
    res.end()
  }

  const migrateDeps: MigrateDeps = {
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    // 迁移页挑会话时同样按标题认人（与传输页同一套口径）。
    resolveTitle,
    // 标题从进程里共用那份投影记录取（不含这份的话，每条会话都要把同一个 JSON 重新解析一遍）。
    projection,
    // 每次调用重新探测（只有工具的前端 / 老版本宿主可能没有这套动作）。
    hostRegistry,
    // 迁移改写了 cwd，旧检查点因此对不上：收口时请宿主重折一遍（见 checkpoint-warm.ts）。
    hostCheckpoints,
    // 宿主持在内存里的那些搬不动（见 plan.ts 的 `BuildPlanOptions.live`）：界面同样要问，否则预演会
    // 报一个"22 条全搬走"的计划，执行时宿主在第一条就回绝。
    liveSessionIds,
  }
  // 没注入就按"需要重启"说：宁可保守，也不谎称已经生效。执行过的那些走执行结果（见 effectOf）。
  const takesEffect = (): EffectMode => (hostRegistry() === undefined ? 'restart-required' : 'immediate')

  // 各操作的端点工厂共用这一份：缓存、写锁与宿主能力位都只有一份，各自 new 一份会让库被扫两遍、
  // 两趟落地各拿一把锁。`sync` 另带一份状态（预演缓存、正在跑的那一趟），所以单独收着。
  const ctx: WebContext = {
    deps,
    paths,
    decodeAll,
    now,
    remoteWrite,
    resolveTitle,
    sessionMeta,
    projection,
    scanForAction,
    logs,
    liveSessionIds,
    hostRegistry,
    hostCheckpoints,
    attachmentPort,
    panelEmit,
    migrateDeps,
    takesEffect,
  }
  const sync = syncHandlers(ctx)

  return {
    'GET /meta': meta,
    'GET /state': state,
    // 这一页打开期间只有这一条长连接：清单、落地那一趟、自动推送那一轮、以及"库变了"的通知都从它来。
    'GET /panel/events': panelEvents,
    ...transcriptHandlers(ctx),
    ...migrationHandlers(ctx),
    ...transferHandlers(ctx),
    ...removeHandlers(ctx),
    ...retitleHandlers(ctx),
    ...sync.handlers,
  }
}

/**
 * 把界面用的路由注册到 webServer 上。
 * @returns 卸载函数：宿主热卸载时逐个摘掉路由。
 */
export function registerWebRoutes(server: WebServerLike, deps: ApiDeps): () => void {
  const handlers = createApiHandlers(deps)
  const disposers: Array<() => void> = []
  for (const [key, handler] of Object.entries(handlers)) {
    const [methods, suffix] = key.split(' ')
    const allowed = (methods ?? '').split('|')
    disposers.push(
      server.register({
        kind: 'exact',
        path: `${API_PREFIX}${suffix}`,
        handler: async (req, res) => {
          if (!allowed.includes((req.method ?? 'GET').toUpperCase())) {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: `${suffix} 只接受 ${allowed.join(' / ')}` }))
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            // 兜底：任何漏网的异常都要变成 500 响应，不能把连接留着不关。
            const message = error instanceof Error ? error.message : String(error)
            if (!res.headersSent) sendJson(res, 500, { error: message })
            else res.end()
          }
        },
      }),
    )
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 卸载期忽略单个注销失败
      }
    }
  }
}
