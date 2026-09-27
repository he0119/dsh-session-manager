/**
 * 会话导入导出的页面主体（注册在设置 → 会话传输 这一页）。
 *
 * 这一层只做三件事：读宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/transfer.ts`）：预演返回的就是将要发生的事，页面不自己推算
 *
 *   - 导出：勾选 → 宿主打包 → 浏览器下载；
 *   - 导入：选包 + 选目标工作区 → **预演** → 看清 create/skip 与 cwd 改写 → 确认落盘。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token；
 * 控件是手写的原生元素，**不 require 宿主的 UI 原语包**——那份包会随时改，而它一抛异常就会让
 * 整个槽位条目变成崩溃占位（控制台里是 `slot entry crashed in '…'`）。
 *
 * @module dsh-session-manager/client/TransferPanel
 */

import * as React from 'react'

import {
  download,
  exportSessions,
  fetchState,
  importBundle,
  type ImportResponse,
  type StateResponse,
} from './api.ts'
import { translateWith, zh, type Translate } from './locales.ts'

/** 页面获得的注入面（`t` 由注册时的 `inject()` 给出；缺席时回落到中文，不让页面白屏）。 */
export interface TransferPanelProps {
  t?: Translate
}

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

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const totalBytes = (entries: readonly { bytes: number }[]): number =>
  entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0)

/** 会话导入导出页。 */
export function TransferPanel({ t = fallback }: TransferPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StateResponse | null>(null)
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [file, setFile] = React.useState<File | null>(null)
  const [payload, setPayload] = React.useState<ArrayBuffer | null>(null)
  const [target, setTarget] = React.useState('')
  const [plan, setPlan] = React.useState<ImportResponse | null>(null)
  const [busy, setBusy] = React.useState<'load' | 'export' | 'preview' | 'apply' | null>('load')
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setBusy('load')
    setError(null)
    try {
      const next = await fetchState()
      setState(next)
      setSelected((current) => current.filter((id) => next.sessions.some((session) => session.id === id)))
    } catch (cause) {
      setError(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }, [t])

  // 只跑一次：`t` 不进依赖是有意的——它是渲染期重新绑定的函数，进了依赖会变成每次渲染都重读。
  const loaded = React.useRef(false)
  React.useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void load()
  }, [load])

  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  const allSelected = sessions.length > 0 && selected.length === sessions.length

  const toggle = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))
  }

  const run = async (kind: 'export' | 'preview' | 'apply', action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (cause) {
      setError(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const doExport = (): void => {
    if (selected.length === 0) {
      setError(t('needSelection'))
      return
    }
    void run('export', async () => {
      const result = await exportSessions(selected)
      download(result)
      const chosen = sessions.filter((session) => selected.includes(session.id))
      setNotice(t('exported', { count: chosen.length, bytes: formatBytes(totalBytes(chosen)) }))
    })
  }

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0] ?? null
    setFile(picked)
    setPlan(null)
    setError(null)
    setNotice(null)
    if (picked === null) {
      setPayload(null)
      return
    }
    void picked
      .arrayBuffer()
      .then((buffer) => setPayload(buffer))
      .catch((cause: unknown) => setError(t('failed', { reason: cause instanceof Error ? cause.message : String(cause) })))
  }

  const doPreview = (): void => {
    if (file === null || payload === null) {
      setError(t('needFile'))
      return
    }
    if (target === '') {
      setError(t('needWorkspace'))
      return
    }
    void run('preview', async () => setPlan(await importBundle(payload, target, 'plan')))
  }

  const doApply = (): void => {
    if (payload === null || target === '') return
    void run('apply', async () => {
      const result = await importBundle(payload, target, 'apply')
      setPlan(result)
      if (result.written && result.written.length > 0) {
        setNotice(t('applied', { count: result.written.length, bytes: formatBytes(result.bytes) }))
        await load()
      }
    })
  }

  const createCount = plan?.entries.filter((entry) => entry.action === 'create').length ?? 0
  const skipCount = plan?.entries.filter((entry) => entry.action === 'skip').length ?? 0

  return (
    <section className="dsm-root" data-plugin="dsh-session-manager">
      <header className="dsm-head">
        <span className="dsm-title">{t('title')}</span>
        <span className="dsm-sub">
          {t('library')}：{state?.sessionsRoot ?? ''} · {t('sessionsCount', { count: sessions.length })} ·{' '}
          {t('workspacesCount', { count: workspaces.length })}
        </span>
        <span className="dsm-spacer" />
        <button type="button" className="dsm-button" onClick={() => void load()} disabled={busy !== null}>
          {busy === 'load' ? t('loading') : t('refresh')}
        </button>
      </header>

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
      {(state?.problems ?? []).map((problem) => (
        <p key={problem} className="dsm-banner dsm-warn">
          {problem}
        </p>
      ))}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('exportTitle')}</span>
          <span className="dsm-hint">{t('selectedCount', { count: selected.length })}</span>
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            onClick={() => setSelected(allSelected ? [] : sessions.map((session) => session.id))}
            disabled={sessions.length === 0}
          >
            {allSelected ? t('clearAll') : t('selectAll')}
          </button>
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={doExport}
            disabled={busy !== null || selected.length === 0}
          >
            {busy === 'export' ? t('exporting') : t('exportAction')}
          </button>
        </div>
        <p className="dsm-hint">{t('exportHint')}</p>

        <div className="dsm-list">
          {sessions.length === 0 ? (
            <p className="dsm-empty">{busy === 'load' ? t('loading') : t('noSessions')}</p>
          ) : (
            sessions.map((session) => (
              <label key={session.id} className="dsm-row">
                <input
                  type="checkbox"
                  checked={selected.includes(session.id)}
                  onChange={() => toggle(session.id)}
                />
                <span className="dsm-rowId">{session.id}</span>
                <span className="dsm-meta" title={session.cwd ?? ''}>
                  {session.cwd ?? t('noCwd')}
                </span>
                <span className="dsm-meta">{formatBytes(session.bytes)}</span>
                <span className="dsm-meta">{formatTime(session.createdAt)}</span>
              </label>
            ))
          )}
        </div>
      </div>

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('importTitle')}</span>
        </div>
        <p className="dsm-hint">{t('importHint')}</p>

        <div className="dsm-controls">
          <input className="dsm-file" type="file" accept=".dhsess" onChange={pickFile} />
          <select
            className="dsm-select"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value)
              setPlan(null)
            }}
          >
            <option value="">{t('pickWorkspace')}</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.path}>
                {workspace.title} — {workspace.path}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="dsm-button"
            onClick={doPreview}
            disabled={busy !== null || file === null}
          >
            {busy === 'preview' ? t('previewing') : t('preview')}
          </button>
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={doApply}
            disabled={busy !== null || createCount === 0}
          >
            {busy === 'apply' ? t('applying') : t('apply')}
          </button>
        </div>

        {plan !== null && (
          <div>
            <p className={plan.ok ? 'dsm-ok' : 'dsm-warn'}>
              {t('planSummary', { create: createCount, skip: skipCount, bytes: formatBytes(plan.bytes) })}
              {plan.error !== undefined ? ` · ${plan.error}` : ''}
            </p>
            {plan.note !== undefined && <p className="dsm-hint">{plan.note}</p>}
            {(plan.problems ?? []).map((problem) => (
              <p key={problem} className="dsm-warn">
                {problem}
              </p>
            ))}
            <table className="dsm-table">
              <thead>
                <tr>
                  <th>{t('colAction')}</th>
                  <th>{t('colSession')}</th>
                  <th>{t('colCwd')}</th>
                  <th>{t('colBytes')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <span className={`dsm-tag ${entry.action === 'create' ? 'dsm-tagCreate' : 'dsm-tagSkip'}`}>
                        {entry.action === 'create' ? t('actionCreate') : t('actionSkip')}
                      </span>
                    </td>
                    <td className="dsm-rowId">
                      {entry.id}
                      {entry.reason !== undefined && <div className="dsm-hint">{entry.reason}</div>}
                    </td>
                    <td className="dsm-meta">
                      {entry.toCwd === undefined
                        ? t('cwdKeep')
                        : t('cwdRewritten', { from: entry.fromCwd ?? '—', to: entry.toCwd })}
                    </td>
                    <td className="dsm-meta">{formatBytes(totalBytes(entry.files))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
