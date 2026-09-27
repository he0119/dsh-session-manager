// src/web.ts — 浏览器界面用的宿主路由（插件设置页的数据面）。
//
// 界面在 Web 端，真正的读写必须在宿主进程里做：会话库在磁盘上、注册表由宿主持有内存副本，
// 浏览器那一侧既没有权限也不该有。因此这一层只做三件事——**列**、**迁移**、**导入导出**——
// 并把每次写入的边界条件（目标目录必须真实存在、包必须自校验通过、冲突只跳过不覆盖、回滚只能
// 回滚自己写下的备份）挡在宿主这一侧，而不是指望界面传对参数。
//
// 编排本身在 `src/migrate.ts`（工具层与这一层共用一份），本模块只负责 HTTP 形状：
// 读参数、翻译成那边认识的请求、把结果按 JSON 回给界面。
//
// 与 webServer 服务解耦：本模块只要求一个 `{ register(route) }`，测试里用假 req/res 直接打
// handler，不必起 HTTP 服务。路由路径固定在本插件命名空间下，`(kind, path)` 与别的插件不会撞。
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { scanBucket, type DiscoveredSession } from './discovery.ts'
import {
  assertBackupDir,
  listBackups,
  loadRegistryForWrite,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
  type MigrateRequest,
} from './migrate.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import { type EffectMode, type ResolvedPaths } from './tools.ts'
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
}

/** 界面要展示的一条会话。 */
interface SessionSummary {
  id: string
  cwd?: string
  createdAt: number
  dir: string
  workspaceId?: string
  bytes: number
  files: Array<{ name: string; bytes: number }>
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

/** 扫整个会话库（分桶 → 会话）。 */
export function scanLibrary(root: string, decodeAll: DecodeAll): DiscoveredSession[] {
  const out: DiscoveredSession[] = []
  let buckets: string[]
  try {
    buckets = readdirSync(root)
  } catch {
    return out
  }
  for (const bucket of buckets) {
    const bucketPath = join(root, bucket)
    try {
      if (!statSync(bucketPath).isDirectory()) continue
    } catch {
      continue
    }
    try {
      out.push(...scanBucket(bucketPath, decodeAll))
    } catch {
      // 单个分桶坏掉不该让整页打不开：跳过它，界面照旧能用。
      continue
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/** 把发现结果与注册表对起来，得到界面要的行。 */
function summarizeSessions(sessions: readonly DiscoveredSession[], registry: WorkspaceRegistryState | null): SessionSummary[] {
  const owner = new Map<string, string>()
  for (const [workspaceId, record] of Object.entries(registry?.tables.workspaces ?? {})) {
    for (const id of record.sessionIds) owner.set(id, workspaceId)
  }
  return sessions.map((session) => ({
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    dir: session.dir,
    workspaceId: owner.get(session.id),
    bytes: session.files.reduce((sum, file) => sum + file.bytes, 0),
    files: session.files.map((file) => ({ name: file.name, bytes: file.bytes })),
  }))
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

/** 界面用的全部 handler，键是 `METHOD 路径后缀`。 */
export function createApiHandlers(deps: ApiDeps): Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const { paths, decodeAll } = deps
  const now = deps.now ?? ((): Date => new Date())

  const state = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { registry, problems } = loadRegistry(paths.registryPath)
    const sessions = scanLibrary(paths.sessionsRoot, decodeAll)
    sendJson(res, 200, {
      sessionsRoot: paths.sessionsRoot,
      registryPath: paths.registryPath,
      problems,
      sessions: summarizeSessions(sessions, registry),
      workspaces: summarizeWorkspaces(registry),
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
    const missing = ids.filter((id) => !byId.has(String(id)))
    if (missing.length > 0) {
      sendJson(res, 404, { error: `这些会话不在库里：${missing.join(', ')}` })
      return
    }

    const sources = ids.map((id) => {
      const session = byId.get(String(id))!
      return { id: session.id, cwd: session.cwd, createdAt: session.createdAt, dir: session.dir, files: session.files }
    })
    const at = now()
    const source: BundleSourceInfo = { sessionsRoot: paths.sessionsRoot, pluginVersion: deps.pluginVersion }
    const bundle = buildBundle(sources, { now: at.toISOString(), source })
    sendBytes(res, 200, bundle, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${fileName(sources.length, at)}"`,
    })
  }

  const importSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const apply = url.searchParams.get('mode') === 'apply'

    const bytes = await readBody(req)
    if (bytes.length === 0) {
      sendJson(res, 400, { error: '请求体为空：请上传一个 .dhsess 文件' })
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
    const from = typeof fields['from'] === 'string' ? fields['from'].trim() : ''
    if (from === '') {
      sendJson(res, 400, { error: '缺少源工作区目录（from）' })
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
      // 计划本身有问题（源桶不存在、目标被占用、cwd 不匹配……）：这是"当前状态不允许"，
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

  return {
    'GET /state': state,
    'POST /export': exportSessions,
    'POST /import': importSessions,
    'GET /backups': backups,
    'POST /migrate': migrate,
    'POST /rollback': rollbackBackup,
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
    const [method, suffix] = key.split(' ')
    disposers.push(
      server.register({
        kind: 'exact',
        path: `${API_PREFIX}${suffix}`,
        handler: async (req, res) => {
          if ((req.method ?? 'GET').toUpperCase() !== method) {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: `${suffix} 只接受 ${method}` }))
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
