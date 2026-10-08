/**
 * 跨模块共享的类型。
 *
 * 这里刻意只用**结构化**类型描述宿主的数据形态，不 import 宿主的类型包：
 * 核心层（除 tools/index 外）保持零 DSH 依赖正是本包的设计目标之一，
 * 这样同一段代码能被插件外壳与测试共用。
 */

/** 会话日志首行的 header（对应宿主 HEADER_REQUIRED_KEYS / HEADER_OPTIONAL_KEYS）。 */
export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  createdAt: number
  /** 缺省时该会话落在 `_no-cwd` 项目目录。 */
  cwd?: string
  parentSession?: string
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth: number
  agentPreset?: string
}

/** workspace 注册表里的一条记录。 */
export interface WorkspaceRecord {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/** `$DSH_HOME/storages/workspace.json` 的领域形态（unit=workspace, version=2）。 */
export interface WorkspaceRegistryState {
  unit?: { name: string; version: number }
  global: {
    initialized?: boolean
    workspaceIds: string[]
    archivedSessionIds?: string[]
    pinnedSessionIds?: string[]
    pendingMutation?: unknown
  }
  tables: { workspaces: Record<string, WorkspaceRecord> }
}

/**
 * 多帧感知的 zstd 解码器：整份字节 → 全量明文。
 *
 * 由调用方注入而不是本包自己挑，是为了配合 `assertMultiFrameAware()` 做启动期探测：
 * 只解首帧的解码器（如 `node:zlib` 的 zstd）会静默丢掉其余帧。
 */
export type DecodeAll = (buf: Uint8Array) => string

/** 首帧压缩器：明文字符串 → 一个完整的 zstd 帧。 */
export type CompressFrame = (text: string) => Buffer

/** 计划里单个会话的迁移项。 */
export interface SessionMove {
  id: string
  /** 折叠出的标题；读不到就没有（见 session-title.ts）。界面靠它认会话，id 退到悬浮提示。 */
  title?: string
  dirName: string
  createdAt: number
  from: string
  to: string
  alreadyAtTarget: boolean
  sourceDir: string
  targetDir: string
  files: SessionLogFile[]
  /**
   * 这条会话**被某个工作区认领**吗（判据见 accounting.ts：登记过 **且** header 的 cwd 归一之后就是那条
   * 记录的 `path`）。它是"本来就在册"的判据——级联带进来的子智能体只有在这一项为真时才跟着改挂。
   */
  registered: boolean
  /**
   * 这条是**级联**带进来的：`via` 是用户点名、把它牵进来的那条祖先会话。
   *
   * 点名的那几条自己没有这个字段——哪怕它同时又是别人的后代（"点名"比"顺带"更该被说出来）。
   * 成员资格不因为跟着走而改变，见 `RelocationPlan.cascaded`。
   */
  via?: { id: string; title?: string }
}

/** 会话目录里的一个代次日志文件。 */
export interface SessionLogFile {
  name: string
  path: string
  version: number
  compression: string | null
  bytes: number
}

/** 产物搬迁项。 */
export interface ArtifactMove {
  sourcePath: string
  targetPath: string
  kind: string
  isDir: boolean
  sessionIds: string[]
  relative: string
}

/** 被跳过的产物候选（附原因，便于向用户解释为什么没搬）。 */
export interface ArtifactSkip {
  path: string
  reason: string
  sessionId?: string
}

/**
 * 宿主**攥在内存里**、这次不能搬的会话（判据与理由见 plan.ts 的 `splitLive()`）。
 *
 * 它们既不能被挂到新工作区（宿主拿内存里那份 header 校验 `cwd`，一口回绝），日志也不能被搬走
 * （宿主手里还有写句柄，搬走之后它照样往旧路径写）。所以它们留在原目录、归属不变。
 */
export interface LiveSkip {
  id: string
  /** 界面认人用的标题（读到才有）。 */
  title?: string
  createdAt: number
  /** 它现在的 cwd——也是它留在原处的理由（源工作区那条记录还认它）。 */
  cwd?: string
}

/** 一次迁移的完整计划。 */
export interface RelocationPlan {
  ok: boolean
  problems: string[]
  /**
   * 源工作区目录；**未分组来源**（`unowned`）时是空串——那时源由"谁都没认领"决定（判据见
   * accounting.ts），可以横跨多个项目目录，每条会话各自的源在 `sessions[].from` 里。
   */
  from: string
  to: string
  root: string
  /** 源项目目录；未分组来源时是空串（源不是一个目录，见 `unowned`）。 */
  sourceProjectDir: string
  targetProjectDir: string
  /**
   * 源是"外壳侧边栏那个「未分组」里有 cwd 的会话"（判据见 visibility.ts 的 `isUngrouped()`），
   * 而不是某个目录。
   *
   * 这一条决定了执行阶段怎么清理源项目目录（按每条会话自己的项目目录，见 execute.ts 第 5 步）与
   * 产物搬迁能不能做（跨目录时拒绝，见 plan.ts 的说明）。
   */
  unowned: boolean
  sessions: SessionMove[]
  /** 级联带进来的条数：点名的会话的子智能体后代（见 `SessionMove.via`）。 */
  cascaded: number
  /**
   * 宿主持在内存里、这次**不搬**的会话（按发现顺序）。
   *
   * 计划因此是一次**部分**迁移：它们没被搬，`sessions` 里没有它们，注册表也不动它们那条归属
   * （源工作区因此不会被摘空、更不会被删）。调用方必须把这份名单报出来——静默少搬就是坏账。
   */
  liveSkipped: LiveSkip[]
  artifacts: { moves: ArtifactMove[]; problems: string[]; skipped: ArtifactSkip[] } | null
  registryChange: RegistryChange | null
  nextRegistry: WorkspaceRegistryState | null
}

/** 注册表改动何时被宿主承认。 */
export type EffectMode = 'immediate' | 'restart-required'

/**
 * 宿主注册表动作的端口：插件把"改这份账"的活儿交给宿主自己做（见 .agents/notes 里就地刷新那篇）。
 *
 * 每一件都对应宿主本来就有的动作（官方界面移动会话走的就是它们）：它先落盘、再改内存、再通知界面，
 * 所以侧边栏不刷新就自己跟上。会话 id 只被"挂靠 / 摘掉"、从不新建；已存在的工作区 id 不变
 * （`ensureWorkspace()` 对同一条路径是幂等的）。
 *
 * 由宿主那半侧（`workspaceRehomePort()`）探测并交出，核心层只认这个形状——本类型不 import 任何宿主包。
 */
export interface HostRegistryPort {
  /**
   * 让宿主按磁盘重看一眼（刷新 header 缓存 + 重建活会话索引，跟它启动时做的两步一样）。
   *
   * **必须在改归属之前**：`attachSession()` 会拿缓存里的 header 校验 `cwd`，缓存还是旧的就会被它
   * 一口回绝（`its cwd resolves to '<旧路径>'`）。
   */
  refreshIndex(): Promise<void>
  /** 复用或新建目标工作区；返回它的 id（同一条路径重复调用返回同一个工作区）。 */
  ensureWorkspace(path: string, title?: string): Promise<string>
  /** 把会话挂到该工作区**末尾**（按调用顺序追加，与计划里的顺序一致）。 */
  attachSession(workspaceId: string, sessionId: string): Promise<void>
  /** 把会话从该工作区摘除。 */
  detachSession(workspaceId: string, sessionId: string): Promise<void>
  /** 该工作区当前的会话 id（顺序即显示顺序）。 */
  members(workspaceId: string): Promise<readonly string[]>
  /** 删除工作区记录（源侧成员搬空之后才该调）。 */
  removeWorkspace(workspaceId: string): Promise<void>
}

/**
 * 本次改动有没有被**活着的宿主**接住。
 *
 * 几种情形要分得开：宿主自己改完了（`applied`）、改到一半失败了（文件已经写好，只能重启）、
 * 这个宿主没有那套动作（只有工具的前端 / 老版本）、这次走的是整份写回文件那条路（`file-only`）。
 * 措辞由 `describeEffect()` 一处给出，
 * 工具层与界面层因此不会各说各话。
 */
export interface EffectOutcome {
  /**
   * `applied` 宿主自己改完了；`failed` 改到一半失败；`unavailable` 这个宿主没有那套动作；
   * `file-only` 是**整份写回文件**那条路（回滚为了原样保住工作区 id 才走它）——文件对了，
   * 宿主手里那份还是旧的，得重启。
   */
  kind: 'applied' | 'failed' | 'unavailable' | 'file-only'
  /** 宿主实际用的目标工作区 id（新建时由宿主分配，与计划里的预测值可能不同）。 */
  targetId?: string
  /** `failed` 时的原因（原样带给用户，别吞）。 */
  error?: string
  /**
   * `failed` 时插件**已经把算好的注册表整份写回文件**了（见 `take-effect.ts` 的 `restoreRegistry()`）。
   *
   * 为什么必须写回来：宿主那一步只要动过手就会按内存整份落盘，把插件写的那份当场盖掉；不写回来，
   * "重启后一致"就是假的。走不到这一步（没给注册表路径 / 没有算好的终态）时为 undefined，
   * 措辞要据此分岔，不能硬说文件是对的。
   */
  registryRestored?: boolean
}

/**
 * 宿主"补齐列表元数据"的两个服务收成的端口（见 checkpoint-warm.ts）。
 *
 * 宿主的会话列表**不读日志**：没活过的会话，标题 / 空白 / 最后活动时间都从它自己持久化的投影检查点里
 * 取，取不到就显示"未命名"。本插件只能借宿主自己的冷读补那一条记录——`sessionQuery.readSession()` 加
 * `sessionProjectionCache.coldSnapshot()`——自己写那份文件是错的（见 checkpoint-warm.ts 的开头）。
 *
 * 由宿主那半侧（`hostCheckpointPort()`）探测并交出，核心层只认这个形状——本类型不 import 任何宿主包。
 */
export interface CheckpointWarmPort {
  /**
   * 让宿主对**一条已存会话**冷读一遍日志、把折叠结果写成检查点（不建活会话、不动日志）。
   *
   * 失败时抛错：调用方逐条兜住——落地已经成功，这里补的是宿主那份派生数据。
   */
  warm(sessionId: string): Promise<void>
}

/** 一次落地之后"请宿主补检查点"的结果（见 checkpoint-warm.ts 的 `warmCheckpoints()`）。 */
export interface WarmOutcome {
  /** 真的补上的条数。 */
  warmed: number
  /** 试过但没补上的条数（逐条兜住，不影响落地结论）。 */
  failed: number
  /** 这个宿主没有那套动作（老版本 / 只装了工具的前端 / 没挂投影缓存）时为 true。 */
  unavailable: boolean
  /** 前几条失败原因（给人看的，最多三条；`failed` 才是全部条数）。 */
  problems: string[]
}

/** `reHome()` 实际发生的动作。 */
export interface RegistryChange {
  targetId: string
  targetPath: string
  /** 新建目标工作区时该用的标题（与 `reHome()` 写进记录的那个一致）。 */
  targetTitle: string
  createdTarget: boolean
  added: string[]
  adoptedFromUnowned: string[]
  movedFrom: Array<{ workspaceId: string; path: string; sessionIds: string[] }>
  removedSources: Array<{ workspaceId: string; path: string }>
  unchanged: boolean
}
