// src/web.ts — 浏览器界面用的宿主路由（插件设置页的数据面）。
//
// 界面在 Web 端，真正的读写必须在宿主进程里做：会话库在磁盘上、注册表由宿主持有内存副本，
// 浏览器那一侧既没有权限也不该有。因此这一层只做三件事——**列**、**迁移**、**传输**——
// 并把每次写入的边界条件（目标目录必须真实存在、包必须自校验通过、冲突只跳过不覆盖、回滚只能
// 回滚自己写下的备份）挡在宿主这一侧，而不是指望界面传对参数。
//
// 编排本身在 `src/migrate.ts`（工具层与这一层共用一份），本模块只负责 HTTP 形状：
// 读参数、翻译成那边认识的请求、把结果按 JSON 回给界面。
//
// 与 webServer 服务解耦：本模块只要求一个 `{ register(route) }`，测试里用假 req/res 直接打
// handler，不必起 HTTP 服务。路由路径固定在本插件命名空间下，`(kind, path)` 与别的插件不会撞。
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { scanAll, type DiscoveredSession } from './discovery.ts'
import {
  assertBackupDir,
  listBackups,
  loadRegistryForWrite,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
  type MigrateRequest,
} from './migrate.ts'
import { familyOf, loneSubagents } from './family.ts'
import { projectionCacheDir } from './paths.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import { runRemoval, type RemoveDeps, type RemovalRun } from './remove.ts'
import { createTitleResolver, type TitleQuery } from './session-title.ts'
import { runSync, testSyncConnection, type SyncOutcome, type SyncProgress } from './sync.ts'
import { type EffectMode, type PickerKind, type RegistryOps, type ResolvedPaths, type SyncInfo, type SyncRuntime } from './tools.ts'
import {
  applyImport,
  buildBundle,
  planImport,
  readBundle,
  type BundleSourceInfo,
  type ImportPlan,
  type ImportOptions,
} from './transfer.ts'
import type { DecodeAll, WorkspaceRegistryState } from './types.ts'
import { createBlankResolver, hiddenReason, isUngrouped, type HiddenReason } from './visibility.ts'

/** 本插件占用的路由前缀。 */
export const API_PREFIX = '/dsh-session-manager/api'

/** 请求体上限：一个会话包可能有几十 MB，给足；再大的一律拒掉而不是把它读进内存。 */
export const MAX_BODY_BYTES = 512 * 1024 * 1024

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

/** 依赖（都可注入，便于测试）。 */
export interface ApiDeps {
  paths: ResolvedPaths
  decodeAll: DecodeAll
  /** 生成清单时间戳与文件名，便于测试注入。 */
  now?: () => Date
  /** 插件版本，写进包的来源信息。 */
  pluginVersion?: string
  /**
   * 注册表改动何时被宿主承认（`immediate` 还是 `restart-required`）。
   *
   * 由入口注入而不是在这里探测：`effectMode()` 要读宿主服务，那件事属于 DSH 边界（`src/index.ts`），
   * 本模块只认 `{ register() }` 形状，不该知道 Cordis 的存在。
   */
  effectMode?: () => EffectMode
  /**
   * 宿主目录选择器的能力种类（`browse` / `native` / `null`）。
   *
   * 同 `effectMode`：要读宿主服务，所以由入口探测后注入。界面拿它决定目录字段上的
   * 「浏览…」是开页面内浏览器还是弹宿主的系统对话框；`null` 时那个按钮根本不出现。
   */
  pickerKind?: () => PickerKind
  /**
   * 读会话标题（界面要显示的东西，见 session-title.ts）。
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
   * 宿主内存里活着的会话 id（`ctx.sessions.list()`，见 src/index.ts）。
   *
   * 删除会拒掉这些：宿主手里有内存副本与写句柄，日志被搬走后它还会继续写。缺席 = 判断不了。
   */
  liveSessionIds?: () => ReadonlySet<string>
  /** 宿主的归档能力；缺席 = 这个宿主改不了归档（界面据此禁用那两个按钮）。 */
  registryOps?: () => RegistryOps | undefined
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
   * 认一批目录的项目身份（git remote，见 repo.ts）——界面据此把"本机路径"那一格换成`host/owner/repo`。
   *
   * 要跑 git，所以由入口注入（`src/index.ts` 造一份带缓存的实现，一个插件实例只问每个目录一次）。
   * 缺省不认：没有这个入口的宿主（测试、没装 git 的机器）界面照旧显示路径。
   */
  repos?: (dirs: readonly string[]) => Promise<ReadonlyMap<string, string>>
}

/** 界面要展示的一条会话。 */
interface SessionSummary {
  id: string
  /** 折叠出的标题；读不到时界面退回显示 id（见 session-title.ts）。 */
  title?: string
  cwd?: string
  createdAt: number
  dir: string
  /** 外壳侧边栏会把它放进「未分组」那一组（判据见 visibility.ts 的 `isUngrouped()`）。 */
  ungrouped: boolean
  bytes: number
  files: Array<{ name: string; bytes: number }>
  /** 外壳侧边栏不显示这条会话的原因（缺省 = 会显示，见 visibility.ts）。 */
  hidden?: HiddenReason
  /** 是否在注册表的归档集里（管理页据此决定按钮写「归档」还是「取消归档」）。 */
  archived: boolean
  /** 宿主判它"一轮都没开始过"（见 visibility.ts）；缓存缺席时按 `false` 处理，与宿主的冷会话口径一致。 */
  blank: boolean
  /** 日志 header 里的 `origin`（只有子代理会话会写）。 */
  origin?: string
  /**
   * 日志 header 里的 `parentSession`：这条子代理会话挂在哪条会话下面。
   *
   * 界面据此把子代理缩进到父会话的下一级（见 client/groups.ts 的 `nestSessions()`）。判据与删除/迁移的
   * 级联展开是同一个字段——列表里看到的父子关系与"删/搬会带上谁"因此不会各说各话。
   */
  parentSession?: string
  /** 宿主内存里活着（删除会拒它）。 */
  live: boolean
}

/** 界面要展示的一个工作区。 */
interface WorkspaceSummary {
  id: string
  path: string
  title: string
  sessionIds: string[]
}

/** 读请求体。 */
export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${limit} 字节`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error: Error) => reject(error))
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': String(body.length), 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/**
 * 把响应切成事件流（SSE）。
 *
 * 为什么这里需要流：同步是唯一"按条走网络"的长动作——一次整库同步可能是几百次往返，界面只有一句
 * "同步中…"时，用户没有任何办法判断它在推进还是卡住了。宿主 `webServer` 的路由 handler
 * **owning the full response lifecycle**（`WebRoute.handler` 的契约原文，允许一直握着响应，SSE
 * 就是它举的例子），所以这里可以直接写。
 *
 * `x-accel-buffering: no` 是给反向代理看的：默认它们会攒够一段缓冲才转发，攒着就等于没有进度。
 * 压缩中间件按 `content-type` 前缀判断并从压缩里**豁免** SSE（宿主那一层的 filter 里写死的），
 * 所以这里不必再管 gzip。
 */
function sendEventStream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/** 写一条 SSE 事件（事件体是一行 JSON，形状为 `{ type, ... }`）。 */
function sendEvent(res: ServerResponse, event: unknown): void {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** 读注册表；文件缺失或坏掉都只记为问题，不拦住"列出会话"。 */
function loadRegistry(
  path: string,
): { registry: WorkspaceRegistryState | null; problems: string[] } {
  try {
    const registry = readRegistry(path)
    const check = validateRegistry(registry)
    return { registry, problems: check.ok ? [] : check.problems.map((problem) => `注册表：${problem}`) }
  } catch (error) {
    return {
      registry: null,
      problems: [`读不到注册表 ${path}：${error instanceof Error ? error.message : String(error)}`],
    }
  }
}

/** 扫整个会话库（项目目录 → 会话）。实现在 discovery.ts，迁移页的「未分组」来源用的是同一个。 */
export const scanLibrary = scanAll

/**
 * 这次点名的会话里有没有"单独的子代理"（父会话还在库里、又不会被一起带上），有就给出拒绝文案。
 *
 * 子代理跟着父会话走（见 family.ts）：单独归档 / 导出它，要么在父会话的 `subagent/catalog` 里留下
 * 一条指着不存在会话的条目，要么打出一个父会话不在里面的包。所以这几条路都直接拒，并指名该点谁。
 * 删除那条路在自己的编排里做同一件事（文案在 remove.ts，多一条父会话标题）。
 */
function loneSubagentError(
  all: readonly DiscoveredSession[],
  ids: readonly string[],
  resolveTitle?: (query: TitleQuery) => string | undefined,
): string | undefined {
  const byId = new Map(all.map((session) => [session.id, session]))
  const lone = loneSubagents(all, new Set(ids))
  if (lone.length === 0) return undefined
  return lone
    .map((item) => {
      const parent = byId.get(item.parentId)
      // 拒绝这条路上才去读父会话的标题（整库带标题扫一遍要 1.7s，见 discovery.ts 的取舍）：
      // 只有一条会话、而且只在这条罕见的错误分支上读。
      const title =
        parent === undefined
          ? undefined
          : (resolveTitle?.({
              id: parent.id,
              createdAt: parent.createdAt,
              ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
              files: parent.files.map((file) => ({ path: file.path, version: file.version })),
            }) ?? parent.title)
      const owner = title === undefined || title.trim() === '' ? item.parentId : `${title.trim()}（${item.parentId}）`
      return `session ${item.id} 是子代理会话（它跟着父会话走）：请改点名它的父会话 ${owner}`
    })
    .join('；')
}

/**
 * 点名的那批 id → 实际要动手的那批：点名的在前，随后是各自跟来的子代理（`familyOf()`）。
 *
 * 库里找不到的 id 原样留着（调用方照旧逐条报"不在库里"，不静默少做一件事）。
 */
function withSubagents(all: readonly DiscoveredSession[], ids: readonly string[]): string[] {
  const byId = new Map(all.map((session) => [session.id, session]))
  const known = new Set(byId.keys())
  const roots = ids.flatMap((id) => {
    const session = byId.get(id)
    return session === undefined ? [] : [session]
  })
  const expanded = familyOf(all, roots).map(({ session }) => session.id)
  return [...ids.filter((id) => !known.has(id)), ...expanded]
}

/**
 * 把发现结果与注册表对起来，得到界面要的行。
 *
 * `ungrouped` = 这条会话在外壳侧边栏里落在「未分组」那一组里（判据与理由见 visibility.ts 的
 * `isUngrouped()`）。行上的标签、会话页那枚筛选芯片、迁移页那个来源都读它——**不再**发"有没有工作区
 * 认领"这个中间事实：以前那三处各自拿它去推「未分组」，于是子代理/空白/已归档这些侧边栏根本不放进
 * 那一组的会话也被标成了「未分组」。
 *
 * `hidden` 是外壳侧边栏"会不会显示这条会话"的判据结果（见 visibility.ts）：三份列表各自要看的东西
 * 不同——导出照单全收、迁移只收侧边栏看得见的、管理页要把看不见的原因标出来——所以这里一次算清，
 * 三处都读同一个字段，避免"面板说 4 条、侧边栏显示 1 条"这种对不上的账。
 */
function summarizeSessions(
  sessions: readonly DiscoveredSession[],
  registry: WorkspaceRegistryState | null,
  options: {
    archived: ReadonlySet<string>
    resolveBlank?: (query: { id: string; createdAt: number; cwd?: string }) => boolean | undefined
    live: ReadonlySet<string>
  },
): SessionSummary[] {
  const owner = new Map<string, string>()
  for (const [workspaceId, record] of Object.entries(registry?.tables.workspaces ?? {})) {
    for (const id of record.sessionIds) owner.set(id, workspaceId)
  }
  return sessions.map((session) => {
    const blank = options.resolveBlank?.({ id: session.id, createdAt: session.createdAt, cwd: session.cwd }) === true
    const archived = options.archived.has(session.id)
    const facts = { ...(session.header.origin === undefined ? {} : { origin: session.header.origin }), blank, archived }
    const hidden = hiddenReason(facts)
    return {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      cwd: session.cwd,
      createdAt: session.createdAt,
      dir: session.dir,
      ungrouped: isUngrouped({ ...facts, owned: owner.has(session.id) }),
      bytes: session.files.reduce((sum, file) => sum + file.bytes, 0),
      files: session.files.map((file) => ({ name: file.name, bytes: file.bytes })),
      archived,
      blank,
      ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
      ...(session.header.parentSession === undefined
        ? {}
        : { parentSession: session.header.parentSession }),
      live: options.live.has(session.id),
      ...(hidden === undefined ? {} : { hidden }),
    }
  })
}

function summarizeWorkspaces(registry: WorkspaceRegistryState | null): WorkspaceSummary[] {
  return (registry?.global.workspaceIds ?? []).flatMap((id) => {
    const record = registry?.tables.workspaces[id]
    if (!record) return []
    return [{ id, path: record.path, title: record.title, sessionIds: record.sessionIds }]
  })
}

/** 读 JSON 请求体；迁移/回滚这类请求很小，给 1 MiB 上限就够（大文件走 readBody 的默认上限）。 */
async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const body = await readBody(req, limit)
  return JSON.parse(body.toString('utf8') || '{}')
}

/** 目标目录必须真实存在：header.cwd 指向一个不存在的目录，导入或迁移出来的会话是坏的。 */
function assertTargetCwd(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('缺少目标工作区目录（targetCwd）')
  const cwd = value.trim()
  let stat
  try {
    stat = statSync(cwd)
  } catch {
    throw new Error(`目标工作区目录不存在：${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`目标工作区不是一个目录：${cwd}`)
  return cwd
}

function fileName(count: number, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  return `dsh-sessions-${count}-${stamp}.dshsess`
}

/** 界面用的全部 handler，键是 `METHOD 路径后缀`；方法可以写成 `GET|POST`（`/sync` 两种都要）。 */
export function createApiHandlers(deps: ApiDeps): Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const { paths, decodeAll } = deps
  const now = deps.now ?? ((): Date => new Date())
  // 标题只给界面看（`/state`）与导入预演看（包自己带着日志）。导出那条路上没人读它，
  // 所以那里扫库时刻意不传 resolveTitle——别为用不上的东西花钱。
  const resolveTitle =
    deps.resolveTitle ?? createTitleResolver({ cacheDir: projectionCacheDir(paths.registryPath), decodeAll })
  // 空白判据与标题同源：都读宿主自己那份投影缓存（见 visibility.ts）。界面与迁移计划因此共用一条口径。
  const resolveBlank =
    deps.resolveBlank ?? createBlankResolver({ cacheDir: projectionCacheDir(paths.registryPath) })
  // 宿主内存里活着的会话：删除会拒掉它们。端口缺席时按空集（判断不了）——预演的输出里没有
  // 任何一处声称"这些一定没在跑"，界面上那句说明也是这么写的。
  const liveSessionIds = (): ReadonlySet<string> => deps.liveSessionIds?.() ?? new Set<string>()

  const state = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { registry, problems } = loadRegistry(paths.registryPath)
    const sessions = scanLibrary(paths.sessionsRoot, decodeAll, { resolveTitle })
    const workspaces = summarizeWorkspaces(registry)
    // 项目身份只认"界面上真会出现的那些目录"：每条会话的 cwd + 注册表登记的工作区路径。别的一律不问
    // ——`git rev-parse` 是每个目录一次进程，列表页的热路径上多问一个都是白花。
    const directories = new Set<string>()
    for (const session of sessions) if (session.cwd !== undefined && session.cwd !== '') directories.add(session.cwd)
    for (const workspace of workspaces) if (workspace.path !== '') directories.add(workspace.path)
    const repos = deps.repos === undefined ? new Map<string, string>() : await deps.repos([...directories])
    sendJson(res, 200, {
      sessionsRoot: paths.sessionsRoot,
      registryPath: paths.registryPath,
      problems,
      // 目录字段能不能「浏览…」由宿主的能力位决定，界面不试错（见 ApiDeps.pickerKind）。
      pickerKind: deps.pickerKind?.() ?? null,
      // 归档按钮能不能点：这个宿主的 workspaceRegistry 在不在（只有 Web profile 才有它）。
      archiveAvailable: deps.registryOps?.() !== undefined,
      // 同步卡片：没有配置就是 null（界面据此说明"没配置 sync.url"，而不是画一个点了没反应的按钮）。
      sync: deps.syncInfo?.() ?? null,
      // 目录 → 项目身份（`host/owner/repo`）：界面把它显示在原来印本机路径的地方。认不出来的目录不在
      // 表里，界面退回显示路径。
      repos: Object.fromEntries(repos),
      sessions: summarizeSessions(sessions, registry, {
        archived: new Set(registry?.global.archivedSessionIds ?? []),
        resolveBlank,
        live: liveSessionIds(),
      }),
      workspaces,
    })
  }

  const exportSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req)
    let wanted: unknown
    try {
      wanted = JSON.parse(body.toString('utf8') || '{}')
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const ids = (wanted as { sessionIds?: unknown }).sessionIds
    if (!Array.isArray(ids) || ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }

    const all = scanLibrary(paths.sessionsRoot, decodeAll)
    const byId = new Map(all.map((session) => [session.id, session]))
    const named: string[] = ids.map((id) => String(id))
    const missing = named.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      sendJson(res, 404, { error: `这些会话不在库里：${missing.join(', ')}` })
      return
    }
    // 子代理不单独打包：它跟着父会话进包，否则包里那条 catalog 会指向一个包内不存在的会话。
    const lone = loneSubagentError(all, named, resolveTitle)
    if (lone !== undefined) {
      sendJson(res, 400, { error: lone })
      return
    }

    const sources = withSubagents(all, named).map((id) => {
      const session = byId.get(id)!
      return { id: session.id, cwd: session.cwd, createdAt: session.createdAt, dir: session.dir, files: session.files }
    })
    const at = now()
    const source: BundleSourceInfo = { sessionsRoot: paths.sessionsRoot, pluginVersion: deps.pluginVersion }
    const bundle = buildBundle(sources, { now: at.toISOString(), source })
    const bytes = sources.reduce((sum, item) => sum + item.files.reduce((s, file) => s + file.bytes, 0), 0)
    sendBytes(res, 200, bundle, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${fileName(sources.length, at)}"`,
      // 包里到底几条 / 多少字节：界面那句"已导出 N 条"要说的是**包里的**，勾一条父会话时它比勾选数多
      'x-dsh-session-count': String(sources.length),
      'x-dsh-session-bytes': String(bytes),
    })
  }

  const importSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const apply = url.searchParams.get('mode') === 'apply'

    const bytes = await readBody(req)
    if (bytes.length === 0) {
      sendJson(res, 400, { error: '请求体为空：请上传一个 .dshsess 文件' })
      return
    }

    let bundle
    try {
      bundle = readBundle(bytes)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    let targetCwd: string
    try {
      targetCwd = assertTargetCwd(url.searchParams.get('targetCwd'))
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const { registry, problems } = loadRegistry(paths.registryPath)
    const options: ImportOptions = {
      root: paths.sessionsRoot,
      targetCwd,
      registry: registry ?? undefined,
      registryPath: paths.registryPath,
      // 预演的每条会话要显示标题：包里的日志已经整份在内存里，折叠一次比再读盘便宜
      // （见 transfer.bundleTitle）。
      decodeAll,
    }

    let plan: ImportPlan
    try {
      plan = planImport(bundle, options)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const payload = {
      mode: apply ? 'apply' : 'plan',
      bundle: { createdAt: bundle.createdAt, source: bundle.source, sessions: bundle.sessions.length },
      problems: [...problems, ...plan.problems],
      entries: plan.entries,
      created: plan.created,
      rehomed: plan.rehomed,
      bytes: plan.bytes,
      registryChange: plan.registryChange,
    }

    if (!apply) {
      sendJson(res, 200, { ...payload, ok: plan.ok })
      return
    }
    if (plan.created.length === 0) {
      sendJson(res, 409, { ...payload, ok: false, error: '没有可导入的会话（都已在库里）' })
      return
    }

    try {
      const outcome = applyImport(bundle, plan, { ...options, decodeAll })
      sendJson(res, 200, {
        ...payload,
        ok: true,
        written: outcome.written,
        writtenBytes: outcome.bytes,
        registryWritten: outcome.registryWritten,
        // 宿主进程内持有注册表内存副本，落盘后重启才会被承认——与迁移那条路径同一套语义。
        note: '会话与注册表已落盘；宿主要重新扫描才会在侧边栏看到，重启 DSH 最稳妥。',
      })
    } catch (error) {
      sendJson(res, 500, {
        ...payload,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const migrateDeps: MigrateDeps = {
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    // 迁移页挑会话时同样按标题认人（与传输页同一套口径）。
    resolveTitle,
  }
  // 没注入就按"需要重启"说：宁可保守，也不谎称已经生效。
  const takesEffect = (): EffectMode => deps.effectMode?.() ?? 'restart-required'

  const backups = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, { backupRoot: paths.backupRoot, backups: listBackups(migrateDeps) })
  }

  /** 迁移：`mode=apply` 执行，缺省只预演。参数与工具层同一套（都进 runMigration）。 */
  const migrate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    // 源有两种：一个目录（from），或者"注册表没认领的那些会话"（unowned，即外壳侧边栏的「未分组」，
    // 可以横跨多个目录）。两者互斥时由计划层报 problem——那是"参数说不清"，比这里猜一个更诚实。
    const unowned = fields['unowned'] === true
    const from = typeof fields['from'] === 'string' ? fields['from'].trim() : ''
    if (from === '' && !unowned) {
      sendJson(res, 400, { error: '缺少源工作区目录（from），或者用 unowned: true 迁移「未分组」里的会话' })
      return
    }
    let to: string
    try {
      to = assertTargetCwd(fields['to'])
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    // 注册表是迁移的前置条件（要往上面登记新工作区）。它坏了就不该动手，先如实拒掉。
    try {
      loadRegistryForWrite(paths.registryPath)
    } catch (error) {
      sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const ids = fields['sessionIds']
    const request: MigrateRequest = {
      from,
      unowned,
      to,
      sessionIds: Array.isArray(ids) ? ids.map((id) => String(id)) : null,
      includeUnowned: fields['includeUnowned'] !== false,
      includeArtifacts: fields['includeArtifacts'] === true,
      ...(typeof fields['title'] === 'string' && fields['title'].trim() !== '' ? { title: fields['title'].trim() } : {}),
    }
    const apply = fields['mode'] === 'apply'
    const run = runMigration(migrateDeps, request, { apply })
    const payload = {
      mode: apply ? 'apply' : 'plan',
      ok: run.preview.ok && (!apply || run.verified),
      preview: run.preview,
      applied: run.applied,
      rewritten: run.rewritten,
      moved: run.moved,
      artifactsMoved: run.artifactsMoved,
      verified: run.verified,
      ...(run.backupDir === undefined ? {} : { backupDir: run.backupDir }),
      problems: run.problems,
      summary: run.summary,
      takesEffect: takesEffect(),
    }

    if (!run.preview.ok) {
      // 计划本身有问题（源项目目录不存在、目标被占用、cwd 不匹配……）：这是"当前状态不允许"，
      // 用 409 而不是 400——参数可能完全正确，是库的状态说了不行。
      sendJson(res, 409, payload)
      return
    }
    if (apply && !run.verified) {
      sendJson(res, 500, { ...payload, error: '迁移后的复核未通过，请查看 problems 并考虑回滚' })
      return
    }
    sendJson(res, 200, payload)
  }

  /** 回滚：`dryRun` 只回动作清单；只认本插件备份根下的目录（越界一律拒）。 */
  const rollbackBackup = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const backupDir = fields['backupDir']
    try {
      assertBackupDir({ backupRoot: paths.backupRoot }, backupDir)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const dryRun = fields['dryRun'] === true
    const outcome = rollbackMigration(
      { backupRoot: paths.backupRoot },
      { backupDir: String(backupDir), dryRun },
    )
    sendJson(res, 200, { mode: dryRun ? 'plan' : 'apply', ...outcome, takesEffect: takesEffect() })
  }

  /**
   * WebDAV 同步：`?mode=apply` 才真跑（拉取 + 推送），`?mode=test` 只探一次连通性，缺省只预演（读远端，
   * 什么都不写）。
   *
   * 拉取来的会话走的是**导入那条编排**（`runSync()` 内部调 `planImport/applyImport`），所以这里与
   * 导入端点同一套边界：包必须自校验通过、同 id 只跳过、`_no-cwd` 直接落项目目录。
   */
  const syncSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const mode = url.searchParams.get('mode')
    const apply = mode === 'apply'
    const runtime = await deps.sync?.()
    if (runtime === undefined) {
      sendJson(res, 409, { error: '这个宿主没有配置 WebDAV 同步（插件配置里的 sync.url 是空的）' })
      return
    }
    if (mode === 'test') {
      // 只读探一次：判定在 sync.ts，这里补上"这次有没有带凭据"两个事实——界面据此把 401 分成
      // "没配上密码"与"服务器不认这套"，那两句的处置完全不同。
      try {
        const result = await testSyncConnection(runtime.dav)
        sendJson(res, 200, {
          mode: 'test',
          remote: { url: runtime.settings.url, machineId: runtime.settings.machineId },
          ...result,
          username: runtime.settings.username ?? null,
          hasPassword: runtime.settings.password !== undefined,
        })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const syncDeps = {
      dav: runtime.dav,
      settings: runtime.settings,
      sessionsRoot: paths.sessionsRoot,
      registryPath: paths.registryPath,
      decodeAll,
      resolveTitle,
      ...(deps.pluginVersion === undefined ? {} : { pluginVersion: deps.pluginVersion }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }
    /** 预演与落地回同一份形状的结果，界面两条路都用同一套解析。 */
    const payloadOf = (outcome: SyncOutcome): Record<string, unknown> => ({
      mode: apply ? 'apply' : 'plan',
      remote: { url: runtime.settings.url, machineId: runtime.settings.machineId },
      ...outcome,
      problems: [...outcome.plan.problems, ...outcome.problems],
      // 只有真的往库里落了会话才谈得上"要不要重启"；纯推送不改本机任何东西。
      takesEffect: apply && outcome.pulled.length > 0 ? takesEffect() : 'immediate',
    })

    /*
     * 预演与落地都走事件流：`{type:'progress'}` 每做一条一次、`{type:'result'}` 收尾、`{type:'error'}`
     * 兜底。预演也要进度——它得先扫本机（每条会话读头、折标题）、再读远端索引、最后逐条比对内容，
     * 冷启动时这几秒里界面原来只有一句"预演中…"；落地那边同样受益，按下确认后到第一条拉取完成之间
     * 算的还是这三个阶段。
     *
     * 流一旦开始，HTTP 状态就已经发出去了（200），所以这一段的错误只能靠事件说——客户端按
     * `content-type` 区分"流"与"一次性 JSON"（没配置同步那类错发生在写头之前，仍然是 JSON +
     * 409/500）。
     */
    sendEventStream(res)
    try {
      const onProgress = (progress: SyncProgress): void => sendEvent(res, { type: 'progress', progress })
      const outcome = await runSync(syncDeps, apply ? { apply: true, onProgress } : { apply: false, onProgress })
      sendEvent(res, { type: 'result', result: payloadOf(outcome) })
    } catch (error) {
      sendEvent(res, { type: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    res.end()
  }

  const removeDeps: RemoveDeps = {
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    resolveTitle,
    liveSessionIds,
  }

  /**
   * 删除会话：`mode=apply` 才真删（**先备份再删**），缺省只预演。
   *
   * 恢复不在这里：删掉的那份就在本插件备份根下，走「备份与回滚」那份清单（见 journal.ts 的
   * `BackupKind`）。删除**不碰注册表**，所以恢复之后登记与归档状态原样还在（见 src/remove.ts）。
   */
  const deleteSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const ids = fields['sessionIds']
    if (!Array.isArray(ids) || ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }
    const apply = fields['mode'] === 'apply'
    const run: RemovalRun = runRemoval(removeDeps, { sessionIds: ids.map((id) => String(id)) }, { apply })
    const payload = {
      mode: apply ? 'apply' : 'plan',
      ok: run.plan.ok && (!apply || run.verified),
      /** 「将会删掉什么」的那份计划（预演与执行同源）。 */
      preview: run.plan,
      applied: run.applied,
      dirsRemoved: run.dirsRemoved,
      removedProjectDirs: run.removedProjectDirs,
      verified: run.verified,
      ...(run.backupDir === undefined ? {} : { backupDir: run.backupDir }),
      problems: run.plan.ok ? run.problems : run.plan.problems,
      summary: run.summary,
    }
    if (!run.plan.ok) {
      // 计划本身有问题（会话不在库里、宿主内存里活着、目录已经不在……）：这是"当前状态不允许"，
      // 用 409 而不是 400——参数可能完全正确，是库的状态说了不行（与 /migrate 同一套口径）。
      sendJson(res, 409, payload)
      return
    }
    if (apply && !run.verified) {
      sendJson(res, 500, { ...payload, error: '删除后的复核未通过，请查看 problems 并从备份恢复' })
      return
    }
    sendJson(res, 200, payload)
  }

  /**
   * 归档 / 取消归档所选会话（`archived: false` 即取消归档）。
   *
   * 走宿主的 `workspaceRegistry`：它一次做完"落盘 + 改内存 + 广播"，侧边栏即时跟着变，所以这里
   * 如实回报 `immediate`。一条失败不影响其余（逐条收集失败原因）——把每条的状态原样告诉界面，
   * 比"整体失败、什么都不说"更有用。
   */
  const archiveSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(fields['sessionIds']) ? fields['sessionIds'].map((id) => String(id)) : []
    if (ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }
    const archived = fields['archived'] !== false
    // 子代理不单独动：勾父会话时它跟着一起归档 / 取消归档（族是一个单位，见 family.ts）。
    const all = scanLibrary(paths.sessionsRoot, decodeAll)
    const lone = loneSubagentError(all, ids, resolveTitle)
    if (lone !== undefined) {
      sendJson(res, 400, { error: lone })
      return
    }
    const targets = [...new Set(withSubagents(all, ids))]
    const ops = deps.registryOps?.()
    if (ops === undefined) {
      // 非 Web profile 没有这个服务：如实拒绝，而不是写一遍注册表文件（写文件绕过宿主的内存副本，
      // 既可能被覆盖，也要等重启才被承认——那不是"归档"，是给宿主埋雷）。
      sendJson(res, 409, { error: '这个宿主没有 workspaceRegistry 服务（归档是它的能力），改不了归档状态' })
      return
    }
    const done: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    for (const id of targets) {
      try {
        if (archived) await ops.archive(id)
        else await ops.unarchive(id)
        done.push(id)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    sendJson(res, failed.length === 0 ? 200 : 409, {
      ok: failed.length === 0,
      archived: done,
      failed,
      takesEffect: 'immediate',
    })
  }

  return {
    'GET /state': state,
    'POST /export': exportSessions,
    'POST /import': importSessions,
    // 一个资源两种方法写一条：宿主的 `register()` 对重复的 (kind, path) 直接抛错。
    'GET|POST /sync': syncSessions,
    'GET /backups': backups,
    'POST /migrate': migrate,
    'POST /rollback': rollbackBackup,
    'POST /delete': deleteSessions,
    'POST /archive': archiveSessions,
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
