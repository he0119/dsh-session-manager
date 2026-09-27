/**
 * 跨模块共享的类型。
 *
 * 这里刻意只用**结构化**类型描述宿主的数据形态，不 import 宿主的类型包：
 * 核心层（除 tools/index 外）保持零 DSH 依赖正是本包的设计目标之一，
 * 这样同一段代码能被插件外壳、离线 CLI 与测试三方共用。
 */

/** 会话日志首行的 header（对应宿主 HEADER_REQUIRED_KEYS / HEADER_OPTIONAL_KEYS）。 */
export interface SessionHeader {
  type: 'session'
  version: number
  id: string
  createdAt: number
  /** 缺省时该会话落在 `_no-cwd` 分桶。 */
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
  registered: boolean
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

/** 一次迁移的完整计划。 */
export interface RelocationPlan {
  ok: boolean
  problems: string[]
  /**
   * 源工作区目录；**未分组来源**（`unowned`）时是空串——那时源由"账本没认领"决定，
   * 可以横跨多个分桶，每条会话各自的源在 `sessions[].from` 里。
   */
  from: string
  to: string
  root: string
  /** 源分桶；未分组来源时是空串（源不是一个目录，见 `unowned`）。 */
  sourceBucket: string
  targetBucket: string
  /**
   * 源是"账本没认领且有 cwd 的会话"（外壳侧边栏那个「未分组」），而不是某个目录。
   *
   * 这一条决定了执行阶段怎么清理源分桶（按每条会话自己的桶，见 execute.ts 第 5 步）与
   * 产物搬迁能不能做（跨目录时拒绝，见 plan.ts 的说明）。
   */
  unowned: boolean
  sessions: SessionMove[]
  artifacts: { moves: ArtifactMove[]; problems: string[]; skipped: ArtifactSkip[] } | null
  registryChange: RegistryChange | null
  nextRegistry: WorkspaceRegistryState | null
}

/** `reHome()` 实际发生的动作。 */
export interface RegistryChange {
  targetId: string
  targetPath: string
  createdTarget: boolean
  added: string[]
  adoptedFromUnowned: string[]
  movedFrom: Array<{ workspaceId: string; path: string; sessionIds: string[] }>
  removedSources: Array<{ workspaceId: string; path: string }>
  unchanged: boolean
}
