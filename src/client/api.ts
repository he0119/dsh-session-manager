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
import type { TranscriptPage } from '../transcript.ts'
import type { SessionDiff } from '../session-diff.ts'

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
  /**
   * 这个目录在盘上还在不在（宿主的一次 stat，见 host 半侧的 `summarizeWorkspaces()`）。
   *
   * 缺席按"还在"处理：目标候选据它把已经不存在的那些标出来并点不动（见 `planRows.directoryTargetRows`），
   * 拿不到这个事实时退回改动之前的样子——不在界面上替宿主猜。
   */
  exists?: boolean
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
   * 这个宿主能不能重新生成会话名称（`sessionTitle` 那套服务凑不凑得齐）；
   * 缺字段（旧宿主）按 `false` 处理——按钮禁用比点了没反应好。
   */
  retitleAvailable?: boolean
  /**
   * 这个宿主有没有附件库服务（`ctx.attachments`）；有它，手动同步会顺带把附件对象对一遍。
   * 缺字段（旧宿主）按 `false` 处理——那一句里宁可不提，也别承诺一件做不到的事。
   */
  attachments?: boolean
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
  /**
   * 自动推送的当前设置（宿主把 `sync.autoPush` / `sync.autoPushIntervalMs` 拍平的结果）；
   * **没开就是 undefined**，界面据此决定要不要补那一句、要不要摆「立即推送一次」。
   *
   * 只有 `intervalMs`：那个"两次真跑之间至少隔多久"的兜底闸（`autoPushMinIntervalMs`）不进这一份
   * ——界面不摆它，摆出来只会让人以为要配两个间隔。
   */
  autoPush?: { intervalMs: number }
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

/** 导入计划里的一条附件对象。 */
export interface ImportAttachmentEntry {
  id: string
  kind: 'image' | 'file'
  bytes: number
  /** 会写下去 / 本机已有 / 落不了（宿主没有附件服务或认不出这种引用）。 */
  action: 'create' | 'present' | 'unavailable'
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
  /** 包里的附件对象（v1 的老包是空数组）。 */
  attachments: ImportAttachmentEntry[]
  /** 其中本机没有、会写下去的条数。 */
  attachmentAdds: number
  /** 会被写下去的附件字节数。 */
  attachmentBytes: number
  written?: string[]
  registryWritten?: boolean
  /** 落地时真写下去的附件对象条数与字节数。 */
  attachmentWritten?: number
  attachmentPresent?: number
  attachmentWrittenBytes?: number
  /** 没能落地的附件（宿主没有附件服务、路径写不进去…）。 */
  attachmentProblems?: string[]
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

/** 两边日志的差异（见 `src/session-diff.ts`）：这一趟只读，宿主一个字节都不写。 */
export interface SyncDiffResponse {
  id: string
  /** 远端那一份是哪台机器贡献的。 */
  machine: string
  /** 本机这份日志的文件名（代次看得出是哪一份）。 */
  localFile: string
  /** 下这一个远端包花了多少字节。 */
  bundleBytes: number
  diff: SessionDiff
}

/**
 * 取"本机这一份 vs 远端那台那份"的差异。
 *
 * `machine` 一般在计划里已经有了（推送行的 `machine`），指名就让宿主去那一台取；留给不指名的调用
 * （比如从别处直接打开）一个退路——那时宿主按远端索引里这个 id 记的那台算。
 */
export async function fetchSyncDiff(
  id: string,
  machine?: string,
  signal?: AbortSignal,
): Promise<SyncDiffResponse> {
  const query = new URLSearchParams({ id })
  if (machine !== undefined && machine !== '') query.set('machine', machine)
  const response = await fetch(`${API_PREFIX}/sync-diff?${query.toString()}`, {
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  return asJson<SyncDiffResponse>(response)
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
  /** 包里带走的附件对象条数与字节数（宿主回报；没有附件服务的宿主上是 0）。 */
  attachments?: number
  attachmentBytes?: number
  /** 日志引用了、但本机附件库里找不到的对象条数（这几个对象这次带不走，图在别的机器上会挂）。 */
  attachmentsMissing?: number
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
  // 附件那几枚：带走了几个对象、多少字节，以及本机库里缺的那几个（见宿主 exportSessions）。
  const attachments = numberHeader(response, 'x-dsh-attachment-count')
  const attachmentBytes = numberHeader(response, 'x-dsh-attachment-bytes')
  const attachmentsMissing = numberHeader(response, 'x-dsh-attachment-missing')
  // 文件名以宿主的 Content-Disposition 为准；这条兜底只在没有响应头时用，后缀与它保持一致。
  return {
    blob: await response.blob(),
    filename: matched?.[1] ?? 'dsh-sessions.dshsess',
    ...(count === undefined ? {} : { count }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(attachments === undefined ? {} : { attachments }),
    ...(attachmentBytes === undefined ? {} : { attachmentBytes }),
    ...(attachmentsMissing === undefined ? {} : { attachmentsMissing }),
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

/*
 * `download()` 用到的那一小片 DOM 面，**就地写出来**而不是靠全局的 `document` / `HTMLAnchorElement`：
 * 本文件同时被两套工程检查——`tsconfig.client.json` 带 DOM（真实那一套），而 `tsconfig.test.json` 是
 * Host 侧的、**没有 DOM lib**（那份工程存在的意义就是"浏览器 API 出现在 Host 代码里"在类型层面不
 * 成立）。测试要引本文件里的纯逻辑（`runAutoPushNow()` 之类）时就会把它拉进没有 DOM 的那一套，于是
 * 那几行把整个测试工程卡住——而"从测试里 import api.ts"是本仓库既有的写法
 * （见 test/browser-auto-push.test.ts）。
 *
 * 声明的是**用到的那几个成员**，不是一整套 DOM：`download()` 只做"造一个隐藏的 a、点一下、撤掉"。
 * 真实浏览器里运行时拿到的当然就是那两样全局对象；这里只是让类型检查在两种 lib 下都说得通。
 */
interface DownloadAnchor {
  href: string
  download: string
  style: { display: string }
  click(): void
  remove(): void
}

interface DownloadDocument {
  createElement(tag: 'a'): DownloadAnchor
  body: { appendChild(node: unknown): void }
}

/** 触发浏览器下载。 */
export function download(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob)
  const doc = (globalThis as unknown as { document: DownloadDocument }).document
  const anchor = doc.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.style.display = 'none'
  doc.body.appendChild(anchor)
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
  code:
    | 'missing'
    | 'remote-ahead'
    | 'remote-newer'
    | 'blank-local'
    | 'no-mapping'
    | 'missing-target'
    | 'keep-remote'
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
  code: 'missing' | 'local-ahead' | 'local-newer' | 'identical' | 'remote-ahead' | 'diverged' | 'keep-local'
  /** 远端那份由哪台机器贡献（"远端领先 / 两边各自写过"要指名道姓）。 */
  machine?: string
  reason?: string
}


/** 两边各自写过时用户挑的正本：`keep-local` 以本机这份为准、`keep-remote` 以远端那份为准。 */
export type SyncDecision = 'keep-local' | 'keep-remote'

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
  /**
   * 这次预演的号码：确认那次带上它，宿主就照着这份计划落地、不再重算一遍（见 `applySync()`）。
   *
   * 只有预演（`mode: 'plan'`）会给；落地那次的响应里没有它。
   */
  planId?: string
  applied: boolean
  pulled: string[]
  /** `pulled` 里"覆盖掉本机原来那份"的那些（旧的那份在备份里；界面据此多说一句）。 */
  replaced: string[]
  pushed: Array<{ id: string; action: 'upload' | 'update' }>
  bytesIn: number
  bytesOut: number
  /**
   * 附件对象那一段（远端共享库里搬的那些，见宿主 `SyncOutcome`）：按对象计，不按引用计。
   *
   * 缺席 = 这个宿主没有附件服务（**不是"零个对象"**）：界面据此一个字都不说，而不是报一串 0。两项都
   * 只在落地那次的响应里可能有（预演不知道远端有哪些对象）。
   */
  attachmentIn?: { written: number; present: number; bytes: number }
  attachmentOut?: { uploaded: number; skipped: number; bytes: number; missing: number }
  registryWritten: boolean
  indexWritten: boolean
  problems: string[]
  /**
   * 这次落地走的哪条路（只有"先预演、后确认"那条路会给）。
   *
   * `reused` = 预演之后本机与远端都没变，照着预演那份计划落的盘；`recomputed` = 有一处对不上（`reason`
   * 说明是哪一处），宿主这次从零重算了一遍——界面据此说一句，免得计划与结果对不上时没人解释。
   */
  planSource?: { kind: 'reused' } | { kind: 'recomputed'; reason: string }
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
export async function fetchSyncPlan(
  onProgress?: (event: ProgressEvent) => void,
  decisions?: ReadonlyMap<string, SyncDecision>,
): Promise<SyncResponse> {
  // 带有裁决的预演必须走 POST：GET 没有请求体，宿主那侧就不知道用户替哪一对挑了正本。没有裁决时
  // 仍用 GET，保持"预演本来就不写任何东西"的样子。
  const body =
    decisions === undefined || decisions.size === 0
      ? undefined
      : JSON.stringify({ decisions: Object.fromEntries(decisions) })
  const response = await fetch(`${API_PREFIX}/sync`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'text/event-stream',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  })
  return readEventStream<SyncResponse>(response, onProgress, '预演')
}

/**
 * 真的跑一次同步（拉取 + 推送），边跑边报进度。
 *
 * 把预演给的 `planId` 带上：宿主对得上就**照着那份计划落地**，不再把同一份计划重算一遍（用户按下确认
 * 到第一条拉取之间原来要等的那几秒正是它），对不上（宿主重启过、又一次预演把它换掉了）就照旧从零
 * 算一遍；响应里的 `planSource` 说清这次走的哪条路。
 *
 * @param planId 预演那次响应里的 `planId`；没有（旧调用方 / 没有预演数据）就按"从零算一遍"处理。
 * @param onProgress 每收到一条进度事件调一次。
 * @returns 落地结果；单条失败在 `problems` 里，不是抛错。
 */
export async function applySync(
  planId?: string,
  onProgress?: (event: ProgressEvent) => void,
  decisions?: ReadonlyMap<string, SyncDecision>,
): Promise<SyncResponse> {
  const body: { planId?: string; decisions?: Record<string, SyncDecision> } = {}
  if (planId !== undefined && planId !== '') body.planId = planId
  if (decisions !== undefined && decisions.size > 0) body.decisions = Object.fromEntries(decisions)
  const response = await fetch(`${API_PREFIX}/sync?mode=apply`, {
    method: 'POST',
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readEventStream<SyncResponse>(response, onProgress, '同步')
}

/**
 * `GET /sync?mode=status` 的响应：后台有没有一趟落地在跑、刚才那一趟成没成。
 *
 * 为什么要这条只读端点：落地这趟可以**关掉窗口继续跑**（见 [syncJob.ts](./logic/syncJob.ts)），于是它
 * 会比发起它的那个页面活得久。刷新之后的页面、另一个页签都靠这一份知道"刚才那一趟还在跑 / 刚跑完"，
 * 而不是点下去才吃一个 409。
 */
export interface SyncStatusResponse {
  /** 正在跑的那一趟；`null` = 没有。`progress` 是宿主记下的最后一条进度事件。 */
  applying: { startedAt: number; progress: ProgressEvent | null } | null
  /** 最近一次落地的结论（宿主进程内存里只留一份，重启就没了）。 */
  last: {
    startedAt: number
    finishedAt: number
    ok: boolean
    pulled: number
    pushed: number
    error?: string
  } | null
}

/**
 * 问一次后台同步的状态。只读：不扫库、不碰远端。
 *
 * @returns 正在跑的那一趟与最近一次落地的结论。
 */
export async function fetchSyncStatus(): Promise<SyncStatusResponse> {
  return asJson<SyncStatusResponse>(
    await fetch(`${API_PREFIX}/sync?mode=status`, { headers: { accept: 'application/json' } }),
  )
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

// ---- 自动推送（只推不拉） ----

/**
 * `GET /auto-push` 的响应：**当场**跑一轮自动推送的结论。
 *
 * 与 `/sync` 的落地响应同形的那几个字段（`plan` / `pulled` / `pushed` / `bytesIn` / `bytesOut` /
 * `problems` / `takesEffect` / `planSource`）只在**真跑了**的那一次才有；没跑（`ran: false`）时它
 * 只报"是因为什么没跑"。`skip` 是机器可读的原因，句子在界面这一侧挑（见 `autoPushSentence()`）。
 */
export interface AutoPushResponse {
  mode: 'auto-push'
  remote: { url: string; machineId: string }
  /** 这一轮真跑了没有。 */
  ran: boolean
  /** 没跑的原因：没开 / 节拍没到 / 上一轮还在跑 / 没有可推送的。 */
  skip?: 'disabled' | 'interval' | 'busy' | 'settle' | 'idle'
  /** 已经连续失败几次（成功清零）。界面据此在连续失败时说一句。 */
  failures: number
  /** 最近一次失败 / 问题的原话。 */
  problem?: string
  /** 真跑了才有（与 `/sync` 的落地响应同形）。 */
  plan?: SyncPlan
  pulled?: string[]
  pushed?: Array<{ id: string; action: 'upload' | 'update' }>
  bytesIn?: number
  bytesOut?: number
  /** 这一轮补进远端共享库的附件对象（缺席 = 宿主没有附件服务，或这次一个对象都没动）。 */
  attachmentOut?: { uploaded: number; skipped: number; bytes: number; missing: number }
  problems?: string[]
  takesEffect?: 'immediate' | 'restart-required'
  planSource?: { kind: 'reused' } | { kind: 'recomputed'; reason: string }
}

/**
 * 当场跑一轮自动推送：只把本机的会话推到远端，**一个字节都不拉**，也不动本机任何会话。
 *
 * 回的是事件流（与 `/sync` 同一套事件形状，宿主那侧标 `what: 'auto-push'`），所以进度能画在页面
 * 横幅上。这条路上**没有预演 / 确认**那一步：它只推不改本机，按下去就是一次。
 *
 * 没配置同步、或这个宿主没有自动推送的节拍器时，宿主回一次性 JSON + 409，`readEventStream()` 按
 * `content-type` 分流，异常里带的是宿主的原话。
 *
 * @param onProgress 每收到一条进度事件调一次。
 * @returns 这一轮的结论；单条失败在 `problems` 里，不是抛错。
 */
export async function runAutoPushNow(
  onProgress?: (event: ProgressEvent) => void,
): Promise<AutoPushResponse> {
  const response = await fetch(`${API_PREFIX}/auto-push`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  })
  return readEventStream<AutoPushResponse>(response, onProgress, '自动推送')
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
  /** 点名的会话 id：**源就是它们**（勾选可以跨目录，见宿主 `MigrateRequest.sessionIds`）。 */
  sessionIds: string[]
  to: string
  /**
   * 这次涉及的来源项目目录（会话日志那一层，去重排序）；来源目录本身不必还在盘上。
   * 多于一处的来源就是"勾选跨目录"，卡片照实列出来。
   */
  sourceProjectDirs: string[]
  targetProjectDir: string
  sessions: PreviewSession[]
  /** 级联带进来的条数：点名的会话的子智能体后代。 */
  cascaded: number
  /**
   * 宿主持在内存里、这次**不搬**的会话（见宿主 `MigrationPreview.liveSkipped`）。
   *
   * 它们不在 `sessions` 里：卡片必须提这一条，否则"勾了 22 条、搬走 9 条"没人解释。
   */
  liveSkipped: Array<{ id: string; title?: string; createdAt: number; cwd?: string }>
  /**
   * 源工作区搬完还剩人、因此**不会被删**的那几块（见宿主 `MigrationPreview.strandedSources`）。
   *
   * 留下的那几条侧边栏不显示（已归档 / 空白 / 子智能体），卡片必须提这一条：不提的话用户看到的就是
   * "整个来源都迁完了，怎么侧边栏里还留着一块一条都不显示的工作区"。
   */
  strandedSources: Array<{
    workspaceId: string
    path: string
    title: string
    members: Array<{ id: string; title?: string; reason: 'subagent' | 'blank' | 'archived' }>
  }>
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
    /** 顺带摘掉的悬空登记（宿主本来就不认它们，见宿主 `RegistryChange.droppedStale`）。 */
    droppedStale: Array<{ workspaceId: string; path: string; sessionIds: string[] }>
    unchanged: boolean
  } | null
  summary: string
}

/** 迁移请求（与宿主 `MigrateRequest` 同形）。 */
export interface MigrationRequest {
  mode: 'plan' | 'apply'
  /** 要迁移的会话 id（**必填、非空**）：源就是它们，各自从自己的 `cwd` 来。 */
  sessionIds: string[]
  to: string
  title?: string
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
  /** 全部会话同源时那个来源目录；勾选跨目录的那次没有单一答案，因此缺省（见 `sourceDirs`）。 */
  from?: string
  to?: string
  /** 这次迁移涉及几个来源目录（勾选跨目录时用它说清"从哪儿来"）。 */
  sourceDirs?: number
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
 * 回的是事件流：预演要扫整库（点名的会话可能散在任意项目目录里），落地要备份、改写每份日志的首帧、
 * 搬目录、复核、请宿主补检查点——实测 47 条会话 / 67.5 MB 要 45 秒（改写首帧是大头），那段时间原来
 * 只有一个不动的按钮。
 *
 * 计划本身有问题（目标不存在、项目目录同名…）与复核没过**都还是结果**：它们带着完整的 `preview`，
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

/** 一条会话重算后的标题（或"没变"）。 */
export interface RetitleEntry {
  id: string
  title: string
}

/** 重新生成名称的响应（宿主 `src/retitle.ts` 的 `RetitleResult`）。 */
export interface RetitleResponse {
  ok: boolean
  /** provider 给出**不同**标题的那些。 */
  retitled: RetitleEntry[]
  /** 重算过但标题没变的那些（模型认为现有的仍然贴切）。 */
  unchanged: RetitleEntry[]
  /**
   * 没被重算的那些，附原因。
   *
   * `reason` 是与宿主共用的词汇（`src/types.ts` 的 `RetitleSkipReason`）：`pinned`（用户改过名）、
   * `subagent`、`no-human-message`、`no-request-route`（这条会话没有过主模型请求）、
   * `no-title-provider`（宿主没装名称 provider）、`not-found`。
   */
  skipped: Array<{ id: string; reason: string }>
  /** 逐条的失败原因（一条失败不影响其余）。 */
  failed: Array<{ id: string; error: string }>
  error?: string
}

/**
 * 重新生成所选会话的标题。
 *
 * 逐条请宿主的名称服务重算（每条都要整份解一次日志再跑一次模型调用），所以走事件流报进度；
 * 宿主没有名称服务时接口回 409 且不带 `retitled`，那时按异常抛给错误横幅。
 */
export async function retitleSessions(
  sessionIds: readonly string[],
  onProgress?: (event: ProgressEvent) => void,
): Promise<RetitleResponse> {
  const response = await fetch(`${API_PREFIX}/retitle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ sessionIds }),
  })
  const parsed = await readEventStream<RetitleResponse>(response, onProgress, '重新生成名称')
  if (!Array.isArray(parsed.retitled)) throw new Error(parsed.error ?? '重新生成名称没有回结果')
  return parsed
}

/** 内容视图顶上那几行事实（与 `/transcript` 响应里的 `session` 同形）。 */
export interface TranscriptFacts {
  id: string
  /** 与列表里显示的是同一个标题（宿主那侧同源折出来的）。 */
  title: string | null
  cwd: string | null
  createdAt: number
  /** 这次解析的那份日志文件的字节数。 */
  bytes: number
  /** 代次文件名（`session.v4.jsonl.zstd`）。 */
  file: string
  /** 格式代次；`generations` 是这条会话目录里一共有几代（> 1 说明另有历史档）。 */
  generation: number
  generations: number
}

/** 一页会话内容：核心层解析出来的条目与计数，加上这条会话的事实。 */
export interface TranscriptResponse extends TranscriptPage {
  session: TranscriptFacts
}

/**
 * 读一页会话内容。
 *
 * 逐条解析日志（不经过宿主），一次一页：`from` 是**事件位**（不是日志里的 `seq`——那个会跳号），
 * 响应里的 `nextCursor` 就是下一页该传的 `from`，缺席说明读到日志末尾了。`maxChars` 给单格文本的
 * 上限（「查看全文」按 `from=<那一条>&limit=1&maxChars=…` 取回来）。
 *
 * 宿主那侧的三处拒绝（400 缺 id、404 库里没这条、422 整份读不出来）都由 `asJson` 抛成异常，
 * 界面照原话摆出来。
 */
export async function fetchTranscript(
  id: string,
  options: { from?: number; limit?: number; maxChars?: number } = {},
): Promise<TranscriptResponse> {
  const query = new URLSearchParams({ id })
  if (options.from !== undefined) query.set('from', String(options.from))
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.maxChars !== undefined) query.set('maxChars', String(options.maxChars))
  const response = await fetch(`${API_PREFIX}/transcript?${query.toString()}`, {
    headers: { accept: 'application/json' },
  })
  return asJson<TranscriptResponse>(response)
}
