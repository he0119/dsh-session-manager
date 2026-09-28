/**
 * 列表/表格里一行该怎么写——抽成纯函数，因为这两处都出过错。
 *
 * 一、cwd 那一格在**跳过**的行上说过错话。
 *
 * 计划里的 `toCwd` 只在「会写盘、而且包里本来有 cwd」的会话上出现（见 `src/transfer.ts` 的
 * `ImportEntry`）：按设计，跳过的行没有 `toCwd`，包里没有 cwd 的会话也没有。原来那一格只判断
 * `toCwd === undefined`，于是把跳过的行显示成「保持无 cwd（落 _no-cwd）」——那些会话明明有 cwd
 * （比如 `/home/uy_sun/dev/dsh-aperture`），而且它们根本不会被写盘。用户看到的是"我的会话要被丢进
 * 无 cwd 项目目录了"，这是把"什么都不会发生"说成了"会发生一件坏事"。
 *
 * 二、一行的"名字"该是标题还是 id（`sessionLabel`）：以前到处显示 `session-9f3c…`，用户认不出是哪条。
 *
 * 判断点摆在一个地方，因此可以被直接测（`test/planRows.test.ts`）。
 *
 * 只用到这几个字段，所以这里**不 import** `/state` 或导入响应的类型：Host 侧的 typecheck 工程
 * `exclude` 了 `src/client`，而 import 会把它拉进那个没有 DOM 的工程里检查（见 groups.ts 里同一段
 * 说明）。
 *
 * @module dsh-session-manager/client/planRows
 */

import type { Translate } from './locales.ts'

/** 判断 cwd 这一格只用得上这三个字段。 */
export interface CwdSubject {
  readonly action: 'create' | 'skip'
  /** 包里的原 cwd；缺省表示这条会话本来就没有 cwd。 */
  readonly fromCwd?: string
  /** 落盘后的 cwd；跳过的行与本来就没有 cwd 的会话都没有这个字段。 */
  readonly toCwd?: string
}

/** 这一格的三种说法：跳过不改写 / 本来就没有 cwd / 会改写成目标路径。 */
export type CwdPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'keepNoCwd' }
  | { readonly kind: 'rewrite'; readonly from: string; readonly to: string }

/** 把一条计划映射成那一格要说的事。 */
export function describeCwd(subject: CwdSubject): CwdPlan {
  // 先判跳过：跳过时 `toCwd` 必然缺省，但那**不代表**"这条会话没有 cwd"，更不代表要落 _no-cwd。
  if (subject.action === 'skip') return { kind: 'skip' }
  if (subject.toCwd === undefined) return { kind: 'keepNoCwd' }
  // 会写盘且有 cwd 时 `fromCwd` 必然有（`toCwd` 就是由它存在推出来的），兜底只为类型与坏数据。
  return { kind: 'rewrite', from: subject.fromCwd ?? '—', to: subject.toCwd }
}

/** 认一条会话只用得上这两个字段。 */
export interface LabelSubject {
  readonly id: string
  /** 折叠出的标题；读不到就没有（见 `src/session-title.ts`）。 */
  readonly title?: string
}

/** 一行会话在界面上怎么称呼。 */
export interface SessionLabel {
  /** 行上可见的文本。 */
  readonly text: string
  /** 悬浮提示（原生 tooltip）。标题在前、id 在后，见下面的说明。 */
  readonly tip: string
  /** 可见的是标题还是 id：前者走正文字体，后者走等宽（机器名就该长得像机器名）。 */
  readonly kind: 'title' | 'id'
}

/**
 * 一条会话在列表/表格里显示成什么。
 *
 * 显示**标题**而不是 id：`session-9f3c…` 这种 uuid 对人是零信息，用户是在"我上次问那个问题的会话"
 * 这一层挑会话的。id 并没有消失，而是退到悬浮提示里——真要指名道姓（报 bug、对日志）时才需要它。
 *
 * 标题读不到（老会话、日志里就没有标题事件）时**回落到 id**：显示空行或"（无标题）"更没用，
 * 那本来就是这个位置以前显示的东西。
 *
 * 提示里两行放着完整标题 + id：标题在行里可能被省略号截掉，悬停是唯一能看全的地方；而 id 是
 * 用户明确要求"悬浮才显示"的东西。标题就是 id 时（没有标题）不重复一遍。
 *
 * @param subject 只读 id 与 title。
 * @returns 可见文本、提示文本与字体种类。
 */
export function sessionLabel(subject: LabelSubject): SessionLabel {
  const title = subject.title?.trim()
  if (title === undefined || title === '') return { text: subject.id, tip: subject.id, kind: 'id' }
  return { text: title, tip: `${title}\n${subject.id}`, kind: 'title' }
}

// ---- 迁移页的来源：目录候选与「未分组」 ----

/**
 * 迁移页源下拉框里那个「未分组」用的**哨兵值**。
 *
 * 源是一个值控件（下拉框自己就是那个值，见 MigrationPanel 的说明），所以「未分组」也得是一个值；
 * 但它不是一个路径。用哨兵而不是"再加一个单选框"是为了不让同一个字段有两个控件——这个值永远
 * 不会下线：发请求时被翻译成 `unowned: true` 且 `from` 传空串（见 MigrationPanel 的 request()）。
 * 合法的目录值要么是绝对路径（`/…` 或 `C:\…`），要么是空串，撞不上它。
 */
export const UNOWNED_SOURCE = '@unowned'

/** 判断一条会话能不能进「未分组」来源，只用得上这三个字段。 */
export interface SourceSubject {
  /** 会话日志 header 里的 cwd；没有 cwd 的老会话缺省。 */
  readonly cwd?: string
  /** 宿主算好的"侧边栏会不会把它放进「未分组」"（见 src/visibility.ts 的 `isUngrouped()`）。 */
  readonly ungrouped?: boolean
  /**
   * 宿主报来的"外壳侧边栏不显示这条会话"的原因（`subagent` / `blank` / `archived`）；缺省 = 会显示。
   *
   * 界面上的候选必须与宿主预演的候选是同一批：宿主那一侧按同一条判据（`src/visibility.ts`）把
   * 侧边栏看不见的会话排除在外，界面若照旧把它们算进条数，用户看到的就是"这里 4 条、搬完 1 条"。
   */
  readonly hidden?: string
}

/**
 * 「未分组」来源覆盖的会话：外壳侧边栏那一组里的那些（可以横跨多个目录）。
 *
 * 判据就是宿主发来的 `ungrouped`（在 `src/visibility.ts` 里算一次）——「未分组」在这个插件里只有一个
 * 定义，行上的标签、会话页那枚芯片、这个来源读的是同一个字段，不许各自再推一遍。
 *
 * 为什么还要**有 cwd**：迁移要改写 header 里的 cwd，而 `relocateHeaderCwd()` 明确拒绝一个没有 cwd 的
 * header（换来的是"绝不凭空造一个 cwd"）。这类会话不是这个来源能搬的东西，所以它们既不进候选、也不算
 * 进那个来源的条数——界面上的条数与宿主预演的数字必须是同一个口径。这是这个来源自己的**能力**限制，
 * 与「未分组」的定义无关（侧边栏那一组里有它们）。
 *
 * @param sessions 会话库里的全部会话。
 */
export function unownedSessions<T extends SourceSubject>(sessions: readonly T[]): T[] {
  return sessions.filter(
    (session) => session.ungrouped === true && typeof session.cwd === 'string' && session.cwd !== '',
  )
}

/** 迁移页一个目录下拉框里的一行。`count` 只有"宿主库里真有会话的目录"才有。 */
export interface PathRow {
  /** 值（也是 React 的 key）：目录路径，或者 UNOWNED_SOURCE。 */
  path: string
  /** 已登记工作区才有标题（注册表里的名字）。 */
  title?: string
  /** 库里这个来源下的会话条数。 */
  count?: number
  /**
   * 整行的文案（有则不再拼"标题 — 路径"）。
   *
   * 「未分组」不是路径，拼上哨兵值等于把内部约定漏给用户看，所以那一行自带文案。
   */
  label?: string
}

/** 一行候选的文案：工作区标题（有则带）+ 路径 + 库里的条数（有则带）。 */
export function optionLabel(row: PathRow, t: Translate): string {
  const head = row.label ?? (row.title === undefined ? row.path : `${row.title} — ${row.path}`)
  return row.count === undefined ? head : `${head} — ${t('sessionsInDir', { count: row.count })}`
}

/**
 * 迁移页的源候选：已登记工作区（注册表顺序在前）+ 库里真有候选会话的目录（按路径排序）+
 * 「未分组」（库里有这类会话时才出现，排在最后——它不是一个目录，位置上也别混进目录堆里）。
 *
 * 每个候选都报**候选条数**（不是库里的会话总数）：注册表的登记条数会骗人，同一个目录下可能还有
 * 没登记在册的会话（那些默认也会被一起搬走），而用户得先看见会话在哪儿；同时侧边栏看不见的那些
 * （子代理 / 空白 / 已归档）一个都不算进来，因为它们根本不会被搬（见 `SourceSubject.hidden`）。
 *
 * @param sessions 会话库里的全部会话。
 * @param workspaces 已登记的工作区。
 * @param t 翻译（只用来拼"N 条会话"）。
 */
export function migrationSourceRows(
  sessions: readonly SourceSubject[],
  workspaces: ReadonlyArray<{ readonly path: string; readonly title?: string }>,
  t: Translate,
): PathRow[] {
  const counts = new Map<string, number>()
  for (const session of sessions) {
    if (session.hidden !== undefined) continue
    if (typeof session.cwd !== 'string' || session.cwd === '') continue
    counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1)
  }
  const options: PathRow[] = []
  const seen = new Set<string>()
  for (const workspace of workspaces) {
    if (seen.has(workspace.path)) continue
    seen.add(workspace.path)
    options.push({ path: workspace.path, title: workspace.title, count: counts.get(workspace.path) ?? 0 })
  }
  for (const [path, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seen.has(path)) continue
    seen.add(path)
    options.push({ path, count })
  }
  const unowned = unownedSessions(sessions).length
  if (unowned > 0) options.push({ path: UNOWNED_SOURCE, label: t('ungroupedSource'), count: unowned })
  return options
}

// ---- 删除预演：「这条是怎么进来的」 ----

/** 删除预演里一条会话的出处只用得上这两个字段。 */
export interface DeleteFamilySubject {
  /** 级联带进来的：用户点名的那个祖先会话（宿主 `RemoveEntry.via`）。 */
  readonly via?: { readonly id: string; readonly title?: string }
  /** 这条子代理的父会话还在库里、却不在这次删除里（宿主 `RemoveEntry.keptParent`）。 */
  readonly keptParent?: { readonly id: string; readonly title?: string }
}

/** 一个出处怎么称呼：有标题用标题，没有才用 id（与 `sessionLabel` 同一套口径）。 */
function referentName(referent: { readonly id: string; readonly title?: string }): string {
  const title = referent.title?.trim()
  return title === undefined || title === '' ? referent.id : title
}

/**
 * 删除预演里那枚"这条是怎么进来的"标签。
 *
 * 删除会**沿着父子关系向下展开**（见 `src/remove.ts`），所以预演清单里会冒出用户没勾过的会话；
 * 这枚标签就是它们的解释——"跟着 <点名的会话> 一起删"。只删子、留着父的那种，说明的是另一件事：
 * 父会话侧边栏里那一行会点不开。两件事都可能落到同一行上（父会话本身活着被挡下时），此时先报
 * "跟着谁来的"——那一条更接近"这条为什么会出现在清单里"。
 *
 * 标签文案刻意短（「随父删」/「父留着」）：它挂在名字右边且 `flex: none`，占的宽度就是从标题里扣的。
 * 在真实 dev GUI 里量的（真实列表 534px 宽、名字列 305px，浅深两套主题同值）：四字的「随父会话删」
 * 吃 74px、名字只剩 225px，两字的吃 50px、名字剩 249px；英文 "goes with parent" 吃 115px、名字只剩
 * 184px，短一档的 "with parent" 吃 83px。省掉的那半句在悬浮提示里，预演摘要还会整句说一遍。
 *
 * @param subject 出处字段（宿主已经算好，界面只负责显示）。
 * @param t 翻译。
 * @returns 标签文案与悬浮提示；两种情形都没有时 `undefined`（不挂标签）。
 */
export function deleteFamilyNote(
  subject: DeleteFamilySubject,
  t: Translate,
): { text: string; tip: string } | undefined {
  if (subject.via !== undefined) {
    return { text: t('manageDeleteVia'), tip: t('manageDeleteViaTip', { name: referentName(subject.via) }) }
  }
  if (subject.keptParent !== undefined) {
    return {
      text: t('manageDeleteKeptParent'),
      tip: t('manageDeleteKeptParentTip', { name: referentName(subject.keptParent) }),
    }
  }
  return undefined
}

/**
 * 这个来源匹配到的会话（勾选面）。
 *
 * 目录来源按 `cwd` 匹配，同样只收侧边栏看得见的那些；「未分组」来源给的就是 `unownedSessions()`
 * 那一批——于是它天然跨目录，这也是它存在的理由（一个目录一个目录地勾，谁也说不清"这两个目录里
 * 没在册的那两条"是一件事）。
 */
export function migrationMatching<T extends SourceSubject>(sessions: readonly T[], from: string): T[] {
  if (from === UNOWNED_SOURCE) return unownedSessions(sessions)
  if (from === '') return []
  return sessions.filter((session) => session.cwd === from && session.hidden === undefined)
}
