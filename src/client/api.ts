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

/** 宿主端点前缀（与 `src/web.ts` 的 `API_PREFIX` 必须一致）。 */
export const API_PREFIX = '/dsh-session-manager/api'

/** 界面上一条会话。 */
export interface SessionSummary {
  id: string
  cwd?: string
  createdAt: number
  dir: string
  workspaceId?: string
  bytes: number
  files: Array<{ name: string; bytes: number }>
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
  registryPath: string
  problems: string[]
  sessions: SessionSummary[]
  workspaces: WorkspaceSummary[]
}

/** 导入计划里的一条会话。 */
export interface ImportEntry {
  id: string
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
export interface ExportResult {
  blob: Blob
  filename: string
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
  // 文件名以宿主的 Content-Disposition 为准；这条兜底只在没有响应头时用，后缀与它保持一致。
  return { blob: await response.blob(), filename: matched?.[1] ?? 'dsh-sessions.dshsess' }
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

// ---- 会话管理：迁移 / 备份 / 回滚 ----

/** 预演里的一条会话（宿主 `MigrationPreview.sessions`）。 */
export interface PreviewSession {
  id: string
  createdAt: number
  registered: boolean
  alreadyAtTarget: boolean
  sourceDir: string
  targetDir: string
  files: number
  bytes: number
}

/** 迁移预演的结果（宿主 `MigrationPreview`）。 */
export interface MigrationPreview {
  ok: boolean
  problems: string[]
  from: string
  to: string
  sourceBucket: string
  targetBucket: string
  sessions: PreviewSession[]
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
  from: string
  to: string
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
