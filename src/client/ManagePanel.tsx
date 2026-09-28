/**
 * 「会话」分页：对着整个会话库逐条管理——归档 / 取消归档、删除。
 *
 * 与另外两页的分工：传输页是"把会话带走"、迁移页是"把会话挪个目录并登记"，这一页是"这条会话我
 * 不要了 / 先收起来"。三页共用同一份 `/state`（页面骨架只拉一次）与同一套列表骨架
 * （[sessionList.tsx](./sessionList.tsx)），所以行、标签、条数、筛选条不会各说各话。
 *
 * 三个刻意的设计：
 *   - **全库都在这里**，包括外壳侧边栏不显示的子代理 / 空白 / 已归档会话：这一页恰恰是用来收拾它们的
 *     （侧边栏里根本点不到），所以它们以标签的形式标出来，而不是被藏掉；筛选条（子代理 / 空白 /
 *     已归档 / 未分组 / 活动中，多选＝任一命中，外加标题搜索）是同一件事的"只看这几类"，判据在
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
import { FILTER_KEYS } from './sessionFilter.ts'
import {
  SessionFilterBar,
  SessionListBox,
  SessionListEmpty,
  SessionRow,
  SessionStaticRow,
  useSessionFilter,
} from './sessionList.tsx'
import type { PanelShare } from './types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

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
  /** 筛选条：一枚芯片都不勾、关键词为空 = 全都列出来（见 sessionFilter.matchesFilters）。 */
  const filter = useSessionFilter(sessions)
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

  /** 当前列出来的那些（筛过之后）。 */
  const listed = React.useMemo(() => sessions.filter(filter.matches), [sessions, filter.matches])

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
          {filter.active && (
            <span className="dsm-hint">{t('shownCount', { shown: listed.length, total: sessions.length })}</span>
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

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}

        {/* 高度固定：连"一条都没筛出来"（以及库里一条都没有）也画在这个框里，否则那些状态会把
            这一页的高度改回去，外层滚动条又能把整个卡片挪动 15px（见 styles.ts 的 .dsm-listFixed）。 */}
        <SessionListBox fixed>
          {sessions.length === 0 ? (
            <SessionListEmpty text={t('noSessions')} />
          ) : (
            <>
              {listed.length === 0 && <SessionListEmpty text={t('noMatch')} />}
              {listed.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  variant="manage"
                  checked={picked.includes(session.id)}
                  onToggle={() => toggle(session.id)}
                  owner={ownerText(session, workspacePaths, t)}
                  // 归属那一格写着「未分组」，再挂一枚同名标签是重复。
                  ungroupedTag={false}
                  t={t}
                />
              ))}
            </>
          )}
        </SessionListBox>

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
          <SessionListBox>
            {plan.preview.entries.map((entry) => (
              <SessionStaticRow
                key={entry.id}
                session={entry}
                className="dsm-row dsm-rowDelete"
                metaTitle={entry.dir}
              />
            ))}
          </SessionListBox>
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
