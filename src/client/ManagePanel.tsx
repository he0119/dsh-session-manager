/**
 * 「会话」分页：对着整个会话库逐条管理——归档 / 取消归档、删除。
 *
 * 与另外两页的分工：传输页是"把会话带走"、迁移页是"把会话挪个目录并登记"，这一页是"这条会话我
 * 不要了 / 先收起来"。三页共用同一份 `/state`（页面骨架只拉一次），所以列表、标签、条数不会各说各话。
 *
 * 三个刻意的设计：
 *   - **全库都在这里**，包括外壳侧边栏不显示的子代理 / 空白 / 已归档会话：这一页恰恰是用来收拾它们的
 *     （侧边栏里根本点不到），所以它们以标签的形式标出来，而不是被藏掉；筛选条（子代理 / 空白 /
 *     已归档 / 未分组 / 活动中，多选＝任一命中）是同一件事的"只看这几类"，判据在
 *     [sessionFilter.ts](./sessionFilter.ts)；
 *   - **删除分两步**（预演 → 确认），预演把"哪些会话会被删、备份落在哪"摆清楚；执行时**先备份再删**
 *     （见 src/remove.ts），恢复走「迁移」页的「备份与回滚」；
 *   - **归档走宿主能力**（`workspaceRegistry`），一次落盘 + 改内存 + 广播，侧边栏即时跟着变；宿主
 *     没有这个能力时按钮禁用并说明原因，而不是绕过宿主去写注册表文件。
 *
 * @module dsh-session-manager/client/ManagePanel
 */

import * as React from 'react'

import {
  archiveSessions,
  deleteSessions,
  type DeleteResponse,
  type SessionSummary,
} from './api.ts'
import { translateWith, zh, type Translate } from './locales.ts'
import { SessionIcon } from './icons.tsx'
import { sessionLabel } from './planRows.ts'
import {
  FILTER_KEYS,
  attributeKeys,
  filterCounts,
  filterSessions,
  type AttributeKey,
  type FilterKey,
} from './sessionFilter.ts'
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
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 行上的属性标签 → 字典键（文案 + "这条会话为什么是这样"的说明）。
 *
 * 这条会话**能挂几枚就挂几枚**（空白且已归档的两枚都挂）：标签既是"侧边栏为什么不显示它"的答案，
 * 也是"这条会话是什么"的标记，而筛选条正是按后者工作的——只挂宿主先判的那一枚，筛「已归档」时就会
 * 冒出几行没有归档标签的会话。
 */
const ATTRIBUTE_LABELS: Record<AttributeKey, { tag: string; tip: string }> = {
  subagent: { tag: 'tagSubagent', tip: 'tagSubagentTip' },
  blank: { tag: 'tagBlank', tip: 'tagBlankTip' },
  archived: { tag: 'tagArchived', tip: 'tagArchivedTip' },
  live: { tag: 'tagLive', tip: 'tagLiveTip' },
}

/** 筛选条上的文案：四类属性与行上标签用同一份文案，「未分组」复用归属那一格的文案与说明。 */
const FILTER_LABELS: Record<FilterKey, { label: string; tip: string }> = {
  subagent: { label: 'tagSubagent', tip: 'tagSubagentTip' },
  blank: { label: 'tagBlank', tip: 'tagBlankTip' },
  archived: { label: 'tagArchived', tip: 'tagArchivedTip' },
  live: { label: 'tagLive', tip: 'tagLiveTip' },
  unowned: { label: 'ungroupedSource', tip: 'unregisteredSessionTip' },
}

/** 这一行属于哪个工作区（未登记就写「未分组」，与外壳侧边栏的叫法一致）。 */
function ownerText(session: SessionSummary, paths: ReadonlyMap<string, string>, t: Translate): string {
  if (session.workspaceId === undefined) return t('ungroupedSource')
  return paths.get(session.workspaceId) ?? session.workspaceId
}

/** 「会话」分页。 */
export function ManagePanel({ t = fallback, state, reload }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const archiveAvailable = state?.archiveAvailable === true

  const [selected, setSelected] = React.useState<readonly string[]>([])
  /** 筛选条：一枚都不勾 = 全都列出来（见 sessionFilter.filterSessions）。 */
  const [filters, setFilters] = React.useState<readonly FilterKey[]>([])
  const [busy, setBusy] = React.useState<'archive' | 'unarchive' | 'plan' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [plan, setPlan] = React.useState<DeleteResponse | null>(null)
  const [failed, setFailed] = React.useState<Array<{ id: string; error: string }>>([])

  const workspacePaths = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const workspace of state?.workspaces ?? []) map.set(workspace.id, workspace.path)
    return map
  }, [state])

  /** 当前列出来的那些（筛选之后）。 */
  const listed = React.useMemo(() => filterSessions(sessions, filters), [sessions, filters])
  /** 每一类各有多少条：对整个库数，不随当前筛选跳（会跳的计数没人信得过）。 */
  const counts = React.useMemo(() => filterCounts(sessions), [sessions])

  const toggleFilter = (key: FilterKey): void => {
    setFilters((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
  }

  // 已被删掉/已不在列表里的 id 不该继续留在选择集里（预演完再刷新时会遇到）。
  const known = React.useMemo(() => new Set(sessions.map((session) => session.id)), [sessions])
  const picked = React.useMemo(() => selected.filter((id) => known.has(id)), [selected, known])

  const toggle = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  const doArchive = async (archived: boolean): Promise<void> => {
    setBusy(archived ? 'archive' : 'unarchive')
    setError(null)
    setNotice(null)
    setFailed([])
    try {
      const response = await archiveSessions(picked, archived)
      // 逐条失败照旧摆出来：一条因为"正在跑"被宿主拒了，不该把其余成功的说成失败。
      setFailed(response.failed)
      if (response.archived.length > 0) {
        setNotice(
          t(archived ? 'manageArchived' : 'manageUnarchived', { count: response.archived.length }) +
            ` ${t('manageArchiveImmediate')}`,
        )
      }
      if (response.failed.length === 0) setSelected([])
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const runDelete = async (mode: 'plan' | 'apply'): Promise<void> => {
    setBusy(mode)
    setError(null)
    if (mode === 'plan') {
      setNotice(null)
      setFailed([])
    }
    try {
      const response = await deleteSessions(picked, mode)
      setPlan(response)
      if (mode === 'apply' && response.applied) {
        setNotice(response.summary)
        setSelected([])
        setPlan(null)
        await reload()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPlan(null)
    } finally {
      setBusy(null)
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
      {failed.length > 0 && (
        <p className="dsm-banner dsm-warn">
          <span>{t('manageArchiveFailed', { count: failed.length })}</span>
        </p>
      )}
      {failed.map((item) => (
        <p key={item.id} className="dsm-warn">
          {item.id}：{item.error}
        </p>
      ))}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('manageTitle')}</span>
          <span className="dsm-hint">{t('selectedCount', { count: picked.length })}</span>
          {filters.length > 0 && (
            <span className="dsm-hint">{t('manageShown', { shown: listed.length, total: sessions.length })}</span>
          )}
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            // 筛过之后再点「全选」，要的是"这几类都选上"，不是"把看不见的也选上"。
            onClick={() => setSelected(listed.map((session) => session.id))}
            disabled={listed.length === 0}
          >
            {t('selectAllSessions')}
          </button>
          <button type="button" className="dsm-button" onClick={() => setSelected([])} disabled={picked.length === 0}>
            {t('clearAll')}
          </button>
        </div>
        <p className="dsm-hint">{t('manageHint')}</p>
        {!archiveAvailable && <p className="dsm-hint">{t('manageArchiveUnavailable')}</p>}

        {sessions.length > 0 && (
          <div className="dsm-filters">
            <span className="dsm-hint">{t('filterLabel')}</span>
            <button
              type="button"
              className="dsm-filter"
              aria-pressed={filters.length === 0}
              onClick={() => setFilters([])}
            >
              {t('filterAll')}
            </button>
            {FILTER_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                className="dsm-filter"
                aria-pressed={filters.includes(key)}
                title={t(FILTER_LABELS[key].tip)}
                onClick={() => toggleFilter(key)}
              >
                {t(FILTER_LABELS[key].label)}
                <span className="dsm-filterCount">{counts[key]}</span>
              </button>
            ))}
          </div>
        )}
        {/* 自己一行，不跟胶囊抢同一行的剩余宽度（理由见 styles.ts 的 .dsm-filters 注释）。 */}
        {sessions.length > 0 && <p className="dsm-hint">{t('filterHint')}</p>}

        {sessions.length === 0 ? (
          <p className="dsm-empty">{t('noSessions')}</p>
        ) : listed.length === 0 ? (
          <p className="dsm-empty">{t('manageNoMatch')}</p>
        ) : (
          <div className="dsm-list">
            {listed.map((session) => {
              // 与另外两页同一套口径：显示标题、id 退到悬浮提示（见 planRows.sessionLabel）。
              const label = sessionLabel(session)
              return (
                <label key={session.id} className="dsm-row dsm-rowManage">
                  <input type="checkbox" checked={picked.includes(session.id)} onChange={() => toggle(session.id)} />
                  <SessionIcon />
                  <span className="dsm-rowLabel">
                    <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={label.tip}>
                      {label.text}
                    </span>
                    {/*
                      侧边栏看不到的那几类、以及"还活在宿主内存里"的那一类，各挂一枚标签：这一页正是
                      用来收拾它们的，藏起来等于假装没有。能挂几枚挂几枚（见 ATTRIBUTE_LABELS）。
                    */}
                    {attributeKeys(session).map((key) => (
                      <span key={key} className="dsm-tag dsm-tagIdle" title={t(ATTRIBUTE_LABELS[key].tip)}>
                        {t(ATTRIBUTE_LABELS[key].tag)}
                      </span>
                    ))}
                  </span>
                  <span className="dsm-meta" title={session.cwd ?? ''}>
                    {ownerText(session, workspacePaths, t)}
                  </span>
                  <span className="dsm-meta">{formatBytes(session.bytes)}</span>
                  <span className="dsm-meta">{formatTime(session.createdAt)}</span>
                </label>
              )
            })}
          </div>
        )}

        <div className="dsm-controls">
          <button
            type="button"
            className="dsm-button"
            onClick={() => void doArchive(true)}
            disabled={busy !== null || picked.length === 0 || !archiveAvailable}
          >
            {busy === 'archive' ? t('manageArchiving') : t('manageArchive')}
          </button>
          <button
            type="button"
            className="dsm-button"
            onClick={() => void doArchive(false)}
            disabled={busy !== null || picked.length === 0 || !archiveAvailable}
          >
            {busy === 'unarchive' ? t('manageArchiving') : t('manageUnarchive')}
          </button>
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            onClick={() => void runDelete('plan')}
            disabled={busy !== null || picked.length === 0}
          >
            {busy === 'plan' ? t('previewing') : t('manageDeletePreview')}
          </button>
        </div>
        <p className="dsm-hint">{t('manageDeleteHint')}</p>
      </div>

      {plan !== null && (
        <div className="dsm-card">
          <div className="dsm-cardHead">
            <span className="dsm-cardTitle">{t('manageDeletePlanTitle')}</span>
          </div>
          <p className={plan.preview.ok ? 'dsm-ok' : 'dsm-warn'}>{plan.summary}</p>
          {plan.problems.length > 0 && (
            <div className="dsm-problems">
              {plan.problems.map((problem) => (
                <p key={problem} className="dsm-warn">
                  {problem}
                </p>
              ))}
            </div>
          )}
          <p className="dsm-hint">{t('manageBackupTo', { dir: plan.backupDir ?? plan.preview.backupRoot })}</p>
          <div className="dsm-list">
            {plan.preview.entries.map((entry) => {
              const label = sessionLabel(entry)
              return (
                <div key={entry.id} className="dsm-row dsm-rowDelete">
                  <SessionIcon />
                  <span className="dsm-rowLabel">
                    <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={label.tip}>
                      {label.text}
                    </span>
                  </span>
                  <span className="dsm-meta" title={entry.dir}>
                    {formatBytes(entry.bytes)}
                  </span>
                  <span className="dsm-meta">{formatTime(entry.createdAt)}</span>
                </div>
              )
            })}
          </div>
          <div className="dsm-controls">
            <button
              type="button"
              className="dsm-button dsm-primary"
              onClick={() => void runDelete('apply')}
              disabled={busy !== null || !plan.preview.ok}
            >
              {busy === 'apply' ? t('manageDeleting') : t('manageDeleteApply')}
            </button>
            <button type="button" className="dsm-button" onClick={() => setPlan(null)} disabled={busy !== null}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
