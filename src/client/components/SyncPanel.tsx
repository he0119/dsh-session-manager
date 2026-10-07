/**
 * 「同步」分页：按 WebDAV 配置在多台机器之间拉取与推送（点「同步」先在弹窗里看只读计划，确认才落盘）。
 *
 * 为什么单独一页，而不是挂在「传输」底下：两者正交——「传输」是一次性的带走/带回来（选包、选目标、
 * 导出下载），同步是一条**常设**通道：远端地址、机器名、映射表与那个确认弹窗都只属于它。挤在一页时
 * 同步那块只能排在导出列表与导入计划表之后，越用越长；而这一页的第一件事（看一眼远端配没配对、
 * 改一下映射）与「传输」的第一件事（勾哪些会话）也没有先后关系。
 *
 * 分页顺序是「会话 → 迁移 → 传输 → 同步 → 备份 → 说明」：同步排在传输之后，是因为它落地走的是导入
 * 那条编排（见 README 的「同步」一节），紧挨着读更顺。
 *
 * 这一页拆成两张卡：上面那张是"这条通道现在通到哪、要不要走一趟"（一句话 + 主动作），下面是设置表单。
 * 拆开是为了让主动作有个自己的动作行（见
 * [决策](../../../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md)）：
 * 表单十几行，按钮放卡头就成了"页面第一件事"、放卡尾又得翻过整张表，而它读的是**已保存**的配置，
 * 与那张表单没有阅读顺序上的先后。
 *
 * 这一层只做三件事：调宿主端点、记本地草稿、把结果摆出来。所有判定都在宿主侧
 * （`src/web.ts` + `src/sync.ts`）：计划返回的就是将要发生的事，页面不自己推算。会话库数据由页面
 * 骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉好传进来，切分页不各拉一份。
 *
 * 落地那一次是**流式**的：宿主按条推事件，正文换成进度条与"正在推送 12 / 84"（见
 * [api.ts](./api.ts) 的 `applySync` 与 [ProgressBar.tsx](./ProgressBar.tsx)）。同步是这个插件里唯一
 * "按条走网络"的动作，一次整库同步可能是几十秒，而在此之前界面只有一句"同步中…"。
 *
 * 弹窗里那三张计划表（会拉取 / 会推送 / 没动）按**项目目录**分组：一次整库同步的计划里，同一个目录会连着
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
  type SessionSummary,
  type SyncProgressEvent,
  type SyncPullEntry,
  type SyncPushEntry,
  type SyncResponse,
} from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { groupKey } from '../logic/groups.ts'
import { WorkspaceIcon } from './icons.tsx'
import type { SessionManagerKey, Translate } from '../logic/locales.ts'
import { projectLabel, sessionLabel, type SessionLabel } from '../logic/planRows.ts'
import { ProgressBar } from './ProgressBar.tsx'
import { formatBytes, sessionTags, type TagCopy } from './sessionList.tsx'
import { SyncConfigForm } from './SyncConfigForm.tsx'
import { groupSyncRows, syncProjectOf, syncPullTip, type SyncGroup, type SyncSide } from '../logic/syncGroups.ts'
import type { PanelShare } from '../types.ts'

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

/** 拉取 / 推送两种计划行的公共字段（只为 `syncWhy()` / `syncTag()` 取字段用）。 */
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
      return t(entry.action === 'create' ? 'sync.why.missingPull' : 'sync.why.missingPush')
    case 'local-ahead':
      return t('sync.why.localAhead')
    case 'local-newer':
      return t('sync.why.localNewer')
    case 'remote-ahead':
      return t('sync.why.remoteAhead', { machine: entry.machine ?? '' })
    case 'diverged':
      return t('sync.why.diverged', { machine: entry.machine ?? '' })
    case 'no-mapping':
      return t('sync.why.noMapping', { from: entry.fromCwd ?? '' })
    case 'missing-target':
      return t('sync.why.missingTarget', { to: entry.toCwd ?? '' })
    default:
      return String(entry.code)
  }
}

/**
 * 「没动」那一类的短标签：状态进标签，整句（`syncWhy()`）挂在它的 `title` 上。
 *
 * 与拉取 / 推送两张表同一口径：窄列里放不下整句，而**状态与会话名必须是两种东西**——挤成一行同色同号的
 * 文字时，一列"某某：两边各自写过（robot-b）"读起来分不出哪个是状态、哪个是会话。认不出来的码退回
 * 整句（宁可挤，也不要显示成一个生词）。
 */
function syncTag(entry: SyncRow, t: Translate): string {
  switch (entry.code) {
    case 'remote-ahead':
      return t('sync.tag.remoteAhead')
    case 'diverged':
      return t('sync.tag.diverged')
    case 'local-newer':
      return t('sync.tag.localNewer')
    case 'no-mapping':
      return t('sync.tag.noMapping')
    case 'missing-target':
      return t('sync.tag.missingTarget')
    default:
      return syncWhy(entry, t)
  }
}

/**
 * 「会拉取」里的**覆盖行**用哪句整句当 title。
 *
 * 覆盖本机那份是三张表里唯一会动本机已有内容的动作，所以那一列不能只说「拉取」：标签说的是动作
 * （「覆盖本机」），title 说清"谁更新、会拿谁换掉本机这份"。码认不出来就退回标签本身（与 `syncWhy()`
 * 同一条兜底规则：宁可挤，也不显示成一个生词）。
 */
function replaceCodeKey(code: SyncPullEntry['code']): SessionManagerKey {
  switch (code) {
    case 'remote-ahead':
      return 'sync.why.replaceAhead'
    case 'remote-newer':
      return 'sync.why.replaceNewer'
    case 'blank-local':
      return 'sync.why.replaceBlank'
    default:
      return 'sync.tag.replace'
  }
}

/**
 * 「会推送」那张表里一行挂哪颗标签、整句是什么。
 *
 * 三件事共用这张表：本机独有（推一条新的）、本机领先（重推刷新远端）、两边各自写过而本机更晚（分叉
 * 重推）。后两者都是"重推"，但后者要让用户知道"远端也有一份、本机这份更晚，推送会把它那格刷成最新"，
 * 所以标签与整句都分开。标签一律短到装得进那一列（列宽与实测见 styles.ts），整句挂在 title 上。
 * 码认不出来时退回"推一条新的"那一套（与拉取表的兜底同一条规则）。
 */
function pushTag(entry: SyncPushEntry, t: Translate): { label: string; title: string; repush: boolean } {
  switch (entry.code) {
    case 'local-ahead':
      return { label: t('sync.tag.repush'), title: t('sync.why.localAhead'), repush: true }
    case 'local-newer':
      return { label: t('sync.tag.localNewer'), title: t('sync.why.localNewer'), repush: true }
    default:
      return { label: t('sync.tag.push'), title: t('sync.why.missingPush'), repush: false }
  }
}

/**
 * 三段清单的段头：标题在左、条数进一颗中性药丸。
 *
 * 原来这里是一行 `.dsm-hint`（13px/400 的次要色），与正文里"跳过 N 条空白会话…"那种说明句一模一样，
 * 于是三张表之间没有可见的分界（用户报的"和其他内容区分并不明显"）。段头用 `h3`：读屏可以按标题在
 * 三段之间跳，视觉上标题是 13px/600 的主文字色、条数退回 12px 的中性药丸——标题、正文、标签三种
 * 东西各有各的形状，扫一眼就分得出来。条数那句与会话列表、组头共用（`list.sessionsInDir`）。
 */
function PlanSectionHead({ title, count, t }: { title: string; count: number; t: Translate }): React.ReactElement {
  return (
    <h3 className="dsm-planHead">
      {title}
      <span className="dsm-tag dsm-tagIdle">{t('list.sessionsInDir', { count })}</span>
    </h3>
  )
}

/**
 * 计划表里的项目组头：一条横跨整行的横幅（`<th colSpan>` 占满那一行）。
 *
 * 为什么在表里插一行、而不是一个项目一张表：会话名与大小必须仍然对着 `<thead>` 那两列，而一张表只有
 * 一个表头——一张表一个项目的话，"动作 / 会话 / 大小"这套表头要么每个项目重复一遍，要么只剩第一张
 * 有，列宽也会各算各的。
 *
 * 组头的画法与列表那边的组头同一档（字色 12% 兑出来的横幅、工作区图形、名字 + 条数），但没有折叠与
 * 勾选：弹窗里这份清单只是读一遍，不在这儿挑东西。称呼规则也共用一份（`planRows.projectLabel()`）：
 * 那一行只摆名字（工作区标题，没登记就是项目名），项目身份与本机路径一起进悬浮提示——它们都是机器
 * 字符串，摆在行里又长又会被截断，而"这是哪个仓库、在哪儿"是想知道才看的信息。
 */
function PlanGroupHead({
  group,
  columns,
  repo,
  t,
}: {
  group: SyncGroup<unknown>
  columns: number
  /** 这一组的项目身份（宿主 `/state` 的 `repos`）；认不出来时没有。 */
  repo?: string
  t: Translate
}): React.ReactElement {
  const label = projectLabel({ path: group.path, title: group.title, repo }, t)
  return (
    <tr className="dsm-planGroup">
      <th className="dsm-planGroupHead" colSpan={columns} scope="colgroup">
        <span className="dsm-planGroupInner">
          <WorkspaceIcon />
          <span className="dsm-groupTitle" title={label.tip}>
            {label.name}
          </span>
          {/* 与列表那边同一枚标签：有项目身份的目录挂主机名，悬浮提示里给全整条身份。 */}
          {label.host !== undefined && (
            <span className="dsm-tag dsm-tagIdle" title={repo}>
              {label.host}
            </span>
          )}
          <span className="dsm-groupCounts">
            <span className="dsm-hint">{t('list.sessionsInDir', { count: group.rows.length })}</span>
          </span>
        </span>
      </th>
    </tr>
  )
}

/**
 * 这一行的**会话类型**标签：与会话列表**同一套**判据（`sessionList.sessionTags()` →
 * `sessionFilter.hasAttribute()`），所以同一条会话在「会话」页与这里挂的标签一模一样——两处各算一套
 * 的话，用户看到的就是两个不同的"什么是空白 / 子智能体"。
 *
 * 计划行本身只带 id、标题与体积，类型得从 `/state` 那份会话清单里按 id 取；本机还没有这条会话时
 * （「会拉取」里新建的那些）取不到，就不挂标签——那是"它还没落到本机"，不是"它什么类型都不是"。
 *
 * 不挂「未分组」：计划表按项目目录分组，组头已经写着这条属于哪个目录（同会话页的理由：归属那一格
 * 已经写着它，不重复挂）。
 *
 * @param session `/state` 里那条会话；本机没有就是 `undefined`。
 * @returns 要挂的标签（字典键 + 说明键），顺序与会话列表一致。
 */
function typeTagsOf(session: SessionSummary | undefined): TagCopy[] {
  return session === undefined ? [] : sessionTags(session, { ungrouped: false })
}

/**
 * 会话名那一格：显示标题、没有标题才退到 id（`sessionLabel()`），后面跟着会话类型标签，id 与整句说明
 * 在悬浮提示里。
 *
 * 拉取行的提示还会补上"这条的 cwd 从哪改写到哪"（`syncPullTip()`）——那句话原来占着 cwd 一列，
 * 现在落地的目录已经在组头上，只有真的改写过的行才需要再说一句从哪儿来。
 *
 * 名字与标签同占一格用的是会话列表那套 `.dsm-rowLabel`（标签 `flex: none`、名字自己负责省略），
 * 三张表因此在窄列里也有同一种排布。
 */
function SessionCell({
  label,
  tip,
  tags,
  t,
}: {
  label: SessionLabel
  tip: string
  tags: TagCopy[]
  t: Translate
}): React.ReactElement {
  return (
    <td>
      <span className="dsm-rowLabel">
        <span className={label.kind === 'title' ? 'dsm-rowTitle' : 'dsm-rowId'} title={tip}>
          {label.text}
        </span>
        {tags.map((tag) => (
          <span key={tag.key} className="dsm-tag dsm-tagIdle" title={t(tag.tip)}>
            {t(tag.key)}
          </span>
        ))}
      </span>
    </td>
  )
}

/**
 * 进度那行字。
 *
 * `done` 是**已经做完**的条数、事件发在开始处理下一条之前，所以正在处理的是第 `done + 1` 条——与
 * 进度条的 `current` 同一个数，两处必须一起变。读远端索引是一次网络往返，没有"第几条"可讲，所以那
 * 一段是固定的一句（`sync.progress.preparing`）。
 */
function progressTextOf(t: Translate, progress: SyncProgressEvent): string {
  switch (progress.phase) {
    case 'scan':
      return t('sync.progress.scanning', { current: progress.done + 1, total: progress.total })
    case 'repo':
      return t('sync.progress.matchingRepos', { current: progress.done + 1, total: progress.total })
    case 'compare':
      return t('sync.progress.comparing', { current: progress.done + 1, total: progress.total })
    case 'remote':
      return t('sync.progress.preparing')
    case 'pull':
      return t('sync.progress.pulling', { current: progress.done + 1, total: progress.total })
    case 'push':
      return t('sync.progress.pushing', { current: progress.done + 1, total: progress.total })
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
  // "中断了再点一次接着补齐"那句话只在真写盘的两段有意义：预演阶段还没有东西可写。
  const writing = progress.phase === 'pull' || progress.phase === 'push'
  return (
    <>
      {/* 分母是 0 的那一段（读一次远端索引）没有"第几条"：只摆那句话，不摆条。 */}
      {progress.total > 0 && <ProgressBar current={progress.done + 1} total={progress.total} label={text} />}
      <p className="dsm-hint">{text}</p>
      {progress.label === undefined ? null : <p className="dsm-rowTitle">{progress.label}</p>}
      {writing && <p className="dsm-hint">{t('sync.progress.note')}</p>}
    </>
  )
}

/** 同步页。 */
export function SyncPanel({ t, state, meta, reload }: PanelShare): React.ReactElement {
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

  /**
   * 同步配置（宿主插件配置里的 `sync` 块）；`null` 或字段缺席都按"没配置"处理，只画一句说明。
   *
   * 这一项不依赖清单（`/meta` 先到），所以按 `state ?? meta` 取；两份都还没到时**不能**按"没配置"
   * 画——那时该说的是"读取中…"，否则页面会先断言一句假的"这台机器没配同步"再改口。
   */
  const facts = state ?? meta
  const syncInfo = facts?.sync ?? null
  const syncKnown = facts !== undefined

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
        setError(t('error.failed', { reason: reasonOf(cause) }))
      },
    )
  }

  /**
   * 弹窗里按「确认同步」：真的拉取与推送。
   *
   * 逐条失败（某一条拉取失败）照旧把成功的那部分报出来，失败的那些**在页面横幅上逐条留着**——弹窗
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
            t('sync.applied', {
              pulled: result.pulled.length,
              pushed: result.pushed.length,
              bytesIn: formatBytes(result.bytesIn),
              bytesOut: formatBytes(result.bytesOut),
            }) +
              // 覆盖本机原来那份是这次同步里唯一"本机内容被换掉"的部分，值得单独说一句（旧的进备份了）。
              (result.replaced.length === 0 ? '' : ` ${t('sync.appliedReplaced', { count: result.replaced.length })}`),
          )
        }
        // 拉取的落到本机库里了：列表与工作区归属都要重读（推的那一侧不改本机任何东西）。
        if (result.pulled.length > 0) void reload()
      },
      (cause) => {
        setBusy(null)
        setDialog(null)
        setProgress(null)
        setError(t('error.failed', { reason: reasonOf(cause) }))
      },
    )
  }

  const syncPlan = sync?.plan ?? null
  // 覆盖本机那份也摆在「会拉取」这张表里（它同样是往本机落内容），只是行上挂一颗不同的标签。
  const syncPulls = syncPlan?.pull.filter((entry) => entry.action !== 'skip') ?? []
  const syncPushes = syncPlan?.push.filter((entry) => entry.action !== 'skip') ?? []
  // 空白会话不进那三张表，只在正文里报一句：它们没有内容可同步，逐条列出来只是把表撑长。
  const syncBlank = syncPlan?.blank?.length ?? 0
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
  /**
   * `/state` 那份会话清单按 id 索引：计划行只带 id，会话类型（空白 / 子智能体 / 已归档 / 活着的）要从
   * 这里取（见 `typeTagsOf()`）——判据与会话列表同一套，本页不自己算。
   */
  const sessionsById = new Map((state?.sessions ?? []).map((session) => [session.id, session]))
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
  /**
   * 落地之后要不要重启才被宿主承认。
   *
   * **只在需要重启时说话**，而且单独一条横幅、不塞进上面那条绿色成功横幅——两件事共用一个颜色底时，
   * 读的人分不出哪句是坏消息。判据取自最近一次结果：`mode === 'apply'` 说明它是落地回来的，不是预演
   * （与迁移页同一口径，见 [MigrationPanel.tsx](./MigrationPanel.tsx)）。
   */
  const restartWarn =
    sync !== null && sync.mode === 'apply' && sync.pulled.length > 0 && sync.takesEffect === 'restart-required'

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

      {restartWarn && (
        // 不定 dismiss：它不是这次操作的错，而是"这次落地还没被宿主承认"这个事实，下一次同步开始
        // （`sync` 换成新的计划）时它自己就没了。
        <p className="dsm-banner dsm-warn">{t('effect.restart')}</p>
      )}

      {failures.map((problem) => (
        <p key={problem} className="dsm-banner dsm-warn">
          {problem}
        </p>
      ))}

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('sync.title')}</span>
          {syncInfo !== null && (
            <span className="dsm-hint">{t('sync.where', { url: syncInfo.url })}</span>
          )}
        </div>
        {/* 没配置同步时只留一句话：摆一个点了没反应的按钮比不摆更糟（与「宿主没有归档能力」同一条口径）。 */}
        <p className="dsm-hint">
          {!syncKnown
            ? t('page.loading')
            : syncInfo === null
              ? t('sync.offHint')
              : t('sync.hint', { mappings: syncInfo.mappings })}
        </p>
        {/* 主动作在卡片底部的动作行里（见 TransferPanel.tsx 的说明）。这一页没有把「同步」放进头部：
            下面那张设置卡有十来行字段，按钮在头部就成了"页面第一件事"、在末尾又得翻过整张表单，
            而它读的是**已保存**的配置——与那张表单没有阅读顺序上的先后。 */}
        {syncInfo !== null && (
          <div className="dsm-controls">
            <button type="button" className="dsm-button dsm-primary" onClick={openSync} disabled={busy !== null}>
              {t('sync.action')}
            </button>
          </div>
        )}
      </div>

      <div className="dsm-card">
        <div className="dsm-cardHead">
          <span className="dsm-cardTitle">{t('sync.form.title')}</span>
        </div>
        {/* 配置改的是这条通道怎么走，与上面那次同步正交：改完 URL 立刻能同步一次。宿主没有设置接缝时
            这一块自己说明。 */}
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
          title={t(busy === 'apply' ? 'sync.running' : 'sync.dialogTitle')}
          confirmLabel={t('sync.applyAction')}
          busyLabel={t('sync.busy')}
          busy={busy === 'apply'}
          planning={planning}
          // 预演那几秒不是在空等：先扫本机、再读远端索引、最后逐条比对内容。算到哪一步摆哪一步的进度
          // （还没有事件时退回 ConfirmDialog 那句「预演中…」）。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={null}
          onConfirm={doSyncApply}
          onCancel={() => setDialog(null)}
        >
        {/* 落地：前面三个阶段（算计划）与后面两段（拉取 / 推送）报的是同一套事件，画法也一样。 */}
        {busy === 'apply' &&
          (progress === null ? (
            <p className="dsm-hint">{t('sync.progress.preparing')}</p>
          ) : (
            <ProgressBlock t={t} progress={progress} />
          ))}
        {busy !== 'apply' && !planning && sync !== null && syncPlan !== null && (
          <div>
            <p className={syncPlan.ok && sync.problems.length === 0 ? 'dsm-ok' : 'dsm-warn'}>
              {t('sync.summary', {
                pull: syncPlan.pullIds.length,
                push: syncPlan.pushIds.length,
                local: syncPlan.localCount,
                remote: syncPlan.remoteCount,
              })}
              {syncPlan.machines.length > 0 ? ` · ${t('sync.machines', { machines: syncPlan.machines.join('、') })}` : ''}
            </p>
            {/* 事前提醒：这次落地之后要不要重启，得在按「确认同步」**之前**说出来（见 `effect.plannedRestart`）。
                纯推送不改本机任何东西，所以只在真有会话要落到本机、且宿主那头需要重启时才摆这一句。 */}
            {syncPulls.length > 0 && sync.takesEffect === 'restart-required' && (
              <p className="dsm-warn">{t('effect.plannedRestart')}</p>
            )}
            {/* 空白会话不进那三张表：它们的去处只有这一句（没有内容可同步，也没有"为什么不动"可讲）。 */}
            {syncBlank > 0 && <p className="dsm-hint">{t('sync.skippedBlank', { count: syncBlank })}</p>}
            {sync.problems.map((problem) => (
              <p key={problem} className="dsm-warn">
                {problem}
              </p>
            ))}
            {syncClean && <p className="dsm-ok">{t('sync.nothing')}</p>}

            {syncPulls.length > 0 && (
              <>
                <PlanSectionHead title={t('sync.pullHead')} count={syncPulls.length} t={t} />
                <table className="dsm-table dsm-planTable dsm-syncPlanTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('table.action')}</th>
                      <th className="dsm-colSession">{t('table.session')}</th>
                      <th className="dsm-colBytes">{t('table.bytes')}</th>
                    </tr>
                  </thead>
                  {pullGroups.map((group) => (
                    // 每个项目一个 <tbody>：组头是它自己的表头行（colSpan 占满），列对齐由上面那一个
                    // <thead> 统一给。
                    <tbody key={groupKey(group.path)}>
                      <PlanGroupHead group={group} columns={3} repo={state?.repos?.[group.path]} t={t} />
                      {group.rows.map((entry) => {
                        const label = sessionLabel(entry)
                        // 覆盖本机那份单独一颗标签、另挂一条整句：它跟"从无到有拉一条"不是一回事。
                        const replace = entry.action === 'replace'
                        return (
                          <tr key={entry.id}>
                            <td>
                              <span
                                className={`dsm-tag ${replace ? 'dsm-tagSkip' : 'dsm-tagCreate'}`}
                                title={t(replace ? replaceCodeKey(entry.code) : 'sync.why.missingPull')}
                              >
                                {t(replace ? 'sync.tag.replace' : 'sync.tag.pull')}
                              </span>
                            </td>
                            <SessionCell
                              label={label}
                              tip={syncPullTip(entry, label.tip, t)}
                              tags={typeTagsOf(sessionsById.get(entry.id))}
                              t={t}
                            />
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
                <PlanSectionHead title={t('sync.pushHead')} count={syncPushes.length} t={t} />
                <table className="dsm-table dsm-planTable dsm-syncPlanTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('table.action')}</th>
                      <th className="dsm-colSession">{t('table.session')}</th>
                      <th className="dsm-colBytes">{t('table.bytes')}</th>
                    </tr>
                  </thead>
                  {pushGroups.map((group) => (
                    <tbody key={groupKey(group.path)}>
                      <PlanGroupHead group={group} columns={3} repo={state?.repos?.[group.path]} t={t} />
                      {group.rows.map((entry) => {
                        const label = sessionLabel(entry)
                        const tag = pushTag(entry, t)
                        return (
                          <tr key={entry.id}>
                            <td>
                              <span className={`dsm-tag ${tag.repush ? 'dsm-tagSkip' : 'dsm-tagCreate'}`} title={tag.title}>
                                {tag.label}
                              </span>
                            </td>
                            <SessionCell label={label} tip={label.tip} tags={typeTagsOf(sessionsById.get(entry.id))} t={t} />
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
                <PlanSectionHead title={t('sync.keptHead')} count={syncKept.length} t={t} />
                {/* 与拉取 / 推送两张表同一种画法：状态列放标签、会话单独一列——挤成一行同色的说明时，
                    状态与会话名分不出来（用户截图报的）。整句仍在标签的 title 上。
                    第三列是**远端是哪台机器**：分组之后路径已经在组头上（缺映射那类给的就是远端
                    路径），这一列再不重复它——剩下的信息只有"另一份是谁的"。 */}
                <table className="dsm-table dsm-planTable dsm-syncPlanTable dsm-keptTable">
                  <thead>
                    <tr>
                      <th className="dsm-colAction">{t('table.action')}</th>
                      <th className="dsm-colSession">{t('table.session')}</th>
                      <th className="dsm-colMachine">{t('table.machine')}</th>
                    </tr>
                  </thead>
                  {keptGroups.map((group) => (
                    <tbody key={groupKey(group.path)}>
                      <PlanGroupHead group={group} columns={3} repo={state?.repos?.[group.path]} t={t} />
                      {group.rows.map(({ entry }) => {
                        const label = sessionLabel(entry)
                        return (
                          <tr key={entry.id}>
                            <td>
                              <span className="dsm-tag dsm-tagSkip" title={syncWhy(entry, t)}>
                                {syncTag(entry, t)}
                              </span>
                            </td>
                            <SessionCell label={label} tip={label.tip} tags={typeTagsOf(sessionsById.get(entry.id))} t={t} />
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
