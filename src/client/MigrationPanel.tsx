/**
 * 「迁移」分页：把某个工作区目录下的会话整体搬到另一个目录。
 *
 * 宿主半边的编排在 `src/migrate.ts`，端点在同名路由下；这一层只做三件事：收参数、把**预演结果**
 * 摆清楚、按用户的确认分两步走（预演 → 落地）。所有判定都在宿主侧——页面不自己推算会不会成功，
 * 也不自己拼路径。
 *
 * 两个刻意的设计：
 *   - **两步走写在同一张卡里**：预演与落地的响应是同一个形状（`mode` 区分），所以"看到的就是
 *     将要发生的"，不存在预览一套、实做另一套；
 *   - 回滚给一份**动作清单**再确认：回滚会搬目录、按字节还原日志、恢复注册表，等于一次真实写入，
 *     因此先 `dryRun` 把动作列出来，用户点确认才动手。
 *
 * @module dsh-session-manager/client/MigrationPanel
 */

import * as React from 'react'

import {
  fetchBackups,
  migrate,
  rollbackBackup,
  type BackupSummary,
  type MigrationRequest,
  type MigrationResponse,
} from './api.ts'
import { translateWith, zh, type Translate } from './locales.ts'
import { DirectoryPicker } from './DirectoryPicker.tsx'
import { normalizePickedPath } from './directory.ts'
import type { PanelShare } from './types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 会话选择：全部，或从匹配到的会话里勾几条。 */
type PickMode = 'all' | 'subset'

/** 目录下拉框里的一行。`count` 只有"宿主库里真有会话的目录"才有。 */
interface PathRow {
  path: string
  title?: string
  count?: number
}

/** 一行候选的文案：工作区标题（有则带）+ 路径 + 库里的条数（有则带）。 */
function optionLabel(row: PathRow, t: Translate): string {
  const head = row.title === undefined ? row.path : `${row.title} — ${row.path}`
  return row.count === undefined ? head : `${head} — ${t('sessionsInDir', { count: row.count })}`
}

/** 一个目录字段的入参。 */
interface PathFieldProps {
  t: Translate
  label: string
  /** 下拉框空值时的提示（"选源目录…"）。 */
  placeholder: string
  rows: PathRow[]
  value: string
  onChange: (value: string) => void
  /** 宿主目录选择器的能力种类；`null` = 这个宿主没有选择器，不显示「浏览…」。 */
  pickerKind: 'browse' | 'native' | null
  onBrowse: () => void
  /** 「手输路径」是否展开。 */
  manualOpen: boolean
  onToggleManual: () => void
  /** 展开中的浏览框（没展开就是 null）。 */
  browser: React.ReactNode
}

/**
 * 一个目录字段：**一个值控件**（下拉框自己就是那个值）+ 两条"另选一个值"的路。
 *
 * 为什么不是"下拉框只是替文本框挑一个候选"：目录是个任意绝对路径，候选列表永远不可能完整
 * （目标目录甚至可能还没建）。所以这里的下拉框 `value={value}` 直接就是值，且当前值一定在
 * 列表里（见调用处的 `sourceRows`/`targetRows`）；「浏览…」走宿主的目录选择器；
 * 「手输路径」是万能兜底——宿主没有选择器时也能改值。
 *
 * 三段控件是并列的兄弟节点而不是把 `<select>` 套进 `<label>`：一个 label 里塞两个可交互控件，
 * 点哪个都会把焦点给第一个。
 */
function PathField({
  t,
  label,
  placeholder,
  rows,
  value,
  onChange,
  pickerKind,
  onBrowse,
  manualOpen,
  onToggleManual,
  browser,
}: PathFieldProps): React.ReactElement {
  return (
    <div className="dsm-field">
      <span className="dsm-fieldLabel">{label}</span>
      <div className="dsm-controls">
        <select
          className="dsm-select dsm-selectPath"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{placeholder}</option>
          {rows.map((row) => (
            <option key={row.path} value={row.path}>
              {optionLabel(row, t)}
            </option>
          ))}
        </select>
        {pickerKind !== null && (
          <button type="button" className="dsm-button" onClick={onBrowse}>
            {t('browse')}
          </button>
        )}
        <button type="button" className="dsm-button" aria-expanded={manualOpen} onClick={onToggleManual}>
          {manualOpen ? t('collapse') : t('typePath')}
        </button>
      </div>
      {manualOpen && (
        <input
          className="dsm-input"
          type="text"
          aria-label={label}
          value={value}
          placeholder={t('pathPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {browser}
    </div>
  )
}

/** 迁移页。 */
export function MigrationPanel({ t = fallback, state, reload, directory }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  // 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时不显示「浏览…」。
  const pickerKind = state?.pickerKind ?? null

  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [includeArtifacts, setIncludeArtifacts] = React.useState(false)
  const [includeUnowned, setIncludeUnowned] = React.useState(true)
  const [pickMode, setPickMode] = React.useState<PickMode>('all')
  const [picked, setPicked] = React.useState<readonly string[]>([])

  // 页面内浏览框挂在哪个字段上，以及「手输路径」展开了哪个字段（同一时刻各一个）。
  const [picking, setPicking] = React.useState<'from' | 'to' | null>(null)
  const [manual, setManual] = React.useState<'from' | 'to' | null>(null)

  const [outcome, setOutcome] = React.useState<MigrationResponse | null>(null)
  const [busy, setBusy] = React.useState<'plan' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const [backups, setBackups] = React.useState<BackupSummary[]>([])
  const [backupRoot, setBackupRoot] = React.useState('')
  const [backupError, setBackupError] = React.useState<string | null>(null)
  const [rollbackBusy, setRollbackBusy] = React.useState<string | null>(null)
  const [rollbackPlan, setRollbackPlan] = React.useState<{ dir: string; actions: string[] } | null>(null)

  const loadBackups = React.useCallback(async (): Promise<void> => {
    try {
      const response = await fetchBackups()
      setBackups(response.backups)
      setBackupRoot(response.backupRoot)
      setBackupError(null)
    } catch (cause) {
      setBackupError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const loaded = React.useRef(false)
  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void loadBackups()
  }, [loadBackups])

  // 库里能按 cwd 匹配到的会话——只是给用户一个勾选面；真正迁移哪些由宿主按源分桶算。
  const matching = React.useMemo(
    () => sessions.filter((session) => from.trim() !== '' && session.cwd === from.trim()),
    [sessions, from],
  )

  // 源目录候选 = 已登记工作区 **+ 库里真有会话的目录**（账本里未必有它：未登记，或记的是旧路径）。
  // "只迁其中几条"的第一步是先看见这些会话在哪个目录下，所以每个候选都报**库里的条数**——
  // 账本的登记条数会骗人：同一个目录下可能还有没登记在册的会话（那些默认也会被一起搬走）。
  const sourceOptions = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      if (typeof session.cwd !== 'string' || session.cwd === '') continue
      counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1)
    }
    const options: PathRow[] = []
    const seen = new Set<string>()
    for (const workspace of workspaces) {
      if (seen.has(workspace.path)) continue
      seen.add(workspace.path)
      options.push({ path: workspace.path, title: workspace.title, count: counts.get(workspace.path) ?? 0 })
    }
    for (const [path, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (seen.has(path)) continue
      seen.add(path)
      options.push({ path, count })
    }
    return options
  }, [sessions, workspaces])

  /**
   * 下拉框里实际列出来的行 = 上面的候选 **+ 当前值本身**。
   *
   * 补这一行是为了让"框里显示的"永远是"真正要用的"：值可能是「浏览…」选回来的、账本和会话都没
   * 覆盖到的目录（比如刚建的空目录），没有这一行下拉框就只能显示占位符，看着像没选中。
   */
  const sourceRows = React.useMemo<PathRow[]>(() => {
    if (from === '' || sourceOptions.some((option) => option.path === from)) return sourceOptions
    return [...sourceOptions, { path: from }]
  }, [sourceOptions, from])

  /** 目标候选：已登记工作区（同一路径只留一条），外加当前值本身。 */
  const targetRows = React.useMemo<PathRow[]>(() => {
    const rows: PathRow[] = []
    const seen = new Set<string>()
    for (const workspace of workspaces) {
      if (seen.has(workspace.path)) continue
      seen.add(workspace.path)
      rows.push({ path: workspace.path, title: workspace.title })
    }
    if (to !== '' && !seen.has(to)) rows.push({ path: to })
    return rows
  }, [workspaces, to])

  const chosen = React.useMemo(
    () => (pickMode === 'all' ? matching.map((s) => s.id) : matching.filter((s) => picked.includes(s.id)).map((s) => s.id)),
    [pickMode, matching, picked],
  )

  /** 请求体：全部（或匹配不到）时 `sessionIds` 传 null，让宿主按源分桶的实际内容迁移。 */
  const request = (mode: 'plan' | 'apply'): MigrationRequest => ({
    mode,
    from: from.trim(),
    to: to.trim(),
    sessionIds: pickMode === 'subset' ? chosen : null,
    includeUnowned,
    includeArtifacts,
    ...(title.trim() === '' ? {} : { title: title.trim() }),
  })

  /**
   * 落一条路径到某个字段：去掉结尾斜杠后当成值（`cwd` 与账本里的路径都不带结尾斜杠，
   * 留着 `/a/b/` 会凭空多出一个迁不到任何会话的桶）。
   */
  const applyPath = (which: 'from' | 'to', raw: string): void => {
    const path = normalizePickedPath(raw)
    if (path === '') return
    if (which === 'from') {
      setFrom(path)
      setPicked([])
    } else {
      setTo(path)
    }
    setOutcome(null)
    setPicking(null)
    setManual(null)
  }

  /**
   * 「浏览…」：按**宿主报来的能力种类**决定开哪一种，不试错。
   *
   * 宿主的目录选择器是能力位服务：`native` 只有 `pick()`（在宿主显示器上弹系统对话框），
   * `browse` 只有 `list()`（页面自己画浏览器）。在 `browse` 宿主上硬调 `pick()` 会被宿主以
   * `directory-picker/unavailable` 拒绝——那正是"按钮看着能用、点了必报错"的坑。
   *
   * 取消（`null`）什么都不做：取消就是取消，不该把已选的值清掉。
   */
  const browse = async (which: 'from' | 'to'): Promise<void> => {
    const api = directory?.()
    if (pickerKind === null || api === undefined) {
      setError(t('browseUnavailable'))
      return
    }
    if (pickerKind === 'browse') {
      // 再点一次收起，不额外给一个"关闭"按钮。
      setPicking((current) => (current === which ? null : which))
      return
    }
    try {
      const picked = await api.pick()
      if (picked === null || picked === '') return
      applyPath(which, picked)
    } catch (cause) {
      setError(t('browseFailed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    }
  }

  /** 某个字段展开中的浏览框；没展开、或选择器服务已卸载时什么都不渲染。 */
  const browserFor = (which: 'from' | 'to'): React.ReactNode => {
    const api = directory?.()
    if (picking !== which || api === undefined) return null
    return (
      <DirectoryPicker
        t={t}
        api={api}
        startPath={which === 'from' ? from : to}
        onPick={(path) => applyPath(which, path)}
        onClose={() => setPicking(null)}
      />
    )
  }

  const run = async (kind: 'plan' | 'apply'): Promise<void> => {
    if (from.trim() === '') {
      setError(t('needFrom'))
      return
    }
    if (to.trim() === '') {
      setError(t('needTo'))
      return
    }
    if (kind === 'apply' && pickMode === 'subset' && chosen.length === 0) {
      setError(t('needMigrateSelection'))
      return
    }
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      const response = await migrate(request(kind))
      setOutcome(response)
      if (response.applied) {
        setNotice(
          t('migrateDone', {
            sessions: response.preview.sessions.length,
            rewritten: response.rewritten,
            moved: response.moved,
            artifacts:
              response.artifactsMoved > 0 ? t('migrateArtifactsPart', { count: response.artifactsMoved }) : '',
          }) +
            ' ' +
            (response.verified ? t('verifiedPass') : t('verifiedFail')),
        )
        await reload()
        await loadBackups()
      }
    } catch (cause) {
      setError(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const preview = outcome?.preview ?? null
  const planned = preview !== null && preview.ok
  const registry = preview?.registryChange ?? null

  const showRollbackPlan = async (dir: string): Promise<void> => {
    setRollbackBusy(dir)
    setBackupError(null)
    try {
      const response = await rollbackBackup(dir, true)
      setRollbackPlan({ dir, actions: response.actions })
    } catch (cause) {
      setBackupError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRollbackBusy(null)
    }
  }

  const doRollback = async (dir: string): Promise<void> => {
    setRollbackBusy(dir)
    setBackupError(null)
    try {
      const response = await rollbackBackup(dir, false)
      setRollbackPlan(null)
      setNotice(t('rollbackDone', { sessions: response.sessions, files: response.restoredFiles }))
      setOutcome(null)
      await reload()
      await loadBackups()
    } catch (cause) {
      setBackupError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRollbackBusy(null)
    }
  }

  return (
    <>
      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setError(null)}>
            {t('dismiss')}
          </button>
        </p>
      )}
      {notice !== null && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setNotice(null)}>
            {t('dismiss')}
          </button>
        </p>
      )}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('migrateTitle')}</span>
        </div>
        <p className="dsm-hint">{t('migrateHint')}</p>

        {/*
          源/目标各自只有**一个值控件**：下拉框本身就是那个值（`value={from}`/`value={to}`），
          不是"选一下、填进别处"。任意绝对路径都能进这个框——「浏览…」走宿主自己的目录选择器
          （能力种类由宿主报来，见 browse()），当前值若不在候选里就地补成一个选项。
        */}
        <div className="dsm-fields">
          <PathField
            t={t}
            label={t('fromLabel')}
            placeholder={t('pickSource')}
            rows={sourceRows}
            value={from}
            pickerKind={pickerKind}
            onChange={(value) => {
              setFrom(value)
              setPicked([])
              setOutcome(null)
            }}
            onBrowse={() => void browse('from')}
            manualOpen={manual === 'from'}
            onToggleManual={() => setManual((current) => (current === 'from' ? null : 'from'))}
            browser={browserFor('from')}
          />
          <PathField
            t={t}
            label={t('toLabel')}
            placeholder={t('pickTarget')}
            rows={targetRows}
            value={to}
            pickerKind={pickerKind}
            onChange={(value) => {
              setTo(value)
              setOutcome(null)
            }}
            onBrowse={() => void browse('to')}
            manualOpen={manual === 'to'}
            onToggleManual={() => setManual((current) => (current === 'to' ? null : 'to'))}
            browser={browserFor('to')}
          />
        </div>

        <label className="dsm-field">
          <span className="dsm-fieldLabel">{t('titleLabel')}</span>
          <input
            className="dsm-input"
            type="text"
            value={title}
            placeholder={t('titlePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <div className="dsm-options">
          <label className="dsm-check">
            <input type="checkbox" checked={includeUnowned} onChange={(event) => setIncludeUnowned(event.target.checked)} />
            <span>{t('includeUnowned')}</span>
          </label>
          <label className="dsm-check">
            <input type="checkbox" checked={includeArtifacts} onChange={(event) => setIncludeArtifacts(event.target.checked)} />
            <span>{t('includeArtifacts')}</span>
          </label>
        </div>

        <div className="dsm-field">
          <span className="dsm-fieldLabel">{t('pickScopeLabel')}</span>
          <div className="dsm-options">
            <label className="dsm-check">
              <input type="radio" name="dsm-pick" checked={pickMode === 'all'} onChange={() => setPickMode('all')} />
              <span>{t('allSessions')}</span>
            </label>
            <label className="dsm-check">
              <input type="radio" name="dsm-pick" checked={pickMode === 'subset'} onChange={() => setPickMode('subset')} />
              <span>
                {pickMode === 'subset' ? t('selectedCount', { count: chosen.length }) : t('pickSubsetLabel')}
              </span>
            </label>
            <span className="dsm-hint">
              {matching.length > 0 ? t('sourceSessions', { count: matching.length }) : t('sourceSessionsNone')}
            </span>
          </div>
        </div>

        {matching.length > 0 && (
          <>
            <div className="dsm-options">
              <span className="dsm-hint">{pickMode === 'all' ? t('pickTickHint') : t('pickSubsetHint')}</span>
              {pickMode === 'subset' && (
                <>
                  <span className="dsm-spacer" />
                  <button type="button" className="dsm-button" onClick={() => setPicked(matching.map((session) => session.id))}>
                    {t('selectAllInSource')}
                  </button>
                  <button type="button" className="dsm-button" onClick={() => setPicked([])}>
                    {t('clearPick')}
                  </button>
                </>
              )}
            </div>
            <div className="dsm-list">
              {matching.map((session) => (
                <label key={session.id} className="dsm-row dsm-rowPick">
                  <input
                    type="checkbox"
                    checked={pickMode === 'subset' && picked.includes(session.id)}
                    onChange={() => {
                      // 在「全部」下勾某一条 = 我指的就是这一条：顺势切到子集，不要求用户先改单选框
                      if (pickMode === 'all') setPickMode('subset')
                      setPicked((current) =>
                        current.includes(session.id) ? current.filter((id) => id !== session.id) : [...current, session.id],
                      )
                    }}
                  />
                  <span className="dsm-rowId">{session.id}</span>
                  <span className="dsm-meta">{formatBytes(session.bytes)}</span>
                  <span className="dsm-meta">{formatTime(new Date(session.createdAt).toISOString())}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="dsm-controls">
          <button type="button" className="dsm-button" onClick={() => void run('plan')} disabled={busy !== null}>
            {busy === 'plan' ? t('previewing') : t('migratePreview')}
          </button>
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={() => void run('apply')}
            disabled={busy !== null || !planned}
          >
            {busy === 'apply' ? t('migrating') : t('migrateApply')}
          </button>
        </div>

        {preview !== null && (
          <div className="dsm-result">
            <p className={preview.ok ? 'dsm-ok' : 'dsm-warn'}>
              {t('migrateSummary', {
                sessions: preview.sessions.length,
                files: preview.files,
                bytes: formatBytes(preview.bytes),
              })}
            </p>
            <p className="dsm-hint">{t('migrateBuckets', { from: preview.sourceBucket, to: preview.targetBucket })}</p>

            {preview.problems.length > 0 && (
              <div className="dsm-problems">
                <p className="dsm-warn">
                  {t('problemsTitle')}（{preview.problems.length}）
                </p>
                <ul className="dsm-listPlain">
                  {preview.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}

            {planned && (
              <div className="dsm-registry">
                <p className="dsm-fields-label">{t('registryChangeTitle')}</p>
                <ul className="dsm-listPlain">
                  {registry === null || registry.unchanged ? (
                    <li>{t('registryUnchanged')}</li>
                  ) : (
                    <>
                      <li>{registry.createdTarget ? t('registryCreateTarget') : t('registryReuseTarget')}</li>
                      {registry.added.length > 0 && <li>{t('registryAdded', { count: registry.added.length })}</li>}
                      {registry.adoptedFromUnowned.length > 0 && (
                        <li>{t('registryAdopted', { count: registry.adoptedFromUnowned.length })}</li>
                      )}
                      {registry.movedFrom.length > 0 && <li>{t('registryMoved', { count: registry.movedFrom.length })}</li>}
                      {registry.removedSources.length > 0 && (
                        <li>{t('registryRemoved', { count: registry.removedSources.length })}</li>
                      )}
                    </>
                  )}
                </ul>
              </div>
            )}

            {preview.artifacts !== null && (
              <p className="dsm-hint">
                {t('artifactsPlanned', { count: preview.artifacts.moves })}
                {preview.artifacts.skipped.length > 0
                  ? ` · ${t('artifactsSkipped', { count: preview.artifacts.skipped.length })}`
                  : ''}
              </p>
            )}

            {outcome?.applied === true && (
              <div className="dsm-effect">
                <p className={outcome.verified ? 'dsm-ok' : 'dsm-warn'}>
                  {outcome.verified ? t('verifiedPass') : t('verifiedFail')}
                  {outcome.backupDir !== undefined ? ` · ${outcome.backupDir}` : ''}
                </p>
                <p className={outcome.takesEffect === 'immediate' ? 'dsm-hint' : 'dsm-warn'}>
                  {outcome.takesEffect === 'immediate' ? t('effectImmediate') : t('effectRestart')}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('backupTitle')}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => void loadBackups()} disabled={rollbackBusy !== null}>
            {t('refresh')}
          </button>
        </div>
        <p className="dsm-hint">{t('backupHint')}</p>
        {backupRoot !== '' && (
          <p className="dsm-hint">
            {t('backupRootLabel')}：{backupRoot}
          </p>
        )}

        {backupError !== null && <p className="dsm-banner dsm-error">{backupError}</p>}

        {backups.length === 0 ? (
          <p className="dsm-empty">{t('noBackups')}</p>
        ) : (
          <div className="dsm-list">
            {backups.map((backup) => (
              <div key={backup.dir} className="dsm-backupRow">
                <div className="dsm-backupMain">
                  <span className="dsm-rowId">{formatTime(backup.createdAt)}</span>
                  <span className="dsm-hint">{t('backupRow', { sessions: backup.sessions, artifacts: backup.artifacts })}</span>
                  {(backup.from !== undefined || backup.to !== undefined) && (
                    <span className="dsm-meta" title={backup.dir}>
                      {backup.from ?? '—'} → {backup.to ?? '—'}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="dsm-button"
                  onClick={() => void showRollbackPlan(backup.dir)}
                  disabled={rollbackBusy !== null}
                >
                  {rollbackPlan?.dir === backup.dir ? t('rollbackAction') : t('rollbackPreview')}
                </button>
              </div>
            ))}
          </div>
        )}

        {rollbackPlan !== null && (
          <div className="dsm-result">
            <p className="dsm-warn">{t('rollbackActions', { count: rollbackPlan.actions.length })}</p>
            <ul className="dsm-listPlain">
              {rollbackPlan.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
            <div className="dsm-controls">
              <button
                type="button"
                className="dsm-button dsm-primary"
                onClick={() => void doRollback(rollbackPlan.dir)}
                disabled={rollbackBusy !== null}
              >
                {rollbackBusy === rollbackPlan.dir ? t('rollingBack') : t('rollbackConfirm')}
              </button>
              <button type="button" className="dsm-button" onClick={() => setRollbackPlan(null)} disabled={rollbackBusy !== null}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
