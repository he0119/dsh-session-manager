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
   * 界面上的候选必须与宿主那份计划的候选是同一批：宿主那一侧按同一条判据（`src/visibility.ts`）把
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
 * 进那个来源的条数——界面上的条数与宿主那份计划的数字必须是同一个口径。这是这个来源自己的**能力**限制，
 * 与「未分组」的定义无关（侧边栏那一组里有它们）。
 *
 * @param sessions 会话库里的全部会话。
 */
export function unownedSessions<T extends SourceSubject>(sessions: readonly T[]): T[] {
  return sessions.filter(
    (session) => session.ungrouped === true && typeof session.cwd === 'string' && session.cwd !== '',
  )
}

// ---- 一个目录在界面上怎么称呼：项目身份、标题与本机路径 ----

/**
 * 一个目录的三种称呼来源：本机路径（必有）、注册表里的工作区标题、仓库的项目身份。
 *
 * 项目身份是仓库的 git remote，宿主已经规范成 `host/owner/repo`（见宿主 `src/repo.ts`）：同一个项目在
 * 两台机器上可以落在完全不同的目录里，本机路径是**机器特有**的那一个，而身份是仓库自己的名字。组头上
 * 只看得见**名字**，身份与本机路径一起进悬浮提示（两个都是机器字符串，摆在那一行里又长又会被截断）；
 * 下拉框里两个都摆在文本里（`<select>` 没有悬浮提示，而同一个仓库在本机的两个克隆只能靠路径区分）。
 */
export interface ProjectSubject {
  /** 本机目录的绝对路径；空串 = 没有 cwd 的那一组。 */
  readonly path: string
  /** 注册表里的工作区标题（未登记目录没有）。 */
  readonly title?: string
  /** 项目身份（`host/owner/repo`）；认不出来时没有。 */
  readonly repo?: string
}

/**
 * 身份里的项目名：最后一段（`github.com/he0119/dsh-session-manager` → `dsh-session-manager`）。
 *
 * 末尾的 `.git` 会去掉：规范形式里它已经被剪掉，而"认不出来就原样退回"的那些形状（裸路径等）可能还带
 * 着它，直接当名字显示会多一个后缀。
 */
export function repoName(repo: string): string {
  const parts = repo.replace(/\.git$/, '').split('/')
  return parts[parts.length - 1] || repo
}

/**
 * 身份里的主机名：第一段（`github.com/he0119/dsh-session-manager` → `github.com`）。
 *
 * "认不出来就原样退回"的那些形状（裸路径等）没有主机段，那时整条原样当标签——这种身份本来就少见，
 * 标签太长由 CSS 的 nowrap 兜住。
 */
export function repoHost(repo: string): string {
  const cut = repo.indexOf('/')
  return cut <= 0 ? repo : repo.slice(0, cut)
}

/**
 * 一个组头要说的事：主名字（唯一可见的那串字）、一枚主机标签（有身份时），以及它们的悬浮提示。
 */
export interface ProjectLabel {
  /** 主名字：工作区标题 → 项目名（没有标题时）→ 本机路径（都没有时）。 */
  readonly name: string
  /**
   * 悬浮提示：**项目身份（有的话）与本机路径各一行**。
   *
   * 组头上只看得见名字——身份与本机路径都是机器字符串，摆在那一行里既长又会被截断（截断的身份比没有
   * 还难认），而"这是哪个仓库、它在本机哪个目录"是"想知道才看"的信息。悬浮提示把两件都给出：身份在
   * 上（跨机器认得出来的那个名字），本机路径在下（同一个仓库在本机的两个克隆靠它区分）。
   */
  readonly tip: string
  /**
   * 项目身份的主机名（`github.com`）：组头在名字后面挂一枚小标签。
   *
   * 只挂主机名，不挂整条身份——整条又长又会被截断（那正是它从这一行里撤下来的原因），而"这枚标签说的
   * 是哪个远端"由标签自己的悬浮提示给全。它同时是个**看得见的记号**：哪些目录是认得出身份的仓库，扫
   * 一眼就知道，不必逐个悬浮。
   */
  readonly host?: string
}

/**
 * 一个目录组头怎么称呼。
 *
 * 名字取**人认得的那一个**：注册表里的工作区标题优先（那是用户自己起的名字），没有标题才退到项目名
 * （身份最后一段——未登记目录原来拿整条本机路径当名字，机器特有的绝对路径对认项目没有帮助）。
 *
 * @param subject 路径、标题与身份。
 * @param t 翻译（没有 cwd 的那一组用 `noCwdGroup`）。
 * @returns 名字与悬浮提示。
 */
export function projectLabel(subject: ProjectSubject, t: Translate): ProjectLabel {
  const { path, title, repo } = subject
  const name = title ?? (path === '' ? t('noCwdGroup') : repo === undefined ? path : repoName(repo))
  const lines = [repo, path].filter((line): line is string => line !== undefined && line !== '')
  return {
    name,
    tip: lines.length === 0 ? name : lines.join('\n'),
    ...(repo === undefined ? {} : { host: repoHost(repo) }),
  }
}

/**
 * 目录下拉框里那一行（不带条数）：项目身份优先「身份 — 路径」，没有身份就照旧「标题 — 路径」。
 *
 * 下拉框与组头不同：`<option>` 没有悬浮提示，所以路径不能退到提示里——同一个仓库在本机的两个克隆
 * 否则就无从区分。身份那一栏取代的是**标题**（标题只是路径的标签，路径与身份都在这一行里）。
 *
 * @param subject 路径、标题与身份。
 * @returns 一行的文案。
 */
export function pathLabel(subject: ProjectSubject): string {
  const { path, title, repo } = subject
  if (repo !== undefined) return `${repo} — ${path}`
  return title === undefined ? path : `${title} — ${path}`
}

/** 迁移页一个目录下拉框里的一行。`count` 只有"宿主库里真有会话的目录"才有。 */
export interface PathRow extends ProjectSubject {
  /** 值（也是 React 的 key）：目录路径，或者 UNOWNED_SOURCE。 */
  path: string
  /** 已登记工作区才有标题（注册表里的名字）。 */
  title?: string
  /** 库里这个来源下的会话条数。 */
  count?: number
  /**
   * 整行的文案（有则不再拼"身份/标题 — 路径"）。
   *
   * 「未分组」不是路径，拼上哨兵值等于把内部约定漏给用户看，所以那一行自带文案。
   */
  label?: string
}

/** 一行候选的文案：身份（或标题）+ 路径 + 库里的条数（有则带）。 */
export function optionLabel(row: PathRow, t: Translate): string {
  const head = row.label ?? pathLabel(row)
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
 * @param repos 目录 → 项目身份（宿主 `/state` 的 `repos`）；缺省按"没有身份"处理。
 */
export function migrationSourceRows(
  sessions: readonly SourceSubject[],
  workspaces: ReadonlyArray<{ readonly path: string; readonly title?: string }>,
  t: Translate,
  repos: Readonly<Record<string, string>> = {},
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
    options.push({
      path: workspace.path,
      title: workspace.title,
      count: counts.get(workspace.path) ?? 0,
      ...(repos[workspace.path] === undefined ? {} : { repo: repos[workspace.path] }),
    })
  }
  for (const [path, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (seen.has(path)) continue
    seen.add(path)
    options.push({ path, count, ...(repos[path] === undefined ? {} : { repo: repos[path] }) })
  }
  const unowned = unownedSessions(sessions).length
  if (unowned > 0) options.push({ path: UNOWNED_SOURCE, label: t('ungroupedSource'), count: unowned })
  return options
}

// ---- 计划清单：「这条是怎么进来的」 ----

/** 计划清单里一条会话的出处只用得上这个字段。 */
export interface FamilySubject {
  /** 级联带进来的：用户点名的那个祖先会话（宿主 `RemoveEntry.via` / `SessionMove.via`）。 */
  readonly via?: { readonly id: string; readonly title?: string }
}

/** 一个出处怎么称呼：有标题用标题，没有才用 id（与 `sessionLabel` 同一套口径）。 */
function referentName(referent: { readonly id: string; readonly title?: string }): string {
  const title = referent.title?.trim()
  return title === undefined || title === '' ? referent.id : title
}

/**
 * 计划清单里那枚"这条是怎么进来的"标签。
 *
 * 删除与迁移都会**沿着父子关系向下展开**（见 `src/remove.ts` 的 `familyOf()` 与 `src/migrate.ts`），
 * 所以清单里会冒出用户没勾过的会话；这枚标签就是它们的解释——"跟着 <点名的会话> 一起走"。判据与
 * 称呼只写这一处，动词由调用方给（删除说「随父删」、迁移说「随父迁」）。
 *
 * @param subject 出处字段（宿主已经算好，界面只负责显示）。
 * @param t 翻译。
 * @param keys 标签文案与提示的字典键。
 * @returns 标签文案与悬浮提示；没有出处时 `undefined`（不挂标签）。
 */
function familyNote(
  subject: FamilySubject,
  t: Translate,
  keys: { readonly text: string; readonly tip: string },
): { text: string; tip: string } | undefined {
  if (subject.via === undefined) return undefined
  return { text: t(keys.text), tip: t(keys.tip, { name: referentName(subject.via) }) }
}

/**
 * 删除计划清单里那枚"随父会话删"标签。
 *
 * 标签文案刻意短（「随父删」）：它挂在名字右边且 `flex: none`，占的宽度就是从标题里扣的。
 * 在真实 dev GUI 里量的（真实列表 534px 宽、名字列 305px，浅深两套主题同值）：四字的「随父会话删」
 * 吃 74px、名字只剩 225px，两字的吃 50px、名字剩 249px；英文 "goes with parent" 吃 115px、名字只剩
 * 184px，短一档的 "with parent" 吃 83px。省掉的那半句在悬浮提示里，弹窗里的摘要还会整句说一遍。
 *
 * @param subject 出处字段（宿主已经算好，界面只负责显示）。
 * @param t 翻译。
 * @returns 标签文案与悬浮提示；点名的那几条自己没有 `via`，于是 `undefined`（不挂标签）。
 */
export function deleteFamilyNote(subject: FamilySubject, t: Translate): { text: string; tip: string } | undefined {
  return familyNote(subject, t, { text: 'manageDeleteVia', tip: 'manageDeleteViaTip' })
}

/**
 * 迁移计划清单里那一枚（「随父迁」）。
 *
 * 与删除那份分开是因为动词不同：迁移不删掉它，只是把它一起搬走——在那张清单上说「随父删」就是一句
 * 错话，而这两张清单里的 `via` 是同一个字段（宿主两张计划各自的 `via`）。
 */
export function migrateFamilyNote(subject: FamilySubject, t: Translate): { text: string; tip: string } | undefined {
  return familyNote(subject, t, { text: 'migrateVia', tip: 'migrateViaTip' })
}

/**
 * 「父会话在别的目录里」那枚标签（列表里缩进的那条子代理用）。
 *
 * 分组键是目录，而子代理的日志落在**它自己 cwd** 的项目目录里——那个 cwd 未必还是父会话现在的 cwd
 * （父会话被单独迁走过一次就长成这样）。这种子代理只能留在它自己的目录组里，缩进说明了父子关系，
 * 这枚标签说明"父不在这里"。完整的父目录在悬浮提示里：标签是 `flex: none`，占的宽度从标题里扣。
 *
 * @param row 缩进后的一行（`groups.NestedRow` 的结构化形状）。
 * @param t 翻译。
 * @returns 标签文案与悬浮提示；父会话就在本组、或不在当前视图里时 `undefined`（不挂标签）。
 */
export function parentDirNote(
  row: { readonly parentPath?: string },
  t: Translate,
): { text: string; tip: string } | undefined {
  const path = row.parentPath
  if (path === undefined || path === '') return undefined
  return { text: t('tagParentElsewhere'), tip: t('tagParentElsewhereTip', { path }) }
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
