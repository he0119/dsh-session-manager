/**
 * 「同步」弹窗里那三张计划表按**项目目录**分组。
 *
 * 为什么分组：一次整库同步的计划可能有几十条，而其中绝大多数行属于同一个目录。原来每条各占一行、
 * 每行都印一遍同样的路径，读起来是一列重复的字符串——真正要看的"这条会话是谁、会落/推到哪个项目"
 * 反而被挤成窄窄一格。分组之后路径在组头上说一次，行里只剩动作、会话名与大小。
 *
 * 分组键的两个方向都取**本机那个目录**（拉取取落地后的 `toCwd`，推取本机的 `cwd`）：用户是从
 * "我哪个项目要动"这个角度读这份计划的，远端那半边的路径只是"从哪儿来"（拉取行把它放在悬浮提示上）。
 * 唯一的例外是**没有映射**的拉取行：它在说"这个远端项目还没有对应的本机目录"，本机根本没有那个
 * 项目可分组，于是退到远端的 `fromCwd` 当组头——那一行要用户补的正是这条路径。
 *
 * 模块是纯函数（不 import React、不碰 `/state` 的响应类型，见 groups.ts 里同一段说明），所以分组
 * 规则能在测试里逐条钉住（[test/syncGroups.test.ts](../../test/syncGroups.test.ts)）。
 *
 * @module dsh-session-manager/client/syncGroups
 */

import { orderProjectPaths, workspaceTitles, type GroupableWorkspace } from './groups.ts'
import type { Translate } from './locales.ts'

/** 一条计划行来自哪张表：拉（远端 → 本机）还是推（本机 → 远端），决定"项目"取哪个字段。 */
export type SyncSide = 'pull' | 'push'

/**
 * 判断一条计划行属于哪个项目只用得上这三个字段。
 *
 * 三个都是"路径"的意思，区别只在方向：`fromCwd` / `toCwd` 是**拉取**行两端的路径、`cwd` 是
 * **推送**行在本机的位置。刻意不 import `api.ts`：那会把 `src/client` 拉进没有 DOM 的 Host
 * typecheck 工程（同 groups.ts 的说明）。
 */
export interface SyncProjectSubject {
  readonly fromCwd?: string
  readonly toCwd?: string
  readonly cwd?: string
}

/**
 * 一条计划行的分组键：**本机那个目录**的路径，`''` 表示"没有 cwd 的那一组"。
 *
 * @param entry - 计划行（只读那三个路径字段）。
 * @param side - 这张表的方向。
 * @returns 项目路径；`''` 是"没有 cwd"的哨兵（与 `groups.groupKey` 同一套约定）。
 */
export function syncProjectOf(entry: SyncProjectSubject, side: SyncSide): string {
  // 推：本机的 cwd 就是项目，缺 cwd 的会话没有项目可归（落 `_no-cwd` 那一组）。
  if (side === 'push') return entry.cwd ?? ''
  // 拉：先看落地后的本机路径（映射配好了才有）；没有映射时退到远端那一段——那一行说的正是
  // "这个远端项目还没有本机目录"，把它的路径摆在组头上就是用户要补的那条。
  return entry.toCwd ?? entry.fromCwd ?? ''
}

/** 一个项目分组：路径（也是它的身份）、注册表里的标题（未登记就没有）、组内的行。 */
export interface SyncGroup<T> {
  /** 分组键：项目目录的绝对路径；"没有 cwd"那一组是空串。 */
  readonly path: string
  /** 这个目录是已登记工作区时它的标题（只是路径的标签，分组键始终是路径）。 */
  readonly title?: string
  /** 组内的行，**保持调用方给的顺序**（计划本身的顺序）。 */
  readonly rows: readonly T[]
}

/**
 * 按项目分组。
 *
 * 组的顺序与列表那边同一套（已登记工作区 → 其余路径按路径排序 → 没有 cwd 的那一组最后，见
 * `groups.orderProjectPaths`）；组内**不重排**：计划里的先后是宿主算出来的，界面不该再给一个顺序。
 *
 * @param rows - 要分组的行（哪张表的都行）。
 * @param projectOf - 这一行的分组键（通常包着 `syncProjectOf()`）。
 * @param workspaces - `/state` 给出的工作区，只用来把路径翻成标题。
 * @returns 分组后的行。
 */
export function groupSyncRows<T>(
  rows: readonly T[],
  projectOf: (row: T) => string,
  workspaces: readonly GroupableWorkspace[],
): SyncGroup<T>[] {
  const byPath = new Map<string, T[]>()
  for (const row of rows) {
    const path = projectOf(row)
    const group = byPath.get(path)
    if (group === undefined) byPath.set(path, [row])
    else group.push(row)
  }
  const titles = workspaceTitles(workspaces)
  return orderProjectPaths(byPath.keys(), workspaces).map((path) => {
    const title = titles.get(path)
    return {
      path,
      ...(title === undefined ? {} : { title }),
      rows: byPath.get(path) ?? [],
    }
  })
}

/**
 * 拉取一行的悬浮提示：会话名与 id 之后补上"这条的 cwd 从哪改写到哪"。
 *
 * 改写那句话原来占着 cwd 一列，分组之后路径已经在组头上（落地的那个目录），**只有真的改写了**
 * （两端路径不同）才值得补一句：没改写的那一行，它的项目就是路径本身。两边相同、或这条会话本来
 * 没有 cwd 时原样返回。
 *
 * @param entry - 计划行（只读 `fromCwd` / `toCwd`）。
 * @param base - 会话名那一格原来的提示（`planRows.sessionLabel()` 给的）。
 * @param t - 翻译。
 * @returns 悬浮提示文本。
 */
export function syncPullTip(entry: SyncProjectSubject, base: string, t: Translate): string {
  const from = entry.fromCwd
  const to = entry.toCwd
  if (from === undefined || to === undefined || from === to) return base
  return `${base}\n${t('cwdRewritten', { from, to })}`
}
