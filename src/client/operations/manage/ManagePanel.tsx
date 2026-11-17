/**
 * 会话列表：这一页唯一常驻的那一面，对着整个会话库逐条管理——归档 / 取消归档、重新生成名称、
 * 删除，以及**迁移**（导出 / 导入在同一行上打开一个弹窗，见 TransferPanel）。
 *
 * 与「传输」页的分工：传输页是"把会话带走 / 带回来"，这一页是"这条会话我不要了 / 先收起来 / 换个
 * 目录"。两页共用同一份 `/state`（页面外壳只拉一次）与同一套列表外壳
 * （[sessionList.tsx](../../shared/ui/sessionList.tsx)），所以行、标签、条数、筛选条、选行那一对按钮都不会各说各话。
 *
 * **迁移原先单独占一个分页，现在并进这条动作行**：它的源改成"你勾中的那些会话"之后，那一页剩下的只有
 * 一张与这一页逐字同形的列表 + 底部一枚「迁移」+ 一个弹窗（选目标目录、看预览、确认）。两页各自的
 * 列表、筛选与勾选本来就是同一份实现，合成一页之后"勾几条会话，再决定拿它们做什么"是一条路，而不是
 * 先在两页之间选一页。**勾不动的行只有子智能体**（它们跟着父会话走）：侧边栏不显示的那几类在这一页
 * 照旧能勾（这一页恰恰是用来收拾它们的），迁移那一路因此**只把看得见的那些送进计划**、并在弹窗里说明
 * 少带了哪几条——宿主对点名的隐藏会话一律拒（见 src/operations/migrate/plan.ts），那不该变成一次没有出口的报错。
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
 *     确认才写入磁盘（见 [ConfirmDialog.tsx](../../shared/ui/ConfirmDialog.tsx)）；执行时**先备份再删**（见 src/operations/remove/remove.ts），
 *     恢复走「迁移」页的「备份与回滚」；
 *   - **归档走宿主能力**（`workspaceRegistry`），一次写入磁盘 + 改内存 + 广播，侧边栏即时跟着变；宿主
 *     没有这个能力时按钮禁用并说明原因，而不是绕过宿主去写注册表文件。
 *   - **标题也能在这里重算**（见 [retitleNotes.ts](../retitle/retitleNotes.ts) 与宿主侧 `src/operations/retitle/retitle.ts`）：
 *     历史会话的标题多半停在"首句前几个词"的兜底名称上，这一枚按钮请宿主的名称服务按整段对话重算一遍
 *     （逐条挂载 → 重算 → 写入磁盘 → 摘掉，见 `src/tools.ts` 的 `titleRefreshPort()`）。跳过与失败分开说：
 *     你自己改过名的那些不动，子智能体的不算。
 *
 * @module dsh-session-manager/client/operations/manage/ManagePanel
 */

import * as React from 'react'

import { Button, Checkbox, Input } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  archiveSessions,
  deleteSessions,
  download,
  exportSessions,
  migrate,
  retitleSessions,
  type DeleteResponse,
  type MigrationRequest,
  type MigrationResponse,
  type ProgressEvent,
  type RetitleResponse,
} from '../../api.ts'
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.tsx'
import { ProblemsBlock } from '../../shared/ui/ProblemsBlock.tsx'
import { DirectoryField, useDirectoryFields } from '../../shared/ui/DirectoryField.tsx'
import { ProgressBlock } from '../../shared/ui/ProgressBlock.tsx'
import { SessionInspector } from './SessionInspector.tsx'
import { Hint } from '../../shared/ui/Hint.tsx'
import { SessionTree } from './SessionTree.tsx'
import { TranscriptDialog } from '../transcript/TranscriptDialog.tsx'
import { groupSessions } from '../../shared/logic/groups.ts'
import {
  deleteFamilyNote,
  directoryTargetRows,
  migrateFamilyNote,
  parentDirNote,
  projectLabel,
  sessionLabel,
  type PathRow,
} from '../../shared/logic/planRows.ts'
import {
  defaultDir,
  foldSubagents,
  groupPickState,
  sessionsInProject,
  sortSessions,
  type GroupPickState,
  type SessionSortKey,
} from './manageRows.ts'
import { describeRetitle, type RetitleNotes } from '../retitle/retitleNotes.ts'
import { dismissRun, startRun } from './runJob.ts'
import {
  SessionListBox,
  SessionListEmpty,
  SessionPickTools,
  SessionRow,
  SessionSearch,
  SessionStaticRow,
  formatBytes,
  totalBytes,
  useSessionFilter,
  useSessionPicking,
  type RowSession,
} from '../../shared/ui/sessionList.tsx'
import { remoteLibrary, type RemoteLibraryState } from '../sync/remoteLibrary.ts'
import { patchArchived, patchMoved, patchRemoved, patchTitles } from './statePatch.ts'
import type { PanelShare } from '../../types.ts'

/** 一次迁移应用之后的结论：复核过没过、备份在哪、要不要重启（原样透出宿主报的三件事）。 */
interface MigrationEffect {
  verified: boolean
  backupDir?: string
  takesEffect: MigrationResponse['takesEffect']
}

/** 会话列表（含迁移那一路）。 */
export function ManagePanel({
  t,
  state,
  meta,
  reload,
  patch,
  directory,
  picking,
  project,
  setProject,
  openBackup,
  /**
   * 从别处"定位"过来的那条会话（同步弹窗里那几枚「只看这一条」交给页面外壳，外壳再交下来）。
   *
   * 它一变就把筛选条重置成"只看这一条"：筛选标签清空、搜索框填上这个 id。用 id 而不是标题——标题可能重名，
   * 而搜索框本来就按"名称或 ID"匹配（见 `list.filter.search`）。
   */
  focusId,
}: PanelShare & { focusId?: string | undefined }): React.ReactElement {
  const sessions = state?.sessions ?? []
  // 归档能力位与清单无关（`/meta` 先给），所以它用 `state ?? meta`：清单还在读时也不会先把
  // "这个宿主没有 workspaceRegistry"画上去。
  const facts = state ?? meta
  const archiveAvailable = facts?.archiveAvailable === true
  const retitleAvailable = facts?.retitleAvailable === true
  /**
   * 删除时要不要**连远端一起删**（配了同步时默认勾上，见 `openDelete`）。
   *
   * 为什么默认勾：只删本机的话，下一次同步会把这条会话当"远端有、本机没有"重新拉回来——那正是这个
   * 选项存在的原因（见 `src/operations/sync/sync.ts` 的 `tombstonesOf()`）。
   */
  const [deleteRemote, setDeleteRemote] = React.useState(true)
  /** 这个宿主配没配 WebDAV 同步：没配就不摆那枚勾选框（没有远端可删）。 */
  const syncConfigured = facts?.sync !== null && facts?.sync !== undefined

  /**
   * 远端各机器格子里有什么（右栏那一行「远端」查它）。
   *
   * **一次刷新读一次**：这份清单换了对象（`state` 的身份变了）就去读一次远端，读到的那份留在
   * `remoteLibrary` 里（模块级，切页签不丢），右栏翻来翻去只是查表。为什么不等右栏关掉了再省着读：
   * 用户点哪一条会话不可预测，按选中现问会让每次点选都等一次 NAS（见 `logic/remoteLibrary.ts`）。
   */
  const [remote, setRemote] = React.useState<RemoteLibraryState>(() => remoteLibrary.snapshot())
  React.useEffect(() => remoteLibrary.subscribe(setRemote), [])
  React.useEffect(() => {
    // 清单还没到（`null`）时不读：页面刚打开那一下会先渲染一次，那一次读出来的位置也没人看。
    if (state === null) return
    void remoteLibrary.load()
  }, [state])

  /**
   * 勾选：行勾选、整组勾选、全选、清空，以及"这一行为什么不能单独勾"。
   *
   * 整份逻辑在 [sessionList.tsx](../../shared/ui/sessionList.tsx) 里，与「传输」页共用一份（那一页原先自己写了一遍
   * 逐字同形的 `toggle` / `toggleGroup` / `lockOf`）。判据见那里的 `useSessionPicking()`：
   * 能勾的集合就是"单独操作不会被拒的集合"（子智能体跟着父会话走）。
   */
  const picked = picking.picked
  /** 筛选条：一枚筛选标签都不勾、关键词为空 = 全都列出来（见 sessionFilter.matchesFilters）。 */
  const filter = useSessionFilter(sessions)
  /*
    别处点「只看这一条」之后落到这里：先把筛选标签清空（否则它可能被"空白""已归档"那些挡在外面），再把
    搜索词换成这个 id。依赖只看 `focusId`——`filter` 每次渲染都是新对象，带上它会让这段每次渲染都跑。
  */
  React.useEffect(() => {
    if (focusId === undefined || focusId === '') return
    filter.clear()
    filter.setQuery(focusId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])
  /**
   * 页面上那几件"按下去就做完"的事情（归档、导出）进行中的那一件。
   *
   * 删除 / 迁移 / 重算名称不在这份状态里：它们确认之后会交给状态窗（`logic/runJob.ts`），自己那扇窗
   * 报进度、报结果，不必让本页再记一份。
   */
  const [busy, setBusy] = React.useState<'archive' | 'unarchive' | 'export' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  /**
   * 删除弹窗：`null` = 没开；开了之后先是一份空壳（计划还在算），算完填进去。
   *
   * 计划与"弹窗开没开"合成一个状态，是因为它俩本来就是一回事：没有弹窗就没有要看的计划，取消
   * （或应用成功）之后那份计划也不该留在页面上——它说的是按下去那一刻的库，留着只会让人以为它还算数。
   */
  const [pending, setPending] = React.useState<{ plan: DeleteResponse | null; error: string | null } | null>(null)
  const [failed, setFailed] = React.useState<Array<{ id: string; error: string }>>([])
  /**
   * 最近收到的那条进度事件（归档与删除共用一份：两者不会同时进行，`busy` 就分得开）。
   *
   * 删除那两段是"扫整库"与"先备份再删"，归档那段是逐条走宿主的注册表动作——都是按下之后要等的活。
   *
   * 声明排在**最后**（不跟 `busy` 挤在一起）：冒烟用例按位置往 null 状态里初始值（见 test/client.test.mjs
   * 的 `nulls`），插在中间会让后面那些种子的位置整体错一格。
   */
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null)
  /**
   * 最近一次「重新生成名称」的结果（`null` = 这次进页面之后还没跑过）。
   *
   * 单独一份状态而不是复用 `failed`：那个动作的结果有三类（改了 / 没变 / 跳过），跳过还要按原因分类
   * 摆出来——"这条你改过名，我没动它"与"这条算的时候报错了"是两件完全不同的事，混在一个横幅里就分不清。
   */
  /** 正在看内容的那条会话（点行上的「内容」时设它，看完关掉）。 */
  const [inspecting, setInspecting] = React.useState<RowSession | null>(null)

  /*
   * ================== 迁移那一路（原先的 MigrationPanel） ==================
   *
   * 这些声明**一律排在前面那些状态之后**：冒烟用例按位置往 null / 空串状态里初始值（见 test/client.test.mjs
   * 的 mount），插在中间会让既有的会话页用例整体错一格。顺序：`to` / `title`（两个空串，排在筛选条那个
   * 搜索词之后）→ `fields`（open / manual 两个 null）→ `migratePending` → `effect`。
   */

  /** 目标目录。它跨弹窗留着：连着迁两批时第二次打开弹窗就有一份预览在等着。 */
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
   * 与删除弹窗同一套形状（计划 + 异常合成一个状态）：没有弹窗就没有要看的计划，取消（或应用成功）
   * 之后那份计划也不该留在页面上。
   */
  const [migratePending, setMigratePending] = React.useState<{
    response: MigrationResponse | null
    error: string | null
  } | null>(null)
  /** 上一次迁移应用之后的结论（复核 / 备份 / 生效方式）：弹窗关了之后它还得在页面上留着。 */
  /**
   * 刚做完的那件事留下了哪个备份目录（删除 / 迁移各一份），以及要不要在提示里给「撤销」。
   *
   * 声明在**最后一个 null 状态**的位置上：冒烟测试的示例数据按调用顺序把种子发给 null 状态（见
   * test/client.test.mjs 的 `nulls`），插在中间会让后面那些整体错一格。
   */

  /**
   * 换一条提示，并决定它带不带「撤销」。
   *
   * 任何一条新提示都先把上一枚撤销清掉：一份备份只能撤刚做的那一件事，提示换了还留着旧的那枚，
   * 点下去会把用户带到一件早已过期的动作上。
   */
  /**
   * 页面上那一条提示（只给"按下去就做完"的动作：归档、导出）。
   *
   * 删除 / 迁移 / 导入 / 恢复 / 整理远端 / 重算名称的结论不在这里：它们走状态窗（`logic/runJob.ts`），
   * 结果与「撤销」都在那扇窗里，按「完成」收掉。
   */
  const notify = (text: string | null): void => {
    setNotice(text)
  }
  /**
   * 只看某一个项目（`null` = 全部）。
   *
   * 平铺之后没有组头了，「整组处理」这件事改成"先按项目筛，再全选"：选中一个项目，清单就只剩它，
   * 卡头那对「全选 / 清空」的作用面跟着变成这一批。取一个对象而不是一个字符串，是因为冒烟用例按
   * 位置往空串状态里初始值（见 test/client.test.mjs 的 mount），多一个字符串会让后面那些种子整体错一格。
   */
  // 「项目」这一格由页面外壳持有（导入要拿它当目标目录的初值，见 ManagerPanel 的说明），这里只读写它。
  const projectPath = project?.path ?? null
  /**
   * 表头那一列的排序：点一下换列，再点一下换方向。
   *
   * 同样用对象状态：它不该占掉字符串种子的位置。默认按时间从新到旧——这一页最常见的问法是
   * "我最近那条在哪"。
   */
  const [sort, setSort] = React.useState<{ key: SessionSortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' })
  /**
   * 窄屏（页面可用宽 ≤960px）下项目树是否展开成浮动面板。
   *
   * 宽屏上这一栏一直摆着，这个值不起作用；CSS 只在容器查询那一档读 `.dsm-treeOpen`。
   */
  const [treeOpen, setTreeOpen] = React.useState(false)
  /**
   * 展开了子智能体的那几条父会话（默认全收）。
   *
   * 只记 id：整库更新之后父行可能已经不在，多留一个 id 没有后果。
   */
  const [expandedIds, setExpandedIds] = React.useState<string[]>([])
  /**
   * 右栏正开着的那一条会话。
   *
   * 只记 id、不记整条会话：整库更新（归档 / 改名 / 删除 / 同步）之后，右栏要从**新清单**里重新取，
   * 否则它会一直摆着旧标题与旧标签。对象包着 id 与项目状态同一个理由：别占掉假 React 的字符串种子。
   */
  const [detail, setDetail] = React.useState<{ id: string | null }>({ id: null })

  /**
   * 全库按目录分一次组：项目下拉的选项、每一行「项目」那一格都从它来。
   *
   * 这里**不再按筛选裁组**（平铺之后组头没了），裁的是下面 `listed` 那一份；选项上的条数因此是
   * 整个项目的条数，不是"筛完剩几条"——会跳的计数没人信得过。
   */
  const projectGroups = React.useMemo(
    () => groupSessions(sessions, state?.workspaces ?? []),
    [sessions, state],
  )
  /**
   * 每个项目右端那个条数：数的是**顶层会话**（子智能体折在父会话下面，不进去）。
   *
   * 与清单里看到的一致：点进这个项目，列出来的就是这么多行。父在别的项目、或父不在这份清单里的
   * 子智能体自己当顶层，照旧算一条——否则点了项目却一条都数不出来。
   */
  const projectRowCounts = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const group of projectGroups) counts.set(group.path, foldSubagents(group.sessions).roots.length)
    return counts
  }, [projectGroups])
  const projectOptions = React.useMemo(
    () =>
      projectGroups.map((group) => {
        const label = projectLabel(
          { path: group.path, title: group.title, repo: state?.repos?.[group.path] },
          t,
        )
        return {
          path: group.path,
          name: label.name,
          count: projectRowCounts.get(group.path) ?? group.sessions.length,
          tip: label.tip,
        }
      }),
    [projectGroups, projectRowCounts, state, t],
  )
  /** 一行属于哪个项目：组头的称呼规则（项目身份优先、没有身份用标题、再没有用路径）。 */
  const projectNameOf = React.useCallback(
    (session: RowSession): string => {
      const key = session.cwd ?? ''
      const hit = projectGroups.find((group) => group.path === key)
      if (hit === undefined) return key === '' ? t('list.noCwdGroup') : key
      return projectLabel(
        { path: hit.path, title: hit.title, repo: state?.repos?.[hit.path] },
        t,
      ).name
    },
    [projectGroups, state, t],
  )
  /** 当前列出来的那些：项目与筛选都过一遍，再按表头那一列排（两件事都是纯函数，见 manageRows.ts）。 */
  const listed = React.useMemo(
    () => sortSessions(sessionsInProject(sessions, projectPath).filter(filter.matches), sort),
    [sessions, projectPath, filter.matches, sort],
  )
  /**
   * 子智能体的父会话在**别的项目**里时的那枚备注（原先写在组内缩进那一行上）。
   *
   * 平铺之后没有父子缩进了，这条信息不能一起丢掉：删 / 迁子会话会连带父会话，父不在眼前时得说一声。
   */
  const parentElsewhereOf = React.useCallback(
    (session: RowSession): { text: string; tip: string } | undefined => {
      if (session.origin !== 'subagent' || session.parentSession === undefined) return undefined
      const parent = sessions.find((item) => item.id === session.parentSession)
      if (parent === undefined || (parent.cwd ?? '') === (session.cwd ?? '')) return undefined
      return parentDirNote({ parentPath: parent.cwd }, t)
    },
    [sessions, t],
  )
  /**
   * 子智能体折到父会话下面：列表里只留顶层那一份，子行按需展开（见 `foldSubagents`）。
   *
   * 计数也按这一份走——「显示 X / Y 条」说的是"顶层会话"，子智能体单独报一条数（它们是跟着父会话
   * 走的东西，不该撑大总数）。
   */
  const folded = React.useMemo(() => foldSubagents(listed), [listed])
  /** 这一页手里的行类型（筛、排、折都从 `listed` 的元素类型来，不另写一份）。 */
  type SessionRowItem = (typeof listed)[number]
  /**
   * 会话库里顶层会话的条数（子智能体折在父会话下面，不进去）：`显示 X / Y` 的那个 Y，也是左栏
   * 「全部项目」右端那个数。与某一行的计数同一套判据——两处数出来的必须一样。
   */
  const topLevelTotal = React.useMemo(() => foldSubagents(sessions).roots.length, [sessions])
  /** 眼下这一份全是子智能体（筛「子智能体」时就是这样）：那时不该拿顶层总数当分母。 */
  const onlySubagents = listed.length > 0 && folded.roots.every((session) => session.origin === 'subagent')
  /** 展开／收起一条父会话下面的子智能体。 */
  const toggleExpanded = (id: string): void =>
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  /** 眼下列出来的那些里能单独勾的（「全选」的作用面与禁用判据）。 */
  const pickable = picking.selectableOf(folded.roots)
  /**
   * 把顶层行画出来，展开的那几条下面接上它们的子智能体（再往下递归：子智能体也可能有自己的子）。
   *
   * @param rows 这一层要画的行。
   * @param depth 缩进级数：0 是顶层，子行 +1（样式按级数给左边距）。
   */
  const renderRows = (rows: readonly SessionRowItem[], depth: number): React.ReactNode[] =>
    rows.flatMap((session) => {
      const children = folded.childrenOf.get(session.id) ?? []
      const open = children.length > 0 && expandedIds.includes(session.id)
      const rendered: React.ReactNode[] = [
        <SessionRow
          key={session.id}
          session={session}
          variant="manage"
          checked={picked.includes(session.id)}
          onToggle={() => picking.toggle(session)}
          owner={projectNameOf(session)}
          note={parentElsewhereOf(session)}
          locked={picking.lockOf(session)}
          depth={depth}
          {...(children.length === 0
            ? {}
            : {
                disclosure: {
                  expanded: open,
                  count: children.length,
                  label: t(open ? 'list.collapseSubagents' : 'list.expandSubagents', { count: children.length }),
                  onToggle: () => toggleExpanded(session.id),
                },
              })}
          onOpenDetail={() => setDetail({ id: session.id })}
          opened={detail.id === session.id}
          t={t}
        />,
      ]
      if (open) rendered.push(...renderRows(children, depth + 1))
      return rendered
    })
  /**
   * 项目树上某个项目的勾选状态：只看"筛出来的、而且能单独勾的"那些，与卡头「全选」同一个作用面。
   *
   * 勾了一部分时给 indeterminate（横杠），而不是一律画成没勾：否则"我勾了两条，这一组看起来像没动过"。
   */
  const treePickState = (path: string): GroupPickState =>
    groupPickState(
      listed.filter((session) => (session.cwd ?? '') === path),
      picked,
      (session) => picking.lockOf(session) === undefined,
    )
  /** 项目行上的勾选框：整组勾选／取消，作用面同上（筛出来的那些）。 */
  const toggleProject = (path: string): void => {
    picking.toggleGroup(listed.filter((session) => (session.cwd ?? '') === path))
  }

  /**
   * 右栏那一条：按 id 从**整库**里取，不按 `listed` 取——换了项目或筛选之后，右栏不该自己关掉；
   * 会话被删掉时它自然变成 `null`，右栏回到提示。
   */
  const inspected = detail.id === null ? null : sessions.find((session) => session.id === detail.id) ?? null
  const inspectedProject = inspected === null ? '' : projectNameOf(inspected)
  const inspectedParent =
    inspected?.parentSession === undefined
      ? undefined
      : sessions.find((session) => session.id === inspected.parentSession)
  const inspectedParentTitle = inspectedParent === undefined ? undefined : sessionLabel(inspectedParent).text
  const inspectedLock = inspected === null ? undefined : picking.lockOf(inspected)
  /** 表头点一下：换列时给这一列一个顺手的默认方向，同一列再点就翻方向。 */
  const toggleSort = (key: SessionSortKey): void => {
    setSort((current) =>
      current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) },
    )
  }

  // ------------------------------- 迁移 -------------------------------

  /**
   * 勾中且**搬得走**的那些：侧边栏不显示的那几类宿主明确会拒（判据是 `/state` 的 `hidden`，与宿主
   * `src/shared/visibility.ts` 同一份结论——这一页读它，不是再判一遍）。
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
   * 与「传输」页导入的目标目录共用同一个构造（见 planRows.directoryTargetRows）：两处问的是同一件事。
   */
  const targetRows = React.useMemo<PathRow[]>(
    () => directoryTargetRows(state?.workspaces ?? [], state?.repos, to),
    [state, to],
  )

  /** 请求体：源是勾中且搬得走的那些 id，目标只有一个（预览与应用用同一份参数）。 */
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
   * 取一份预览（只读，不写入磁盘）。
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
   * 点「迁移」：开弹窗，同时把只读的迁移计划取回来（`mode: 'plan'`，不写入磁盘）。
   *
   * 参数不齐时不开口：没勾会话时按钮本来就是禁用的；目标为空时弹窗里那句提示会告诉用户下一步该做什么，
   * 空弹窗也比一句"还没到能算计划的地步"合适——目标就在这个弹窗里选。
   *
   * 计划回来时弹窗可能已经被取消掉了：`current === null` 时原地作废（同删除弹窗）。
   */
  /**
   * 导出：把勾中的那些打成 `.dshsess`，交给浏览器下载。
   *
   * 为什么这一枚不问一句：它只把已有字节打成包，不改本机任何东西（写作的那一面是导入，它要看清计划）。
   * 包里的条数、字节与附件对象以**宿主回报的**为准：勾一条父会话时它的子智能体跟着进包，比勾选数多；
   * 附件对象也照实报——缺的那几个不会凭空出现，用户得在导出这一侧就知道，而不是到另一台机器上看到
   * "图片加载失败"。
   */
  const doExport = async (): Promise<void> => {
    if (picked.length === 0) return
    setBusy('export')
    setError(null)
    notify(null)
    try {
      const result = await exportSessions(picked)
      download(result)
      const chosen = sessions.filter((session) => picked.includes(session.id))
      notify(
        [
          t('export.done', {
            count: result.count ?? chosen.length,
            bytes: formatBytes(result.bytes ?? totalBytes(chosen)),
          }),
          (result.attachments ?? 0) > 0
            ? t('export.attachments', {
                attachments: result.attachments ?? 0,
                bytes: formatBytes(result.attachmentBytes ?? 0),
              })
            : null,
          (result.attachmentsMissing ?? 0) > 0
            ? t('export.attachmentsMissing', { count: result.attachmentsMissing ?? 0 })
            : null,
        ]
          .filter((line): line is string => line !== null)
          .join(' '),
      )
    } catch (cause) {
      setError(t('error.failed', { reason: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const openMigrate = (): void => {
    if (picked.length === 0) return
    setError(null)
    notify(null)
    setProgress(null)
    setMigratePending({ response: null, error: null })
    runPreview(to, includeArtifacts)
  }

  /**
   * 弹窗里按「确认迁移」：真的搬（宿主那边是同一个 `buildRelocationPlan()`，只是这次写入磁盘并复核）。
   *
   * 写入失败但正文里带着完整结果（计划不 ok / 复核没过）时把那份结果摆回弹窗里——用户正看着清单，
   * 新的问题清单就该出现在同一个位置；请求本身没走通（网络、参数被拒）才抛给页面横幅并关掉弹窗。
   */
  const applyMigration = (): void => {
    const target = to.trim()
    const withArtifacts = includeArtifacts
    const body = request('apply', target, withArtifacts)
    // 确认到此为止：接下来是状态窗（进度 → 结果 → 「完成」）。
    setMigratePending(null)
    setError(null)
    setProgress(null)
    startRun(
      'migrate',
      (report) => migrate(body, report),
      (done) => {
        if (!done.ok) return <p className="dsm-error">{t('run.error', { reason: done.error ?? '' })}</p>
        const response = done.result as MigrationResponse
        return (
          <div className="dsm-planBody">
            <div className={response.applied && response.verified ? 'dsm-ok' : 'dsm-warn'}>{response.summary}</div>
            <ProblemsBlock t={t} problems={response.problems} />
            {/*
              需要重启才被宿主承认时，这一句跟着结果一起说（原来它单独挂在页面上）。宿主自己接住的
              情况这里一个字都不说——"无需重启"在那时只是噪音。
            */}
            {response.applied && response.takesEffect === 'restart-required' && (
              <p className="dsm-warn">{t('effect.restart')}</p>
            )}
            {response.applied && response.backupDir !== undefined && openBackup !== undefined && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const dir = response.backupDir
                    if (dir === undefined) return
                    dismissRun()
                    openBackup(dir)
                  }}
                >
                  {t('undo.action')}
                </Button>
              </div>
            )}
          </div>
        )
      },
      {
        onChange: (done) => {
          if (!done.ok) return
          const response = done.result as MigrationResponse
          if (!response.applied) return
          // 搬走的那几条先在清单里换到目标目录（分组跟着换），整库快照随后到。
          patch?.((current) =>
            patchMoved(
              current,
              response.preview.sessions.map((session) => ({ id: session.id, dir: session.targetDir })),
              response.preview.to,
            ),
          )
          void reload()
        },
      },
    )
  }

  const doArchive = async (archived: boolean, ids: readonly string[] = picked): Promise<void> => {
    setBusy(archived ? 'archive' : 'unarchive')
    setError(null)
    notify(null)
    setFailed([])
    setProgress(null)
    try {
      const response = await archiveSessions(ids, archived, setProgress)
      // 逐条失败照旧摆出来：一条因为"正在跑"被宿主拒了，不该把其余成功的说成失败。
      setFailed(response.failed)
      if (response.archived.length > 0) {
        notify(t(archived ? 'manage.archive.done' : 'manage.archive.undone', { count: response.archived.length }))
        // 先改这几行（含级联带上的子智能体），整库快照随后在后台取回来覆盖它。
        patch?.((current) => patchArchived(current, response.archived, archived))
      }
      // 从右栏归档**单条**时不清勾选：手上那批勾选与这一条是两件事。
      if (response.failed.length === 0 && ids === picked) picking.clear()
      void reload()
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
  const doRetitle = (): void => {
    const ids = [...picked]
    setError(null)
    setFailed([])
    setProgress(null)
    startRun(
      'retitle',
      (report) => retitleSessions(ids, report),
      (done) => {
        if (!done.ok) return <p className="dsm-error">{t('run.error', { reason: done.error ?? '' })}</p>
        const response = done.result as RetitleResponse
        const notes = describeRetitle(response, t)
        return (
          <div className="dsm-planBody">
            {notes.notice === undefined ? null : <div className="dsm-ok">{notes.notice}</div>}
            {notes.skipped.map((line) => (
              <div key={line} className="dsm-hint">
                {line}
              </div>
            ))}
            <ProblemsBlock
              t={t}
              problems={response.failed.map((item) => `${item.id}：${item.error}`)}
            />
          </div>
        )
      },
      {
        onChange: (done) => {
          if (!done.ok) return
          const response = done.result as RetitleResponse
          setFailed(response.failed)
          if (response.failed.length === 0) picking.clear()
          // 列表上的标题是这次动作改的：先按结果改这几行，整库快照随后在后台取回来（`/state` 每次重折标题）。
          patch?.((current) => patchTitles(current, response.retitled))
          void reload()
        },
      },
    )
  }

  /**
   * 点「删除所选」：开弹窗，同时把只读的删除计划取回来。
   *
   * 计划是**只读**的一次计算（`mode: 'plan'` 不写入磁盘，见 src/operations/remove/remove.ts），所以这一步可以放心地替用户
   * 做掉——他还没承诺任何事。取回来之前弹窗里只有一行"正在预览…"，应用按钮是禁用的。
   *
   * 计划回来时弹窗可能已经被取消掉了（用户在这几百毫秒里按了 Escape）：`current === null` 时原地
   * 作废，不然一个已经被关掉的弹窗会被打印出来的计划**重新打开**。
   */
  const openDelete = (): void => {
    if (picked.length === 0) return
    setError(null)
    notify(null)
    setFailed([])
    setPending({ plan: null, error: null })
    setProgress(null)
    // 每次打开都回到"一起删"：这是绝大多数人的意图（只删本机等于下次同步又拉回来）。
    setDeleteRemote(true)
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
   * 弹窗里按「确认删除」：真删（先备份再删，见 src/operations/remove/remove.ts）。
   *
   * 失败有两种，各归各的地方：
   *   - **计划本身不 ok / 复核没过**：正文里带着完整结果，把它摆回弹窗里（问题清单当场更新），用户
   *     看着新的问题清单决定下一步；
   *   - **请求本身没走通**（网络、HTTP 参数）：抛给页面顶部的错误横幅，弹窗关掉——那种错留在一个
   *     只剩下"取消"的弹窗里没有意义。
   */
  const applyDelete = (): void => {
    const ids = [...picked]
    const remote = deleteRemote
    // 确认到此为止：接下来是状态窗（进度 → 结果 → 「完成」），不再让确认弹窗兼做进度窗。
    setPending(null)
    setError(null)
    setProgress(null)
    startRun(
      'delete',
      (report) => deleteSessions(ids, 'apply', report, remote),
      (done) => {
        if (!done.ok) return <p className="dsm-error">{t('run.error', { reason: done.error ?? '' })}</p>
        const result = done.result as DeleteResponse
        return (
          <div className="dsm-planBody">
            {/* 结论那句由宿主给（"已删除 1 条会话。"）；失败它会说"复核没通过"。 */}
            <div className={result.verified ? 'dsm-ok' : 'dsm-warn'}>{result.summary}</div>
            <ProblemsBlock t={t} problems={result.problems} />
            {result.backupDir !== undefined && openBackup !== undefined && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const dir = result.backupDir
                    if (dir === undefined) return
                    // 先收起结果页，再打开那份备份的回滚确认：两扇窗口不该叠在一起。
                    dismissRun()
                    openBackup(dir)
                  }}
                >
                  {t('undo.action')}
                </Button>
              </div>
            )}
          </div>
        )
      },
      {
        onChange: (done) => {
          if (!done.ok) return
          const result = done.result as DeleteResponse
          if (!result.applied) return
          picking.clear()
          // 删掉的那些（含级联）先从清单里摘掉，不必等整库重扫；快照随后到，以快照为准。
          patch?.((current) => patchRemoved(current, result.preview.entries.map((entry) => entry.id)))
          void reload()
        },
      },
    )
  }

  /**
   * 这次重算该说的几句话（改了 / 没变 / 为什么跳过那些）。
   *
   * 在渲染期算而不是塞进状态：它是结果的**纯函数**，多存一份只会多一个可能与 `retitle` 不一致的地方。
   */

  // 迁移弹窗正文里那些从计划派生出来的东西（同原先的 MigrationPanel）。
  const preview = migratePending?.response?.preview ?? null
  const planned = preview !== null && preview.ok
  /** 目标还没定：这一份不是"预览中"，而是"等你选目标"——两者在弹窗里长得不一样。 */
  const waitingForTarget = to.trim() === ''
  const registry = preview?.registryChange ?? null
  /** 顺带摘掉的悬空登记条数（宿主本来就不认它们，见宿主 `RegistryChange.droppedStale`）。 */
  const staleDropped = (registry?.droppedStale ?? []).reduce((n, entry) => n + entry.sessionIds.length, 0)
  /**
   * 这次改动会不会**需要重启**才被宿主承认：预览那次按宿主接口的探测说（见 src/web.ts 的迁移端点），
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
   * 勾中的一条都搬不走（全是侧边栏不显示的）。
   *
   * 这时**不该**再摆「正在预览…」：`runPreview()` 在空集合上直接返回，一份计划都不会去取，那一行等下去
   * 永远等不到——弹窗里要说的是一句"这些都不搬、先在列表里处理"，而不是一个不会结束的等待。
   */
  const nothingMigratable = migratable.length === 0
  /**
   * 宿主有没有目录选择器、是哪一种；`null`（含旧宿主没这个字段）时候选面板里不摆「浏览文件系统…」。
   * 它来自 `/meta`（与清单无关、先到），所以清单还在读时那枚按钮也不至于晚一步出现。
   */
  const pickerKind = (state ?? meta)?.pickerKind ?? null
  /** 表头那一列的箭头：只有当前排序列才有。 */
  const sortArrow = (key: SessionSortKey): string => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '')

  return (
    <>
      {error !== null && (
        <p className="dsm-banner dsm-error">
          <span>{error}</span>
          <span className="dsm-spacer" />
          {/* 关掉一条横幅：本页不用官方缺省的 ghost（那条标准见「动作行里的动作带边框」那篇笔记）。 */}
          <Button variant="outline" size="sm" onClick={() => setError(null)}>
            {t('error.dismiss')}
          </Button>
        </p>
      )}
      {notice !== null && (
        <p className="dsm-banner dsm-ok">
          <span>{notice}</span>
          <span className="dsm-spacer" />
          <Button variant="outline" size="sm" onClick={() => notify(null)}>
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

      <div className="dsm-workbench">
        <SessionTree
          t={t}
          total={topLevelTotal}
          options={projectOptions}
          value={projectPath}
          onPick={(path) => setProject?.({ path })}
          filter={filter}
          pickState={treePickState}
          onToggleGroup={toggleProject}
          onClose={() => setTreeOpen(false)}
          open={treeOpen}
          loading={state === null}
        />
        <div className="dsm-workbenchMain">
          <div className="dsm-card dsm-cardFill">
            <div className="dsm-cardHead">
              <span className="dsm-cardTitle">{t('manage.title')}</span>
              {/*
                窄屏（工作台可用宽 ≤960px）才出现：那一条项目栏收成浮动面板，用这枚按钮打开。宽屏上项目栏
                一直摆着，CSS 把这枚按钮藏起来（见 styles.ts 的容器查询）。
              */}
              <Button
                className="dsm-treeToggle"
                variant="outline"
                size="sm"
                aria-expanded={treeOpen}
                aria-controls="dsm-tree"
                onClick={() => setTreeOpen(true)}
              >
                {t('list.tree.open')}
              </Button>
              <SessionSearch filter={filter} t={t} />
              <span className="dsm-spacer" />
              {(filter.active || projectPath !== null) && (
                <span className="dsm-hint">
                  {onlySubagents
                    ? t('list.shownSubagents', { shown: folded.roots.length })
                    : t('list.shown', { shown: folded.roots.length, total: topLevelTotal })}
                </span>
              )}
              <span className="dsm-hint">{t('list.selected', { count: picked.length })}</span>
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

            {/*
              平铺表格：一行一条，按目录分组时写在各组头上的「项目」变成一列。表头跟列表一起滚没意义，
              它是列的说明，所以贴在列表顶部（见 styles.ts 的 .dsm-tableHead）。

              排序只在界面上排，不写盘：同一份清单换一种看法，不该留下副作用。
            */}
            <SessionListBox fill>
              <div className="dsm-tableHead">
                <span />
                <span />
                {/* 折叠标记那一列：表头这里空着，但它必须在，否则标题那一格会与行错位。 */}
                <span />
                <Hint text={t('list.sort.tip')} side="top">
                  <button type="button" className="dsm-sort" onClick={() => toggleSort('title')}>
                    {t('list.sort.title')}
                    {sortArrow('title')}
                  </button>
                </Hint>
                <span className="dsm-sortStatic">{t('list.project.column')}</span>
                <Hint text={t('list.sort.tip')} side="top">
                  <button type="button" className="dsm-sort dsm-sortNum" onClick={() => toggleSort('size')}>
                    {t('list.sort.size')}
                    {sortArrow('size')}
                  </button>
                </Hint>
                <Hint text={t('list.sort.tip')} side="top">
                  <button type="button" className="dsm-sort dsm-sortNum" onClick={() => toggleSort('time')}>
                    {t('list.sort.time')}
                    {sortArrow('time')}
                  </button>
                </Hint>
              </div>
              {state === null ? (
                // 清单还在读：这一格说"读取中…"而不是"这个会话库里还没有会话"——后者是个结论。
                <SessionListEmpty text={t('loading')} />
              ) : sessions.length === 0 ? (
                <SessionListEmpty text={t('list.empty')} />
              ) : listed.length === 0 ? (
                <SessionListEmpty text={t('list.noMatch')} />
              ) : (
                renderRows(folded.roots, 0)
              )}
            </SessionListBox>

            <p className="dsm-hint">{t('manage.delete.hint')}</p>

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
                {t('manage.retitle.action')}
              </Button>
              {/*
                「迁移」也在这条动作行上：它与归档 / 改名 / 删除是同一句话——"对勾中的这些做一件事"。
                它开自己的弹窗（目标目录 + 预览 + 确认），所以这里只是一枚按钮。
              */}
              <Button
                variant="outline"
                size="sm"
                onClick={openMigrate}
                disabled={busy !== null || picked.length === 0}
              >
                {t('migrate.action')}
              </Button>
              {/*
                导出**不问**：它只把已有字节打成包给浏览器下载，不改本机任何东西。所以这一枚按下去就做，
                完成之后那一条提示报出包里有几条、多少字节、带走了几个附件对象。包里带什么就是列表里
                勾的那几个（父子会话跟着走的那几条也在），列表上「已选 N」与之一致。
                导入不在这条行上：它跟勾选无关，在底部状态栏（见 ManagerPanel）。
              */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void doExport()}
                disabled={busy !== null || picked.length === 0}
              >
                {busy === 'export' ? t('export.running') : t('export.action')}
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
          </div>
          {/*
            浮动面板外面那层空白：窄屏有浮动面板打开时（左栏的「项目与筛选」或右侧的「详情」），点它就收起，
            不必先找到那一层里那枚「关闭」（见 styles.ts 的容器查询）。
            它接住这一下点击，所以点到的那一行不会顺带被选中、右栏也不会顺带换一条——一次点击只做
            一件事。它挂在主栏里（不是工作台那一层）：左栏在 960–1180 那一档还是常驻的一列，这一层
            因此不会盖住它。
            键盘那条路仍是浮动面板里那两枚「关闭」（这一层 `aria-hidden`、进不了 Tab 序）。
          */}
          <div
            className="dsm-scrim"
            aria-hidden="true"
            onClick={() => {
              setTreeOpen(false)
              setDetail({ id: null })
            }}
          />
        </div>

        <SessionInspector
          t={t}
          session={inspected}
          projectName={inspectedProject}
          parentTitle={inspectedParentTitle}
          fileCount={inspected === null ? undefined : inspected.files.length}
          remote={remote}
          checked={inspected !== null && picked.includes(inspected.id)}
          archiveAvailable={archiveAvailable}
          busy={busy !== null}
          lockedTip={inspectedLock?.tip}
          onClose={() => setDetail({ id: null })}
          onTranscript={() => {
            if (inspected !== null) setInspecting(inspected)
          }}
          onArchive={() => {
            if (inspected !== null) void doArchive(inspected.archived !== true, [inspected.id])
          }}
          onPick={() => {
            if (inspected !== null) picking.toggle(inspected)
          }}
        />
      </div>

      {/* 删除弹窗：清单与「确认」在同一块地方（见 ConfirmDialog.tsx 的说明）。 */}
      {pending !== null && (
        <ConfirmDialog
          t={t}
          // 应用那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t('manage.delete.dialogTitle')}
          confirmLabel={t('manage.delete.apply')}
          acknowledge={t('manage.delete.acknowledge')}
          planning={pending.plan === null && pending.error === null}
          // 预览要扫整库（找这些会话与它们的后代），那几秒里把静态的「正在预览…」换成进度。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={pending.error}
          disabled={pending.plan === null || !pending.plan.preview.ok}
          onConfirm={applyDelete}
          onCancel={() => setPending(null)}
        >
          {pending.plan !== null && (
            /* 块间 12px（`.dsm-planBody`，与同步计划那一段同一套节奏）、块内 4–6px；正文层那 8px
               只留给"这一整块"与弹窗其它部分之间。 */
            <div className="dsm-planBody">
              {/*
                结论、清单、说明各占一块，块与块之间靠对话框正文那 20px 的节奏；用 <div> 而不是 <p>——
                <p> 自带 1em 的上下边距，会和那 20px 叠成 32px，四行字看着一样松、谁也不挨着谁。
              */}
              <div className={`dsm-planVerdict ${pending.plan.preview.ok ? 'dsm-ok' : 'dsm-warn'}`}>
                {pending.plan.summary}
              </div>
              {/*
                没做到的那几条：与「上次同步」那张卡里那块同一种画法（淡告警底 + 左边一道细线，标题是个
                小标签，逐条原话用正文色、发丝线分隔）。原来它们是一串同色的橙色大段——结论、清单、说明
                三件事看上去一样，读不出哪句是"不能删"，也读不出有几条。
              */}
              {pending.plan.problems.length > 0 && (
                <div className="dsm-warnBlock">
                  <div className="dsm-leftovers">
                    <p className="dsm-leftoversTitle">
                      {t('manage.delete.problemsTitle', { count: pending.plan.problems.length })}
                    </p>
                    <ul className="dsm-listPlain">
                      {pending.plan.problems.map((problem) => (
                        <li key={problem} className="dsm-leftoverRow">
                          <span>{problem}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {syncConfigured && (
                <div className="dsm-fieldGroup">
                  <div className="dsm-options">
                    <Checkbox
                      checked={deleteRemote}
                      label={t('manage.delete.remote')}
                      onChange={setDeleteRemote}
                    />
                  </div>
                  {/* 说明另起一行、紧贴这一枚勾（6px）：与勾选框同一行时它会被挤成贴着标签的一小段，
                      读起来像标签的一部分；离得太远又会被读成另一件事。 */}
                  {deleteRemote && <div className="dsm-hint">{t('manage.delete.remoteHint')}</div>}
                </div>
              )}
              <div className="dsm-hint">{t('manage.delete.backupTo')}</div>
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
            </div>
          )}
        </ConfirmDialog>
      )}
      {/* 迁移弹窗：目标目录 + 计划 + 「确认」同框（见 ConfirmDialog.tsx 的说明）。 */}
      {migratePending !== null && (
        <ConfirmDialog
          t={t}
          // 应用那一段标题也换掉：这时候已经不是"将要"了，正文里正跑着进度。
          title={t('migrate.dialogTitle')}
          confirmLabel={t('migrate.apply')}
          acknowledge={t('migrate.acknowledge')}
          // 目标为空时不算"预览中"：那时正文是一句"先选目标目录"，不是一句等待；一条都搬不走时同理
          //（那一份计划根本不会去取，等下去等不到）。
          planning={
            !waitingForTarget &&
            !nothingMigratable &&
            migratePending.response === null &&
            migratePending.error === null
          }
          // 算计划那一段不是空等（要扫整库认族、算注册表变更），所以有事件就把那句静态的「正在预览…」
          // 换成进度。
          planningDetail={progress === null ? undefined : <ProgressBlock t={t} progress={progress} />}
          error={migratePending.error}
          disabled={!planned || waitingForTarget}
          onConfirm={applyMigration}
          onCancel={() => setMigratePending(null)}
        >
          {(
            <>
              {/*
                目标目录是这一弹窗的第一步。`title` 与产物开关跟着它：三者都是"这次怎么应用"的参数，
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
                名称不进预览的正文（那份计划里只报"新建 / 复用目标工作区"这一件事，不报它的名字），所以
                改它不必重新预览：应用那次请求现取这个名字。产物开关不一样——它直接改变计划里的条数，
                所以跟着重新预览。
              */}
              <div className="dsm-options">
                {/*
                  这个开关直接改变计划里的条数（带上产物 vs 只带会话），所以跟着重新预览。
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
                一律拒（见 src/operations/migrate/plan.ts），而"我勾了它、你没动它"必须能分辨，所以在这里点名条数。
              */}
              {nothingMigratable ? (
                // 一条都搬不走时说清"为什么没有计划"（见 nothingMigratable），而不是只报"另有 N 条"。
                <p className="dsm-warn">{t('migrate.nothingVisible')}</p>
              ) : (
                hiddenPicked > 0 && (
                  <p className="dsm-hint">{t('migrate.hiddenSkipped', { count: hiddenPicked })}</p>
                )
              )}

              {!waitingForTarget && preview !== null && (
                <>
                  {/*
                    计划过不去时不说"将迁移 N 条"：那句是承诺，而 `ok === false` 意味着一条都不会写进去
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
