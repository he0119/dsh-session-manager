/**
 * 界面与宿主端点之间的唯一通道。
 *
 * 为什么不走 Remote/typert：本页要的是**二进制**（下载一个包、上传一个包），而 Remote 那套是
 * 结构化调用面；宿主已经为本插件开了自己的路由，同源 `fetch` 是最短路径，也省掉一层描述符。
 *
 * 端点由 `src/web.ts` 注册，路径固定在本插件命名空间下（`/dsh-session-manager/api`）。
 *
 * @module dsh-session-manager/client/api
 */

import { SseFrames, interpretSyncEvent, type SyncProgressEvent } from './logic/syncStream.ts'

// 事件流的分帧与解释在 syncStream.ts（那份文件与 DOM 无关，所以 Host 侧的测试图能直接引它）。类型
// 从这里转出去，界面那一侧只认 api.ts 一个入口。
export type { SyncProgressEvent }

/** 宿主端点前缀（与 `src/web.ts` 的 `API_PREFIX` 必须一致）。 */
export const API_PREFIX = '/dsh-session-manager/api'

/** 界面上一条会话。 */
export interface SessionSummary {
  id: string
  /** 折叠出的标题（宿主侧从投影缓存或日志里读，见 `src/session-title.ts`）；没有时界面显示 id。 */
  title?: string
  cwd?: string
  createdAt: number
  dir: string
  /**
   * 外壳侧边栏会把它放进「未分组」那一组（宿主按 `src/visibility.ts` 的 `isUngrouped()` 算好发过来）。
   *
   * 界面不再自己从"有没有工作区认领"推：那样推出来的「未分组」把子代理、空白、已归档也算进去，
   * 而侧边栏从来不把它们放进那一组（它默认压根不显示它们）。
   */
  ungrouped?: boolean
  bytes: number
  files: Array<{ name: string; bytes: number }>
  /**
   * 外壳侧边栏不显示这条会话的原因（缺省 = 会显示，见 `src/visibility.ts`）。
   *
   * 判据在宿主侧算一次（`/state`），界面只读结论：传输页照单全收、迁移页只收看得见的、
   * 「会话」页把原因标出来——三处读同一个字段，不会各自算出一套。
   */
  hidden?: 'subagent' | 'blank' | 'archived'
  /** 在注册表的归档集里（「会话」页据此决定按钮写「归档」还是「取消归档」）。 */
  archived?: boolean
  /** 宿主判它"一轮都没开始过"（见 `src/visibility.ts`）。 */
  blank?: boolean
  /** 日志 header 里的 `origin`（只有子代理会话会写）。 */
  origin?: string
  /** 日志 header 里的 `parentSession`：这条子代理挂在哪条会话下面（列表据此缩进一级）。 */
  parentSession?: string
  /** 宿主内存里活着（删除会拒它）。 */
  live?: boolean
}

/** 界面上一个工作区。 */
export interface WorkspaceSummary {
  id: string
  path: string
  title: string
  sessionIds: string[]
}

/** `GET /state` 的响应。 */
export interface StateResponse {
  sessionsRoot: string
  /**
   * 宿主目录选择器的能力种类：`native` = 系统对话框、`browse` = 页面内浏览、`null` = 没有。
   * 目录字段据此决定「浏览…」开哪一种；缺字段（旧宿主）按 `null` 处理。
   */
  pickerKind?: 'browse' | 'native' | null
  /**
   * 这个宿主能不能改归档（`workspaceRegistry` 在不在，只有 Web profile 才有它）；
   * 缺字段（旧宿主）按 `false` 处理——按钮禁用比点了没反应好。
   */
  archiveAvailable?: boolean
  /**
   * WebDAV 同步的非敏感配置（宿主插件配置里的 `sync` 块）；没配时是 `null`。
   * 缺字段（旧宿主）同样按"没配置"处理。
   */
  sync?: SyncInfo | null
  /**
   * 目录 → 项目身份（仓库的 git remote，规范成 `host/owner/repo`，见宿主 `src/repo.ts`）。
   *
   * 界面把它显示在原来印本机路径的地方：路径是机器特有的，同一个项目在两台机器上可以落在完全不同的
   * 目录里，而 `host/owner/repo` 是仓库自己的名字。认不出来的目录不在表里（不是仓库、没有 remote、
   * 目录已经不在），界面退回显示路径；缺字段（旧宿主）按空表处理。
   */
  repos?: Record<string, string>
  registryPath: string
  problems: string[]
  sessions: SessionSummary[]
  workspaces: WorkspaceSummary[]
}

/** 同步往哪儿去、这台机器叫什么（宿主 `SyncInfo`，不含任何凭据）。 */
export interface SyncInfo {
  url: string
  machineId: string
  /** 显式映射的条数；映射内容在插件配置里，界面只报条数。 */
  mappings: number
}

/** 导入计划里的一条会话。 */
export interface ImportEntry {
  id: string
  /** 包里的标题（宿主从载荷的日志里折出来的）；没有时界面显示 id。 */
  title?: string
  action: 'create' | 'skip'
  reason?: string
  fromCwd?: string
  toCwd?: string
  dir: string
  files: Array<{ name: string; bytes: number }>
}

/** 导入（预演或落地）的响应。 */
export interface ImportResponse {
  mode: 'plan' | 'apply'
  ok: boolean
  error?: string
  problems: string[]
  entries: ImportEntry[]
  created: string[]
  rehomed: string[]
  bytes: number
  written?: string[]
  registryWritten?: boolean
  note?: string
  bundle?: { createdAt: string; source: { sessionsRoot?: string; pluginVersion?: string }; sessions: number }
}

/** 把响应体读成 JSON，失败时把人话抛出去（HTTP 层与业务错误都在这里收口）。 */
async function asJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  }
  const body = parsed as { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return parsed as T
}

/** 读会话库与工作区清单。 */
export async function fetchState(): Promise<StateResponse> {
  return asJson<StateResponse>(await fetch(`${API_PREFIX}/state`, { headers: { accept: 'application/json' } }))
}

/** 导出的结果：字节 + 宿主给的文件名。 */
/** 读一个数字响应头：缺席或不是数字时返回 `undefined`（界面据此回落自己算的那份）。 */
function numberHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export interface ExportResult {
  blob: Blob
  filename: string
  /** 包里实际有几条会话（宿主回报）：勾一条父会话时它的子代理跟着进包，比勾选数多。 */
  count?: number
  /** 包里日志的总字节数（宿主回报）；缺席时界面按勾中的那些算。 */
  bytes?: number
}

/** 导出选中的会话。 */
export async function exportSessions(sessionIds: readonly string[]): Promise<ExportResult> {
  const response = await fetch(`${API_PREFIX}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionIds }),
  })
  if (!response.ok) {
    // 失败时宿主回的是 JSON；成功时是二进制，所以只有失败这一支按 JSON 解。
    await asJson<unknown>(response).catch((error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error))
    })
    throw new Error(`HTTP ${response.status}`)
  }
  const disposition = response.headers.get('content-disposition') ?? ''
  const matched = /filename="([^"]+)"/.exec(disposition)
  // 包里到底几条 / 多少字节：界面那句"已导出 N 条"说的是包里的东西，而包里可能多了跟来的子代理。
  const count = numberHeader(response, 'x-dsh-session-count')
  const bytes = numberHeader(response, 'x-dsh-session-bytes')
  // 文件名以宿主的 Content-Disposition 为准；这条兜底只在没有响应头时用，后缀与它保持一致。
  return {
    blob: await response.blob(),
    filename: matched?.[1] ?? 'dsh-sessions.dshsess',
    ...(count === undefined ? {} : { count }),
    ...(bytes === undefined ? {} : { bytes }),
  }
}

/** 导入一个包：`mode: 'plan'` 只预演不写盘。 */
export async function importBundle(
  bytes: ArrayBuffer,
  targetCwd: string,
  mode: 'plan' | 'apply',
): Promise<ImportResponse> {
  const url = `${API_PREFIX}/import?mode=${mode}&targetCwd=${encodeURIComponent(targetCwd)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  // 预演成功回 200，落地冲突回 409——两者都带完整的 JSON 正文，所以不按 ok 提前抛。
  const text = await response.text()
  let parsed: ImportResponse
  try {
    parsed = JSON.parse(text) as ImportResponse
  } catch {
    throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  }
  if (!response.ok && parsed.error === undefined) throw new Error(`HTTP ${response.status}`)
  return parsed
}

/** 触发浏览器下载。 */
export function download(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

// ---- WebDAV 同步 ----

/** 一次同步里"会拉取"的一条。 */
export interface SyncPullEntry {
  id: string
  title?: string
  fromCwd?: string
  toCwd?: string
  /** 贡献这条的机器。 */
  machine: string
  bytes: number
  action: 'create' | 'skip'
  /** 机器可读的分类：界面按它挑文案（`reason` 是给模型看的细节）。 */
  code: 'missing' | 'no-mapping' | 'missing-target'
  reason?: string
}

/** 一次同步里"会推送"的一条。 */
export interface SyncPushEntry {
  id: string
  title?: string
  cwd?: string
  bytes: number
  action: 'upload' | 'update' | 'skip'
  code: 'missing' | 'local-ahead' | 'identical' | 'remote-ahead' | 'diverged'
  /** 远端那份由哪台机器贡献（"远端领先 / 两边各自写过"要指名道姓）。 */
  machine?: string
  reason?: string
}

/** 同步计划（宿主 `SyncPlan`）。 */
export interface SyncPlan {
  ok: boolean
  problems: string[]
  pull: SyncPullEntry[]
  push: SyncPushEntry[]
  pullIds: string[]
  pushIds: string[]
  bytesIn: number
  bytesOut: number
  localCount: number
  remoteCount: number
  machines: string[]
}

/** `GET|POST /sync` 的响应。 */
export interface SyncResponse {
  mode: 'plan' | 'apply'
  remote: { url: string; machineId: string }
  plan: SyncPlan
  applied: boolean
  pulled: string[]
  pushed: Array<{ id: string; action: 'upload' | 'update' }>
  bytesIn: number
  bytesOut: number
  registryWritten: boolean
  indexWritten: boolean
  problems: string[]
  /** 这次落地要不要重启 DSH 才被承认（与迁移/导入同一套口径）。 */
  takesEffect: 'immediate' | 'restart-required'
  error?: string
}

/**
 * 预演一次同步（读远端，什么都不写），边算边报进度。
 *
 * 宿主对预演与落地回的都是 **SSE**：预演要先扫本机（每条会话读头、折标题）、再读远端索引、最后逐条
 * 比对内容，冷启动时那几秒里界面原来只有一句"预演中…"；落地的理由是上百条各一次网络往返。事件形状
 * 两条路完全一样，所以下面 `readSyncResponse()` 一份就够。
 *
 * @param onProgress 每收到一条进度事件调一次。
 * @returns 计划；问题在 `problems` 里，连接层的失败抛原话。
 */
export async function fetchSyncPlan(onProgress?: (event: SyncProgressEvent) => void): Promise<SyncResponse> {
  const response = await fetch(`${API_PREFIX}/sync`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  })
  return readSyncResponse(response, onProgress, '预演')
}

/**
 * 一次性响应：流还没开始就被挡下（没配置同步、方法不对、内部错误）时宿主回的还是普通 JSON，
 * 带状态码。这里保持与其它端点同一套口径。
 */
async function readOneShot(response: Response): Promise<SyncResponse> {
  const text = await response.text()
  let parsed: SyncResponse | null = null
  try {
    parsed = JSON.parse(text) as SyncResponse
  } catch {
    // 不是 JSON：下面统一把原文截一段报出去，比"解析失败"有用。
  }
  if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  if (parsed === null) throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  return parsed
}

/**
 * 按 `content-type` 把一次同步的响应读出来：事件流就边读边报进度，一次性 JSON 就整份解析。
 *
 * @param response 宿主回的那份响应。
 * @param onProgress 进度事件的回调（只有流走得到）。
 * @param what 出错时的主语（「预演」/「同步」）。
 */
async function readSyncResponse(
  response: Response,
  onProgress: ((event: SyncProgressEvent) => void) | undefined,
  what: string,
): Promise<SyncResponse> {
  // 流开始之前的错（没配置同步、内部错误）仍然是一次性 JSON。
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) return await readOneShot(response)

  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error(`这次${what}没有可读的事件流（浏览器不支持流式响应）`)
  // 分帧与解释都在 syncStream.ts（纯字符串处理，没有 DOM）；这里只负责把字节读出来喂进去。
  const frames = new SseFrames()
  const decoder = new TextDecoder()
  let result: SyncResponse | null = null
  let failure: string | null = null
  const handle = (data: string): void => {
    const event = interpretSyncEvent(data)
    if (event === null) return
    if (event.kind === 'progress') onProgress?.(event.progress)
    else if (event.kind === 'result') result = event.result as SyncResponse
    else failure = event.message
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const data of frames.push(decoder.decode(value, { stream: true }))) handle(data)
  }
  for (const data of frames.flush()) handle(data)

  if (failure !== null) throw new Error(failure)
  if (result === null) throw new Error(`${what}没有回结果（连接提前断了？）`)
  return result
}

/**
 * 真的跑一次同步（拉取 + 推送），边跑边报进度。
 *
 * @param onProgress 每收到一条进度事件调一次（算计划的四段与写盘的两段走同一个回调）。
 * @returns 落地结果；单条失败在 `problems` 里，不是抛错。
 */
export async function applySync(onProgress?: (event: SyncProgressEvent) => void): Promise<SyncResponse> {
  const response = await fetch(`${API_PREFIX}/sync?mode=apply`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
  })
  return readSyncResponse(response, onProgress, '同步')
}

/** `GET|POST /sync?mode=test` 的响应：一次只读探测的结论（判定码在宿主侧，句子在界面）。 */
export interface SyncTestResponse {
  mode: 'test'
  remote: { url: string; machineId: string }
  code:
    | 'ok'
    | 'unauthenticated'
    | 'forbidden'
    | 'notFound'
    | 'unsupported'
    | 'unreachable'
    | 'serverError'
    | 'other'
  /** 判定依据的状态码；传输层错误（DNS / 连接 / TLS / 超时）为 0。 */
  status: number
  /** 远端已经有 `dsh-session-manager/` 这一层。 */
  namespaceExists: boolean
  /** 这一层里已有的机器格（按名字排序）。 */
  machines: string[]
  /** 这一层里的直接子项数。 */
  entries: number
  /** 失败时的原始一句话（状态行或异常消息）；连得上时不带。 */
  detail?: string
  /** 这次用的用户名；没配就是 `null`。 */
  username: string | null
  /** 这次到底有没有拿到密码（值不会回来，只有"有没有"）。 */
  hasPassword: boolean
}

/**
 * 探一次远端：只读两次 PROPFIND，不改远端任何东西。
 *
 * 按**已保存的**配置测（宿主运行时按配置现读、密码从凭据库现解析），所以界面上有未保存的草稿时不该
 * 调它——那会拿旧地址、旧密码测出一个结论。
 */
export async function testSync(): Promise<SyncTestResponse> {
  return asJson<SyncTestResponse>(
    await fetch(`${API_PREFIX}/sync?mode=test`, { headers: { accept: 'application/json' } }),
  )
}

// ---- 会话管理：迁移 / 备份 / 回滚 ----

/** 预演里的一条会话（宿主 `MigrationPreview.sessions`）。 */
export interface PreviewSession {
  id: string
  /** 折叠出的标题；没有时界面显示 id。 */
  title?: string
  createdAt: number
  registered: boolean
  alreadyAtTarget: boolean
  sourceDir: string
  targetDir: string
  files: number
  bytes: number
  /** 级联带进来的：点名的那个祖先会话（点名的几条自己没有这一项，见宿主 SessionMove.via）。 */
  via?: { id: string; title?: string }
}

/** 迁移预演的结果（宿主 `MigrationPreview`）。 */
export interface MigrationPreview {
  ok: boolean
  problems: string[]
  /** 源工作区目录；未分组来源时是空串（见 `unowned`）。 */
  from: string
  to: string
  /** 源项目目录；未分组来源时是空串（源不是一个目录）。 */
  sourceProjectDir: string
  targetProjectDir: string
  /** 源是不是那个跨目录的「未分组」（界面据此换一句项目目录说明）。 */
  unowned: boolean
  /** 本次会搬动的会话各自所在的源项目目录（去重、排序）；未分组来源下不止一个。 */
  sourceProjectDirs: string[]
  sessions: PreviewSession[]
  /** 级联带进来的条数：点名的会话的子代理后代。 */
  cascaded: number
  files: number
  bytes: number
  artifacts: {
    moves: number
    problems: string[]
    skipped: Array<{ path: string; reason: string; sessionId?: string }>
  } | null
  registryChange: {
    targetId: string
    targetPath: string
    createdTarget: boolean
    added: string[]
    adoptedFromUnowned: string[]
    movedFrom: Array<{ workspaceId: string; path: string; sessionIds: string[] }>
    removedSources: Array<{ workspaceId: string; path: string }>
    unchanged: boolean
  } | null
  summary: string
}

/** 迁移请求（与宿主 `MigrateRequest` 同形）。 */
export interface MigrationRequest {
  mode: 'plan' | 'apply'
  /** 源目录；`unowned` 为 true 时是空串（那时源不是一个目录）。 */
  from: string
  to: string
  /**
   * 源取"注册表没认领且有 cwd 的会话"（外壳侧边栏的「未分组」），而不是某个目录。
   * 与 `from` 互斥；界面上的哨兵值（planRows.UNOWNED_SOURCE）到这里才翻译成这个字段。
   */
  unowned?: boolean
  sessionIds?: string[] | null
  title?: string
  includeUnowned?: boolean
  includeArtifacts?: boolean
}

/** 迁移响应。 */
export interface MigrationResponse {
  mode: 'plan' | 'apply'
  ok: boolean
  preview: MigrationPreview
  applied: boolean
  rewritten: number
  moved: number
  artifactsMoved: number
  verified: boolean
  backupDir?: string
  problems: string[]
  summary: string
  takesEffect: 'immediate' | 'restart-required'
  error?: string
}

/** 备份清单里的一条。 */
export interface BackupSummary {
  dir: string
  createdAt: string
  sessions: number
  artifacts: number
  /** 这份备份是迁移留下的还是删除留下的（老备份缺字段 = 迁移）。 */
  kind?: 'migrate' | 'delete'
  from?: string
  to?: string
}

/** `GET /backups` 的响应。 */
export interface BackupsResponse {
  backupRoot: string
  backups: BackupSummary[]
}

/** 回滚响应。 */
export interface RollbackResponse {
  mode: 'plan' | 'apply'
  dryRun: boolean
  actions: string[]
  restoredFiles: number
  restoredArtifacts: number
  registryRestored: boolean
  backupDir: string
  createdAt: string
  sessions: number
  artifacts: number
  takesEffect: 'immediate' | 'restart-required'
}

/**
 * 迁移或只预演。
 *
 * 预演与落地都可能回非 2xx（计划有问题 → 409；复核没过 → 500），而这两种情况**正文里带着
 * 完整结果**，所以这里不按 `ok` 提前抛，交给页面把 problems 摆出来。
 */
export async function migrate(request: MigrationRequest): Promise<MigrationResponse> {
  const response = await fetch(`${API_PREFIX}/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  const text = await response.text()
  let parsed: MigrationResponse
  try {
    parsed = JSON.parse(text) as MigrationResponse
  } catch {
    throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  }
  // 判据是"正文里有没有完整结果"，而不是状态码：带 preview 的 409/500 是**结果**（计划有问题 /
  // 复核没过），页面必须把它摆出来；不带 preview 的 400 是参数被拒，当成异常抛给错误横幅。
  if (parsed.preview === undefined) throw new Error(parsed.error ?? `HTTP ${response.status}`)
  return parsed
}

/** 列出本插件的备份。 */
export async function fetchBackups(): Promise<BackupsResponse> {
  return asJson<BackupsResponse>(await fetch(`${API_PREFIX}/backups`, { headers: { accept: 'application/json' } }))
}

/** 回滚一份备份；`dryRun` 只回动作清单。 */
export async function rollbackBackup(backupDir: string, dryRun: boolean): Promise<RollbackResponse> {
  return asJson<RollbackResponse>(
    await fetch(`${API_PREFIX}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backupDir, dryRun }),
    }),
  )
}

// ---- 会话管理：删除 / 归档 ----

/** 删除预演里的一条会话（宿主 `RemovalPlan.entries`）。 */
export interface DeleteEntry {
  id: string
  /** 折叠出的标题；没有时界面显示 id。 */
  title?: string
  createdAt: number
  /** 会被整个删掉的会话目录。 */
  dir: string
  files: Array<{ name: string; bytes: number }>
  bytes: number
  /** 宿主内存里活着（这种会被预演挡下，正常不会出现在条目里）。 */
  live: boolean
  /** 日志 header 里的 `origin`（子代理会话写 `subagent`）。 */
  origin?: string
  /** 级联带进来的：点名的那个祖先会话（点名的那几条自己没有这一项，见宿主 `RemoveEntry.via`）。 */
  via?: { id: string; title?: string }
}

/** 删除（预演或落地）的响应。 */
export interface DeleteResponse {
  mode: 'plan' | 'apply'
  ok: boolean
  preview: {
    ok: boolean
    problems: string[]
    entries: DeleteEntry[]
    files: number
    bytes: number
    /** 备份根（执行时真实落下的那一个在 `backupDir`）。 */
    backupRoot: string
  }
  applied: boolean
  dirsRemoved: number
  removedProjectDirs: string[]
  verified: boolean
  backupDir?: string
  problems: string[]
  summary: string
  error?: string
}

/**
 * 删除会话（`mode: 'apply'` 才真删，且**先备份再删**）。
 *
 * 与 `migrate()` 同一套判据：正文里带 `preview` 的 409/500 是**结果**（计划不 ok / 复核没过），
 * 页面必须把它摆出来；不带 `preview` 的才是异常。
 */
export async function deleteSessions(
  sessionIds: readonly string[],
  mode: 'plan' | 'apply',
): Promise<DeleteResponse> {
  const response = await fetch(`${API_PREFIX}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionIds, mode }),
  })
  const text = await response.text()
  let parsed: DeleteResponse
  try {
    parsed = JSON.parse(text) as DeleteResponse
  } catch {
    throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  }
  if (parsed.preview === undefined) throw new Error(parsed.error ?? `HTTP ${response.status}`)
  return parsed
}

/** 归档或取消归档的响应。 */
export interface ArchiveResponse {
  ok: boolean
  /** 成功的那些 id。 */
  archived: string[]
  /** 逐条的失败原因（一条失败不影响其余）。 */
  failed: Array<{ id: string; error: string }>
  /** 宿主服务"落盘 + 改内存 + 广播"一次做完，所以必然即时生效。 */
  takesEffect: 'immediate'
  error?: string
}

/**
 * 归档或取消归档所选会话。
 *
 * 走宿主能力，所以**不需要重启**；宿主不在（非 Web profile）时接口回 409 且不带 `failed`，
 * 那时按异常抛给错误横幅（区别于"部分失败"那种要逐条摆出来的结果）。
 */
export async function archiveSessions(
  sessionIds: readonly string[],
  archived: boolean,
): Promise<ArchiveResponse> {
  const response = await fetch(`${API_PREFIX}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionIds, archived }),
  })
  const text = await response.text()
  let parsed: ArchiveResponse
  try {
    parsed = JSON.parse(text) as ArchiveResponse
  } catch {
    throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  }
  if (!Array.isArray(parsed.failed)) throw new Error(parsed.error ?? `HTTP ${response.status}`)
  return parsed
}
