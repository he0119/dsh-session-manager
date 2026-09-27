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
import { translateWith, zh } from './locales.ts'
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

/** 迁移页。 */
export function MigrationPanel({ t = fallback, state, reload }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []

  const [from, setFrom] = React.useState('')
  const [to, setTo] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [includeArtifacts, setIncludeArtifacts] = React.useState(false)
  const [includeUnowned, setIncludeUnowned] = React.useState(true)
  const [pickMode, setPickMode] = React.useState<PickMode>('all')
  const [picked, setPicked] = React.useState<readonly string[]>([])

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
    const options: { path: string; title?: string; count: number }[] = []
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

        <div className="dsm-fields">
          <label className="dsm-field">
            <span className="dsm-fieldLabel">{t('fromLabel')}</span>
            <input
              className="dsm-input"
              type="text"
              value={from}
              placeholder={t('fromPlaceholder')}
              onChange={(event) => {
                setFrom(event.target.value)
                setPicked([])
                setOutcome(null)
              }}
            />
          </label>
          <label className="dsm-field">
            <span className="dsm-fieldLabel">{t('toLabel')}</span>
            <input
              className="dsm-input"
              type="text"
              value={to}
              placeholder={t('toPlaceholder')}
              onChange={(event) => {
                setTo(event.target.value)
                setOutcome(null)
              }}
            />
          </label>
        </div>

        {(sourceOptions.length > 0 || workspaces.length > 0) && (
          <div className="dsm-controls">
            {sourceOptions.length > 0 && (
              <select
                className="dsm-select"
                value=""
                onChange={(event) => {
                  if (event.target.value === '') return
                  setFrom(event.target.value)
                  setPicked([])
                  setOutcome(null)
                }}
              >
                <option value="">{t('pickSource')}</option>
                {sourceOptions.map((source) => (
                  <option key={source.path} value={source.path}>
                    {source.title === undefined ? source.path : `${source.title} — ${source.path}`} —{' '}
                    {t('sessionsInDir', { count: source.count })}
                  </option>
                ))}
              </select>
            )}
            {workspaces.length > 0 && (
              <select
                className="dsm-select"
                value=""
                onChange={(event) => {
                  if (event.target.value !== '') setTo(event.target.value)
                }}
              >
                <option value="">{t('pickTarget')}</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.path}>
                    {workspace.title} — {workspace.path}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

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
