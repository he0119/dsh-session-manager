/**
 * 「传输」分页：把会话带走（导出 .dshsess）或带回来（导入）。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/transfer.ts`）：计划返回的就是将要发生的事，页面不自己推算
 *
 *   - 导出：按目录分组的列表里勾选（组头可整组勾）→ 宿主打包 → 浏览器下载；
 *   - 导入：选包 + 选目标目录（与「迁移」页共用那枚目录值控件，见 [DirectoryField.tsx](./DirectoryField.tsx)）
 *     → 点「导入」开确认弹窗（看清 create/skip 与 cwd 改写）→ 确认才落盘。
 *
 * 导出那一个**不问**：它只把已有字节打成包给浏览器下载，不改本机任何东西，弹一次窗只是多一次点击。
 * 会写盘的那个（导入）才需要先看清再确认——这条分界与「会话」页里归档（即时）和删除（弹窗）的分界
 * 是同一条。
 *
 * 两张卡的形状不同（一张是列表、一张是字段），但**主动作的位置是同一条规矩**：卡片级的主动作（导出所选、
 * 导入）一律在卡片底部的动作行里，卡片头部只放不动数据的工具（全选 / 清空、刷新、收起 / 展开）。
 * 判据见 [决策](../../../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md)：
 * 动作跟着它的输入走——字段与清单在上、动作在下，与确认弹窗、与内建设置页的表单同一个阅读顺序。
 *
 * WebDAV 同步**不在这里**：它是一条常设通道（远端地址、机器名、映射表与确认弹窗），与本页的正交，
 * 见 [SyncPanel.tsx](./SyncPanel.tsx)。两件事挤在一页时，同步那块只能排在导出列表与导入计划表之后。
 *
 * 会话库数据由页面骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉好传进来：切分页不该各拉一份，
 * 也不该出现"两个分页对同一个库给出不同数字"。列表行、组头、列表框与筛选条都出自
 * [sessionList.tsx](./sessionList.tsx)——三个分页的行是同一套解剖结构。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token；控件以手写的原生
 * 元素为主，确认弹窗外壳走官方控件库的 `Modal`（[ConfirmDialog.tsx](./ConfirmDialog.tsx) 里说了为
 * 什么）。渲染路径上不许做会抛的事——抛出去整个 Slot 条目会变成崩溃占位（控制台里是
 * `slot entry crashed in '…'`）。
 *
 * @module dsh-session-manager/client/TransferPanel
 */

import * as React from 'react'

import { download, exportSessions, importBundle, type ImportResponse } from '../api.ts'
import type { ImportEntry, SessionSummary } from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { groupKey, groupSessions, lockedParentOf, nestSessions } from '../logic/groups.ts'
import { describeCwd, directoryTargetRows, parentDirNote, sessionLabel } from '../logic/planRows.ts'
import { FILTER_KEYS } from '../logic/sessionFilter.ts'
import {
  SessionFilterBar,
  SessionGroupHead,
  SessionGroupTools,
  SessionListBox,
  SessionListEmpty,
  SessionRow,
  formatBytes,
  totalBytes,
  useGroupCollapse,
  useSessionFilter,
} from './sessionList.tsx'
import { DirectoryField, useDirectoryFields } from './DirectoryField.tsx'
import type { Translate } from '../logic/locales.ts'
import type { PanelShare } from '../types.ts'

/**
 * cwd 那一格：三支分支在 [planRows.ts](./planRows.ts) 里判，这里只挑文案。
 *
 * 跳过的那一支曾经跟着"没有 toCwd"一起被当成"没有 cwd"，把跳过的会话显示成要落 `_no-cwd`。
 */
function cwdText(entry: ImportEntry, t: Translate): string {
  const plan = describeCwd(entry)
  if (plan.kind === 'skip') return t('cwd.skipped')
  if (plan.kind === 'keepNoCwd') return t('cwd.keep')
  return t('cwd.rewritten', { from: plan.from, to: plan.to })
}

/** 传输页。 */
export function TransferPanel({ t, state, meta, reload, directory }: PanelShare): React.ReactElement {
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [file, setFile] = React.useState<File | null>(null)
  const [payload, setPayload] = React.useState<ArrayBuffer | null>(null)
  const [target, setTarget] = React.useState('')
  /**
   * 导入弹窗：`null` = 没开；开了先是一份空壳（计划还在算）。
   *
   * 与另外两页同一套形状（见 [ConfirmDialog.tsx](./ConfirmDialog.tsx)）：计划与弹窗开没开合成一个
   * 状态，取消之后那份计划不会留在页面上。
   */
  const [pending, setPending] = React.useState<{ plan: ImportResponse | null; error: string | null } | null>(null)
  const [busy, setBusy] = React.useState<'export' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  // 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时候选面板里不摆「浏览文件系统…」。
  // 这一项来自 `/meta`（与清单无关、先到），所以清单还在读时那枚按钮也不至于晚一步出现。
  const pickerKind = (state ?? meta)?.pickerKind ?? null
  /** 落地目录那一个字段的展开状态（页面上只有它一个目录字段）。 */
  const fields = useDirectoryFields<'target'>()
  /**
   * 目标目录的候选：与「迁移」页的目标目录同一份构造（见 planRows.directoryTargetRows）——两处问的是
   * 同一件事。
   */
  const targetRows = React.useMemo(
    () => directoryTargetRows(workspaces, state?.repos, target),
    [workspaces, state?.repos, target],
  )
  /** 筛选条：类别芯片 + 标题搜索。这一页列的是**整个库**（隐藏会话也在），所以五类芯片都有意义。 */
  const filter = useSessionFilter(sessions)
  // 列表按**目录**分组（不是按注册表里的工作区）：同一个目录下常有没登记在册的会话，而用户说的
  // "把这个工作区的会话带走"指的永远是这个目录。理由与边界见 groups.ts。
  //
  // 筛选之后**空掉的组不画**（组头底下没有行，看着像坏了），组头报的条数也就是筛剩下的那些——
  // 于是"整组勾选"勾的正是眼前这一组。
  const groups = React.useMemo(() => {
    const filtered = groupSessions(sessions, workspaces)
      .map((group) => ({ group, sessions: group.sessions.filter(filter.matches) }))
      .filter((item) => item.sessions.length > 0)
    // 子智能体缩进到父会话的下一级；缩进在**筛完之后**才算（父被筛掉时子按普通行画），理由与三条边界
    // 见 groups.ts 的 nestSessions。
    const visible = new Set(filtered.flatMap((item) => item.sessions.map((session) => session.id)))
    return filtered.map((item) => ({ group: item.group, rows: nestSessions(item.sessions, sessions, visible) }))
  }, [sessions, workspaces, filter.matches])
  /** 眼下列出来的那些（筛过之后，按组摊平）。缩进只改画法，不改"列出来了哪些"。 */
  const listed = React.useMemo(() => groups.flatMap((item) => item.rows.map((row) => row.session)), [groups])
  /**
   * 折叠：只是把组内的行收起来，**不改"列出来了哪些"**。
   *
   * 收起来的是"画不画"，不是"算不算"：头部照样报「显示 N / M 条」，「全选整库」照样选这些组里的会话
   * （组头上"这组几条 / 勾了几条"一直在，收起一个目录之后这两串数字正是最该看见的）。反过来做——让
   * 折叠把行从全选里摘出去——就会变成"点一下箭头悄悄改了要导出的东西"，那才是真难查。
   */
  const collapse = useGroupCollapse(groups.map((item) => groupKey(item.group.path)))
  const allSelected = listed.length > 0 && listed.every((session) => selected.includes(session.id))

  // 库变了（例如刚导入完）：把已经不在库里的选择摘掉，别让「已选 3」里混着不存在的会话。
  React.useEffect(() => {
    setSelected((current) => current.filter((id) => sessions.some((session) => session.id === id)))
  }, [sessions])

  /**
   * 这一行能不能单独勾：子智能体跟着父会话走（父会话还在库里时就只能跟着它）。判据与「会话」页共用
   * `groups.ts` 的 `lockedParentOf()`，与宿主那条导出路的拒绝判据同源。
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
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))
  }

  /**
   * 点组头：整组勾上，或整组取消。
   *
   * 只勾了一部分时点一下是"补齐"，这是列表的通行手感（Gmail/GitHub 都这样）；想去掉整组，
   * 再看一眼它变成"全部勾上"之后再点一下即可。一条会话都没勾的组同理是"勾上"。
   */
  const toggleGroup = (group: readonly SessionSummary[]): void => {
    const ids = group.filter(selectable).map((session) => session.id)
    if (ids.length === 0) return
    const whole = ids.every((id) => selected.includes(id))
    setSelected((current) =>
      whole ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])],
    )
  }

  const run = async (kind: 'export', action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (cause) {
      setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const doExport = (): void => {
    if (selected.length === 0) {
      setError(t('transfer.import.needSelection'))
      return
    }
    void run('export', async () => {
      const result = await exportSessions(selected)
      download(result)
      const chosen = sessions.filter((session) => selected.includes(session.id))
      // 包里的条数与字节以宿主回报的为准：勾一条父会话时，它的子智能体跟着进包，比勾选数多。
      setNotice(
        t('transfer.export.done', {
          count: result.count ?? chosen.length,
          bytes: formatBytes(result.bytes ?? totalBytes(chosen)),
        }),
      )
    })
  }

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0] ?? null
    setFile(picked)
    setPending(null)
    setError(null)
    setNotice(null)
    if (picked === null) {
      setPayload(null)
      return
    }
    void picked
      .arrayBuffer()
      .then((buffer) => setPayload(buffer))
      .catch((cause: unknown) => setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) })))
  }

  /**
   * 点「导入」：开弹窗，同时把只读的导入计划取回来（`mode=plan` 不写盘）。
   *
   * 包与目标目录都得先有：缺哪个就在页面横幅上说出缺的那个（`transfer.import.needFile` / `transfer.import.needTarget`），而不是
   * 先弹一个空框再抱怨——那一步的错与"计划有什么问题"不是一件事。
   *
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同「会话」页的删除弹窗）。
   */
  const openImport = (): void => {
    if (file === null || payload === null) {
      setError(t('transfer.import.needFile'))
      return
    }
    if (target === '') {
      setError(t('transfer.import.needTarget'))
      return
    }
    setError(null)
    setNotice(null)
    setPending({ plan: null, error: null })
    void importBundle(payload, target, 'plan').then(
      (plan) => setPending((current) => (current === null ? current : { ...current, plan })),
      (cause) =>
        setPending((current) =>
          current === null ? current : { plan: null, error: cause instanceof Error ? cause.message : String(cause) },
        ),
    )
  }

  /**
   * 弹窗里按「确认导入」：真写盘。
   *
   * 一条都没写进去（计划里全是 skip，或落地被拒）时把结果摆回弹窗里：冲突原因就在 `problems` 与每行的
   * `reason` 上，用户得看着它改包或改目标，而不是只收到一句"没写成功"。
   */
  const applyImport = (): void => {
    if (payload === null || target === '') return
    setBusy('apply')
    setError(null)
    void importBundle(payload, target, 'apply').then(
      (result) => {
        setBusy(null)
        if (result.written !== undefined && result.written.length > 0) {
          setPending(null)
          setNotice(t('transfer.import.done', { count: result.written.length, bytes: formatBytes(result.bytes) }))
          void reload()
          return
        }
        setPending((current) => (current === null ? current : { ...current, plan: result }))
      },
      (cause) => {
        setBusy(null)
        setPending(null)
        setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
      },
    )
  }

  const createCount = pending?.plan?.entries.filter((entry) => entry.action === 'create').length ?? 0
  const skipCount = pending?.plan?.entries.filter((entry) => entry.action === 'skip').length ?? 0
  const plan = pending?.plan ?? null

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
      {(state?.problems ?? []).map((problem) => (
        <p key={problem} className="dsm-banner dsm-warn">
          {problem}
        </p>
      ))}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('transfer.export.title')}</span>
          <span className="dsm-hint">{t('list.selected', { count: selected.length })}</span>
          {filter.active && (
            <span className="dsm-hint">{t('list.shown', { shown: listed.length, total: sessions.length })}</span>
          )}
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            // 筛过之后"全选/清空"针对的是**眼下列出来的**那些：勾选面看到什么就选什么，
            // 已经勾上的不会因为切筛选而丢（头部一直报着"已选几条"）。
            // 不能单独勾的那些不进来：子智能体跟着父会话走，勾父会话就等于勾了它。
            onClick={() => setSelected(allSelected ? [] : listed.filter(selectable).map((session) => session.id))}
            disabled={listed.filter(selectable).length === 0}
          >
            {allSelected ? t('list.clear') : t('transfer.export.selectAll')}
          </button>
        </div>
        <p className="dsm-hint">{t('transfer.export.hint')}</p>

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}
        {/* 一个组都没有（筛空了或库里是空的）时不摆这对按钮：没有可收起的东西。 */}
        {groups.length > 0 && <SessionGroupTools collapse={collapse} t={t} />}

        <SessionListBox fixed>
          {state === null ? (
            // 清单还在读：说"读取中…"而不是"这个会话库里还没有会话"（见 ManagerPanel 的两份数据说明）。
            <SessionListEmpty text={t('page.loading')} />
          ) : sessions.length === 0 ? (
            <SessionListEmpty text={t('list.empty')} />
          ) : groups.length === 0 ? (
            // 高度固定，空态画在框里（见 styles.ts 的 .dsm-listFixed）
            <SessionListEmpty text={t('list.noMatch')} />
          ) : (
            groups.map(({ group, rows }) => {
              const key = groupKey(group.path)
              const picked = rows.filter((row) => selected.includes(row.session.id)).length
              const collapsed = collapse.isCollapsed(key)
              return (
                // key 与折叠状态同一个身份（`groupKey`），免得两处各写一遍哨兵。
                <div key={key} className="dsm-group">
                  <SessionGroupHead
                    path={group.path}
                    title={group.title}
                    repo={state?.repos?.[group.path]}
                    count={rows.length}
                    picked={picked}
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
                        variant="export"
                        checked={selected.includes(row.session.id)}
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

        {/* 卡片级的主动作放底部动作行（见文件头那条规矩）：头部只留"全选 / 清空"这枚选行工具。 */}
        <div className="dsm-controls">
          <button type="button" className="dsm-button dsm-primary" onClick={doExport} disabled={busy !== null || selected.length === 0}>
            {busy === 'export' ? t('transfer.export.running') : t('transfer.export.action')}
          </button>
        </div>
      </div>

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('transfer.import.title')}</span>
        </div>
        <p className="dsm-hint">{t('transfer.import.hint')}</p>

        {/* 与「迁移」页同一套字段摆法：一件输入一个字段（带标签），目录那一个是共用的值控件，卡片级的
            主动作落在底部的动作行里（见文件头那条规矩）。 */}
        <label className="dsm-field">
          <span className="dsm-fieldLabel">{t('transfer.import.fileLabel')}</span>
          {/* 后缀必须与宿主导出的文件名一致（`src/web.ts` 的 `fileName()`）。这里曾经写成
              `.dhsess`：刚导出的包在选择框的过滤器里被挡掉，用户以为导入坏了——一个错字把功能
              弄坏了，所以 test/client.test.mjs 里钉了一条。 */}
          <input className="dsm-file" type="file" accept=".dshsess" onChange={pickFile} />
        </label>

        {/* 落地目录：与「迁移」页的目标目录是同一个组件、同一份候选（见 DirectoryField.tsx）。 */}
        <DirectoryField
          t={t}
          controls={fields}
          field="target"
          label={t('transfer.import.targetLabel')}
          placeholder={t('transfer.import.targetPlaceholder')}
          rows={targetRows}
          value={target}
          onChange={(path) => {
            setTarget(path)
            setPending(null)
          }}
          pickerKind={pickerKind}
          directory={directory}
          onError={setError}
        />

        <div className="dsm-controls">
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={openImport}
            disabled={busy !== null || file === null}
          >
            {t('transfer.import.action')}
          </button>
        </div>

        {/*
          弹窗里的正文：计划只读、不改本机任何东西，所以「取消」不会留下半个动作（同 ConfirmDialog.tsx）。
          列类名是给列宽用的：这张表是 table-layout: fixed，宽度写在样式里。
          自动布局在长路径面前会把「跳过」标签挤成一列一个字。
        */}
        {pending !== null && (
          <ConfirmDialog
            t={t}
            title={t('transfer.import.dialogTitle')}
            confirmLabel={t('transfer.import.apply')}
            busyLabel={t('transfer.import.applying')}
            busy={busy === 'apply'}
            planning={plan === null && pending.error === null}
            error={pending.error}
            disabled={plan === null || !plan.ok || createCount === 0}
            onConfirm={applyImport}
            onCancel={() => setPending(null)}
          >
            {plan !== null && (
              <>
                <p className={plan.ok ? 'dsm-ok' : 'dsm-warn'}>
                  {t('transfer.import.planSummary', { create: createCount, skip: skipCount, bytes: formatBytes(plan.bytes) })}
                  {plan.error !== undefined ? ` · ${plan.error}` : ''}
                </p>
                {plan.note !== undefined && <p className="dsm-hint">{plan.note}</p>}
                {(plan.problems ?? []).map((problem) => (
                  <p key={problem} className="dsm-warn">
                    {problem}
                  </p>
                ))}
                <table className="dsm-table dsm-planTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('table.action')}</th>
                      <th className="dsm-colSession">{t('table.session')}</th>
                      <th className="dsm-colCwd">{t('table.cwd')}</th>
                      <th className="dsm-colBytes">{t('table.bytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.entries.map((entry) => {
                      const label = sessionLabel(entry)
                      return (
                        <tr key={entry.id}>
                          <td>
                            <span className={`dsm-tag ${entry.action === 'create' ? 'dsm-tagCreate' : 'dsm-tagSkip'}`}>
                              {entry.action === 'create' ? t('table.create') : t('table.skip')}
                            </span>
                          </td>
                          <td>
                            <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={label.tip}>
                              {label.text}
                            </span>
                            {entry.reason !== undefined && <div className="dsm-hint">{entry.reason}</div>}
                          </td>
                          <td className="dsm-cwd">{cwdText(entry, t)}</td>
                          <td className="dsm-meta">{formatBytes(totalBytes(entry.files))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>
            )}
          </ConfirmDialog>
        )}
      </div>
    </>
  )
}
