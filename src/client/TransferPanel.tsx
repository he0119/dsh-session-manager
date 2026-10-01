/**
 * 「传输」分页：把会话带走（导出 .dshsess）或带回来（导入）。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/transfer.ts`）：预演返回的就是将要发生的事，页面不自己推算
 *
 *   - 导出：按目录分组的列表里勾选（组头可整组勾）→ 宿主打包 → 浏览器下载；
 *   - 导入：选包 + 选目标工作区 → **预演** → 看清 create/skip 与 cwd 改写 → 确认落盘。
 *
 * 会话库数据由页面骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉好传进来：切分页不该各拉一份，
 * 也不该出现"两个分页对同一个库给出不同数字"。列表行、组头、列表框与筛选条都出自
 * [sessionList.tsx](./sessionList.tsx)——三个分页的行是同一套解剖结构。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token；
 * 控件是手写的原生元素，**不 require 宿主的 UI 原语包**——那份包会随时改，而它一抛异常就会让
 * 整个 Slot 条目变成崩溃占位（控制台里是 `slot entry crashed in '…'`）。
 *
 * @module dsh-session-manager/client/TransferPanel
 */

import * as React from 'react'

import { applySync, download, exportSessions, fetchSyncPlan, importBundle, type ImportResponse, type SyncResponse } from './api.ts'
import type { ImportEntry, SessionSummary, SyncPullEntry, SyncPushEntry } from './api.ts'
import { groupKey, groupSessions, lockedParentOf, nestSessions } from './groups.ts'
import { describeCwd, parentDirNote, sessionLabel } from './planRows.ts'
import { FILTER_KEYS } from './sessionFilter.ts'
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
import { translateWith, zh, type Translate } from './locales.ts'
import type { PanelShare } from './types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

/**
 * cwd 那一格：三支分支在 [planRows.ts](./planRows.ts) 里判，这里只挑文案。
 *
 * 跳过的那一支曾经跟着"没有 toCwd"一起被当成"没有 cwd"，把跳过的会话显示成要落 `_no-cwd`。
 */
function cwdText(entry: ImportEntry, t: Translate): string {
  const plan = describeCwd(entry)
  if (plan.kind === 'skip') return t('cwdSkipped')
  if (plan.kind === 'keepNoCwd') return t('cwdKeep')
  return t('cwdRewritten', { from: plan.from, to: plan.to })
}

/** 同步计划里一条的显示名：标题优先，没有标题才退到 id（与行上那套口径一致）。 */
function syncName(entry: { id: string; title?: string }): string {
  const title = entry.title?.trim()
  return title === undefined || title === '' ? entry.id : title
}

/** 拉/推两种计划行的公共字段（只为 `syncWhy()` 取字段用）。 */
interface SyncRow {
  code: SyncPullEntry['code'] | SyncPushEntry['code']
  action: 'create' | 'upload' | 'update' | 'skip'
  machine?: string
  fromCwd?: string
  toCwd?: string
}

/**
 * 一条"没动"的说明。
 *
 * 文案由 `code` 决定，**不解析 `reason`**：那些 reason 是中文的、给模型看的细节，界面要能跟着
 * 语言走（英文界面里冒出一句中文是最容易被当成 bug 的那种）。带机器名的那两条因此读 `machine`，
 * 缺映射那条读 `fromCwd`。
 */
function syncWhy(entry: SyncRow, t: Translate): string {
  switch (entry.code) {
    case 'missing':
      return t(entry.action === 'create' ? 'syncCodeMissingPull' : 'syncCodeMissingPush')
    case 'local-ahead':
      return t('syncCodeLocalAhead')
    case 'remote-ahead':
      return t('syncCodeRemoteAhead', { machine: entry.machine ?? '' })
    case 'diverged':
      return t('syncCodeDiverged', { machine: entry.machine ?? '' })
    case 'no-mapping':
      return t('syncCodeNoMapping', { from: entry.fromCwd ?? '' })
    case 'missing-target':
      return t('syncCodeMissingTarget', { to: entry.toCwd ?? '' })
    default:
      return ''
  }
}

/** 传输页。 */
export function TransferPanel({ t = fallback, state, reload }: PanelShare): React.ReactElement {
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [file, setFile] = React.useState<File | null>(null)
  const [payload, setPayload] = React.useState<ArrayBuffer | null>(null)
  const [target, setTarget] = React.useState('')
  const [plan, setPlan] = React.useState<ImportResponse | null>(null)
  const [sync, setSync] = React.useState<SyncResponse | null>(null)
  const [busy, setBusy] = React.useState<'export' | 'preview' | 'apply' | 'syncPreview' | 'syncApply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  /** 同步配置（宿主插件配置里的 `sync` 块）；`null` 或字段缺席都按"没配置"处理，只画一句说明。 */
  const syncInfo = state?.sync ?? null
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
    // 子代理缩进到父会话的下一级；缩进在**筛完之后**才算（父被筛掉时子按普通行画），理由与三条边界
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
   * 这一行能不能单独勾：子代理跟着父会话走（父会话还在库里时就只能跟着它）。判据与「会话」页共用
   * `groups.ts` 的 `lockedParentOf()`，与宿主那条导出路的拒绝判据同源。
   */
  const lockOf = React.useMemo(() => {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    return (session: SessionSummary): { tip: string } | undefined => {
      const parent = lockedParentOf(session, byId)
      return parent === undefined ? undefined : { tip: t('lockedSubagentTip', { name: parent.title ?? parent.id }) }
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

  const run = async (
    kind: 'export' | 'preview' | 'apply' | 'syncPreview' | 'syncApply',
    action: () => Promise<void>,
  ): Promise<void> => {
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
      // 包里的条数与字节以宿主回报的为准：勾一条父会话时，它的子代理跟着进包，比勾选数多。
      setNotice(
        t('exported', {
          count: result.count ?? chosen.length,
          bytes: formatBytes(result.bytes ?? totalBytes(chosen)),
        }),
      )
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

  /**
   * 同步：先预演（读远端，什么都不写），确认之后才拉 + 推。
   *
   * 落地的按钮不按"计划里有几条"禁用：一次空转的 apply 只会重写自己那一格的索引，而按条数禁用会
   * 在"只想刷新索引/远端那份落后了"的时候把按钮捏死。真正会拦人的是没配置同步——那种情况压根
   * 不画按钮。
   */
  const doSyncPreview = (): void => {
    void run('syncPreview', async () => {
      setSync(await fetchSyncPlan())
    })
  }

  const doSyncApply = (): void => {
    void run('syncApply', async () => {
      const result = await applySync()
      setSync(result)
      if (result.pulled.length > 0 || result.pushed.length > 0) {
        setNotice(t('syncApplied', {
          pulled: result.pulled.length,
          pushed: result.pushed.length,
          bytesIn: formatBytes(result.bytesIn),
          bytesOut: formatBytes(result.bytesOut),
        }))
      }
      // 拉下来的落到本机库里了：列表与工作区归属都要重读（推的那一侧不改本机任何东西）。
      if (result.pulled.length > 0) await reload()
    })
  }

  const syncPlan = sync?.plan ?? null
  const syncPulls = syncPlan?.pull.filter((entry) => entry.action === 'create') ?? []
  const syncPushes = syncPlan?.push.filter((entry) => entry.action !== 'skip') ?? []
  // 只留"有信息量"的没动项：`identical` 是"远端已经有这一份"，整库同步时它是最多也最没用的一类。
  const syncKept = syncPlan === null
    ? []
    : [
        ...syncPlan.pull.filter((entry) => entry.action === 'skip'),
        ...syncPlan.push.filter((entry) => entry.action === 'skip' && entry.code !== 'identical'),
      ]
  const syncClean = syncPlan !== null && syncPulls.length === 0 && syncPushes.length === 0 && syncKept.length === 0

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
          {filter.active && (
            <span className="dsm-hint">{t('shownCount', { shown: listed.length, total: sessions.length })}</span>
          )}
          <span className="dsm-spacer" />
          <button
            type="button"
            className="dsm-button"
            // 筛过之后"全选/清空"针对的是**眼下列出来的**那些：勾选面看到什么就选什么，
            // 已经勾上的不会因为切筛选而丢（头部一直报着"已选几条"）。
            // 不能单独勾的那些不进来：子代理跟着父会话走，勾父会话就等于勾了它。
            onClick={() => setSelected(allSelected ? [] : listed.filter(selectable).map((session) => session.id))}
            disabled={listed.filter(selectable).length === 0}
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

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}
        {/* 一个组都没有（筛空了或库里是空的）时不摆这对按钮：没有可收起的东西。 */}
        {groups.length > 0 && <SessionGroupTools collapse={collapse} t={t} />}

        <SessionListBox fixed>
          {sessions.length === 0 ? (
            <SessionListEmpty text={t('noSessions')} />
          ) : groups.length === 0 ? (
            // 高度固定，空态画在框里（见 styles.ts 的 .dsm-listFixed）
            <SessionListEmpty text={t('noMatch')} />
          ) : (
            groups.map(({ group, rows }) => {
              const key = groupKey(group.path)
              const picked = rows.filter((row) => selected.includes(row.session.id)).length
              // 组头的名字：登记过就用工作区标题（人认得的名字），没登记就只剩路径可显示。
              const name = group.title ?? (group.path === '' ? t('noCwdGroup') : group.path)
              const collapsed = collapse.isCollapsed(key)
              return (
                // key 与折叠状态同一个身份（`groupKey`），免得两处各写一遍哨兵。
                <div key={key} className="dsm-group">
                  <SessionGroupHead
                    name={name}
                    title={group.title}
                    path={group.path}
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
            {/* 列类名是给列宽用的：这张表是 table-layout: fixed，宽度写在样式里。
                自动布局在长路径面前会把「跳过」标签挤成一列一个字。 */}
            <table className="dsm-table dsm-planTable">
              <thead>
                <tr>
                  <th className="dsm-colAction">{t('colAction')}</th>
                  <th className="dsm-colSession">{t('colSession')}</th>
                  <th className="dsm-colCwd">{t('colCwd')}</th>
                  <th className="dsm-colBytes">{t('colBytes')}</th>
                </tr>
              </thead>
              <tbody>
                {plan.entries.map((entry) => {
                  const label = sessionLabel(entry)
                  return (
                    <tr key={entry.id}>
                      <td>
                        <span className={`dsm-tag ${entry.action === 'create' ? 'dsm-tagCreate' : 'dsm-tagSkip'}`}>
                          {entry.action === 'create' ? t('actionCreate') : t('actionSkip')}
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
          </div>
        )}
      </div>

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('syncTitle')}</span>
          {syncInfo !== null && (
            <span className="dsm-hint">{t('syncWhere', { url: syncInfo.url, machine: syncInfo.machineId })}</span>
          )}
          {syncInfo !== null && <span className="dsm-spacer" />}
          {syncInfo !== null && (
            <>
              <button type="button" className="dsm-button" onClick={doSyncPreview} disabled={busy !== null}>
                {busy === 'syncPreview' ? t('previewing') : t('syncPreview')}
              </button>
              <button type="button" className="dsm-button dsm-primary" onClick={doSyncApply} disabled={busy !== null}>
                {busy === 'syncApply' ? t('applying') : t('syncApply')}
              </button>
            </>
          )}
        </div>
        {/* 没配置同步时只留一句话：摆一个点了没反应的按钮比不摆更糟（与「宿主没有归档能力」同一条口径）。 */}
        <p className="dsm-hint">
          {syncInfo === null ? t('syncOffHint') : t('syncHint', { mappings: syncInfo.mappings })}
        </p>

        {sync !== null && syncPlan !== null && (
          <div>
            <p className={syncPlan.ok && sync.problems.length === 0 ? 'dsm-ok' : 'dsm-warn'}>
              {t('syncSummary', {
                pull: syncPlan.pullIds.length,
                push: syncPlan.pushIds.length,
                local: syncPlan.localCount,
                remote: syncPlan.remoteCount,
              })}
              {syncPlan.machines.length > 0 ? ` · ${t('syncMachines', { machines: syncPlan.machines.join('、') })}` : ''}
            </p>
            {sync.applied && sync.pulled.length > 0 && (
              <p className="dsm-hint">
                {sync.takesEffect === 'immediate' ? t('effectImmediate') : t('effectRestart')}
              </p>
            )}
            {sync.problems.map((problem) => (
              <p key={problem} className="dsm-warn">
                {problem}
              </p>
            ))}
            {syncClean && <p className="dsm-ok">{t('syncNothing')}</p>}

            {syncPulls.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncPullHead', { count: syncPulls.length })}</p>
                <table className="dsm-table dsm-planTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colCwd">{t('colCwd')}</th>
                      <th className="dsm-colBytes">{t('colBytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncPulls.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span className="dsm-tag dsm-tagCreate">{t('syncCodeMissingPull')}</span>
                        </td>
                        <td>
                          <span className="dsm-rowTitle" title={entry.id}>
                            {syncName(entry)}
                          </span>
                        </td>
                        <td className="dsm-cwd">
                          {entry.toCwd === undefined
                            ? t('cwdKeep')
                            : t('cwdRewritten', { from: entry.fromCwd ?? '', to: entry.toCwd })}
                        </td>
                        <td className="dsm-meta">{formatBytes(entry.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {syncPushes.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncPushHead', { count: syncPushes.length })}</p>
                <table className="dsm-table dsm-planTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colCwd">{t('colCwd')}</th>
                      <th className="dsm-colBytes">{t('colBytes')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {syncPushes.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          <span className={`dsm-tag ${entry.code === 'local-ahead' ? 'dsm-tagSkip' : 'dsm-tagCreate'}`}>
                            {entry.code === 'local-ahead' ? t('syncCodeLocalAhead') : t('syncCodeMissingPush')}
                          </span>
                        </td>
                        <td>
                          <span className="dsm-rowTitle" title={entry.id}>
                            {syncName(entry)}
                          </span>
                        </td>
                        <td className="dsm-cwd">{entry.cwd ?? t('noCwd')}</td>
                        <td className="dsm-meta">{formatBytes(entry.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {syncKept.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncKeptHead', { count: syncKept.length })}</p>
                {syncKept.map((entry) => (
                  <p key={entry.id} className="dsm-hint">
                    {t('syncNote', { name: syncName(entry), why: syncWhy(entry, t) })}
                  </p>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
  )
}
