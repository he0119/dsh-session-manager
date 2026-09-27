/**
 * 「导入导出」分页：把会话带走（导出 .dshsess）或带回来（导入）。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/transfer.ts`）：预演返回的就是将要发生的事，页面不自己推算
 *
 *   - 导出：按目录分组的列表里勾选（组头可整组勾）→ 宿主打包 → 浏览器下载；
 *   - 导入：选包 + 选目标工作区 → **预演** → 看清 create/skip 与 cwd 改写 → 确认落盘。
 *
 * 会话库数据由页面骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉好传进来：切分页不该各拉一份，
 * 也不该出现"两个分页对同一个库给出不同数字"。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token；
 * 控件是手写的原生元素，**不 require 宿主的 UI 原语包**——那份包会随时改，而它一抛异常就会让
 * 整个槽位条目变成崩溃占位（控制台里是 `slot entry crashed in '…'`）。
 *
 * @module dsh-session-manager/client/TransferPanel
 */

import * as React from 'react'

import { download, exportSessions, importBundle, type ImportResponse } from './api.ts'
import type { SessionSummary } from './api.ts'
import { groupSessions, type SessionGroup } from './groups.ts'
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

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const totalBytes = (entries: readonly { bytes: number }[]): number =>
  entries.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? entry.bytes : 0), 0)

/**
 * 组头的三态勾选框。
 *
 * `indeterminate` 不是能写进 JSX 的属性（React 明确不支持它）：它是**节点上的状态**，只能赋值，
 * 所以这里用 ref 在每次渲染后同步。少了这一步，组里勾了一部分时选框只画成"空"，
 * 用户会以为自己点的"整组勾上"没生效。
 */
function GroupCheckbox({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean
  indeterminate: boolean
  label: string
  onToggle: () => void
}): React.ReactElement {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      title={label}
      onChange={onToggle}
    />
  )
}

/** 导入导出页。 */
export function TransferPanel({ t = fallback, state, reload }: PanelShare): React.ReactElement {
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [file, setFile] = React.useState<File | null>(null)
  const [payload, setPayload] = React.useState<ArrayBuffer | null>(null)
  const [target, setTarget] = React.useState('')
  const [plan, setPlan] = React.useState<ImportResponse | null>(null)
  const [busy, setBusy] = React.useState<'export' | 'preview' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  const allSelected = sessions.length > 0 && selected.length === sessions.length
  // 列表按**目录**分组（不是按账本里的工作区）：同一个目录下常有没登记在册的会话，而用户说的
  // "把这个工作区的会话带走"指的永远是这个目录。理由与边界见 groups.ts。
  const groups = React.useMemo(() => groupSessions(sessions, workspaces), [sessions, workspaces])

  // 库变了（例如刚导入完）：把已经不在库里的选择摘掉，别让「已选 3」里混着不存在的会话。
  React.useEffect(() => {
    setSelected((current) => current.filter((id) => sessions.some((session) => session.id === id)))
  }, [sessions])

  const toggle = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))
  }

  /**
   * 点组头：整组勾上，或整组取消。
   *
   * 只勾了一部分时点一下是"补齐"，这是列表的通行手感（Gmail/GitHub 都这样）；想去掉整组，
   * 再看一眼它变成"全部勾上"之后再点一下即可。一条会话都没勾的组同理是"勾上"。
   */
  const toggleGroup = (group: SessionGroup<SessionSummary>): void => {
    const ids = group.sessions.map((session) => session.id)
    const whole = ids.every((id) => selected.includes(id))
    setSelected((current) =>
      whole ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])],
    )
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
        await reload()
      }
    })
  }

  const createCount = plan?.entries.filter((entry) => entry.action === 'create').length ?? 0
  const skipCount = plan?.entries.filter((entry) => entry.action === 'skip').length ?? 0

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
            <p className="dsm-empty">{t('noSessions')}</p>
          ) : (
            groups.map((group) => {
              const ids = group.sessions.map((session) => session.id)
              const picked = ids.filter((id) => selected.includes(id)).length
              // 组头的名字：登记过就用工作区标题（人认得的名字），没登记就只剩路径可显示。
              const name = group.title ?? (group.path === '' ? t('noCwdGroup') : group.path)
              return (
                // key 用路径；没有 cwd 的那一组路径是空串，换成一个不可能撞上路径的键。
                <div key={group.path === '' ? '\u0000no-cwd' : group.path} className="dsm-group">
                  <label className="dsm-groupHead">
                    <GroupCheckbox
                      checked={picked === ids.length}
                      indeterminate={picked > 0 && picked < ids.length}
                      label={t('selectGroup', { name })}
                      onToggle={() => toggleGroup(group)}
                    />
                    <span className="dsm-groupTitle">{name}</span>
                    {group.title !== undefined && <span className="dsm-meta">{group.path}</span>}
                    {group.title === undefined && group.path !== '' && (
                      <span className="dsm-tag dsm-tagIdle">{t('unregisteredDir')}</span>
                    )}
                    <span className="dsm-spacer" />
                    <span className="dsm-hint">{t('sessionsInDir', { count: ids.length })}</span>
                    <span className="dsm-hint">{t('selectedCount', { count: picked })}</span>
                  </label>
                  {group.sessions.map((session) => (
                    <label key={session.id} className="dsm-row dsm-rowExport">
                      <input
                        type="checkbox"
                        checked={selected.includes(session.id)}
                        onChange={() => toggle(session.id)}
                      />
                      <span className="dsm-rowId">{session.id}</span>
                      <span className="dsm-meta">{formatBytes(session.bytes)}</span>
                      <span className="dsm-meta">{formatTime(session.createdAt)}</span>
                    </label>
                  ))}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('importTitle')}</span>
        </div>
        <p className="dsm-hint">{t('importHint')}</p>

        <div className="dsm-controls">
          {/* 后缀必须与宿主导出的文件名一致（`src/web.ts` 的 `fileName()`）。这里曾经写成
              `.dhsess`：刚导出的包在选择框的过滤器里被挡掉，用户以为导入坏了——一个错字把功能
              弄坏了，所以 test/client.test.mjs 里钉了一条。 */}
          <input className="dsm-file" type="file" accept=".dshsess" onChange={pickFile} />
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
          <button type="button" className="dsm-button" onClick={doPreview} disabled={busy !== null || file === null}>
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
    </>
  )
}
