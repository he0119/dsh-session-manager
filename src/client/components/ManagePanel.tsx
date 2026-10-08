/**
 * 「会话」分页：对着整个会话库逐条管理——归档 / 取消归档、删除。
 *
 * 与另外两页的分工：传输页是"把会话带走"、迁移页是"把会话挪个目录并登记"，这一页是"这条会话我
 * 不要了 / 先收起来"。三页共用同一份 `/state`（页面骨架只拉一次）与同一套列表骨架
 * （[sessionList.tsx](./sessionList.tsx)），所以行、标签、条数、筛选条、选行那一对按钮都不会各说各话。
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

import { archiveSessions, deleteSessions, type DeleteResponse, type ProgressEvent } from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import { groupKey, groupSessions, nestSessions } from '../logic/groups.ts'
import { deleteFamilyNote, parentDirNote } from '../logic/planRows.ts'
import { FILTER_KEYS } from '../logic/sessionFilter.ts'
import {
  SessionFilterBar,
  SessionGroupHead,
  SessionGroupTools,
  SessionListBox,
  SessionListEmpty,
  SessionPickTools,
  SessionRow,
  SessionStaticRow,
  useGroupCollapse,
  useSessionFilter,
  useSessionPicking,
} from './sessionList.tsx'
import type { PanelShare } from '../types.ts'

/** 「会话」分页。 */
export function ManagePanel({ t, state, meta, reload }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  // 归档能力位与清单无关（`/meta` 先给），所以它用 `state ?? meta`：清单还在读时也不会先把
  // "这个宿主没有 workspaceRegistry"画上去。
  const facts = state ?? meta
  const archiveAvailable = facts?.archiveAvailable === true

  /**
   * 勾选：行勾选、整组勾选、全选、清空，以及"这一行为什么不能单独勾"。
   *
   * 整份逻辑在 [sessionList.tsx](./sessionList.tsx) 里，与「传输」页共用一份（那一页原先自己写了一遍
   * 逐字同形的 `toggle` / `toggleGroup` / `lockOf`）。判据见那里的 `useSessionPicking()`：
   * 能勾的集合就是"单独操作不会被拒的集合"（子智能体跟着父会话走）。
   */
  const picking = useSessionPicking(sessions, t)
  const picked = picking.picked
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
   * 最近收到的那条进度事件（归档与删除共用一份：两者不会同时进行，`busy` 就分得开）。
   *
   * 删除那两段是"扫整库"与"先备份再删"，归档那段是逐条走宿主的注册表动作——都是按下之后要等的活。
   *
   * 声明排在**最后**（不跟 `busy` 挤在一起）：冒烟用例按位置往 null 状态里种值（见 test/client.test.mjs
   * 的 `nulls`），插在中间会让后面那些种子的位置整体错一格。
   */
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null)

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
  /** 眼下列出来的那些里能单独勾的（「全选」的作用面与禁用判据）。 */
  const pickable = picking.selectableOf(listed)

  const doArchive = async (archived: boolean): Promise<void> => {
    setBusy(archived ? 'archive' : 'unarchive')
    setError(null)
    setNotice(null)
    setFailed([])
    setProgress(null)
    try {
      const response = await archiveSessions(picked, archived, setProgress)
      // 逐条失败照旧摆出来：一条因为"正在跑"被宿主拒了，不该把其余成功的说成失败。
      setFailed(response.failed)
      if (response.archived.length > 0) {
        setNotice(
          t(archived ? 'manage.archive.done' : 'manage.archive.undone', { count: response.archived.length }) +
            ` ${t('manage.archive.immediate')}`,
        )
      }
      if (response.failed.length === 0) picking.clear()
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
      setProgress(null)
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
    setProgress(null)
    void deleteSessions(picked, 'plan', setProgress).then(
      (response) => {
        setProgress(null)
        setPending((current) => (current === null ? current : { ...current, plan: response }))
      },
      (cause) => {
        setProgress(null)
        setPending((current) =>
          current === null ? current : { plan: null, error: cause instanceof Error ? cause.message : String(cause) },
        )
      },
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
    setProgress(null)
    void deleteSessions(picked, 'apply', setProgress).then(
      (response) => {
        setBusy(null)
        setProgress(null)
        if (response.applied) {
          setNotice(response.summary)
          picking.clear()
          setPending(null)
          void reload()
          return
        }
        setPending((current) => (current === null ? current : { ...current, plan: response }))
      },
      (cause) => {
        setBusy(null)
        setProgress(null)
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
          {/*
            筛过之后「全选」要的是"这几类都选上"，不是"把看不见的也选上"；不能单独勾的那些也不进来：
            子智能体跟着父会话走，勾父会话就等于勾了它。这一对与「传输」「迁移」两页是同一个组件。
          */}
          <SessionPickTools
            selectableCount={pickable.length}
            pickedCount={picked.length}
            onSelectAll={() => picking.selectAll(listed)}
            onClear={picking.clear}
            t={t}
          />
        </div>
        <p className="dsm-hint">{t('manage.hint')}</p>
        {/* 能力位还没到（首帧，`/meta` 与 `/state` 都没回来）时先不说结论：那一刻的真相是"还不知道"。 */}
        {facts !== undefined && !archiveAvailable && <p className="dsm-hint">{t('manage.archive.unavailable')}</p>}

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}
        {groups.length > 0 && <SessionGroupTools collapse={collapse} t={t} />}

        {/* 高度固定：连"一条都没筛出来"（以及库里一条都没有）也画在这个框里，否则那些状态会把
            这一页的高度改回去，外层滚动条又能把整个卡片挪动 15px（见 styles.ts 的 .dsm-listFixed）。 */}
        <SessionListBox fixed>
          {state === null ? (
            // 清单还在读：这一格说"读取中…"而不是"这个会话库里还没有会话"——后者是个结论。
            <SessionListEmpty text={t('page.loading')} />
          ) : sessions.length === 0 ? (
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
                    onToggle={() => picking.toggleGroup(rows.map((row) => row.session))}
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
                        onToggle={() => picking.toggle(row.session)}
                        depth={row.depth}
                        note={parentDirNote(row, t)}
                        locked={picking.lockOf(row.session)}
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
        {/* 归档 / 取消归档的进度：逐条走宿主能力，勾一整页时这一段是可感知的。 */}
        {(busy === 'archive' || busy === 'unarchive') &&
          (progress === null ? (
            <p className="dsm-hint">{t('progress.waiting')}</p>
          ) : (
            <ProgressBlock t={t} progress={progress} />
          ))}
        <p className="dsm-hint">{t('manage.delete.hint')}</p>
      </div>

      {/* 删除弹窗：清单与「确认」在同一块地方（见 ConfirmDialog.tsx 的说明）。 */}
      {pending !== null && (
        <ConfirmDialog
          t={t}
          // 落地那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t(busy === 'apply' ? 'manage.delete.running' : 'manage.delete.dialogTitle')}
          confirmLabel={t('manage.delete.apply')}
          busyLabel={t('manage.delete.running')}
          busy={busy === 'apply'}
          planning={pending.plan === null && pending.error === null}
          // 预演要扫整库（找这些会话与它们的后代），那几秒里把静态的「预演中…」换成进度。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={pending.error}
          disabled={pending.plan === null || !pending.plan.preview.ok}
          onConfirm={applyDelete}
          onCancel={() => setPending(null)}
        >
          {/* 落地：先备份整份会话目录再删，正文换成进度（清单说的是"将要"，这时候已经过期了）。 */}
          {busy === 'apply' &&
            (progress === null ? (
              <p className="dsm-hint">{t('progress.waiting')}</p>
            ) : (
              <ProgressBlock t={t} progress={progress} note={t('manage.delete.progress.note')} />
            ))}
          {busy !== 'apply' && pending.plan !== null && (
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
