/**
 * 把会话按**目录**分组——「传输」那张列表的组织方式。
 *
 * 为什么按目录（`cwd`）而不是按注册表里的工作区 id 分组：这两件事经常不是一回事。注册表的
 * `sessionIds` 只是"登记在册"的那部分，同一个目录下完全可能有没登记的会话（迁移页的候选列表
 * 就是为此才按目录数、按目录列）；而注册表记的路径也可能与日志里的 `cwd` 不一致。用户嘴里的
 * "把这个工作区的会话带走"指的永远是**这个目录下的会话**，所以分组键只能是路径，工作区标题
 * 只是这个路径的**标签**（题外：迁移页选源目录用的是同一套口径，两个分页对同一个库必须给出
 * 同一个心智模型）。
 *
 * 这个模块刻意不依赖 React、也不碰文件系统：分组规则是纯函数，才好在测试里把边界钉住
 * （空库、没 cwd、未登记目录、注册表里重复路径、组内顺序）。
 *
 * @module dsh-session-manager/client/groups
 */

/**
 * 分组只用到这几个字段，于是这里**不 import `/state` 的响应类型**。
 *
 * 为什么在意这个：Host 侧的 typecheck 工程刻意 `exclude: ["src/client"]`（那一半要 DOM 与 JSX），
 * 而 TypeScript 的 exclude 只影响**入口集合**——一旦有文件 import 了被排除的文件，它照样会被拉进
 * 这个没有 DOM 的工程里检查，于是浏览器代码在 Host 工程里报 TS2584（找不到 `document`）。
 * 纯函数不绑在响应形状上，这个坑就绕开了；页面那边传 `SessionSummary[]` 进来天然兼容（结构化类型）。
 */
/**
 * 一个组的稳定键：就是它的路径。
 *
 * 没有 cwd 的那一组路径是空串，换成一个不可能撞上真实路径的键——React 的 key 与折叠状态都拿它当
 * 身份，两处各写一遍迟早会不一致。
 */
export function groupKey(path: string): string {
  return path === '' ? '\u0000no-cwd' : path
}

export interface GroupableSession {
  readonly id: string
  readonly cwd?: string
  readonly createdAt: number
}

/** 分组只用到工作区的路径与标题（标题是路径的标签）。 */
export interface GroupableWorkspace {
  readonly path: string
  readonly title: string
}

/** 一组会话：同一个目录下的全部会话。 */
export interface SessionGroup<S extends GroupableSession = GroupableSession> {
  /** 分组键：目录的绝对路径；没有 cwd 的会话自成一组的键是**空串**。 */
  readonly path: string
  /** 注册表上这个目录的工作区标题（这个目录不是已登记工作区时没有）。 */
  readonly title?: string
  /** 组内会话，最近的在前。 */
  readonly sessions: readonly S[]
}

/** 组内排序：新会话在前；同一毫秒再按 id 定序，免得刷新一次顺序就换。 */
function newestFirst<S extends GroupableSession>(sessions: readonly S[]): S[] {
  return [...sessions].sort((left, right) => {
    if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}

/**
 * 按目录分组。
 *
 * 组的顺序：**已登记的工作区**（按注册表顺序，也就是界面上别处的工作区顺序）→ 其余目录
 * （按路径排序，纯为稳定）→ 没有 cwd 的那一组（放最后，它不是一个真的目录）。
 * 没有会话的已登记工作区不会成为空组：列表是用来勾选的，空组只会多一个勾不动的行。
 *
 * @param sessions - `/state` 给出的会话（未排序也没关系）。
 * @param workspaces - `/state` 给出的工作区，用于把路径翻译成标题。
 * @returns 分组后的会话，顺序如上。
 */
export function groupSessions<S extends GroupableSession>(
  sessions: readonly S[],
  workspaces: readonly GroupableWorkspace[],
): SessionGroup<S>[] {
  // 同一个路径在注册表里出现多次（同一目录被登记成两个工作区）时取先出现的那个标题，
  // 与迁移页的下拉候选同一个口径。
  const titles = new Map<string, string>()
  for (const workspace of workspaces) {
    if (!titles.has(workspace.path)) titles.set(workspace.path, workspace.title)
  }

  const byPath = new Map<string, S[]>()
  for (const session of sessions) {
    // cwd 缺失或空串都算"没有 cwd"：空串不是一条路径，单独列成一组反而像真有这个目录。
    const key = session.cwd === undefined || session.cwd === '' ? '' : session.cwd
    const group = byPath.get(key)
    if (group === undefined) byPath.set(key, [session])
    else group.push(session)
  }

  const groups: SessionGroup<S>[] = []
  const taken = new Set<string>()
  for (const workspace of workspaces) {
    if (taken.has(workspace.path) || !byPath.has(workspace.path)) continue
    taken.add(workspace.path)
    const title = titles.get(workspace.path)
    groups.push({
      path: workspace.path,
      ...(title === undefined ? {} : { title }),
      sessions: newestFirst(byPath.get(workspace.path) ?? []),
    })
  }

  const rest = [...byPath.keys()].filter((key) => key !== '' && !taken.has(key)).sort()
  for (const path of rest) {
    groups.push({ path, sessions: newestFirst(byPath.get(path) ?? []) })
  }

  const orphans = byPath.get('')
  if (orphans !== undefined) groups.push({ path: '', sessions: newestFirst(orphans) })

  return groups
}

/**
 * 「子代理挂到父会话的下一级」——同一个目录组里再按父子关系缩进。
 *
 * 为什么值得缩进：子代理会话在外壳侧边栏里就嵌在父会话下面（那一行是从父日志的 `subagent/catalog`
 * 长出来的），而插件这边的列表原先把它们平铺在同一个目录组里，只挂一枚「子代理」小标签。一族会话在
 * 列表里被拆成互不相邻的几行，"这条为什么在这儿""删/搬父会话会带上谁"就只能靠读标签猜。缩进之后，
 * 列表里的父子关系与删除 / 迁移的级联展开是**同一条边**（`parentSession` + `origin === "subagent"`，
 * 见 family.ts）长出来的同一棵树。
 *
 * **只有子代理缩进**：header 里的 `parentSession` 还有另一种来源——**分叉**（`sessions.fork()`，把源
 * 会话"已完成轮次"的事件拷进新会话，`isSeeded: true`、没有 `origin`）。分叉是自洽的普通会话，父删掉
 * 它照旧能打开、缩进它等于说"它挂在上面那条下面"，而删除 / 迁移不会带走它——列表和行为会各说各话。
 * 所以判据要看 `origin`，不能只看 `parentSession`。
 *
 * 四条边界（都会在真实库里遇到）：
 *
 * 1. **父会话在别的目录组里**：给 `depth: 1` 并带上 `parentPath`，让行上写明父会话在哪个目录。分组键
 *    仍然是目录——把子代理挪进父那一组会让"勾组头 = 勾这个目录下的会话"变成假的；
 * 2. **父会话没在当前视图里**（被筛选条或搜索框筛掉、或压根不在库里）：`depth: 0` 按普通行画。
 *    没有可见的父行时缩进就是错的（凭空多出一级），行上仍有「子代理」标签；
 * 3. **分叉**（有 `parentSession`、不是子代理）：`depth: 0` 按普通行画，不缩进（理由见上）；
 * 4. **坏数据里的环**（A 的父是 B、B 的父是 A）：环路里没有一个节点是"根"，遍历会一行都画不出来。
 *    所以走完之后把还没画过的按原顺序补在最后，宁可少一层缩进也不能让会话凭空消失。
 *
 * 这一层是**显示**关系，不改变任何选择语义：勾选、组头计数、筛出来的条数都还是"这些行"，
 * 与缩进无关。
 */

/** 缩进最多画到第几级：真实库里只有"父 → 子"这一层，更深的链条按最后一级算（别把标题挤没）。 */
export const MAX_NEST_DEPTH = 3

/** 缩进只用到这几个字段（同 `GroupableSession`，刻意不绑 `/state` 的响应类型）。 */
export interface NestableSession {
  readonly id: string
  /** 日志 header 里的 `parentSession`；缺省 = 它没有父。 */
  readonly parentSession?: string
  /** 日志 header 里的 `origin`：只有子代理会话是 `'subagent'`（分叉没有它）。 */
  readonly origin?: string
  readonly cwd?: string
  readonly createdAt: number
}

/**
 * 这条会话"跟着父走"的那条边（父的 id），没有就是 `undefined`。
 *
 * 只有子代理才有这条边：分叉（有 `parentSession`、没有 `origin`）是自洽的独立会话，与缩进无关
 * （见本段上面的说明，以及 family.ts 文件头为什么级联也不带它）。
 */
function subagentParent(session: NestableSession): string | undefined {
  if (session.origin !== 'subagent') return undefined
  const parent = session.parentSession
  if (parent === undefined || parent === '' || parent === session.id) return undefined
  return parent
}

/** 缩进后的一行。 */
export interface NestedRow<S extends NestableSession = NestableSession> {
  readonly session: S
  /** 缩进级数：0 = 顶层（正常会话），1 = 挂在上面那张父行下面。 */
  readonly depth: number
  /** 父会话在**别的目录组**里时给出那个目录的路径（行上据此说明）；父就在本组或不在视图里时没有它。 */
  readonly parentPath?: string
}

/**
 * 把一组（同一目录、已筛选、已按"新→旧"排好）的会话排成"父在前、子紧随其后"的顺序并标出缩进级数。
 *
 * @param visible - 这一组里当前要画的会话，顺序即"顶层行的顺序"（调用方给的是新→旧）。
 * @param library - **整个库**的会话（不筛）：用来判断父会话是"在别的组里"还是"不在视图里"。
 * @param visibleIds - 整个视图（跨组）当前画出来的 id 集合。
 * @returns 按显示顺序排好的行（与原集合一一对应，一条不多一条不少）。
 */
export function nestSessions<S extends NestableSession>(
  visible: readonly S[],
  library: readonly NestableSession[],
  visibleIds: ReadonlySet<string>,
): NestedRow<S>[] {
  const inGroup = new Map(visible.map((session) => [session.id, session]))
  const pathById = new Map(library.map((session) => [session.id, session.cwd ?? '']))

  /** 直接子们（只收子代理）：边只在"父也在这一组里"时才算（跨组的父不在这里）。 */
  const children = new Map<string, S[]>()
  for (const session of visible) {
    const parent = subagentParent(session)
    if (parent === undefined || !inGroup.has(parent)) continue
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [session])
    else list.push(session)
  }

  const rows: NestedRow<S>[] = []
  const drawn = new Set<string>()
  const walk = (session: S, depth: number, parentPath?: string): void => {
    if (drawn.has(session.id)) return
    drawn.add(session.id)
    rows.push({
      session,
      depth: Math.min(depth, MAX_NEST_DEPTH),
      ...(parentPath === undefined || parentPath === '' ? {} : { parentPath }),
    })
    for (const child of children.get(session.id) ?? []) walk(child, depth + 1)
  }

  for (const session of visible) {
    if (drawn.has(session.id)) continue
    const parent = subagentParent(session)
    // 父就在这一组里：这一行由父的子树负责画（跟着父走，而不是留在自己原来的位置）。
    if (parent !== undefined && inGroup.has(parent)) continue
    // 父在别的目录组里（还在视图里）：缩进一级并说明它在哪儿；父不在视图里就按普通行画。
    if (parent !== undefined && visibleIds.has(parent)) {
      walk(session, 1, pathById.get(parent))
      continue
    }
    walk(session, 0)
  }
  // 兜底：环路（互为父子的坏数据）里没有一个节点是"根"，上面那一轮会一条都画不出来。
  for (const session of visible) if (!drawn.has(session.id)) walk(session, 0)
  return rows
}
