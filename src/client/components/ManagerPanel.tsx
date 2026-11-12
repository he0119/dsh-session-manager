/**
 * 「会话管理」页的骨架：一条工具条 + 工作台 + 一条状态栏。页面只做一件事——看这个库、对勾选的这批
 * 做事；其余三件事各自是一处入口 + 一个宽弹窗（[WorkDialog.tsx](./WorkDialog.tsx)）。
 *
 * 为什么去掉页签：页签让"你在哪一页"顶替了"你要对哪些会话做什么"。勾选原先只在「会话」页有效，
 * 切到「传输」再想导出得在那里重新勾一遍；而「迁移」早已因为同一个理由并进了勾选动作行（见
 * [ManagePanel.tsx](./ManagePanel.tsx) 的模块说明）。这一版把剩下两件也搬过去——导出进动作行、
 * 导入进同一个弹窗的另一栏——于是勾选成了全页唯一的输入。三个入口分别是：
 *
 * - 导出 / 导入：工作台卡片底部那条动作行（`manage.transfer.action`），开 1080 宽的传输弹窗；
 * - 同步：页头那枚状态（官方 `Button` + `StateDot`），平时只说配没配、这一趟跑完没有，点开才是
 *   远端、计划、差异与确认；
 * - 备份与回滚：底部状态栏那枚入口，三种写操作共同的后悔面。
 *
 * 「说明」照旧从页头那枚「?」开弹窗，不占入口。
 *
 * 数据分两份到：`/meta`（库在哪、宿主有哪些能力位，不扫库）与 `/state`（扫完整库的清单）。页头读
 * `state ?? meta`，所以"位置与能力位"不必等那遍扫描；清单没到的面板说「读取中…」，而不是先把
 * "还没有会话""这个宿主没有这个能力"这类**结论**画上去再改。
 *
 * 弹窗打开 / 关闭等于挂载 / 卸载：本地草稿（勾选、弹窗里那份计划、导入选的文件）随之清掉。这是
 * 有意的——一份计划不该在关掉再打开之后还留着，让人以为它还是刚刚算出来的那份。
 *
 * @module dsh-session-manager/client/ManagerPanel
 */

import * as React from 'react'

import { Button, Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'

import { fetchBackups, type MetaResponse, type ProgressEvent, type StateResponse } from '../api.ts'
import { panelEvents, type PanelSnapshot } from '../logic/panelEvents.ts'
import { getNavigationApi } from '../navigation.ts'
import { PLUGIN_COMMIT, PLUGIN_DIRTY, PLUGIN_VERSION } from '../build.ts'
import type { DirectoryApi } from '../directory.ts'
import type { Translate } from '../logic/locales.ts'
import { syncJob, type SyncJobSnapshot } from '../logic/syncJob.ts'
import { chooseBundle } from '../logic/fileDrop.ts'
import { relativeLabel } from '../logic/relativeTime.ts'
import { syncBarLabel } from '../logic/syncJobLabel.ts'
import { versionCommit, versionLabel, versionTag } from '../logic/version.ts'
import { BackupPanel } from './BackupPanel.tsx'
import { HelpPanel } from './HelpPanel.tsx'
import { ManagePanel } from './ManagePanel.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import { SyncPanel } from './SyncPanel.tsx'
import { ImportPanel } from './ImportPanel.tsx'
import { useFileDrop } from './useFileDrop.ts'
import { useSessionPicking } from './sessionList.tsx'
import { WorkDialog } from './WorkDialog.tsx'

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

/**
 * 页面上那几块"做事的面"。
 *
 * `none` 是列表本身（这一页常驻的那一面）；其余四个各是一个弹窗。原来它们是一个 `PanelKey` 的
 * 页签值，`manage` 那一档随页签一起去掉了——列表不再是"四个里选一个"，而是这一页唯一的样子。
 */
type Surface = 'none' | 'import' | 'sync' | 'backup' | 'help'

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
  /**
   * 这一页自己那条"做完了"的提示（目前只有导入用它）。
   *
   * 为什么放在页面这一级：导入成功之后弹窗就关掉了，写入的条数与字节总得有个地方说；列表顶部那条
   * 横幅正是删除、迁移、归档那几件事共用的位置。用 `undefined` 起头而不是 `null`：冒烟夹具按顺序把
   * 种子发给 null 状态（见 test/client.test.mjs 的 `nulls`），这里插一个 null 会让后面整体错一格。
   */
  const [notice, setNotice] = React.useState<string | undefined>(undefined)
  /**
   * 从页面上拖进来的那个包（松手之后交给导入那一面）。
   *
   * 它只活到弹窗打开那一刻：`ImportPanel` 在新挂载的那一帧把它读成"已经选好的文件"，之后改由它自己持有。
   * 用 `undefined` 起头，不去抢 null 状态那颗种子（同上面 `notice`）。
   */
  const [droppedFile, setDroppedFile] = React.useState<File | undefined>(undefined)
  // 这一页一进来就是列表：它不再是"四个里选一个"的默认项，而是唯一常驻的那一面。
  const [surface, setSurface] = React.useState<Surface>('none')

  /**
   * 重数一遍备份份数（状态栏那枚入口上的数字）。
   *
   * 只读一次目录（`GET /backups` 与备份清单同一份来源）。三类写操作都会留一份备份，所以它在这些时刻
   * 各读一次：页面挂上、手动刷新、以及任何一面关掉之后（那时刚做完的动作已经落盘）。
   * 读失败就保持原样：那个数字只是入口上的一句提示，不该让页面报错。
   */
  const countBackups = React.useCallback((): void => {
    void fetchBackups().then(
      (response) => setBackupCount(response.backups.length),
      () => undefined,
    )
  }, [])

  React.useEffect(() => {
    countBackups()
  }, [countBackups])

  /**
   * 页面这一层也是落点：把 `.dshsess` 拖到列表上，松手就开导入那一面，并且包已经拿在手里。
   *
   * 为什么页面也要接：用户手上多半没有"打开导入弹窗"这个前置动作——拖进来正是最省事的那一步。弹窗自己
   * 也接（见 ImportPanel），两条路都落到同一处 `acceptFile()`。
   *
   * 后缀不对时只在页面上说一句，不打开空弹窗：那不是"要导的东西"，不必拉用户进去。
   */
  const pageDrop = useFileDrop((files) => {
    const choice = chooseBundle(files)
    if (choice.kind === 'empty') return
    if (choice.kind === 'unknownSuffix') {
      setNotice(t('import.needBundle'))
      return
    }
    setDroppedFile(choice.file)
    setSurface('import')
  })

  /**
   * 关掉正在开的那一面：等于回到列表。
   *
   * 顺带重数一遍备份份数：那一面里刚做完的动作（导入落地、回滚、同步）都会留下或还原一份备份，
   * 入口上的数字得跟着变。
   */
  const close = React.useCallback((): void => {
    setSurface('none')
    setBackupFocus(undefined)
    // 拖进来的包只属于"这一次打开"：关掉之后再开不该又冒出上次那个文件。
    setDroppedFile(undefined)
    countBackups()
  }, [countBackups])
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
   * 有几份备份（状态栏那枚入口上的数字）。
   *
   * `undefined` = 还没读到。它只决定那枚按钮要不要带数字，读失败就照旧只写名字——比画一个"0 份"诚实
   * （一次目录列举，`/backups` 只读，与备份清单同一份来源）。用 `undefined` 而不是 `null` 起头：冒烟
   * 夹具按顺序把种子发给 null 状态，这里插一个 null 会让「会话」页后面那些整体错一格。
   */
  const [backupCount, setBackupCount] = React.useState<number | undefined>(undefined)
  /**
   * 从「撤销」点进来时指着的那一份备份（删除 / 迁移刚留下的）。
   *
   * 交给备份弹窗：它开着时直接摆出那份的动作清单与确认框，用户不用在清单里再找一遍。关掉弹窗就清掉，
   * 下次手点状态栏那枚入口是从清单开始。
   */
  const [backupFocus, setBackupFocus] = React.useState<string | undefined>(undefined)
  /**
   * 左栏「项目」筛着的那个（`null` = 全部项目）。
   *
   * 它原先在列表那一层，这里上移一格是为了导入：导入要回答"落到哪个项目"，而用户在看这一页时已经用
   * 左栏说过一次了——弹窗里的目标目录默认就填它，不用再问第二遍。
   */
  const [project, setProject] = React.useState<{ path: string | null }>({ path: null })
  /**
   * 列表与导出清单共用的勾选集（见 types.ts 的 `picking`）。
   *
   * 放在页面这一级，是因为它比任何一面都活得久：勾了 6 条 → 开「导出 / 导入」→ 导出栏里就是这 6 条；
   * 关掉弹窗回来，列表里还是这 6 条。原先两个页签各有一套，切过去要重勾一遍。
   */
  const picking = useSessionPicking(state?.sessions ?? [], t)

  /**
   * 后台那一趟同步跑到哪儿了（见 logic/syncJob.ts）。
   *
   * 为什么放在**页面**这一级而不是同步弹窗里：那一趟的生命周期比任何一面都长——用户可能开着别的
   * 弹窗、或者把整个窗口关掉，回来看到的是列表。状态挂在模块级，这里只是读它并把横幅画在列表上面，
   * 所以"关掉再回来还看得见"是它天然的样子，不是特例。
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
   * 那一行要不要摆：同步弹窗会自己说这一趟的结论（成功说细的那几句、失败说原因），由它说时这里就不
   * 重复；其余情况——弹窗没开，或者这一趟是别处发起、同步那一面拿不到结论——由这里说。
   */
  /** 状态栏那一格说什么（纯函数判，见 logic/syncJobLabel.ts）；`null` = 这一格不出现。 */
  const barLabel = syncBarLabel(job)

  /**
   * 结论别在状态栏上留着不走：跑完 12 秒后自己收掉。
   *
   * 长的那几句（拉了几条、推了几条、失败原因）在悬浮提示与同步那一面里；这一格只负责"刚才那趟成没成"。
   * 页头那枚同步状态另有一套常驻的说法（多久以前），所以收掉不丢东西。
   */
  React.useEffect(() => {
    if (job.running || job.done === null) return
    const timer = setTimeout(() => syncJob.dismiss(), 12000)
    return () => clearTimeout(timer)
  }, [job.done, job.running])

  /**
   * 手动「刷新」：重连一次要一份新清单（宿主会重新扫库，进度照旧画在同一个位置）。
   *
   * 别处（面板流上那条 `stale`）走的也是它——读清单只有这一条路。
   *
   * @returns 新清单落地（或 30 秒之后）resolve：各弹窗的 `await reload()` 之后要接着读新清单。
   */
  const load = React.useCallback((): Promise<void> => {
    setBusy(true)
    countBackups()
    return panelEvents.reload().finally(() => setBusy(false))
  }, [countBackups])

  /**
   * 就地改清单（见 statePatch.ts）：动作落地之后先让那一行改对，不等整库快照。
   *
   * 写进 `state` 同一个位置，所以它与快照走同一条渲染路径——一份数据，没有"本地副本与快照打架"这回事；
   * 快照随后到达时直接盖掉它（快照是磁盘的真话）。
   */
  const patch = React.useCallback((update: (current: StateResponse) => StateResponse): void => {
    setState((current) => (current === null ? current : update(current)))
  }, [])

  // 页面挂上就连、走了就断：断开之后宿主不再为一个没人看的页面扫库。
  React.useEffect(() => {
    panelEvents.start()
    return () => panelEvents.stop()
  }, [])

  /**
   * 已经摊进 `state` 的那份快照。
   *
   * 为什么记它：面板流每次 `publish` 都会把**同一份** `snapshot.state` 再发一遍（连接状态、进度、
   * 后台同步的状态都在变，而清单没变）。原来这里无脑 `setState(snapshot.state)`，于是动作落地后刚
   * 按响应改过的那几行（见 `patch`）会在下一次 publish 时被旧快照盖回去——实测"取消归档"那一行要等
   * 整库快照回来（约 1.2 秒）才变。只认**换了对象**的那一份：patch 改过之后，旧快照的引用对不上新
   * state，自然不再盖回去；新快照到达时引用变了，照旧覆盖。
   */
  const lastSnapshotState = React.useRef<StateResponse | null>(null)

  // 快照一变就重画；新清单落地之后收掉"刷新中"。
  React.useEffect(() => {
    const read = (snapshot: PanelSnapshot): void => {
      if (snapshot.state !== null && snapshot.state !== lastSnapshotState.current) {
        lastSnapshotState.current = snapshot.state
        setState(snapshot.state)
      }
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

  /**
   * 页头那枚同步状态说哪一句：只报**本地知道**的事（配没配、自动推送开没开、这一趟跑完没有）。
   *
   * "上次同步几点、待拉几条"要跑一趟计划（联网），这一枚不能为了它去联网——那一趟在点开之后的计划
   * 面里看；宿主那侧目前也没记上一次同步的时间，所以这里不编一个出来。
   */
  const syncInfo = (meta ?? state)?.sync ?? null
  /** 「多久以前」那句话：档位由纯函数判（见 logic/relativeTime.ts），这里只把键交给字典。 */
  const ago = (at: string): string => {
    const label = relativeLabel(Date.parse(at), Date.now())
    return label.key === 'time.justNow' ? t('time.justNow') : t(label.key, { count: label.count })
  }
  /**
   * 那枚状态说哪一句，按"手里证据的新鲜程度"排：
   *
   * 1. 这一趟正跑着 / 这一进程里刚跑完 → 说这个（最准）；
   * 2. 否则说磁盘上那条记录（进程重启之后还在）：多久以前、成没成；
   * 3. 再没有就退到配置事实：开了自动推送 / 只说"同步"。
   *
   * "待拉几条"不在这里：那要联网算一份计划，一个页头按钮不该为了它去连远端。
   */
  const syncLabel = ((): string => {
    if (meta === undefined) return t('place.sync')
    if (syncInfo === null) return t('sync.chip.off')
    if (job.running) return t('sync.chip.running')
    if (job.done !== null) return job.done.ok ? t('sync.chip.justNow') : t('sync.chip.failedJustNow')
    const lastRun = syncInfo.lastRun
    if (lastRun !== undefined) {
      return lastRun.ok
        ? t('sync.chip.at', { when: ago(lastRun.at) })
        : t('sync.chip.failedAt', { when: ago(lastRun.at) })
    }
    return syncInfo.autoPush !== undefined ? t('sync.chip.auto') : t('place.sync')
  })()
  /**
   * 状态点：跑着是转圈，失败是红点，其余是空心 idle。
   *
   * 成功不点绿：一条"三天前同步成功"的绿点会被读成"现在刚刚同步过"。成没成由那枚按钮上的字说。
   */
  const syncDot: StateDotState = job.running
    ? 'ongoing'
    : job.done !== null
      ? job.done.ok
        ? 'idle'
        : 'error'
      : syncInfo?.lastRun !== undefined && !syncInfo.lastRun.ok
        ? 'error'
        : 'idle'

  return (
    <section
      className="dsm-root"
      data-plugin="dsh-session-manager"
      /*
        整页都是落点：拖一个 .dshsess 上来，松手就开导入那一面（见 `pageDrop`）。弹窗开着的时候
        遮罩挡在前面，拖到弹窗里的那一层由 ImportPanel 自己接。
      */
      {...(surface === 'none' ? pageDrop.handlers : {})}
      data-drop-over={pageDrop.over && surface === 'none' ? 'true' : undefined}
    >
      {/*
        拖到页面上时的提示：一层不挡事件的虚线框，写的正是"松手会发生什么"。
        它只在这一页同时满足"没有开着别的面 + 正拖着文件"时存在。
      */}
      {pageDrop.over && surface === 'none' && (
        <div className="dsm-dropVeil">
          <span className="dsm-dropVeilPill">{t('import.dropVeil')}</span>
        </div>
      )}
      {/*
        页头是一条**工具条**：标题、同步状态、页面级动作排在同一行。

        为什么不再用「标题一行 + 说明一行」那种设置页的形状：这一页现在从侧栏进来，占的是整块主栏，
        不是设置弹窗里的一格。宽屏上那两行会把列表往下推 60px，而库路径与条数每天都在看、却要占掉
        一行；挪到底部状态栏之后，视线从列表移到底部才看它，正好。

        标题右边那枚是所有入口里**唯一会自己变**的东西：同步配没配、这一趟跑完没有。原来它藏在页签
        里，跑完关掉窗口再回来默认停在「会话」，不点进去就不知道昨晚那趟成没成。它**不看"配没配"**：
        恰恰是没配的时候最需要它（点开那面会说要填什么、去哪儿填）。

        「插件设置」仍在标题这一行：配置挂在**插件页**上（`plugins.bundle.config`，见 PluginConfigCard），
        不在这一页。「刷新」也搬到这里——它重读整页的状态（`/meta` + `/state`），不属于任何一面。
        宿主没装插件管理器时禁用（点了没反应比禁用更糟）。
      */}
      <header className="dsm-head">
        <h2 className="dsm-title">{t('page.title')}</h2>
        <Button
          className="dsm-headChip"
          variant="outline"
          size="sm"
          icon={<StateDot state={syncDot} />}
          title={t('sync.chip.tip')}
          aria-haspopup="dialog"
          aria-expanded={surface === 'sync'}
          onClick={() => setSurface('sync')}
        >
          {syncLabel}
        </Button>
        <span className="dsm-spacer" />
        {/*
          说明是一次性读的参考，不占入口：页头这枚 `?` 把它开成弹窗，关掉就回到列表。
          按钮只有「?」一个字，悬浮提示与无障碍名字走字典。
        */}
        <Button
          className="dsm-headAction"
          variant="outline"
          size="sm"
          aria-label={t('page.help.open')}
          title={t('page.help.open')}
          aria-haspopup="dialog"
          aria-expanded={surface === 'help'}
          onClick={() => setSurface('help')}
        >
          ?
        </Button>
        <Button
          className="dsm-headAction"
          variant="outline"
          size="sm"
          onClick={() => void load()}
          disabled={busy}
        >
          {busy ? t('loading') : t('page.refresh')}
        </Button>
        <Button
          className="dsm-headAction"
          variant="outline"
          size="sm"
          onClick={() => getNavigationApi()?.openPackage()}
          disabled={getNavigationApi() === undefined}
        >
          {t('sync.settings.action')}
        </Button>
      </header>

      {/*
        读库的进度：整库要逐条读 header、折标题（更大或更慢的库上是几秒），这一段原来只有页头那句
        「读取中…」。摆在页头下面、列表上面——它是这一页自己的事，不属于任何一面。
      */}
      {loadProgress !== undefined && <ProgressBlock t={t} progress={loadProgress} />}

      {/*
        后台同步：跑着的时候是进度条（关掉窗口、开别的弹窗都还在），跑完留一行结论直到用户关掉它。
        摆在列表**上面**是因为它不属于任何一面——与「读库的进度」同一个位置、同一条理由。
      */}
      {notice !== undefined && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <Button variant="outline" size="sm" onClick={() => setNotice(undefined)}>
            {t('error.dismiss')}
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
        列表就是这一页：它不再是"四个里选一个"的默认项，而是唯一常驻的那一面。所以这一层不再有
        `role="tabpanel"`，也没有 `aria-controls` 要接——页签没了，那个引用也就没有对象。
      */}
      <ManagePanel
        t={t}
        state={state}
        meta={meta}
        reload={load}
        patch={patch}
        directory={directory}
        picking={picking}
        project={project}
        setProject={setProject}
        openBackup={(dir) => {
          setBackupFocus(dir)
          setSurface('backup')
        }}
      />

      {/*
        同步与备份各是一个宽弹窗（见 WorkDialog.tsx 的说明），导入是一个 640 的窄弹窗（见
        ImportPanel.tsx：它只有两个字段，没有清单要摆）。开哪个由 `surface` 决定；关掉就是卸载，本地
        草稿随之清掉。它们与列表共用同一份 `/state`：同一个库不会出现两套数字。
      */}
      {surface === 'import' && (
        <ImportPanel
          t={t}
          state={state}
          meta={meta}
          reload={load}
          directory={directory}
          defaultTarget={project.path ?? ''}
          initialFile={droppedFile}
          onClose={close}
          onDone={(text) => {
            // 成功就关掉它：写入的条数与字节正是页面顶部那条提示该报的，列表也已经重读过了。
            close()
            setNotice(text)
          }}
        />
      )}
      {surface === 'sync' && (
        <WorkDialog
          t={t}
          title={t('sync.title')}
          // 远端地址属于"在跟谁说话"，放标题下面那一行；没配置时没有可说的，就不带。
          description={syncInfo === null ? undefined : t('sync.where', { url: syncInfo.url })}
          size="narrow"
          onClose={close}
        >
          <SyncPanel
            t={t}
            state={state}
            meta={meta}
            reload={load}
            // 认领来的那趟结论（别处发起的）：那个弹窗自己没有完整结果，由这里把这一句交给它说。
            {...(job.done?.adopted === undefined || jobLine === null ? {} : { backgroundLine: jobLine })}
          />
        </WorkDialog>
      )}
      {surface === 'backup' && (
        <WorkDialog t={t} title={t('backup.title')} onClose={close}>
          <BackupPanel t={t} reload={load} focus={backupFocus} />
        </WorkDialog>
      )}

      {/*
        说明弹窗：四张卡片（分类 / 哪里做什么 / 数据从哪来 / 常见疑问）原样搬进来，换的是外面那层
        卡片壳——弹窗已经是容器，再套四张卡片只会多四圈描边。正文层自己滚（官方 Modal 的正文层
        就是唯一滚动区，见 styles.ts 的 .dsm-dialogContent）。
      */}
      {surface === 'help' && (
        <Modal
          open
          onClose={close}
          title={t('page.help.title')}
          closeLabel={t('close')}
          className="dsm-dialog dsm-helpDialog"
          contentClassName="dsm-dialogContent dsm-helpContent"
        >
          <div className="dsm-helpBody">
            <HelpPanel t={t} state={state} meta={meta} />
          </div>
        </Modal>
      )}
      {/*
        底部状态栏：库在哪、有多少条、备份与回滚在哪儿、这一页是哪个构建。

        这几样原来在页头那行说明与页脚各占一处，现在收进这一行，理由与页头合成工具条是同一个：
        从侧栏进来占的是整块主栏，纵向空间该留给列表。状态栏**不随弹窗开关消失**——"库在哪 / 多少条 /
        有哪些备份"是整页的上下文。版本号的悬浮提示把"发布版还是直接 build 的"说全（判据见
        build.ts 与 scripts/build-identity.ts）；一句话里的数字来自构建期常量，渲染路径上没有任何 IO。
      */}
      <footer className="dsm-statusBar">
        <span className="dsm-statusLib" title={facts?.sessionsRoot ?? ''}>
          {t('page.library')}：{libraryLine}
        </span>
        <span className="dsm-spacer" />
        {/*
          库这一级的两件事：导入（往库里放东西，与勾选无关）与备份回滚（三种写操作共同的后悔面，
          不属于其中任何一件）。它们都不跟着动作走，所以跟"库在哪"这一档信息一起待在状态栏。
        */}
        {/*
          同步那一趟在状态栏里说一句（39px 的单行）：跑着时是「同步中 3/7」，刚跑完是「同步完成 · 2 条」
          或「同步失败」，点一下开同步那一面。字节、正在处理的那条会话、失败原因都在那一面里说。
          为什么不是列表上方那条横幅：进度那一档有 100px 高，压的是列表；而这件事跟列表内容无关，
          位置该跟「导入…」「备份与回滚」排在同一排。弹窗开着时不摆——那一面正显示着更细的进度。
        */}
        {barLabel !== null && surface !== 'sync' && (
          /*
            这枚也用官方 `Button`（outline/sm，与旁边那两枚同款）：本页的控制件一律走官方控件库，
            裸 `<button>` 会带出浏览器自己那套灰边白底。它读起来是"这段的状态"，但点下去是动作（开同步
            那一面），所以形状与邻居一致比"看起来不像按钮"更要紧。
          */
          <Button
            className="dsm-statusAction dsm-statusJob"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            title={jobLine === null ? undefined : jobLine.text}
            onClick={() => setSurface('sync')}
          >
            {'params' in barLabel ? t(barLabel.key, barLabel.params) : t(barLabel.key)}
          </Button>
        )}
        <Button
          className="dsm-statusAction"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={surface === 'import'}
          onClick={() => setSurface('import')}
        >
          {t('import.entry')}
        </Button>
        <Button
          className="dsm-statusAction"
          variant="outline"
          size="sm"
          aria-haspopup="dialog"
          aria-expanded={surface === 'backup'}
          onClick={() => setSurface('backup')}
        >
          {backupCount !== undefined && backupCount > 0 ? t('backup.entry', { count: backupCount }) : t('place.backup')}
        </Button>
        <span className="dsm-statusVersion" title={versionTip}>
          {version}
        </span>
      </footer>
    </section>
  )
}
