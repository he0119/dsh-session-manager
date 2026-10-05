/**
 * 「会话」分页：对着整个会话库逐条管理——归档 / 取消归档、删除。
 *
 * 与另外两页的分工：传输页是"把会话带走"、迁移页是"把会话挪个目录并登记"，这一页是"这条会话我
 * 不要了 / 先收起来"。三页共用同一份 `/state`（页面骨架只拉一次）与同一套列表骨架
 * （[sessionList.tsx](./sessionList.tsx)），所以行、标签、条数、筛选条不会各说各话。
 *
 * 三个刻意的设计：
 *   - **全库都在这里**，包括外壳侧边栏不显示的子智能体 / 空白 / 已归档会话：这一页恰恰是用来收拾它们的
 *     （侧边栏里根本点不到），所以它们以标签的形式标出来，而不是被藏掉；筛选条（子智能体 / 空白 /
 *     已归档 / 未分组 / 活动中，多选＝任一命中，外加标题搜索）是同一件事的"只看这几类"，判据在
 *     [sessionFilter.ts](./sessionFilter.ts)；
 *   - **列表与「传输」页同形**：按目录分组、组头可折叠、组头那一下就是整组勾选（"把这个旧项目的会话
 *     都归档 / 都删掉"因此是一次点击）。归属因此从行里挪进了组头——行上那六列本来有一列专门写着工作区
 *     路径，而组头就写着它，重复那一次是白占标题的宽度；注册表没认领的会话仍挂「未分组」小标签（它
 *     与组头说的是两件事：组头是目录，标签是"注册表不认这条"）；
 *   - **删除那一下就把清单摆出来**：点「删除所选」开确认弹窗，里面是"哪些会话会被删、备份落在哪"，
 *     确认才落盘（见 [ConfirmDialog.tsx](./ConfirmDialog.tsx)）；执行时**先备份再删**（见 src/remove.ts），
 *     恢复走「迁移」页的「备份与回滚」；
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
} from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { groupKey, groupSessions, lockedParentOf, nestSessions } from '../logic/groups.ts'
import { deleteFamilyNote, parentDirNote } from '../logic/planRows.ts'
import { FILTER_KEYS } from '../logic/sessionFilter.ts'
import {
  SessionFilterBar,
  SessionGroupHead,
  SessionGroupTools,
  SessionListBox,
  SessionListEmpty,
  SessionRow,
  SessionStaticRow,
  useGroupCollapse,
  useSessionFilter,
} from './sessionList.tsx'
import type { PanelShare } from '../types.ts'

/** 「会话」分页。 */
export function ManagePanel({ t, state, reload }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const archiveAvailable = state?.archiveAvailable === true

  const [selected, setSelected] = React.useState<readonly string[]>([])
  /** 筛选条：一枚芯片都不勾、关键词为空 = 全都列出来（见 sessionFilter.matchesFilters）。 */
  const filter = useSessionFilter(sessions)
  const [busy, setBusy] = React.useState<'archive' | 'unarchive' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /**
   * 删除弹窗：`null` = 没开；开了之后先是一份空壳（计划还在算），算完填进去。
   *
   * 计划与"弹窗开没开"合成一个状态，是因为它俩本来就是一回事：没有弹窗就没有要看的计划，取消
   * （或落地成功）之后那份计划也不该留在页面上——它说的是按下去那一刻的库，留着只会让人以为它还算数。
   */
  const [pending, setPending] = React.useState<{ plan: DeleteResponse | null; error: string | null } | null>(null)
  const [failed, setFailed] = React.useState<Array<{ id: string; error: string }>>([])

  /**
   * 按目录分组，组内留着筛选之后的那些（空掉的组整组不画：组头底下没有行，看着像坏了）。
   *
   * 与「传输」页逐字同形（那边也是这几步），理由见 groups.ts：分组键是目录而不是注册表里的工作区 id，
   * 因为同一个目录下常有没登记的会话，而用户说"这个工作区的会话"指的是这个目录。
   */
  const groups = React.useMemo(() => {
    const filtered = groupSessions(sessions, state?.workspaces ?? [])
      .map((group) => ({ group, sessions: group.sessions.filter(filter.matches) }))
      .filter((item) => item.sessions.length > 0)
    // 缩进在**筛完之后**才算：父被筛掉时子按普通行画（见 groups.nestSessions 的三条边界）。
    const visible = new Set(filtered.flatMap((item) => item.sessions.map((session) => session.id)))
    return filtered.map((item) => ({ group: item.group, rows: nestSessions(item.sessions, sessions, visible) }))
  }, [sessions, state, filter.matches])
  /** 折叠：只把组内的行收起来，不改"列出来了哪些"（见 TransferPanel 里的同一段说明）。 */
  const collapse = useGroupCollapse(groups.map((item) => groupKey(item.group.path)))
  /** 当前列出来的那些（筛过之后，按组摊平）。缩进只改画法，不改"列出来了哪些"。 */
  const listed = React.useMemo(() => groups.flatMap((item) => item.rows.map((row) => row.session)), [groups])

  // 已被删掉/已不在列表里的 id 不该继续留在选择集里（弹窗里删完再刷新时会遇到）。
  const known = React.useMemo(() => new Set(sessions.map((session) => session.id)), [sessions])
  const picked = React.useMemo(() => selected.filter((id) => known.has(id)), [selected, known])

  /**
   * 这一行能不能单独勾：子智能体跟着父会话走（父会话还在库里时就只能跟着它）。
   *
   * 判据在 `groups.ts` 的 `lockedParentOf()` 里，与宿主那几条路（remove.ts、web.ts 的归档与导出）
   * 同源——能勾的集合就是"单独操作不会被拒的集合"。
   */
  const lockOf = React.useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    return (session: SessionSummary): { tip: string } | undefined => {
      const parent = lockedParentOf(session, byId)
      return parent === undefined ? undefined : { tip: t('list.lockedSubagentTip', { name: parent.title ?? parent.id }) }
    }
  }, [sessions, t])
  const selectable = (session: SessionSummary): boolean => lockOf(session) === undefined

  const toggle = (session: SessionSummary): void => {
    if (!selectable(session)) return
    const id = session.id
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  /** 组头那一下：整组勾上，或整组取消（与「传输」页同一套）。不能单独勾的那些不参与。 */
  const toggleGroup = (sessions: readonly SessionSummary[]): void => {
    const ids = sessions.filter(selectable).map((session) => session.id)
    if (ids.length === 0) return
    const whole = ids.every((id) => selected.includes(id))
    setSelected((current) =>
      whole ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])],
    )
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
          t(archived ? 'manage.archive.done' : 'manage.archive.undone', { count: response.archived.length }) +
            ` ${t('manage.archive.immediate')}`,
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

  /**
   * 点「删除所选」：开弹窗，同时把只读的删除计划取回来。
   *
   * 计划是**只读**的一次计算（`mode: 'plan'` 不落盘，见 src/remove.ts），所以这一步可以放心地替用户
   * 做掉——他还没承诺任何事。取回来之前弹窗里只有一行"预演中…"，落地按钮是禁用的。
   *
   * 计划回来时弹窗可能已经被取消掉了（用户在这几百毫秒里按了 Escape）：`current === null` 时原地
   * 作废，不然一个已经被关掉的弹窗会被打印出来的计划**重新打开**。
   */
  const openDelete = (): void => {
    if (picked.length === 0) return
    setError(null)
    setNotice(null)
    setFailed([])
    setPending({ plan: null, error: null })
    void deleteSessions(picked, 'plan').then(
      (response) => setPending((current) => (current === null ? current : { ...current, plan: response })),
      (cause) =>
        setPending((current) =>
          current === null ? current : { plan: null, error: cause instanceof Error ? cause.message : String(cause) },
        ),
    )
  }

  /**
   * 弹窗里按「确认删除」：真删（先备份再删，见 src/remove.ts）。
   *
   * 失败有两种，各归各的地方：
   *   - **计划本身不 ok / 复核没过**：正文里带着完整结果，把它摆回弹窗里（问题清单当场更新），用户
   *     看着新的问题清单决定下一步；
   *   - **请求本身没走通**（网络、HTTP 参数）：抛给页面顶部的错误横幅，弹窗关掉——那种错留在一个
   *     只剩下"取消"的弹窗里没有意义。
   */
  const applyDelete = (): void => {
    setBusy('apply')
    setError(null)
    void deleteSessions(picked, 'apply').then(
      (response) => {
        setBusy(null)
        if (response.applied) {
          setNotice(response.summary)
          setSelected([])
          setPending(null)
          void reload()
          return
        }
        setPending((current) => (current === null ? current : { ...current, plan: response }))
      },
      (cause) => {
        setBusy(null)
        setPending(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  return (
    <>
      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setError(null)}>
            {t('error.dismiss')}
          </button>
        </p>
      )}
      {notice !== null && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <button type="button" className="dsm-button" onClick={() => setNotice(null)}>
            {t('error.dismiss')}
          </button>
        </p>
      )}
      {failed.length > 0 && (
        <p className="dsm-banner dsm-warn">
          <span>{t('manage.archive.failed', { count: failed.length })}</span>
        </p>
      )}
      {failed.map((item) => (
        <p key={item.id} className="dsm-warn">
          {item.id}：{item.error}
        </p>
      ))}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('manage.title')}</span>
          <span className="dsm-hint">{t('list.selected', { count: picked.length })}</span>
          {filter.active && (
            <span className="dsm-hint">{t('list.shown', { shown: listed.length, total: sessions.length })}</span>
          )}
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            // 筛过之后再点「全选」，要的是"这几类都选上"，不是"把看不见的也选上"；不能单独勾的那些
            // 也不进来：子智能体跟着父会话走，勾父会话就等于勾了它。
            onClick={() => setSelected(listed.filter(selectable).map((session) => session.id))}
            disabled={listed.filter(selectable).length === 0}
          >
            {t('list.selectAll')}
          </button>
          <button type="button" className="dsm-button" onClick={() => setSelected([])} disabled={picked.length === 0}>
            {t('list.clear')}
          </button>
        </div>
        <p className="dsm-hint">{t('manage.hint')}</p>
        {!archiveAvailable && <p className="dsm-hint">{t('manage.archive.unavailable')}</p>}

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}
        {groups.length > 0 && <SessionGroupTools collapse={collapse} t={t} />}

        {/* 高度固定：连"一条都没筛出来"（以及库里一条都没有）也画在这个框里，否则那些状态会把
            这一页的高度改回去，外层滚动条又能把整个卡片挪动 15px（见 styles.ts 的 .dsm-listFixed）。 */}
        <SessionListBox fixed>
          {sessions.length === 0 ? (
            <SessionListEmpty text={t('list.empty')} />
          ) : groups.length === 0 ? (
            <SessionListEmpty text={t('list.noMatch')} />
          ) : (
            groups.map(({ group, rows }) => {
              const key = groupKey(group.path)
              const collapsed = collapse.isCollapsed(key)
              return (
                <div key={key} className="dsm-group">
                  <SessionGroupHead
                    path={group.path}
                    title={group.title}
                    repo={state?.repos?.[group.path]}
                    count={rows.length}
                    picked={rows.filter((row) => picked.includes(row.session.id)).length}
                    collapsed={collapsed}
                    onToggle={() => toggleGroup(rows.map((row) => row.session))}
                    onToggleCollapse={() => collapse.toggle(key)}
                    t={t}
                  />
                  {!collapsed &&
                    rows.map((row) => (
                      <SessionRow
                        key={row.session.id}
                        session={row.session}
                        variant="manage"
                        checked={picked.includes(row.session.id)}
                        onToggle={() => toggle(row.session)}
                        depth={row.depth}
                        note={parentDirNote(row, t)}
                        locked={lockOf(row.session)}
                        t={t}
                      />
                    ))}
                </div>
              )
            })
          )}
        </SessionListBox>

        <div className="dsm-controls">
          <button
            type="button"
            className="dsm-button"
            onClick={() => void doArchive(true)}
            disabled={busy !== null || picked.length === 0 || !archiveAvailable}
          >
            {busy === 'archive' ? t('manage.archive.running') : t('manage.archive.action')}
          </button>
          <button
            type="button"
            className="dsm-button"
            onClick={() => void doArchive(false)}
            disabled={busy !== null || picked.length === 0 || !archiveAvailable}
          >
            {busy === 'unarchive' ? t('manage.archive.running') : t('manage.archive.undo')}
          </button>
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            onClick={openDelete}
            disabled={busy !== null || picked.length === 0}
          >
            {t('manage.delete.action')}
          </button>
        </div>
        <p className="dsm-hint">{t('manage.delete.hint')}</p>
      </div>

      {/* 删除弹窗：清单与「确认」在同一块地方（见 ConfirmDialog.tsx 的说明）。 */}
      {pending !== null && (
        <ConfirmDialog
          t={t}
          title={t('manage.delete.dialogTitle')}
          confirmLabel={t('manage.delete.apply')}
          busyLabel={t('manage.delete.running')}
          busy={busy === 'apply'}
          planning={pending.plan === null && pending.error === null}
          error={pending.error}
          disabled={pending.plan === null || !pending.plan.preview.ok}
          onConfirm={applyDelete}
          onCancel={() => setPending(null)}
        >
          {pending.plan !== null && (
            <>
              <p className={pending.plan.preview.ok ? 'dsm-ok' : 'dsm-warn'}>{pending.plan.summary}</p>
              {pending.plan.problems.length > 0 && (
                <div className="dsm-problems">
                  {pending.plan.problems.map((problem) => (
                    <p key={problem} className="dsm-warn">
                      {problem}
                    </p>
                  ))}
                </div>
              )}
              <p className="dsm-hint">
                {t('manage.delete.backupTo', { dir: pending.plan.backupDir ?? pending.plan.preview.backupRoot })}
              </p>
              <SessionListBox>
                {pending.plan.preview.entries.map((entry) => (
                  <SessionStaticRow
                    key={entry.id}
                    session={entry}
                    className="dsm-row dsm-rowPlan"
                    metaTitle={entry.dir}
                    // 级联带进来的条目在清单里是"没勾过却要一起删"的那些，得在行上说明出处；
                    // 同时缩进一级：宿主给的顺序是"点名的在前、随后是各自的后代"（familyOf 的 BFS），
                    // 缩进之后"哪几条是它带进来的"不用读标签也看得出。
                    depth={entry.via === undefined ? 0 : 1}
                    note={deleteFamilyNote(entry, t)}
                  />
                ))}
              </SessionListBox>
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
