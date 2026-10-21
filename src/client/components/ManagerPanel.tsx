/**
 * 「会话管理」页的骨架：一条标题行 + 页内分页，把三件事收在同一页里。
 *
 * 为什么是页内分页而不是几个设置分节：导出/导入、逐条管理与迁移都是"对着同一个会话库做一件事"，
 * 共用一份库状态（`/state` 只拉一次）、共用一句"库在哪、有多少条"的说明，分开成几页反而每次都要
 * 重新认一遍上下文。页面本体分别是 [ManagePanel.tsx](./ManagePanel.tsx)（逐条管理，**含迁移**）、
 * [TransferPanel.tsx](./TransferPanel.tsx) 与 [BackupPanel.tsx](./BackupPanel.tsx)（后者是三个写
 * 操作共同的后悔面，不属于其中任何一个动作页）。
 *
 * 迁移原先单独占一个分页：它的源改成"你勾中的那些会话"之后，那一页就只剩一张与「会话」页逐字同形的
 * 列表 + 一枚按钮 + 一个弹窗，于是并进了那一页的动作行（见 ManagePanel 的模块说明）。
 *
 * 数据分两份到：`/meta`（库在哪、宿主有哪些能力位，不扫库）与 `/state`（扫完整库的清单）。页头读
 * `state ?? meta`，所以"位置与能力位"不必等那遍扫描；清单没到的分页说「读取中…」，而不是先把
 * "还没有会话""这个宿主没有这个能力"这类**结论**画上去再改。
 *
 * 分页切换会**卸载**另一个分页：本地草稿（勾选、弹窗里那份计划）随之清掉。这是有意的——一份计划
 * 不该在切走再切回来之后还留着，让人以为它还是刚刚算出来的那份。
 *
 * @module dsh-session-manager/client/ManagerPanel
 */

import * as React from 'react'

import { Button, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'

import type { MetaResponse, ProgressEvent, StateResponse } from '../api.ts'
import { panelEvents, type PanelSnapshot } from '../logic/panelEvents.ts'
import { PLUGIN_COMMIT, PLUGIN_DIRTY, PLUGIN_VERSION } from '../build.ts'
import type { DirectoryApi } from '../directory.ts'
import type { Translate } from '../logic/locales.ts'
import { syncJob, type SyncJobSnapshot } from '../logic/syncJob.ts'
import { versionCommit, versionLabel, versionTag } from '../logic/version.ts'
import { BackupPanel } from './BackupPanel.tsx'
import { HelpPanel } from './HelpPanel.tsx'
import { ManagePanel } from './ManagePanel.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import { SyncPanel } from './SyncPanel.tsx'
import { TransferPanel } from './TransferPanel.tsx'

/**
 * 页面获得的注入面：`t` 是**框架 props**（注册时带 `locale: NS` 换来的那一个），`directory` 由
 * 注册时的 `inject()` 给出。
 *
 * `t` 必定在——带 `locale` 注册的条目拿到的就是它；目录选择器可以缺席（那个能力由别的客户端
 * 插件提供），缺席时界面上给提示，而不是整页白屏。
 */
export interface ManagerPanelProps {
  t: Translate
  directory?: () => DirectoryApi | undefined
}

/** 页内分页。 */
type PanelKey = 'transfer' | 'sync' | 'manage' | 'backup' | 'help'

/** 会话管理页。 */
export function ManagerPanel({ t, directory }: ManagerPanelProps): React.ReactElement {
  /**
   * 这一页的全部数据都从**那一条连接**来（见 [panelEvents.ts](../logic/panelEvents.ts)）：打开页面时连上，
   * 宿主先发宿主事实、再发两种后台状态的当下，最后发一份整库清单（边扫边报"扫到第几条"）。
   *
   * 下面这几个状态是那份快照在渲染里的影子：它们与快照同进同退（见下面那条订阅），不在本地另算一遍。
   * 分成几个而不是留一份对象，是因为每个在界面上各答一件事——位置/能力位、清单、进度、错。
   */
  const [state, setState] = React.useState<StateResponse | null>(null)
  /**
   * 会话库位置与能力位那一份。
   *
   * 用 `undefined` 而不是 `null` 表示"还没到"：`null` 在本页是"读到了，宿主就是没给"（比如没配同步），
   * 两者不能混。它跟着第一条 `ready` 到，页头因此不必等扫库。
   */
  const [meta, setMeta] = React.useState<MetaResponse | undefined>(undefined)
  /**
   * 这次读库扫到哪儿了。
   *
   * `undefined` = 还没收到第一条进度（与 `meta` 同一个语义："还没到"），那时页头照旧只说「读取中…」、
   * 不画条——还不知道分母。
   */
  const [loadProgress, setLoadProgress] = React.useState<ProgressEvent | undefined>(undefined)
  // 默认停在第一个页签（「会话」）：它是这一页的日常视图，另外两页是偶发动作。
  const [panel, setPanel] = React.useState<PanelKey>('manage')
  /**
   * 手动「刷新」按下去之后、新清单回来之前。
   *
   * 它不跟连接状态走：重连期间连接是 `connecting`，但屏幕上是上一次那份清单，那时该画的还是一份清单
   * 加一条进度，而不是把整页退回「读取中…」。
   */
  const [busy, setBusy] = React.useState(false)
  /** 那条连接报的错（连不上、扫库失败），宿主原话；渲染时套进「刚才那件事没成：…」那一句。 */
  const [error, setError] = React.useState<string | null>(null)

  /**
   * 后台那一趟同步跑到哪儿了（见 logic/syncJob.ts）。
   *
   * 为什么放在**页面**这一级而不是同步分页里：那一趟的生命周期比任何一页都长——用户可能切到别的分页、
   * 或者把整个设置窗口关掉，回来时默认停在「会话」那一页。状态挂在模块级，这里只是读它并把横幅画在
   * 页签上面，所以"关掉再回来还看得见"是它天然的样子，不是特例。
   */
  const [job, setJob] = React.useState<SyncJobSnapshot>(syncJob.snapshot())
  React.useEffect(() => syncJob.subscribe(setJob), [])
  /**
   * 接上宿主那一路"落地那一趟跑到哪"（页面那条唯一的连接上就有，见 panelEvents.ts）。
   *
   * 刷新整个页面之后这一份内存是新的，状态只能从宿主那里认领；没配同步时那一路本来也不会有活儿。
   */
  React.useEffect(() => syncJob.refresh(), [])
  /** 后台那一趟的结论一句话（页面顶上那一行）；没有结论时 `null`。 */
  const jobLine = ((): { ok: boolean; text: string } | null => {
    const done = job.done
    if (done === null) return null
    if (!done.ok) return { ok: false, text: t('sync.background.failed', { reason: done.error ?? '' }) }
    // 宿主那边连"搬了几条"都没留下（进程重启过）：只说结束，不编一个 0。
    const counts =
      done.result === undefined && done.adopted === undefined
        ? null
        : {
            pulled: done.result?.pulled.length ?? done.adopted?.pulled ?? 0,
            pushed: done.result?.pushed.length ?? done.adopted?.pushed ?? 0,
          }
    return { ok: true, text: counts === null ? t('sync.background.donePlain') : t('sync.background.done', counts) }
  })()
  /**
   * 那一行要不要摆：同步分页会自己说这一趟的结论（成功说细的那几句、失败说原因），由它说时这里就不
   * 重复；其余情况——用户在别的分页，或者这一趟是别处发起、同步分页拿不到结论——由这里说。
   */
  const showJobLine = jobLine !== null && (panel !== 'sync' || job.done?.adopted !== undefined)

  /**
   * 手动「刷新」：重连一次要一份新清单（宿主会重新扫库，进度照旧画在同一个位置）。
   *
   * 别处（面板流上那条 `stale`）走的也是它——读清单只有这一条路。
   *
   * @returns 新清单落地（或 30 秒之后）resolve：各分页的 `await reload()` 之后要接着读新清单。
   */
  const load = React.useCallback((): Promise<void> => {
    setBusy(true)
    return panelEvents.reload().finally(() => setBusy(false))
  }, [])

  // 页面挂上就连、走了就断：断开之后宿主不再为一个没人看的页面扫库。
  React.useEffect(() => {
    panelEvents.start()
    return () => panelEvents.stop()
  }, [])

  // 快照一变就重画；新清单落地之后收掉"刷新中"。
  React.useEffect(() => {
    const read = (snapshot: PanelSnapshot): void => {
      setState(snapshot.state)
      setMeta(snapshot.meta ?? undefined)
      setLoadProgress(snapshot.scan ?? undefined)
      setError(snapshot.error)
      if (snapshot.state !== null) setBusy(false)
    }
    const unsubscribe = panelEvents.subscribe(read)
    // 先把当下那一份摊进来：这一页可能是"上次进来读过、这次重新挂着"的情形，那时快照里已经有清单。
    read(panelEvents.snapshot())
    return unsubscribe
  }, [])

  /** 上一份已经据此重读过库的结论：同一份别每渲染一次就重读一遍。 */
  const freshAfter = React.useRef<SyncJobSnapshot['done']>(null)
  React.useEffect(() => {
    const done = job.done
    if (done === null || freshAfter.current === done) return
    freshAfter.current = done
    // 拉取落到本机库里了：会话清单与工作区归属都得重读（推的那一侧不改本机任何东西）。
    const pulled = done.result?.pulled.length ?? done.adopted?.pulled ?? 0
    if (pulled > 0) panelEvents.refresh()
  }, [job])


  const sessions = state?.sessions.length ?? 0
  const workspaces = state?.workspaces.length ?? 0
  /**
   * 页头那行读的那些事实：`/state` 到了以它为准（它是超集），没到就用先回来的 `/meta`。
   *
   * 清单没到时条数说"读取中…"而不是 0——`0 个会话` 是**结论**，而那一刻的真相是"还不知道"。
   */
  const facts = state ?? meta
  const counts =
    state === null
      ? t('loading')
      : `${t('page.count.sessions', { count: sessions })} · ${t('page.count.workspaces', { count: workspaces })}`
  const libraryLine = facts === undefined ? t('loading') : `${facts.sessionsRoot} · ${counts}`
  // 这一页是哪个构建：构建期写死的版本号，加上直接从 git build 时的短 commit（脏工作区挂 -dirty）。
  const version = versionLabel(PLUGIN_VERSION, PLUGIN_COMMIT, PLUGIN_DIRTY)
  // 提示里版本号与 commit 各占一处，所以这里传的是不带 commit 的那个版本号。
  const versionTip =
    PLUGIN_COMMIT === ''
      ? t('page.version.tip', { version: versionTag(PLUGIN_VERSION) })
      : t('page.version.tipBuild', {
          version: versionTag(PLUGIN_VERSION),
          commit: versionCommit(PLUGIN_COMMIT, PLUGIN_DIRTY),
        })

  return (
    <section className="dsm-root" data-plugin="dsh-session-manager">
      <header className="dsm-head">
        <h2 className="dsm-title">{t('page.title')}</h2>
        <p className="dsm-intro">
          {t('page.library')}：{libraryLine}
        </p>
      </header>

      {/*
        读库的进度：整库要逐条读 header、折标题（更大或更慢的库上是几秒），这一段原来只有页头那句
        「读取中…」。摆在页头下面、页签上面——它是这一页自己的事，不属于任何一个分页。
      */}
      {loadProgress !== undefined && <ProgressBlock t={t} progress={loadProgress} />}

      {/*
        后台同步：跑着的时候是进度条（关掉窗口、切分页都还在），跑完留一行结论直到用户关掉它。
        摆在页签**上面**是因为它不属于任何一个分页——与「读库的进度」同一个位置、同一条理由。
      */}
      {job.running && (
        <div className="dsm-banner dsm-progressBanner">
          <span className="dsm-hint">
            {t(job.adopted ? 'sync.background.adopted' : 'sync.background.running')}
          </span>
          {job.progress === null ? null : <ProgressBlock t={t} progress={job.progress} />}
          {job.adopted ? null : <span className="dsm-hint">{t('sync.background.hint')}</span>}
        </div>
      )}
      {showJobLine && jobLine !== null && (
        <p className={jobLine.ok ? 'dsm-banner dsm-ok' : 'dsm-banner dsm-error'}>
          <span>{jobLine.text}</span>
          <span className="dsm-spacer" />
          <Button variant="outline" size="sm" onClick={() => setPanel('sync')}>
            {t('sync.background.open')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => syncJob.dismiss()}>
            {t('close')}
          </Button>
        </p>
      )}

      {error !== null && (
        <p className="dsm-banner dsm-error">
          {/* 宿主报的是原话（扫库失败、连不上）：界面只负责把它套进「刚才那件事没成：…」那一句。 */}
          <span>{t('error.failed', { reason: error })}</span>
          <span className="dsm-spacer" />
          {/* 关掉一条横幅：本页不用官方缺省的 ghost（那条口径见「动作行里的动作带边框」那篇笔记）。 */}
          <Button variant="outline" size="sm" onClick={() => setError(null)}>
            {t('error.dismiss')}
          </Button>
        </p>
      )}

      {/*
        页签顺序：三个动作页按日常程度排（会话 → 传输 → 同步），「备份」是那三个写操作
        共同的后悔面（迁移 / 删除 / 同步覆盖各留一份），日常程度最低却也不属于其中任何一页，所以
        排在动作页之后、最后的「说明」之前——「说明」是一次性读的参考，不该挤在动作页上（详见
        HelpPanel.tsx 的取舍）。同步紧挨着传输，是因为它落地走的是导入那条编排（见 SyncPanel.tsx
        的说明）。顺序与页签、页面本体两处都跟着走对齐，默认页就是第一个（见上面 useState 的初值）。

        「刷新」挂在这一行的右端，不在页头里（见下面 dsm-tabsRow 的说明）。
      */}
      <div className="dsm-tabsRow">
        {/*
          页签走官方 `SegmentedControl`：手写那排 `role="tab"` 的 `<button>` 得自己接
          `aria-selected` / `tabIndex` / 方向键走查 / `aria-controls`，官方原语一并带齐（还多一层
          滑块指示器）。`id` 是前缀，每段拿 `<id>-<value>` 与 `<id>-<value>-panel`，与下面分页本体
          的 `id` 配成一对。段与段的值就是 `PanelKey`，受控在 `panel` 那个状态上。
        */}
        <SegmentedControl
          id="dsm-panel"
          value={panel}
          label={t('page.title')}
          onChange={setPanel}
          options={[
            { value: 'manage', label: t('page.tab.manage') },
            { value: 'transfer', label: t('page.tab.transfer') },
            { value: 'sync', label: t('page.tab.sync') },
            { value: 'backup', label: t('page.tab.backup') },
            { value: 'help', label: t('page.tab.help') },
          ]}
        />
        {/*
          「刷新」在这一行的右端，不在页头里：它重读的是**整页**的状态（`/meta` + `/state`：库在哪、
          多少个会话、多少个工作区、同步配没配），所以它不属于任何一个分页，只能留在页面这一级；
          而页头只有标题与说明行两行（规格与内建设置页对齐，见
          [决策](../../../.agents/notes/implemented/architecture/2026-09-28-page-header-matches-the-builtin-settings.md)），
          摆进去就会把标题那一行撑高、并与设置外壳自己那枚「打开配置文件」在同一个右列里上下叠着。
          排到说明行右端也不行：那一行（`会话库：… · 457 个会话 · 13 个工作区`）实测宽 497px，加上
          按钮与间距要 580px，而内容列只有 564px——它会被挤成两行。这一行右端量下来还有 142px 空着
          （右端对齐由 `.dsm-tabsRow > .dsm-tabsAction` 的 `margin-left:auto` 做，换行后也贴着右端）。
        */}
        {/*
          这枚按钮要一个自己的类：官方 `Button` 的类名是它 CSS module 的哈希名（认不得、也不该认），
          所以"推到这一行右端"这条布局得挂在本页自己的类上。
        */}
        <Button className="dsm-tabsAction" variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
          {busy ? t('loading') : t('page.refresh')}
        </Button>
      </div>

      {/*
        分页本体外面这一层带上 `id`，与上面 `SegmentedControl` 给每段写的 `aria-controls`
        （`<id>-<value>-panel`）接上：官方原语按这个约定生成引用，不接上就是一个指向空气的
        `aria-controls`。`role="tabpanel"` 也在这一层。
      */}
      <div id={`dsm-panel-${panel}-panel`} role="tabpanel" className="dsm-panel">
        {panel === 'manage' && <ManagePanel t={t} state={state} meta={meta} reload={load} directory={directory} />}
        {panel === 'transfer' && <TransferPanel t={t} state={state} meta={meta} reload={load} directory={directory} />}
        {panel === 'sync' && <SyncPanel t={t} state={state} meta={meta} reload={load} />}
        {panel === 'backup' && <BackupPanel t={t} reload={load} />}
        {panel === 'help' && <HelpPanel t={t} state={state} meta={meta} reload={load} />}
      </div>

      {/*
        版本徽标：这一页的右下角。放在页内分页**之后**而不是页头——它答的是"这一页是哪个构建"，
        与"你要做什么"无关；悬浮提示把"发布版还是直接 build 的"说全（判据见 build.ts 与
        scripts/build-identity.ts）。一句话里的数字来自构建期常量，渲染路径上没有任何 IO。
      */}
      <p className="dsm-version" title={versionTip}>
        {version}
      </p>
    </section>
  )
}
