/**
 * 「会话」分页：对着整个会话库逐条管理——归档 / 取消归档、重新生成名称、删除，以及**迁移**。
 *
 * 与「传输」页的分工：传输页是"把会话带走 / 带回来"，这一页是"这条会话我不要了 / 先收起来 / 换个
 * 目录"。两页共用同一份 `/state`（页面骨架只拉一次）与同一套列表骨架
 * （[sessionList.tsx](./sessionList.tsx)），所以行、标签、条数、筛选条、选行那一对按钮都不会各说各话。
 *
 * **迁移原先单独占一个分页，现在并进这条动作行**：它的源改成"你勾中的那些会话"之后，那一页剩下的只有
 * 一张与这一页逐字同形的列表 + 底部一枚「迁移」+ 一个弹窗（选目标目录、看预演、确认）。两页各自的
 * 列表、筛选与勾选本来就是同一份实现，合成一页之后"勾几条会话，再决定拿它们做什么"是一条路，而不是
 * 先在两页之间选一页。**勾不动的行只有子智能体**（它们跟着父会话走）：侧边栏不显示的那几类在这一页
 * 照旧能勾（这一页恰恰是用来收拾它们的），迁移那一路因此**只把看得见的那些送进计划**、并在弹窗里说明
 * 少带了哪几条——宿主对点名的隐藏会话一律拒（见 src/plan.ts），那不该变成一次没有出口的报错。
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
 *   - **标题也能在这里重算**（见 [retitleNotes.ts](../logic/retitleNotes.ts) 与宿主侧 `src/retitle.ts`）：
 *     历史会话的标题多半停在"首句前几个词"的兜底名称上，这一枚按钮请宿主的名称服务按整段对话重算一遍
 *     （逐条挂载 → 重算 → 落盘 → 摘掉，见 `src/tools.ts` 的 `titleRefreshPort()`）。跳过与失败分开说：
 *     你自己改过名的那些不动，子智能体的不算。
 *
 * @module dsh-session-manager/client/ManagePanel
 */

import * as React from 'react'

import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  archiveSessions,
  deleteSessions,
  migrate,
  retitleSessions,
  type DeleteResponse,
  type MigrationRequest,
  type MigrationResponse,
  type ProgressEvent,
  type RetitleResponse,
} from '../api.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { DirectoryField, useDirectoryFields } from './DirectoryField.tsx'
import { ProgressBlock } from './ProgressBlock.tsx'
import { TranscriptDialog } from './TranscriptDialog.tsx'
import { groupKey, groupSessions, nestSessions } from '../logic/groups.ts'
import {
  deleteFamilyNote,
  directoryTargetRows,
  migrateFamilyNote,
  parentDirNote,
  type PathRow,
} from '../logic/planRows.ts'
import { describeRetitle, type RetitleNotes } from '../logic/retitleNotes.ts'
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
  formatBytes,
  useGroupCollapse,
  useSessionFilter,
  useSessionPicking,
  type RowSession,
} from './sessionList.tsx'
import type { PanelShare } from '../types.ts'

/** 一次迁移落地之后的结论：复核过没过、备份在哪、要不要重启（原样透出宿主报的三件事）。 */
interface MigrationEffect {
  verified: boolean
  backupDir?: string
  takesEffect: MigrationResponse['takesEffect']
}

/** 「会话」分页（含迁移那一路）。 */
export function ManagePanel({ t, state, meta, reload, directory }: PanelShare): React.ReactElement {
  const sessions = state?.sessions ?? []
  // 归档能力位与清单无关（`/meta` 先给），所以它用 `state ?? meta`：清单还在读时也不会先把
  // "这个宿主没有 workspaceRegistry"画上去。
  const facts = state ?? meta
  const archiveAvailable = facts?.archiveAvailable === true
  const retitleAvailable = facts?.retitleAvailable === true

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
  const [busy, setBusy] = React.useState<'archive' | 'unarchive' | 'apply' | 'retitle' | 'migrate' | null>(null)
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
   * 最近一次「重新生成名称」的结果（`null` = 这次进页面之后还没跑过）。
   *
   * 单独一份状态而不是复用 `failed`：那个动作的结果有三类（改了 / 没变 / 跳过），跳过还要按原因分类
   * 摆出来——"这条你改过名，我没动它"与"这条算的时候报错了"是两件完全不同的事，混在一个横幅里就分不清。
   */
  const [retitle, setRetitle] = React.useState<RetitleResponse | null>(null)
  /** 正在看内容的那条会话（点行上的「内容」时设它，看完关掉）。 */
  const [inspecting, setInspecting] = React.useState<RowSession | null>(null)

  /*
   * ================== 迁移那一路（原先的 MigrationPanel） ==================
   *
   * 这些声明**一律排在前面那些状态之后**：冒烟用例按位置往 null / 空串状态里种值（见 test/client.test.mjs
   * 的 mount），插在中间会让既有的会话页用例整体错一格。顺序：`to` / `title`（两个空串，排在筛选条那个
   * 搜索词之后）→ `fields`（open / manual 两个 null）→ `migratePending` → `effect`。
   */

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
   * 与删除弹窗同一套形状（计划 + 异常合成一个状态）：没有弹窗就没有要看的计划，取消（或落地成功）
   * 之后那份计划也不该留在页面上。
   */
  const [migratePending, setMigratePending] = React.useState<{
    response: MigrationResponse | null
    error: string | null
  } | null>(null)
  /** 上一次迁移落地之后的结论（复核 / 备份 / 生效方式）：弹窗关了之后它还得在页面上留着。 */
  const [effect, setEffect] = React.useState<MigrationEffect | null>(null)

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

  // ------------------------------- 迁移 -------------------------------

  /**
   * 勾中且**搬得走**的那些：侧边栏不显示的那几类宿主明确会拒（判据是 `/state` 的 `hidden`，与宿主
   * `src/visibility.ts` 同一份结论——这一页读它，不是再判一遍）。
   *
   * 这一页的勾选集服务五件事，其中归档 / 删除本来就该收下隐藏的那几类，所以**不能**把它们从勾选里
   * 挡掉；挡在这一层：送进迁移计划的只有看得见的那些，弹窗里再用一句"另有 N 条这次不搬"说清。
   */
  const migratable = React.useMemo(() => {
    const hidden = new Set(sessions.filter((session) => session.hidden !== undefined).map((session) => session.id))
    return picked.filter((id) => !hidden.has(id))
  }, [picked, sessions])

  /**
   * 目标候选：已登记工作区（同一路径只留一条），外加当前值本身。
   *
   * 与「传输」页导入的落地目录共用同一个构造（见 planRows.directoryTargetRows）：两处问的是同一件事。
   */
  const targetRows = React.useMemo<PathRow[]>(
    () => directoryTargetRows(state?.workspaces ?? [], state?.repos, to),
    [state, to],
  )

  /** 请求体：源是勾中且搬得走的那些 id，目标只有一个（预演与落地用同一份参数）。 */
  const request = (mode: 'plan' | 'apply', target: string, artifacts: boolean): MigrationRequest => ({
    mode,
    sessionIds: [...migratable],
    to: target,
    includeArtifacts: artifacts,
    ...(title.trim() === '' ? {} : { title: title.trim() }),
  })

  /** 乱序防护：连点候选时后一次请求可能先回来，只让最新那一次写进弹窗。 */
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
    if (trimmed === '' || migratable.length === 0) {
      setMigratePending({ response: null, error: null })
      return
    }
    setMigratePending((current) => (current === null ? current : { response: null, error: null }))
    setProgress(null)
    void migrate(request('plan', trimmed, artifacts), setProgress).then(
      (response) => {
        if (token === previewToken.current) {
          setMigratePending((current) => (current === null ? current : { response, error: null }))
        }
      },
      (cause) => {
        if (token === previewToken.current) {
          setMigratePending((current) =>
            current === null ? current : { response: null, error: cause instanceof Error ? cause.message : String(cause) },
          )
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
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同删除弹窗）。
   */
  const openMigrate = (): void => {
    if (picked.length === 0) return
    setError(null)
    setNotice(null)
    setEffect(null)
    setProgress(null)
    setMigratePending({ response: null, error: null })
    runPreview(to, includeArtifacts)
  }

  /**
   * 弹窗里按「确认迁移」：真的搬（宿主那边是同一个 `buildRelocationPlan()`，只是这次落盘并复核）。
   *
   * 落地失败但正文里带着完整结果（计划不 ok / 复核没过）时把那份结果摆回弹窗里——用户正看着清单，
   * 新的问题清单就该出现在同一个位置；请求本身没走通（网络、参数被拒）才抛给页面横幅并关掉弹窗。
   */
  const applyMigration = (): void => {
    setBusy('migrate')
    setError(null)
    setProgress(null)
    void migrate(request('apply', to.trim(), includeArtifacts), setProgress).then(
      (response) => {
        setBusy(null)
        setProgress(null)
        if (!response.applied) {
          setMigratePending((current) => (current === null ? current : { ...current, response }))
          return
        }
        setMigratePending(null)
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
        setMigratePending(null)
        setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
      },
    )
  }

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
   * 点「重新生成名称」：把勾选的会话交给宿主的名称服务逐条重算。
   *
   * 与归档那一下的差别在**结果**上：归档只有"改了 / 没改（失败）"两种，而这里可能是"算了 3 条、
   * 跳过 5 条（其中 4 条你自己改过名）"，所以结论、跳过原因与失败清单三样分别摆（见 retitleNotes.ts）。
   *
   * 失败照旧逐条摆出来，不问其余成功的算不算数：一条模型超时不该把另一条刚算好的标题说成没算。
   * 逐条失败的那几条**不清勾选**——用户多半要重试它们。
   */
  const doRetitle = async (): Promise<void> => {
    setBusy('retitle')
    setError(null)
    setNotice(null)
    setFailed([])
    setRetitle(null)
    setProgress(null)
    try {
      const response = await retitleSessions(picked, setProgress)
      setFailed(response.failed)
      setRetitle(response)
      if (response.failed.length === 0) picking.clear()
      // 列表上的标题是这次动作改的，读回来才看得见（`/state` 每次都重折一遍标题）。
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

  /**
   * 这次重算该说的几句话（改了 / 没变 / 为什么跳过那些）。
   *
   * 在渲染期算而不是塞进状态：它是结果的**纯函数**，多存一份只会多一个可能与 `retitle` 不一致的地方。
   */
  const retitleNotes: RetitleNotes = React.useMemo(
    () => (retitle === null ? { skipped: [] } : describeRetitle(retitle, t)),
    [retitle, t],
  )

  // 迁移弹窗正文里那些从计划派生出来的东西（同原先的 MigrationPanel）。
  const preview = migratePending?.response?.preview ?? null
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
    planned &&
    registry !== null &&
    !registry.unchanged &&
    migratePending?.response?.takesEffect === 'restart-required'
  /** 勾中但这次不搬的那几条（侧边栏不显示）：弹窗里要说清，不然"勾了 5 条、只搬 2 条"没有解释。 */
  const hiddenPicked = picked.length - migratable.length
  /**
   * 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时候选面板里不摆「浏览文件系统…」。
   * 它来自 `/meta`（与清单无关、先到），所以清单还在读时那枚按钮也不至于晚一步出现。
   */
  const pickerKind = (state ?? meta)?.pickerKind ?? null

  return (
    <>
      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          {/* 关掉一条横幅：本页不用官方缺省的 ghost（那条口径见「动作行里的动作带边框」那篇笔记）。 */}
          <Button variant="outline" size="sm" onClick={() => setError(null)}>
            {t('error.dismiss')}
          </Button>
        </p>
      )}
      {notice !== null && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <Button variant="outline" size="sm" onClick={() => setNotice(null)}>
            {t('error.dismiss')}
          </Button>
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
      {retitleNotes.notice !== undefined && (
        <p className="dsm-banner dsm-ok">
          <span>{retitleNotes.notice}</span>
          <span className="dsm-spacer" />
          <Button variant="outline" size="sm" onClick={() => setRetitle(null)}>
            {t('error.dismiss')}
          </Button>
        </p>
      )}
      {/* 跳过的那几条单独说：它们不是失败，但用户得知道"我勾了 8 条，为什么只有 3 条换了名字"。 */}
      {retitleNotes.skipped.map((line) => (
        <p key={line} className="dsm-hint">
          {line}
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
        {/* 重新生成名称同理：宿主没有那套名称服务时先说清原因，而不是留一个点不动的按钮。 */}
        {facts !== undefined && !retitleAvailable && <p className="dsm-hint">{t('manage.retitle.unavailable')}</p>}

        {sessions.length > 0 && <SessionFilterBar keys={FILTER_KEYS} filter={filter} t={t} />}
        {groups.length > 0 && <SessionGroupTools collapse={collapse} t={t} />}

        {/* 高度固定：连"一条都没筛出来"（以及库里一条都没有）也画在这个框里，否则那些状态会把
            这一页的高度改回去，外层滚动条又能把整个卡片挪动 15px（见 styles.ts 的 .dsm-listFixed）。 */}
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
                        onInspect={() => setInspecting(row.session)}
                        inspectLabel={t('manage.transcript.open')}
                        inspectTip={t('manage.transcript.openTip')}
                        t={t}
                      />
                    ))}
                </div>
              )
            })
          )}
        </SessionListBox>

        <div className="dsm-controls">
          {/*
            归档 / 取消归档 / 重新生成名称 / 迁移：都是"对勾选的这些做一件事"，走官方 `outline`。
            最后那枚「删除」是破坏性动作，靠 spacer 顶到同一行右端（判据见
            .agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md）。

            这一页**不用官方缺省的 `ghost`**：它是"无边框无底色"，一行动作并排时整行看起来就是一段
            灰字（真实 dev GUI 里量到 `border-width: 0px`，鼠标放上去才认得出来是按钮），旁边内建的
            「打开配置文件」反倒是带边的 `outline`（量到 `border: rgba(0, 0, 0, 0.12) 1px`）。所以凡是
            用官方 `Button` 的地方都给轮廓：主动作 `primary`、其余 `outline`。判据与取舍见
            .agents/notes/implemented/bug-fix/2026-10-16-actions-carry-their-frame.md。
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void doArchive(true)}
            disabled={busy !== null || picked.length === 0 || !archiveAvailable}
          >
            {busy === 'archive' ? t('manage.archive.running') : t('manage.archive.action')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void doArchive(false)}
            disabled={busy !== null || picked.length === 0 || !archiveAvailable}
          >
            {busy === 'unarchive' ? t('manage.archive.running') : t('manage.archive.undo')}
          </Button>
          {/*
            重新生成名称与归档同属"对勾选的这些做一件事"，所以放在同一条动作行上（见 styles.ts 的
            `.dsm-controls`）；破坏性的「删除」仍在 spacer 之后那一头。
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void doRetitle()}
            disabled={busy !== null || picked.length === 0 || !retitleAvailable}
          >
            {busy === 'retitle' ? t('manage.retitle.running') : t('manage.retitle.action')}
          </Button>
          {/*
            「迁移」也在这条动作行上：它与归档 / 改名 / 删除是同一句话——"对勾中的这些做一件事"。
            它开自己的弹窗（目标目录 + 预演 + 确认），所以这里只是一枚按钮。
          */}
          <Button
            variant="outline"
            size="sm"
            onClick={openMigrate}
            disabled={busy !== null || picked.length === 0}
          >
            {t('migrate.action')}
          </Button>
          <span className="dsm-spacer" />
          <Button
            variant="outline"
            size="sm"
            onClick={openDelete}
            disabled={busy !== null || picked.length === 0}
          >
            {t('manage.delete.action')}
          </Button>
        </div>
        {/* 归档 / 取消归档的进度：逐条走宿主能力，勾一整页时这一段是可感知的。 */}
        {(busy === 'archive' || busy === 'unarchive') &&
          (progress === null ? (
            <p className="dsm-hint">{t('progress.waiting')}</p>
          ) : (
            <ProgressBlock t={t} progress={progress} />
          ))}
        {/* 迁移落地之后的结论：弹窗关了，这三件事（复核 / 备份位置 / 生效方式）还得留在页面上。 */}
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
      {/* 迁移弹窗：目标目录 + 计划 + 「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {migratePending !== null && (
        <ConfirmDialog
          t={t}
          // 落地那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t(busy === 'migrate' ? 'migrate.running' : 'migrate.dialogTitle')}
          confirmLabel={t('migrate.apply')}
          busyLabel={t('migrate.running')}
          busy={busy === 'migrate'}
          // 目标为空时不算"预演中"：那时正文是一句"先选目标目录"，不是一句等待。
          planning={!waitingForTarget && migratePending.response === null && migratePending.error === null}
          // 算计划那一段不是空等（要扫整库认族、算注册表变更），所以有事件就把那句静态的「预演中…」
          // 换成进度。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={migratePending.error}
          disabled={!planned || waitingForTarget}
          onConfirm={applyMigration}
          onCancel={() => setMigratePending(null)}
        >
          {/* 落地：正文换成进度，那份计划表说的是"将要"，这时候已经过期了。 */}
          {busy === 'migrate' &&
            (progress === null ? (
              <p className="dsm-hint">{t('progress.waiting')}</p>
            ) : (
              <ProgressBlock t={t} progress={progress} note={t('migrate.progress.note')} />
            ))}
          {busy !== 'migrate' && (
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
                <Input
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
                {/*
                  这个开关直接改变计划里的条数（带上产物 vs 只带会话），所以跟着重新预演。
                  走官方 `Checkbox`：`label` 就是原来那个 `<span>` 里的文案，勾选框与文案一起构成
                  可见 label（原先的 `<label className="dsm-check">` 那层由官方原语自己长出来）。
                */}
                <Checkbox
                  checked={includeArtifacts}
                  label={t('migrate.includeArtifacts')}
                  onChange={(next) => {
                    setIncludeArtifacts(next)
                    runPreview(to, next)
                  }}
                />
              </div>

              {waitingForTarget && <p className="dsm-hint">{t('migrate.needTarget')}</p>}

              {/*
                勾中的那几条里有一部分搬不走（侧边栏不显示）：它们不进这份计划——宿主对点名的隐藏会话
                一律拒（见 src/plan.ts），而"我勾了它、你没动它"必须能分辨，所以在这里点名条数。
              */}
              {hiddenPicked > 0 && <p className="dsm-hint">{t('migrate.hiddenSkipped', { count: hiddenPicked })}</p>}

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
      {inspecting !== null && (
        <TranscriptDialog
          session={{ id: inspecting.id, ...(inspecting.title === undefined ? {} : { title: inspecting.title }) }}
          onClose={() => setInspecting(null)}
          t={t}
        />
      )}
    </>
  )
}
