/**
 * 界面与宿主端点之间的唯一通道。
 *
 * 为什么不走 Remote/typert：本页要的是**二进制**（下载一个包、上传一个包），而 Remote 那套是
 * 结构化调用面；宿主已经为本插件开了自己的路由，同源 `fetch` 是最短路径，也省掉一层描述符。
 *
 * 端点由 `src/web.ts` 注册，路径固定在本插件命名空间下（`/dsh-session-manager/api`）。
 *
 * **长动作回的都是事件流**（`/state`、`/migrate`、`/delete`、`/rollback`、`/import`、`/archive`、
 * `/sync`）：按下之后到结束之间的每一段都会推一条 `progress` 事件，界面据此画进度。参数不对、
 * 宿主没这个能力这类**在流开始之前**就挡下的错，回的仍然是一次性 JSON + 状态码；`readEventStream()`
 * 按 `content-type` 分流，所以调用方两种形状都认。
 *
 * @module dsh-session-manager/client/api
 */

import { SseFrames, interpretStreamEvent, type ProgressEvent } from './logic/eventStream.ts'

// 事件流的分帧与解释在 eventStream.ts（那份文件与 DOM 无关，所以 Host 侧的测试图能直接引它）。类型
// 从这里转出去，界面那一侧只认 api.ts 一个入口。
export type { ProgressEvent }

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
   * 界面不再自己从"有没有工作区认领"推：那样推出来的「未分组」把子智能体、空白、已归档也算进去，
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
  /** 日志 header 里的 `origin`（只有子智能体会话会写）。 */
  origin?: string
  /** 日志 header 里的 `parentSession`：这条子智能体挂在哪条会话下面（列表据此缩进一级）。 */
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

/**
 * `GET /meta` 的响应：会话库位置与宿主的能力位。
 *
 * 它不扫库，所以总是先于 `/state` 回来；`/state` 的响应是它的**超集**（同样这几个字段，另加清单）。
 * 界面据此在"清单还在读"的那段时间里也能把库在哪、能不能归档先说清楚。
 */
export interface MetaResponse {
  sessionsRoot: string
  registryPath: string
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
}

/** `GET /state` 的响应：`/meta` 那几项 + 这次扫库扫出来的清单。 */
export interface StateResponse extends MetaResponse {
  /**
   * 目录 → 项目身份（仓库的 git remote，规范成 `host/owner/repo`，见宿主 `src/repo.ts`）。
   *
   * 界面把它显示在原来印本机路径的地方：路径是机器特有的，同一个项目在两台机器上可以落在完全不同的
   * 目录里，而 `host/owner/repo` 是仓库自己的名字。认不出来的目录不在表里（不是仓库、没有 remote、
   * 目录已经不在），界面退回显示路径；缺字段（旧宿主）按空表处理。
   */
  repos?: Record<string, string>
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

/**
 * 一次性响应：流还没开始就被挡下（参数不对、没配同步、方法不对、内部错误）时宿主回的是普通 JSON，
 * 带状态码。这里保持与其它端点同一套口径——把宿主给的原话抛出去。
 */
async function readOneShot<T>(response: Response): Promise<T> {
  const text = await response.text()
  let parsed: { error?: string } | null = null
  try {
    parsed = JSON.parse(text) as { error?: string }
  } catch {
    // 不是 JSON：下面统一把原文截一段报出去，比"解析失败"有用。
  }
  if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  if (parsed === null) throw new Error(`HTTP ${response.status}：${text.slice(0, 200) || '空响应'}`)
  return parsed as T
}

/**
 * 按 `content-type` 把一个长动作的响应读出来：事件流就边读边报进度，一次性 JSON 就整份解析。
 *
 * @param response 宿主回的那份响应。
 * @param onProgress 进度事件的回调（只有流走得到）。
 * @param what 出错时的主语（「预演」「同步」「迁移」…）。
 */
async function readEventStream<T>(
  response: Response,
  onProgress: ((event: ProgressEvent) => void) | undefined,
  what: string,
): Promise<T> {
  // 流开始之前的错（参数被拒、没配置同步、内部错误）仍然是一次性 JSON。
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) return await readOneShot<T>(response)

  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error(`这次${what}没有可读的事件流（浏览器不支持流式响应）`)
  // 分帧与解释都在 eventStream.ts（纯字符串处理，没有 DOM）；这里只负责把字节读出来喂进去。
  const frames = new SseFrames()
  const decoder = new TextDecoder()
  // 收尾那条事件可能不带 `result`（`undefined` 也是合法负载），所以"收到没收到"单独记一个位，
  // 而不是拿值的真假去判。
  let result: T | undefined
  let sawResult = false
  let failure: string | null = null
  const handle = (data: string): void => {
    const event = interpretStreamEvent(data)
    if (event === null) return
    if (event.kind === 'progress') onProgress?.(event.progress)
    else if (event.kind === 'result') {
      result = event.result as T
      sawResult = true
    } else {
      // 宿主只说了一句 `{type:'error'}` 时补上主语，别让界面上出现一个空字符串。
      failure = event.message === '' ? `${what}失败` : event.message
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const data of frames.push(decoder.decode(value, { stream: true }))) handle(data)
  }
  for (const data of frames.flush()) handle(data)

  if (failure !== null) throw new Error(failure)
  if (!sawResult) throw new Error(`${what}没有回结果（连接提前断了？）`)
  return result as T
}

/**
 * 读会话库位置与宿主能力位（不扫库，先于 `/state` 到）。
 *
 * 拿不到时**不该**把整页变成错误：这几项只是"先说清楚"，清单那条路（`fetchState`）照样能把它带回来
 * ——页头因此退回"读取中…"，而不是白屏（见 ManagerPanel 的 load）。
 */
export async function fetchMeta(): Promise<MetaResponse> {
  return asJson<MetaResponse>(await fetch(`${API_PREFIX}/meta`, { headers: { accept: 'application/json' } }))
}

/**
 * 读会话库与工作区清单。
 *
 * 走事件流：这一份要扫完整库（每条会话读 header、折标题），冷启动或大库上是几秒的活，整页都在等它。
 * 拿到之前界面上只有一句「读取中…」，现在跟着 `scan` 那一段一起报"扫到第几条"。
 *
 * @param onProgress 每收到一条进度事件调一次。
 */
export async function fetchState(onProgress?: (event: ProgressEvent) => void): Promise<StateResponse> {
  const response = await fetch(`${API_PREFIX}/state`, { headers: { accept: 'text/event-stream' } })
  return readEventStream<StateResponse>(response, onProgress, '读取会话库')
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
  /** 包里实际有几条会话（宿主回报）：勾一条父会话时它的子智能体跟着进包，比勾选数多。 */
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
  // 包里到底几条 / 多少字节：界面那句"已导出 N 条"说的是包里的东西，而包里可能多了跟来的子智能体。
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
  onProgress?: (event: ProgressEvent) => void,
): Promise<ImportResponse> {
  const url = `${API_PREFIX}/import?mode=${mode}&targetCwd=${encodeURIComponent(targetCwd)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', accept: 'text/event-stream' },
    body: bytes,
  })
  /*
   * 包本身读不动、落地目录不在这类判定发生在**收到请求体之后、流开始之前**，回的是 400 + JSON；
   * 一旦开始干活（预演逐条读包、落地逐条写盘）就是事件流，正文从 `result` 事件里拿。
   */
  return readEventStream<ImportResponse>(response, onProgress, '导入')
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
  /** `replace` = 本机原来那份被这条顶掉（旧的那份先备份）。 */
  action: 'create' | 'replace' | 'skip'
  /** 机器可读的分类：界面按它挑文案（`reason` 是给模型看的细节）。 */
  code: 'missing' | 'remote-ahead' | 'remote-newer' | 'blank-local' | 'no-mapping' | 'missing-target'
  reason?: string
}

/** 一次同步里"会推送"的一条。 */
export interface SyncPushEntry {
  id: string
  title?: string
  cwd?: string
  bytes: number
  action: 'upload' | 'update' | 'skip'
  /** `local-newer` = 两边各自写过、本机这份更新（`local-ahead` 是"远端确实是本机这份的前缀"）。 */
  code: 'missing' | 'local-ahead' | 'local-newer' | 'identical' | 'remote-ahead' | 'diverged'
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
  /** 本机判为空白、这次不参与同步的会话 id（界面只拿它说一句"跳过 N 条"）。 */
  blank: string[]
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
  /** `pulled` 里"覆盖掉本机原来那份"的那些（旧的那份在备份里；界面据此多说一句）。 */
  replaced: string[]
  pushed: Array<{ id: string; action: 'upload' | 'update' }>
  bytesIn: number
  bytesOut: number
  registryWritten: boolean
  indexWritten: boolean
  problems: string[]
  /**
   * 这次同步要不要重启 DSH 才被承认（与迁移/导入同一套口径）。
   *
   * 落地那次说的是**实际结果**；预演那次说的是"执行时会不会需要"（按宿主端口的探测）——界面靠它在
   * 按下「确认同步」之前就把这句话摆出来。两种模式都只在真有会话要落到本机时才谈得上生效。
   */
  takesEffect: 'immediate' | 'restart-required'
  error?: string
}

/**
 * 预演一次同步（读远端，什么都不写），边算边报进度。
 *
 * 宿主对预演与落地回的都是 **SSE**：预演要先扫本机（每条会话读头、折标题）、再读远端索引、最后逐条
 * 比对内容，冷启动时那几秒里界面原来只有一句"预演中…"；落地的理由是上百条各一次网络往返。事件形状
 * 两条路完全一样，所以 `readEventStream()` 一份就够。
 *
 * @param onProgress 每收到一条进度事件调一次。
 * @returns 计划；问题在 `problems` 里，连接层的失败抛原话。
 */
export async function fetchSyncPlan(onProgress?: (event: ProgressEvent) => void): Promise<SyncResponse> {
  const response = await fetch(`${API_PREFIX}/sync`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  })
  return readEventStream<SyncResponse>(response, onProgress, '预演')
}

/**
 * 真的跑一次同步（拉取 + 推送），边跑边报进度。
 *
 * @param onProgress 每收到一条进度事件调一次（算计划的四段与写盘的两段走同一个回调）。
 * @returns 落地结果；单条失败在 `problems` 里，不是抛错。
 */
export async function applySync(onProgress?: (event: ProgressEvent) => void): Promise<SyncResponse> {
  const response = await fetch(`${API_PREFIX}/sync?mode=apply`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
  })
  return readEventStream<SyncResponse>(response, onProgress, '同步')
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
  /** 级联带进来的条数：点名的会话的子智能体后代。 */
  cascaded: number
  /**
   * 宿主持在内存里、这次**不搬**的会话（见宿主 `MigrationPreview.liveSkipped`）。
   *
   * 它们不在 `sessions` 里：卡片必须提这一条，否则"勾了 22 条、搬走 9 条"没人解释。
   */
  liveSkipped: Array<{ id: string; title?: string; createdAt: number; cwd?: string }>
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
  /** 这份备份是哪一类操作留下的：迁移 / 删除 / 同步时覆盖本机那份（老备份缺字段 = 迁移）。 */
  kind?: 'migrate' | 'delete' | 'replace'
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
 * 回的是事件流：预演要扫源目录（未分组来源时是整个库），落地要备份、改写每份日志的首帧、搬目录、
 * 复核、请宿主补检查点——实测 47 条会话 / 67.5 MB 要 45 秒（改写首帧是大头），那段时间原来只有一个
 * 不动的按钮。
 *
 * 计划本身有问题（源目录不存在、目标被占用…）与复核没过**都还是结果**：它们带着完整的 `preview`，
 * 页面要把清单与问题摆出来，所以都从 `result` 事件回，而不是当成流的错。
 */
export async function migrate(
  request: MigrationRequest,
  onProgress?: (event: ProgressEvent) => void,
): Promise<MigrationResponse> {
  const response = await fetch(`${API_PREFIX}/migrate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(request),
  })
  const parsed = await readEventStream<MigrationResponse>(response, onProgress, '迁移')
  // 事件流那条路上正文一定带 preview（宿主把"计划有问题"也当结果回）；缺了说明对面不是本插件的宿主。
  if (parsed.preview === undefined) throw new Error(parsed.error ?? '迁移没有回计划')
  return parsed
}

/** 列出本插件的备份。 */
export async function fetchBackups(): Promise<BackupsResponse> {
  return asJson<BackupsResponse>(await fetch(`${API_PREFIX}/backups`, { headers: { accept: 'application/json' } }))
}

/** 回滚一份备份；`dryRun` 只回动作清单。 */
export async function rollbackBackup(
  backupDir: string,
  dryRun: boolean,
  onProgress?: (event: ProgressEvent) => void,
): Promise<RollbackResponse> {
  const response = await fetch(`${API_PREFIX}/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ backupDir, dryRun }),
  })
  // 回滚要逐条会话搬目录、逐文件复写字节，整库回滚同样是几十秒的活，所以它也是事件流。
  return readEventStream<RollbackResponse>(response, onProgress, '回滚')
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
  /** 日志 header 里的 `origin`（子智能体会话写 `subagent`）。 */
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
 * 回的是事件流：预演要扫整库找这些会话与它们的后代，落地要先把整份会话目录按字节备份、再逐条删、
 * 最后复核。计划本身不 ok（会话不在库里、宿主内存里活着…）与复核没过**都还是结果**——它们带着完整
 * 的 `preview`，页面要把清单与问题摆出来。
 */
export async function deleteSessions(
  sessionIds: readonly string[],
  mode: 'plan' | 'apply',
  onProgress?: (event: ProgressEvent) => void,
): Promise<DeleteResponse> {
  const response = await fetch(`${API_PREFIX}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ sessionIds, mode }),
  })
  const parsed = await readEventStream<DeleteResponse>(response, onProgress, '删除')
  // 事件流那条路上正文一定带 plan（宿主把"计划有问题"也当结果回）；缺了说明对面不是本插件的宿主。
  if (parsed.preview === undefined) throw new Error(parsed.error ?? '删除没有回计划')
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
  onProgress?: (event: ProgressEvent) => void,
): Promise<ArchiveResponse> {
  const response = await fetch(`${API_PREFIX}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ sessionIds, archived }),
  })
  // 逐条走宿主的注册表动作（每条一次落盘 + 广播），勾一整页时这一段是可感知的，所以它也报进度。
  const parsed = await readEventStream<ArchiveResponse>(response, onProgress, '归档')
  if (!Array.isArray(parsed.failed)) throw new Error(parsed.error ?? '归档没有回结果')
  return parsed
}
