// src/accounting.ts — 「这条会话被哪个工作区认领」的唯一一份判据（宿主 `Workspace.sessionIds` 的口径）。
//
// 注册表里**登记**了不等于**认领**：宿主把记录里的 `sessionIds` 再过滤一遍才发给界面——
//
//   record.sessionIds.filter((id) => sessionPath(id) === record.path)
//
// 而 `sessionPath(id)` 是启动时按每条会话 header 的 `cwd` 建的索引（`fs.realpath` 解析得出来，而且
// 解析到的东西真的还是一个目录）。所以目录被改名或删掉之后，那条登记还留在注册表里，会话本身却已经
// 不算任何工作区的成员：外壳侧边栏把它放进「未分组」那一组，工作区那一组里也没有它。
//
// 插件以前读的是原始 `sessionIds`（登记就算有主），于是同一批会话在插件这边"有主"、在外壳那边
// 「未分组」——迁移页那个来源永远是 0 条，而侧边栏那一组里明明摆着会话。两边的账要对上，只能读宿主
// 最终用的那个判据：**登记 且 这条会话 header 的 cwd 归一之后就是记录的 `path`**。
//
// 与 visibility.ts 的分工：这里只答"有没有主"，「侧边栏会不会显示」是那边的事（`hiddenReason()`）；
// 两者合取才是「未分组」（`isUngrouped()`）。
import { canonicalDirIfExists } from './canonical-path.ts'
import type { WorkspaceRegistryState } from './types.ts'

/** 判成员资格只用得上这两样。 */
export interface AccountableSession {
  readonly id: string
  /** 日志 header 里的 cwd；缺席 = 宿主那一侧同样判它没有 cwd，必定不算成员。 */
  readonly cwd?: string
}

/** `accountedOwners()` 的选项。 */
export interface AccountingOptions {
  /**
   * cwd → 规范拼写（**必须真的解析得出来**），解析不出来返回 `undefined`。
   *
   * 缺省是 `canonicalDirIfExists()`（宿主的等价物）。留这个口子是为了测试能不碰磁盘，也因为调用方
   * 往往有更便宜的一份：`/state` 一次要判上千条会话，而它们共用几十个 cwd。
   */
  resolveDir?: (cwd: string) => string | undefined
}

/**
 * 会话 id → 认领它的工作区 id（不在表里 = 谁都没认领，「未分组」那一组里就有它）。
 *
 * @param registry 注册表；读不到（`null`）时没有任何会话被认领。
 * @param sessions 库里扫出来的会话。**没扫到的登记项不进结果**：目录还在不在这件事要先有这条会话的
 *   `cwd` 才判得了，而只对着注册表的调用方本来也要靠这份列表去认会话。
 * @param options.resolveDir cwd 的规范拼写解析器（缺省见上）。
 * @returns 每个被认领的会话对应的那个工作区 id；同一个 id 只会有一个（注册表不变式：一条会话只能属于
 *   一个工作区，见 registry.ts）。
 */
export function accountedOwners(
  registry: WorkspaceRegistryState | null | undefined,
  sessions: readonly AccountableSession[],
  options: AccountingOptions = {},
): Map<string, string> {
  const resolveDir = options.resolveDir ?? canonicalDirIfExists
  const byId = new Map(sessions.map((session) => [session.id, session]))
  // 同一个 cwd 只解析一次：解析要碰磁盘（realpath + stat），而一个库里的会话挤在几十个目录里。
  const resolved = new Map<string, string | undefined>()
  const canonicalOf = (cwd: string): string | undefined => {
    if (!resolved.has(cwd)) resolved.set(cwd, resolveDir(cwd))
    return resolved.get(cwd)
  }

  const owners = new Map<string, string>()
  for (const [workspaceId, record] of Object.entries(registry?.tables?.workspaces ?? {})) {
    for (const id of record.sessionIds) {
      const session = byId.get(id)
      if (session === undefined) continue
      if (session.cwd === undefined || session.cwd === '') continue
      if (canonicalOf(session.cwd) !== record.path) continue
      owners.set(id, workspaceId)
    }
  }
  return owners
}
