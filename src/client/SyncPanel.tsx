/**
 * 「同步」分页：按 WebDAV 配置在多台机器之间拉与推（点「同步」先在弹窗里看只读计划，确认才落盘）。
 *
 * 为什么单独一页，而不是挂在「传输」底下：两者正交——「传输」是一次性的带走/带回来（选包、选目标、
 * 导出下载），同步是一条**常设**通道：远端地址、机器名、映射表与那个确认弹窗都只属于它。挤在一页时
 * 同步那块只能排在导出列表与导入计划表之后，越用越长；而这一页的第一件事（看一眼远端配没配对、
 * 改一下映射）与「传输」的第一件事（勾哪些会话）也没有先后关系。
 *
 * 分页顺序是「会话 → 迁移 → 传输 → 同步 → 说明」：同步排在传输之后，是因为它落地走的是导入那条
 * 编排（见 README 的「同步」一节），紧挨着读更顺。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/sync.ts`）：计划返回的就是将要发生的事，页面不自己推算。会话库数据由页面
 * 骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉好传进来，切分页不各拉一份。
 *
 * 落地那一次是**流式**的：宿主按条推事件，正文换成进度条与"正在推送 12 / 84"（见
 * [api.ts](./api.ts) 的 `applySync` 与 [ProgressBar.tsx](./ProgressBar.tsx)）。同步是这个插件里唯一
 * "按条走网络"的动作，一次整库同步可能是几十秒，而在此之前界面只有一句"同步中…"。
 *
 * 弹窗里那三张计划表（会拉 / 会推 / 没动）按**项目目录**分组：一次整库同步的计划里，同一个目录会连着
 * 出现十几条，逐行印一遍同样的路径只是把人绕进去。分组键怎么取、组怎么排见
 * [syncGroups.ts](./syncGroups.ts)——那是纯函数，规则在 `test/syncGroups.test.ts` 里逐条钉着。
 *
 * 样式只在 [styles.ts](./styles.ts) 里定义，颜色只用 `--dsw-alias-*` 主题 token；控件以手写的原生
 * 元素为主，确认弹窗外壳走官方控件库的 `Modal`（[ConfirmDialog.tsx](./ConfirmDialog.tsx) 里说了
 * 为什么）。渲染路径上不许做会抛的事——抛出去整个 Slot 条目会变成崩溃占位（控制台里是
 * `slot entry crashed in '…'`）。
 *
 * @module dsh-session-manager/client/SyncPanel
 */

import * as React from 'react'

import {
  applySync,
  fetchSyncPlan,
  type SyncProgressEvent,
  type SyncPullEntry,
  type SyncPushEntry,
  type SyncResponse,
} from './api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { groupKey } from './groups.ts'
import { WorkspaceIcon } from './icons.tsx'
import { translateWith, zh, type Translate } from './locales.ts'
import { sessionLabel, type SessionLabel } from './planRows.ts'
import { ProgressBar } from './ProgressBar.tsx'
import { formatBytes } from './sessionList.tsx'
import { SyncConfigForm } from './SyncConfigForm.tsx'
import { groupSyncRows, syncProjectOf, syncPullTip, type SyncGroup, type SyncSide } from './syncGroups.ts'
import type { PanelShare } from './types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

/** 异常 → 一句话（弹窗正文与横幅共用，同迁移页）。 */
function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 计划行 + 它来自哪张表。
 *
 * 「这次不动」那张表把两个方向的跳过项并在一起，而"属于哪个项目"要看方向（见 `syncProjectOf()`），
 * 所以方向必须跟着行一起走，不能到了渲染那一步再猜——推送行的 `cwd` 与拉取行的 `fromCwd` 都可能是
 * 同一段路径，靠字段碰运气认方向迟早认错。
 */
interface SyncKeptRow {
  readonly side: SyncSide
  readonly entry: SyncPullEntry | SyncPushEntry
}

/** 拉/推两种计划行的公共字段（只为 `syncWhy()` / `syncTag()` 取字段用）。 */
interface SyncRow {
  code: SyncPullEntry['code'] | SyncPushEntry['code']
  action: string
  machine?: string
  fromCwd?: string
  toCwd?: string
}

/**
 * 「没动」那一类为什么没动：判据在宿主侧的 `code` 上，页面只把它翻成一句话。
 *
 * 认不出来的码退回原始字符串：新增一类关系时界面上会出现一个生词，好过悄悄显示成"已跳过"。
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
      return String(entry.code)
  }
}

/**
 * 「没动」那一类的短标签：状态进标签，整句（`syncWhy()`）挂在它的 `title` 上。
 *
 * 与拉/推两张表同一口径：窄列里放不下整句，而**状态与会话名必须是两种东西**——挤成一行同色同号的
 * 文字时，一列"某某：两边各自写过（robot-b）"读起来分不出哪个是状态、哪个是会话。认不出来的码退回
 * 整句（宁可挤，也不要显示成一个生词）。
 */
function syncTag(entry: SyncRow, t: Translate): string {
  switch (entry.code) {
    case 'remote-ahead':
      return t('syncTagRemoteAhead')
    case 'diverged':
      return t('syncTagDiverged')
    case 'no-mapping':
      return t('syncTagNoMapping')
    case 'missing-target':
      return t('syncTagMissingTarget')
    default:
      return syncWhy(entry, t)
  }
}

/**
 * 计划表里的项目组头：一条横跨整行的横幅（`<th colSpan>` 占满那一行）。
 *
 * 为什么在表里插一行、而不是一个项目一张表：会话名与大小必须仍然对着 `<thead>` 那两列，而一张表只有
 * 一个表头——一张表一个项目的话，"动作 / 会话 / 大小"这套表头要么每个项目重复一遍，要么只剩第一张
 * 有，列宽也会各算各的。
 *
 * 组头的画法与列表那边的组头同一档（字色 12% 兑出来的横幅、工作区图形、标题 + 等宽路径 + 条数），
 * 但没有折叠与勾选：弹窗里这份清单只是读一遍，不在这儿挑东西。路径只在有工作区标题时才单列一格，
 * 没有标题时路径自己就是标题（与列表那边同一个写法，免得同一段路径印两遍）。
 */
function PlanGroupHead({
  group,
  columns,
  t,
}: {
  group: SyncGroup<unknown>
  columns: number
  t: Translate
}): React.ReactElement {
  const name = group.title ?? (group.path === '' ? t('noCwdGroup') : group.path)
  return (
    <tr className="dsm-planGroup">
      <th className="dsm-planGroupHead" colSpan={columns} scope="colgroup">
        <span className="dsm-planGroupInner">
          <WorkspaceIcon />
          <span className="dsm-groupTitle" title={name}>
            {name}
          </span>
          {group.title !== undefined && (
            <span className="dsm-groupPath" title={group.path}>
              {group.path}
            </span>
          )}
          <span className="dsm-groupCounts">
            <span className="dsm-hint">{t('sessionsInDir', { count: group.rows.length })}</span>
          </span>
        </span>
      </th>
    </tr>
  )
}

/**
 * 会话名那一格：显示标题、没有标题才退到 id（`sessionLabel()`），id 与整句说明在悬浮提示里。
 *
 * 拉取行的提示还会补上"这条的 cwd 从哪改写到哪"（`syncPullTip()`）——那句话原来占着 cwd 一列，
 * 现在落地的目录已经在组头上，只有真的改写过的行才需要再说一句从哪儿来。
 */
function SessionCell({ label, tip }: { label: SessionLabel; tip: string }): React.ReactElement {
  return (
    <td>
      <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={tip}>
        {label.text}
      </span>
    </td>
  )
}

/**
 * 进度那行字。
 *
 * `done` 是**已经做完**的条数、事件发在开始处理下一条之前，所以正在处理的是第 `done + 1` 条——与
 * 进度条的 `current` 同一个数，两处必须一起变。读远端索引是一次网络往返，没有"第几条"可讲，所以那
 * 一段是固定的一句（`syncPreparing`）。
 */
function progressTextOf(t: Translate, progress: SyncProgressEvent): string {
  switch (progress.phase) {
    case 'scan':
      return t('syncScanning', { current: progress.done + 1, total: progress.total })
    case 'repo':
      return t('syncMatchingRepos', { current: progress.done + 1, total: progress.total })
    case 'compare':
      return t('syncComparing', { current: progress.done + 1, total: progress.total })
    case 'remote':
      return t('syncPreparing')
    case 'pull':
      return t('syncPulling', { current: progress.done + 1, total: progress.total })
    case 'push':
      return t('syncPushing', { current: progress.done + 1, total: progress.total })
  }
}

/**
 * 进度条 + 那行字（+ 正在处理的那一条）。
 *
 * 算计划那四段（扫本机 / 读远端 / 认仓库 / 比对内容）没有"某一条"可讲，`label` 缺席时不摆那一行——
 * 预演与落地共用这一段，落地那边前四个阶段也是这个形状。
 */
function ProgressBlock({
  t,
  progress,
}: {
  t: Translate
  progress: SyncProgressEvent
}): React.ReactElement {
  const text = progressTextOf(t, progress)
  // "只增不覆盖、再点一次接着补齐"那句话只在真写盘的两段有意义：预演阶段还没有东西可覆盖。
  const writing = progress.phase === 'pull' || progress.phase === 'push'
  return (
    <>
      {/* 分母是 0 的那一段（读一次远端索引）没有"第几条"：只摆那句话，不摆条。 */}
      {progress.total > 0 && <ProgressBar current={progress.done + 1} total={progress.total} label={text} />}
      <p className="dsm-hint">{text}</p>
      {progress.label === undefined ? null : <p className="dsm-rowTitle">{progress.label}</p>}
      {writing && <p className="dsm-hint">{t('syncProgressNote')}</p>}
    </>
  )
}

/** 同步页。 */
export function SyncPanel({ t = fallback, state, reload }: PanelShare): React.ReactElement {
  /** 最近一次计划或结果：映射表的远端候选与弹窗正文都读它（关掉弹窗之后候选还得在）。 */
  const [sync, setSync] = React.useState<SyncResponse | null>(null)
  /** 同步弹窗开着吗（`plan` = 正在算计划、`apply` = 正在落地）。 */
  const [dialog, setDialog] = React.useState<'plan' | 'apply' | null>(null)
  const [busy, setBusy] = React.useState<'plan' | 'apply' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /** 落地时逐条失败的原因（宿主只把成功的那些算进 pulled/pushed，失败的在这里）。 */
  const [failures, setFailures] = React.useState<readonly string[]>([])
  /**
   * 落地进行到哪了：宿主每开始处理一条推一条事件（见 api.ts 的 `applySync`）。
   *
   * `null` 有两种时候——还没开始、以及刚开始那一段（宿主在算计划：读远端索引、扫本机库、比指纹，
   * 没有逐条可报）。后者界面显示"正在读取远端索引…"，所以这里不需要第三个状态位。
   */
  const [progress, setProgress] = React.useState<SyncProgressEvent | null>(null)

  /** 同步配置（宿主插件配置里的 `sync` 块）；`null` 或字段缺席都按"没配置"处理，只画一句说明。 */
  const syncInfo = state?.sync ?? null

  /**
   * 点「同步」：开弹窗并算一份只读计划（`GET /sync` 只读远端，什么都不写）。
   *
   * 计划取不到（没配同步、远端连不上）时**不开空弹窗**：关掉它，把宿主/网络给的原话摆到页面横幅上。
   * 那类错不是"这份计划有什么问题"，留在弹窗里只会让人以为还能按确认。
   */
  const openSync = (): void => {
    setDialog('plan')
    setBusy('plan')
    setError(null)
    setNotice(null)
    setFailures([])
    setProgress(null)
    void fetchSyncPlan(setProgress).then(
      (response) => {
        setBusy(null)
        setSync(response)
      },
      (cause) => {
        setBusy(null)
        setDialog(null)
        setError(t('failed', { reason: reasonOf(cause) }))
      },
    )
  }

  /**
   * 弹窗里按「确认同步」：真拉真推。
   *
   * 逐条失败（某一条拉不下来）照旧把成功的那部分报出来，失败的那些**在页面横幅上逐条留着**——弹窗
   * 关掉之后它们还得看得见；不然用户只知道"同步过了"，不知道有一条没成。
   */
  const doSyncApply = (): void => {
    setBusy('apply')
    setError(null)
    setProgress(null)
    void applySync(setProgress).then(
      (result) => {
        setBusy(null)
        setDialog(null)
        setProgress(null)
        setSync(result)
        setFailures(result.problems)
        if (result.pulled.length > 0 || result.pushed.length > 0) {
          setNotice(
            t('syncApplied', {
              pulled: result.pulled.length,
              pushed: result.pushed.length,
              bytesIn: formatBytes(result.bytesIn),
              bytesOut: formatBytes(result.bytesOut),
            }) +
              // 拉下来的会话进没进宿主内存里的那份注册表：这句只在真拉了东西时才有意义。
              (result.pulled.length === 0
                ? ''
                : ` ${result.takesEffect === 'immediate' ? t('effectImmediate') : t('effectRestart')}`),
          )
        }
        // 拉下来的落到本机库里了：列表与工作区归属都要重读（推的那一侧不改本机任何东西）。
        if (result.pulled.length > 0) void reload()
      },
      (cause) => {
        setBusy(null)
        setDialog(null)
        setProgress(null)
        setError(t('failed', { reason: reasonOf(cause) }))
      },
    )
  }

  const syncPlan = sync?.plan ?? null
  const syncPulls = syncPlan?.pull.filter((entry) => entry.action === 'create') ?? []
  const syncPushes = syncPlan?.push.filter((entry) => entry.action !== 'skip') ?? []
  // 只留"有信息量"的没动项：`identical` 是"远端已经有这一份"，整库同步时它是最多也最没用的一类。
  const syncKept: SyncKeptRow[] =
    syncPlan === null
      ? []
      : [
          ...syncPlan.pull
            .filter((entry) => entry.action === 'skip')
            .map((entry): SyncKeptRow => ({ side: 'pull', entry })),
          ...syncPlan.push
            .filter((entry) => entry.action === 'skip' && entry.code !== 'identical')
            .map((entry): SyncKeptRow => ({ side: 'push', entry })),
        ]
  const syncClean = syncPlan !== null && syncPulls.length === 0 && syncPushes.length === 0 && syncKept.length === 0
  /**
   * 三张表各自按**项目目录**分组（见 [syncGroups.ts](./syncGroups.ts)）：拉取行按落地后的本机目录、
   * 推送行按本机目录、「没动」按它自己那一边的目录。工作区标题从 `/state` 来（同一个路径在别处显示
   * 成什么名字，这里就是什么名字）；首帧还没读到状态时标题缺席，组头退回路径本身。
   */
  const workspaces = state?.workspaces ?? []
  const pullGroups = groupSyncRows(syncPulls, (entry) => syncProjectOf(entry, 'pull'), workspaces)
  const pushGroups = groupSyncRows(syncPushes, (entry) => syncProjectOf(entry, 'push'), workspaces)
  const keptGroups = groupSyncRows(syncKept, (row) => syncProjectOf(row.entry, row.side), workspaces)
  /**
   * 上次同步的计划里见过的远端 cwd：交给映射表当候选。
   *
   * 它解决的是这一栏唯一真正难的地方——远端那一侧必须**逐字**对上别的机器记下的路径，而那条路径
   * 靠人背是靠不住的（抄错一个字符，结果就是"没配映射，跳过"）。没有过计划时它是空的，行为退回手填。
   */
  const remoteCwds = [
    ...new Set(
      [...(syncPlan?.pull ?? []).map((entry) => entry.fromCwd), ...(syncPlan?.push ?? []).map((entry) => entry.cwd)].filter(
        (cwd): cwd is string => typeof cwd === 'string' && cwd !== '',
      ),
    ),
  ]
  /** 计划还在算：正文暂时不画（`sync` 里可能还留着上一次的那份结果，摆出来会被当成这次的）。 */
  const planning = dialog === 'plan' && busy === 'plan'

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

      {failures.map((problem) => (
        <p key={problem} className="dsm-banner dsm-warn">
          {problem}
        </p>
      ))}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('syncTitle')}</span>
          {syncInfo !== null && (
            <span className="dsm-hint">{t('syncWhere', { url: syncInfo.url })}</span>
          )}
          {syncInfo !== null && <span className="dsm-spacer" />}
          {syncInfo !== null && (
            <button type="button" className="dsm-button dsm-primary" onClick={openSync} disabled={busy !== null}>
              {t('syncAction')}
            </button>
          )}
        </div>
        {/* 没配置同步时只留一句话：摆一个点了没反应的按钮比不摆更糟（与「宿主没有归档能力」同一条口径）。 */}
        <p className="dsm-hint">
          {syncInfo === null ? t('syncOffHint') : t('syncHint', { mappings: syncInfo.mappings })}
        </p>
        {/* 配置表单就在「同步」旁边：改完 URL 立刻能同步一次。宿主没有设置接缝时这一块自己说明。 */}
        <SyncConfigForm
          t={t}
          onSaved={() => void reload()}
          remoteCwds={remoteCwds}
          // 机器名那一栏的灰字：宿主解析出来的缺省值（没配就是主机名）。摆在这儿比摆回标题上近——
          // 要改的就在同一行，不必先回标题里认一遍这台机器叫什么。
          machineDefault={syncInfo === null ? undefined : syncInfo.machineId}
        />
      </div>

      {/* 同步弹窗：计划与「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {dialog !== null && (
        <ConfirmDialog
          t={t}
          // 落地那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t(busy === 'apply' ? 'syncRunning' : 'syncDialogTitle')}
          confirmLabel={t('syncApply')}
          busyLabel={t('syncBusy')}
          busy={busy === 'apply'}
          planning={planning}
          // 预演那几秒不是在空等：先扫本机、再读远端索引、最后逐条比对内容。算到哪一步摆哪一步的进度
          // （还没有事件时退回 ConfirmDialog 那句「预演中…」）。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={null}
          onConfirm={doSyncApply}
          onCancel={() => setDialog(null)}
        >
        {/* 落地：前面三个阶段（算计划）与后面两段（拉 / 推）报的是同一套事件，画法也一样。 */}
        {busy === 'apply' &&
          (progress === null ? (
            <p className="dsm-hint">{t('syncPreparing')}</p>
          ) : (
            <ProgressBlock t={t} progress={progress} />
          ))}
        {busy !== 'apply' && !planning && sync !== null && syncPlan !== null && (
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
            {sync.problems.map((problem) => (
              <p key={problem} className="dsm-warn">
                {problem}
              </p>
            ))}
            {syncClean && <p className="dsm-ok">{t('syncNothing')}</p>}

            {syncPulls.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncPullHead', { count: syncPulls.length })}</p>
                <table className="dsm-table dsm-planTable dsm-syncPlanTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colBytes">{t('colBytes')}</th>
                    </tr>
                  </thead>
                  {pullGroups.map((group) => (
                    // 每个项目一个 <tbody>：组头是它自己的表头行（colSpan 占满），列对齐由上面那一个
                    // <thead> 统一给。
                    <tbody key={groupKey(group.path)}>
                      <PlanGroupHead group={group} columns={3} t={t} />
                      {group.rows.map((entry) => {
                        const label = sessionLabel(entry)
                        return (
                          <tr key={entry.id}>
                            <td>
                              <span className="dsm-tag dsm-tagCreate" title={t('syncCodeMissingPull')}>
                                {t('syncTagPull')}
                              </span>
                            </td>
                            <SessionCell label={label} tip={syncPullTip(entry, label.tip, t)} />
                            <td className="dsm-meta">{formatBytes(entry.bytes)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  ))}
                </table>
              </>
            )}

            {syncPushes.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncPushHead', { count: syncPushes.length })}</p>
                <table className="dsm-table dsm-planTable dsm-syncPlanTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colBytes">{t('colBytes')}</th>
                    </tr>
                  </thead>
                  {pushGroups.map((group) => (
                    <tbody key={groupKey(group.path)}>
                      <PlanGroupHead group={group} columns={3} t={t} />
                      {group.rows.map((entry) => {
                        const label = sessionLabel(entry)
                        return (
                          <tr key={entry.id}>
                            <td>
                              <span
                                className={`dsm-tag ${entry.code === 'local-ahead' ? 'dsm-tagSkip' : 'dsm-tagCreate'}`}
                                title={entry.code === 'local-ahead' ? t('syncCodeLocalAhead') : t('syncCodeMissingPush')}
                              >
                                {entry.code === 'local-ahead' ? t('syncTagRepush') : t('syncTagPush')}
                              </span>
                            </td>
                            <SessionCell label={label} tip={label.tip} />
                            <td className="dsm-meta">{formatBytes(entry.bytes)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  ))}
                </table>
              </>
            )}

            {syncKept.length > 0 && (
              <>
                <p className="dsm-hint">{t('syncKeptHead', { count: syncKept.length })}</p>
                {/* 与拉/推两张表同一种画法：状态列放标签、会话单独一列——挤成一行同色的说明时，
                    状态与会话名分不出来（用户截图报的）。整句仍在标签的 title 上。
                    第三列是**远端是哪台机器**：分组之后路径已经在组头上（缺映射那类给的就是远端
                    路径），这一列再不重复它——剩下的信息只有"另一份是谁的"。 */}
                <table className="dsm-table dsm-planTable dsm-syncPlanTable dsm-keptTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('colAction')}</th>
                      <th className="dsm-colSession">{t('colSession')}</th>
                      <th className="dsm-colMachine">{t('colMachine')}</th>
                    </tr>
                  </thead>
                  {keptGroups.map((group) => (
                    <tbody key={groupKey(group.path)}>
                      <PlanGroupHead group={group} columns={3} t={t} />
                      {group.rows.map(({ entry }) => {
                        const label = sessionLabel(entry)
                        return (
                          <tr key={entry.id}>
                            <td>
                              <span className="dsm-tag dsm-tagSkip" title={syncWhy(entry, t)}>
                                {syncTag(entry, t)}
                              </span>
                            </td>
                            <SessionCell label={label} tip={label.tip} />
                            <td className="dsm-cwd">{entry.machine ?? ''}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  ))}
                </table>
              </>
            )}
          </div>
        )}
        </ConfirmDialog>
      )}
    </>
  )
}
