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
