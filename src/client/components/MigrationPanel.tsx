/**
 * 「迁移」分页：勾几条会话、选一个目标目录，把它们搬过去。
 *
 * **源就是勾中的那些会话**：每条会话的来源目录是它自己的 `cwd`（判据在宿主 `src/plan.ts`），所以勾选
 * 可以跨目录，目标只有一个。"项目文件夹被删掉、项目重建到别处之后把会话迁过去"那条路因此就是：在一张
 * 按目录分组的列表里勾上那几条（它们在侧边栏里落在「未分组」那一组，那只是标签），点「迁移」，在弹窗里
 * 选重建后的目录。列表与「会话」页是同一张（分组 / 标签 / 筛选 / 勾选都在
 * [sessionList.tsx](./sessionList.tsx)），这一页与它的差别只有底部那枚动作。
 *
 * 目标目录为什么在弹窗里而不是这一页的字段上：勾选在列表上、落地在哪儿是同一件事的另一半，而列表占整页。
 * 摆进弹窗之后"选目标 → 看预演 → 确认"三件事在同一块地方完成（见 [ConfirmDialog.tsx](./ConfirmDialog.tsx)
 * 的说明）；预演随目标变化重新取一份（目录字段只在"选中候选 / 手输回车"时改值，所以每次都是一次明确的
 * 用户动作），不另摆一枚「预演」按钮——弹窗正文就是那份计划。
 *
 * 哪些行勾不动：子智能体（跟着父会话走）与侧边栏不显示的空白 / 已归档会话。判据与理由见
 * `src/visibility.ts`：宿主那一侧对点名的隐藏会话同样逐个拒（见 `src/plan.ts`），两边是**同一条**判据，
 * 所以"勾得动的集合"就是"宿主会搬的集合"，不留"勾了再被拒"的路。
 *
 * 这一页只做迁移这一件事：迁移留下的那份备份（以及删除、同步覆盖留下的）在「备份」分页里，见
 * [BackupPanel.tsx](./BackupPanel.tsx)。
 *
 * @module dsh-session-manager/client/MigrationPanel
 */

import * as React from 'react'

import {
  migrate,
  type MigrationRequest,
  type MigrationResponse,
  type ProgressEvent,
  type SessionSummary,
} from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import {
  SessionFilterBar,
  SessionGroupHead,
  SessionGroupTools,
  SessionListBox,
  SessionListEmpty,
  SessionPickTools,
  SessionRow,
  SessionStaticRow,
  formatBytes,
  useGroupCollapse,
  useSessionFilter,
  useSessionPicking,
} from './sessionList.tsx'
import { DirectoryField, useDirectoryFields } from './DirectoryField.tsx'
import { directoryTargetRows, migrateFamilyNote, parentDirNote, type PathRow } from '../logic/planRows.ts'
import { groupKey, groupSessions, nestSessions } from '../logic/groups.ts'
import { FILTER_KEYS } from '../logic/sessionFilter.ts'
import type { Translate } from '../logic/locales.ts'
import type { PanelShare } from '../types.ts'

/** 异常 → 一句话（弹窗正文与横幅共用）。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 一次落地之后的结论：复核过没过、备份在哪、要不要重启（原样透出宿主报的三件事）。 */
interface MigrationEffect {
  verified: boolean
  backupDir?: string
  takesEffect: MigrationResponse['takesEffect']
}

/** 迁移页。 */
export function MigrationPanel({ t, state, meta, reload, directory }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  const workspaces = state?.workspaces ?? []
  // 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时候选面板里不摆「浏览文件系统…」。
  // 这一项来自 `/meta`（与清单无关、先到），所以清单还在读时那枚按钮也不至于晚一步出现。
  const pickerKind = (state ?? meta)?.pickerKind ?? null

  /**
   * 这一页勾得动的那些：侧边栏看得见的（`hidden === undefined`，判据见 `src/visibility.ts`）。
   *
   * 勾选集挂在**这一份**上（不是整个库）：空白 / 已归档 / 子智能体那三类宿主明确会拒，让它们的勾计进
   * `picked` 就等于让界面替宿主撒谎。
   */
  const migratable = React.useMemo(() => sessions.filter((session) => session.hidden === undefined), [sessions])

  /**
   * 勾选：与「会话」「传输」两页同一个 hook、同一对按钮（见 sessionList.tsx）。
   *
   * `lockable` 用缺省值（有）：子智能体跟着父会话走，要动它得勾它的父会话——宿主那条迁移路也是这么判的
   * （点名一条子智能体只会被拒，见 `src/plan.ts`）。
   */
  const picking = useSessionPicking(migratable, t)
  const picked = picking.picked

  /** 目标目录。它跨弹窗留着：连着迁两批时第二次打开弹窗就有一份预演在等着。 */
  const [to, setTo] = React.useState('')
  const [title, setTitle] = React.useState('')
  const [includeArtifacts, setIncludeArtifacts] = React.useState(false)

  /**
   * 目标字段的展开状态（候选面板／宿主的目录浏览框、「手输路径」）。
   *
   * 状态由页面持有（`useDirectoryFields`），所以同一时刻只有一个面板开着；这一页只有目标一个字段。
   */
  const fields = useDirectoryFields<'to'>()

  /**
   * 迁移弹窗：`null` = 没开；开了先是一份空壳（计划还在算，或目标还没选）。
   *
   * 与「会话」页的删除弹窗同一套形状（计划 + 异常合成一个状态）：没有弹窗就没有要看的计划，取消
   * （或落地成功）之后那份计划也不该留在页面上。
   */
  const [pending, setPending] = React.useState<{ response: MigrationResponse | null; error: string | null } | null>(
    null,
  )
  const [busy, setBusy] = React.useState<'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /** 上一次落地之后的结论（复核 / 备份 / 生效方式）：弹窗关了之后它还得在页面上留着。 */
  const [effect, setEffect] = React.useState<MigrationEffect | null>(null)

  /**
   * 最近收到的那条进度事件（宿主每做一段报一条，见 api.ts 的 `migrate()`）。
   *
   * `null` = 还没收到第一条：算计划那一段的头几百毫秒是这样（扫库的第一条事件马上就到），落地那条路上
   * 则是按下确认之后的头一瞬。那时弹窗里摆的是那句静态的「预演中…」/按钮上的「迁移中…」，不画条——
   * 还不知道分母，画一条只会让人以为已经开始了。
   *
   * 声明排在**最后**（不跟 `busy` 挤在一起）：冒烟用例按位置往 null 状态里种值（见 test/client.test.mjs
   * 的 `nulls`），插在中间会让后面那些种子的位置整体错一格。
   */
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null)

  /** 筛选：与「会话」页同一份（含类别芯片）——列表就是同一张，筛选条没有理由少一格。 */
  const filter = useSessionFilter(sessions)

  /**
   * 按目录分组，组内留着筛选之后的那些（空掉的组整组不画：组头底下没有行，看着像坏了）。
   *
   * 与「会话」「传输」两页逐字同形（理由见 groups.ts：分组键是目录而不是注册表里的工作区 id，因为
   * 同一个目录下常有没登记的会话）。
   */
  const groups = React.useMemo(() => {
    const filtered = groupSessions(sessions, workspaces)
      .map((group) => ({ group, sessions: group.sessions.filter(filter.matches) }))
      .filter((item) => item.sessions.length > 0)
    // 缩进在**筛完之后**才算：父被筛掉时子按普通行画（见 groups.nestSessions 的三条边界）。
    const visible = new Set(filtered.flatMap((item) => item.sessions.map((session) => session.id)))
    return filtered.map((item) => ({ group: item.group, rows: nestSessions(item.sessions, sessions, visible) }))
  }, [sessions, workspaces, filter.matches])
  /** 折叠：只把组内的行收起来，不改"列出来了哪些"（见 TransferPanel 里的同一段说明）。 */
  const collapse = useGroupCollapse(groups.map((item) => groupKey(item.group.path)))
  /** 当前列出来的那些（筛过之后，按组摊平）。缩进只改画法，不改"列出来了哪些"。 */
  const listed = React.useMemo(() => groups.flatMap((item) => item.rows.map((row) => row.session)), [groups])

  /**
   * 一行勾不动的原因：子智能体那条由 hook 给（提示里点名该勾哪条父会话），侧边栏看不见的两类在这里补。
   *
   * 两处判据都指向同一件事——"宿主不会搬它"（`src/visibility.ts` 一条判据，宿主那一侧照它逐条拒）。
   */
  const lockOf = React.useCallback(
    (session: SessionSummary): { tip: string } | undefined =>
      picking.lockOf(session) ?? (session.hidden === undefined ? undefined : { tip: t('migrate.lockedHidden') }),
    [picking, t],
  )
  /** 眼下列出来的那些里能单独勾的（「全选」的作用面与禁用判据）。 */
  const pickable = React.useMemo(() => listed.filter((session) => lockOf(session) === undefined), [listed, lockOf])

  /**
   * 目标候选：已登记工作区（同一路径只留一条），外加当前值本身。
   *
   * 与「传输」页导入的落地目录共用同一个构造（见 planRows.directoryTargetRows）：两处问的是同一件事。
   */
  const targetRows = React.useMemo<PathRow[]>(
    () => directoryTargetRows(workspaces, state?.repos, to),
    [workspaces, to, state?.repos],
  )

  /** 请求体：源是勾中的那些 id，目标只有一个（预演与落地用同一份参数）。 */
  const request = (mode: 'plan' | 'apply', target: string, artifacts: boolean): MigrationRequest => ({
    mode,
    sessionIds: [...picked],
    to: target,
    includeArtifacts: artifacts,
    ...(title.trim() === '' ? {} : { title: title.trim() }),
  })

  /**
   * 乱序防护：连点候选时后一次请求可能先回来，只让最新那一次写进弹窗。
   */
  const previewToken = React.useRef(0)

  /**
   * 取一份预演（只读，不落盘）。
   *
   * 目标为空时不取：弹窗正文是一句「先选一个目标目录」，主按钮禁用——还没到能算计划的地步。
   *
   * 取之前先把上一份计划清掉：目标一变，旧计划说的就不再是"将要发生的"，留着它等于让用户照着过期的
   * 清单按确认（这正是 ConfirmDialog 那句"看到的就是将要发生的"要防的）。
   */
  const runPreview = (target: string, artifacts: boolean): void => {
    const trimmed = target.trim()
    const token = ++previewToken.current
    if (trimmed === '' || picked.length === 0) {
      setPending({ response: null, error: null })
      return
    }
    setPending((current) => (current === null ? current : { response: null, error: null }))
    setProgress(null)
    void migrate(request('plan', trimmed, artifacts), setProgress).then(
      (response) => {
        if (token === previewToken.current) {
          setPending((current) => (current === null ? current : { response, error: null }))
        }
      },
      (cause) => {
        if (token === previewToken.current) {
          setPending((current) => (current === null ? current : { response: null, error: reasonOf(cause) }))
        }
      },
    )
  }

  /**
   * 点「迁移」：开弹窗，同时把只读的迁移计划取回来（`mode: 'plan'`，不落盘）。
   *
   * 参数不齐时不开口：没勾会话时按钮本来就是禁用的；目标为空时弹窗里那句提示会告诉用户下一步该做什么，
   * 空弹窗也比一句"还没到能算计划的地步"合适——目标就在这个弹窗里选。
   *
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同「会话」页的删除弹窗）。
   */
  const openMigrate = (): void => {
    if (picked.length === 0) return
    setError(null)
    setNotice(null)
    setProgress(null)
    setPending({ response: null, error: null })
    runPreview(to, includeArtifacts)
  }

  /**
   * 弹窗里按「确认迁移」：真的搬（宿主那边是同一个 `buildRelocationPlan()`，只是这次落盘并复核）。
   *
   * 落地失败但正文里带着完整结果（计划不 ok / 复核没过）时把那份结果摆回弹窗里——用户正看着清单，
   * 新的问题清单就该出现在同一个位置；请求本身没走通（网络、参数被拒）才抛给页面横幅并关掉弹窗。
   */
  const applyMigration = (): void => {
    setBusy('apply')
    setError(null)
    setProgress(null)
    void migrate(request('apply', to.trim(), includeArtifacts), setProgress).then(
      (response) => {
        setBusy(null)
        setProgress(null)
        if (!response.applied) {
          setPending((current) => (current === null ? current : { ...current, response }))
          return
        }
        setPending(null)
        setEffect({
          verified: response.verified,
          ...(response.backupDir === undefined ? {} : { backupDir: response.backupDir }),
          takesEffect: response.takesEffect,
        })
        setNotice(
          t('migrate.done', {
            sessions: response.preview.sessions.length,
            rewritten: response.rewritten,
            moved: response.moved,
            artifacts:
              response.artifactsMoved > 0 ? t('migrate.doneArtifacts', { count: response.artifactsMoved }) : '',
          }) +
            ' ' +
            (response.verified ? t('verify.pass') : t('verify.fail')),
        )
        void reload()
      },
      (cause) => {
        setBusy(null)
        setProgress(null)
        setPending(null)
        setError(t('error.failed', { reason: reasonOf(cause) }))
      },
    )
  }

  const preview = pending?.response?.preview ?? null
  const planned = preview !== null && preview.ok
  /** 目标还没定：这一份不是"预演中"，而是"等你选目标"——两者在弹窗里长得不一样。 */
  const waitingForTarget = to.trim() === ''
  const registry = preview?.registryChange ?? null
  /** 顺带摘掉的悬空登记条数（宿主本来就不认它们，见宿主 `RegistryChange.droppedStale`）。 */
  const staleDropped = (registry?.droppedStale ?? []).reduce((n, entry) => n + entry.sessionIds.length, 0)
  /**
   * 这次改动会不会**需要重启**才被宿主承认：预演那次按宿主端口的探测说（见 src/web.ts 的迁移端点），
   * 摆在弹窗里当事前提醒。注册表本来就不用改（`unchanged`）时没有"生效"可谈，不摆这一句。
   */
  const plannedRestart =
    planned && registry !== null && !registry.unchanged && pending?.response?.takesEffect === 'restart-required'

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

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('migrate.title')}</span>
          <span className="dsm-hint">{t('list.selected', { count: picked.length })}</span>
          {filter.active && (
            <span className="dsm-hint">{t('list.shown', { shown: listed.length, total: sessions.length })}</span>
          )}
          <span className="dsm-spacer" />
          {/*
            筛过之后「全选」要的是"列出来的这些都选上"，而不是"把看不见的也选上"；勾不动的那些也不进来
            （子智能体跟着父会话走，隐藏的搬不走）。这一对与「会话」「传输」两页是同一个组件。
          */}
          <SessionPickTools
            selectableCount={pickable.length}
            pickedCount={picked.length}
            onSelectAll={() => picking.selectAll(pickable)}
            onClear={picking.clear}
            t={t}
          />
        </div>
        <p className="dsm-hint">{t('migrate.hint')}</p>

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}
        {groups.length > 0 && <SessionGroupTools collapse={collapse} t={t} />}

        {/* 高度固定：连"一条都没筛出来"（以及库里一条都没有）也画在这个框里，否则那些状态会把这一页的
            高度改回去，外层滚动条又能把整个卡片挪动 15px（见 styles.ts 的 .dsm-listFixed）。 */}
        <SessionListBox fixed>
          {state === null ? (
            // 清单还在读：这一格说"读取中…"而不是"这个会话库里还没有会话"——后者是个结论。
            <SessionListEmpty text={t('loading')} />
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
                    onToggle={() => picking.toggleGroup(rows.map((row) => row.session).filter((s) => lockOf(s) === undefined))}
                    onToggleCollapse={() => collapse.toggle(key)}
                    t={t}
                  />
                  {!collapsed &&
                    rows.map((row) => (
                      <SessionRow
                        key={row.session.id}
                        session={row.session}
                        variant="pick"
                        checked={picked.includes(row.session.id)}
                        onToggle={() => picking.toggle(row.session)}
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

        {/*
          卡片级的主动作放底部动作行（见 .dsm-controls 的决策）：一枚「迁移」，每一条要搬的会话都在上面
          勾好了。没勾会话时它禁用——下一步要做什么，用户看列表就知道。
        */}
        <div className="dsm-controls">
          <button
            type="button"
            className="dsm-button dsm-primary"
            onClick={openMigrate}
            disabled={busy !== null || picked.length === 0}
          >
            {t('migrate.action')}
          </button>
        </div>

        {/* 落地之后的结论：弹窗关了，这三件事（复核 / 备份位置 / 生效方式）还得留在页面上。 */}
        {effect !== null && (
          <div className="dsm-effect">
            <p className={effect.verified ? 'dsm-ok' : 'dsm-warn'}>
              {effect.verified ? t('verify.pass') : t('verify.fail')}
              {effect.backupDir !== undefined ? ` · ${effect.backupDir}` : ''}
            </p>
            {/* **只在需要重启时说话**（与同步页同一口径）：宿主自己接住时这里再说一句"无需重启"只是噪音，
                而两句话都用同一个颜色时反而分不出哪句是坏消息。 */}
            {effect.takesEffect === 'restart-required' && <p className="dsm-warn">{t('effect.restart')}</p>}
          </div>
        )}
      </div>

      {/* 迁移弹窗：目标目录 + 计划 + 「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {pending !== null && (
        <ConfirmDialog
          t={t}
          // 落地那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t(busy === 'apply' ? 'migrate.running' : 'migrate.dialogTitle')}
          confirmLabel={t('migrate.apply')}
          busyLabel={t('migrate.running')}
          busy={busy === 'apply'}
          // 目标为空时不算"预演中"：那时正文是一句"先选目标目录"，不是一句等待。
          planning={!waitingForTarget && pending.response === null && pending.error === null}
          // 算计划那一段不是空等（要扫整库认族、算注册表变更），所以有事件就把那句静态的「预演中…」
          // 换成进度。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={pending.error}
          disabled={!planned || waitingForTarget}
          onConfirm={applyMigration}
          onCancel={() => setPending(null)}
        >
          {/* 落地：正文换成进度，那份计划表说的是"将要"，这时候已经过期了。 */}
          {busy === 'apply' &&
            (progress === null ? (
              <p className="dsm-hint">{t('progress.waiting')}</p>
            ) : (
              <ProgressBlock t={t} progress={progress} note={t('migrate.progress.note')} />
            ))}
          {busy !== 'apply' && (
            <>
              {/*
                目标目录是这一弹窗的第一步。`title` 与产物开关跟着它：三者都是"这次怎么落地"的参数，
                摆在同一块地方，用户不必在页面与弹窗之间来回看。
              */}
              <DirectoryField
                t={t}
                controls={fields}
                field="to"
                label={t('migrate.to.label')}
                placeholder={t('migrate.to.pick')}
                rows={targetRows}
                value={to}
                onChange={(value) => {
                  setTo(value)
                  // 目标一变，旧计划说的就不再是"将要发生的"：清掉结论，并（目标非空时）立刻取新的一份。
                  setEffect(null)
                  runPreview(value, includeArtifacts)
                }}
                pickerKind={pickerKind}
                directory={directory}
                onError={setError}
              />

              <label className="dsm-field">
                <span className="dsm-fieldLabel">{t('migrate.workspaceTitle.label')}</span>
                <input
                  className="dsm-input"
                  type="text"
                  value={title}
                  placeholder={t('migrate.workspaceTitle.placeholder')}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              {/*
                名称不进预演的正文（那份计划里只报"新建 / 复用目标工作区"这一件事，不报它的名字），所以
                改它不必重新预演：落地那次请求现取这个名字。产物开关不一样——它直接改变计划里的条数，
                所以跟着重新预演。
              */}
              <div className="dsm-options">
                <label className="dsm-check">
                  <input
                    type="checkbox"
                    checked={includeArtifacts}
                    onChange={(event) => {
                      const next = event.target.checked
                      setIncludeArtifacts(next)
                      runPreview(to, next)
                    }}
                  />
                  <span>{t('migrate.includeArtifacts')}</span>
                </label>
              </div>

              {waitingForTarget && <p className="dsm-hint">{t('migrate.needTarget')}</p>}

              {!waitingForTarget && preview !== null && (
                <>
                  {/*
                    计划过不去时不说"将迁移 N 条"：那句是承诺，而 `ok === false` 意味着一条都不会落地
                    （确认按钮也禁用了）。这时摆一句"这次不会搬任何会话"，下面那张问题清单才是原因。
                  */}
                  {planned ? (
                    <p className="dsm-ok">
                      {t('migrate.summary', {
                        sessions: preview.sessions.length,
                        files: preview.files,
                        bytes: formatBytes(preview.bytes),
                      })}
                    </p>
                  ) : (
                    <p className="dsm-warn">{t('migrate.blocked')}</p>
                  )}
                  {/* 级联带进来的子智能体要说明白：勾的是一条父会话，清单里却多出几条没勾过的。 */}
                  {preview.cascaded > 0 && <p className="dsm-hint">{t('migrate.family', { count: preview.cascaded })}</p>}
                  {/* 少搬的那批同样要说明白：它们不在下面那张清单里，不提这一句就是"勾了 22 条、搬走 9 条"。 */}
                  {preview.liveSkipped.length > 0 && (
                    <p className="dsm-hint">{t('migrate.liveSkipped', { count: preview.liveSkipped.length })}</p>
                  )}
                  {/* 侧边栏不显示的那几条：这次也不搬，源工作区因此留在注册表里——不提的话用户看到的
                      就是"整个来源都迁完了，怎么还留着一块一条都不显示的工作区"。 */}
                  {preview.strandedSources.length > 0 && (
                    <p className="dsm-hint">
                      {t('migrate.stranded', {
                        count: preview.strandedSources.reduce((n, source) => n + source.members.length, 0),
                      })}
                    </p>
                  )}
                  {/* 一条会话都不在计划里时（全都搬不动）来源那一栏是空的：那半句就别摆出来。 */}
                  {preview.sourceProjectDirs.length > 0 && (
                    <p className="dsm-hint">
                      {t('migrate.projectDirs', {
                        from: preview.sourceProjectDirs.join('、'),
                        to: preview.targetProjectDir,
                      })}
                    </p>
                  )}

                  {preview.problems.length > 0 && (
                    <div className="dsm-problems">
                      <p className="dsm-warn">
                        {t('problems.title')}（{preview.problems.length}）
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
                      <p className="dsm-fields-label">{t('registry.change.title')}</p>
                      <ul className="dsm-listPlain">
                        {registry === null || registry.unchanged ? (
                          <li>{t('registry.unchanged')}</li>
                        ) : (
                          <>
                            <li>{registry.createdTarget ? t('registry.create') : t('registry.reuse')}</li>
                            {registry.added.length > 0 && <li>{t('registry.added', { count: registry.added.length })}</li>}
                            {registry.adoptedFromUnowned.length > 0 && (
                              <li>{t('registry.adopted', { count: registry.adoptedFromUnowned.length })}</li>
                            )}
                            {registry.movedFrom.length > 0 && <li>{t('registry.moved', { count: registry.movedFrom.length })}</li>}
                            {registry.removedSources.length > 0 && (
                              <li>{t('registry.removed', { count: registry.removedSources.length })}</li>
                            )}
                            {staleDropped > 0 && <li>{t('registry.stale', { count: staleDropped })}</li>}
                          </>
                        )}
                      </ul>
                    </div>
                  )}

                  {/* 事前提醒：这次改动要不要重启才被宿主承认，得在按「确认迁移」**之前**说出来
                      （判据与"注册表本来就不用改"那一条见上面的 `plannedRestart`）。 */}
                  {plannedRestart && <p className="dsm-warn">{t('effect.plannedRestart')}</p>}

                  {preview.artifacts !== null && (
                    <p className="dsm-hint">
                      {t('artifacts.planned', { count: preview.artifacts.moves })}
                      {preview.artifacts.skipped.length > 0
                        ? ` · ${t('artifacts.skipped', { count: preview.artifacts.skipped.length })}`
                        : ''}
                    </p>
                  )}

                  {/* 逐条列出会被搬走的会话：摘要报的是数字，这里才是"哪几条"。 */}
                  {preview.sessions.length > 0 && (
                    <SessionListBox>
                      {preview.sessions.map((session) => (
                        <SessionStaticRow
                          key={session.id}
                          session={session}
                          className="dsm-row dsm-rowPlan"
                          metaTitle={session.sourceDir}
                          // 级联进来的那些缩进一级并挂「随父迁」：勾的是一条父会话，清单里却多出几条（同删除清单）。
                          depth={session.via === undefined ? 0 : 1}
                          note={migrateFamilyNote(session, t)}
                        />
                      ))}
                    </SessionListBox>
                  )}
                </>
              )}
            </>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}
