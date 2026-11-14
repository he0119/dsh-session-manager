/**
 * 「会话」页平铺表格的两件纯逻辑：按项目筛、按表头那一列排。
 *
 * 单独拎出来是为了能直接测：排序与筛选错了不会抛错、也不会崩，只会让"我明明按大小排了"变成一句谎话，
 * 而界面冒烟（假 React 钩子点不动表头）照不到这种错。界面只负责把结果画出来。
 *
 * @module dsh-session-manager/client/logic/manageRows
 */

import { sessionLabel } from './planRows.ts'

/** 表头能排的三列。 */
export type SessionSortKey = 'time' | 'size' | 'title'

/** 当前排的是哪一列、朝哪个方向。 */
export interface SessionSort {
  readonly key: SessionSortKey
  readonly dir: 'asc' | 'desc'
}

/** 排与筛要读的那几个字段（`SessionSummary` 与测试夹具都满足它）。 */
export interface SortableSession {
  readonly id: string
  readonly title?: string
  readonly createdAt: number
  readonly bytes: number
  readonly cwd?: string
}

/** 换个方向时的默认值：时间与大小默认从大到小，标题默认从 A 到 Z。 */
export function defaultDir(key: SessionSortKey): 'asc' | 'desc' {
  return key === 'title' ? 'asc' : 'desc'
}

/**
 * 只看一个项目。
 *
 * @param rows 全部会话。
 * @param path 项目目录；`null` = 全部。没有 cwd 的那一组用空串（与 `groups.ts` 的分组键同一个约定）。
 */
export function sessionsInProject<T extends { cwd?: string }>(rows: readonly T[], path: string | null): T[] {
  if (path === null) return [...rows]
  return rows.filter((row) => (row.cwd ?? '') === path)
}

/**
 * 按表头那一列排。
 *
 * 标题读的是行上显示的那一个称呼（`sessionLabel()`：有标题用标题、没有就用 id），所以"按标题排"与
 * 眼睛看到的顺序一致。同名时再按 id 定序，免得同一毫秒的两条每次刷新都换位置。
 *
 * @param rows 要排的那些。
 * @param sort 列与方向。
 * @returns 新数组（不改入参）。
 */
export function sortSessions<T extends SortableSession>(rows: readonly T[], sort: SessionSort): T[] {
  const direction = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    if (sort.key === 'size') return (left.bytes - right.bytes) * direction
    if (sort.key === 'title') {
      const order = sessionLabel(left).text.localeCompare(sessionLabel(right).text, 'zh')
      return (order === 0 ? left.id.localeCompare(right.id) : order) * direction
    }
    return (left.createdAt - right.createdAt) * direction
  })
}

/** 项目行上那枚勾选框的三态。 */
export interface GroupPickState {
  readonly checked: boolean
  readonly indeterminate: boolean
  /** 这一组里有没有能单独勾的行；没有就不画勾选框。 */
  readonly available: boolean
}

/**
 * 项目行勾选框的状态：只看**传进来的这些行**（界面按"当前筛出来的"传），能单独勾的才算。
 *
 * 勾了一部分时给 indeterminate（横杠），不是一律画成没勾：否则"我勾了两条，这一组看起来像没动过"。
 * 一条可勾的都没有（空组，或整组都是跟着父会话走的子智能体）时 `available: false`——画一个点不动的
 * 勾选框只是噪音。
 *
 * @param rows 这一组眼下列出来的行。
 * @param picked 已选 id。
 * @param selectable 这一行能不能单独勾（子智能体不能）。
 */
export function groupPickState<T extends { id: string }>(
  rows: readonly T[],
  picked: readonly string[],
  selectable: (row: T) => boolean,
): GroupPickState {
  const choices = rows.filter(selectable)
  const chosen = choices.filter((row) => picked.includes(row.id)).length
  return {
    checked: choices.length > 0 && chosen === choices.length,
    indeterminate: chosen > 0 && chosen < choices.length,
    available: choices.length > 0,
  }
}

/**
 * 把子智能体折到父会话下面：列表里只留"顶层"那些行，子智能体挂在父行上按需展开。
 *
 * 判据只有 header 里的两条：`origin === "subagent"` 是子智能体，`parentSession` 是它的父。父**不在
 * 这一份里**（被筛掉、被搜索排掉、在别的项目里）时，子智能体自己就是顶层——折起来就等于让它消失，
 * 而这一页恰恰是唯一能收拾它的地方。
 *
 * 展开状态不在这里：这一层只回答"谁挂谁下面"，展开与否由界面拿着（默认全收）。
 *
 * @param rows 已经筛过、排过的那一份。
 * @returns `roots`（顶层行，保持原顺序）、`childrenOf`（父 id → 直接子行，保持原顺序）。
 */
export function foldSubagents<
  T extends { id: string; origin?: string; parentSession?: string; cwd?: string },
>(rows: readonly T[]): { roots: T[]; childrenOf: Map<string, T[]> } {
  const byParent = new Map(rows.map((row) => [row.id, row]))
  const childrenOf = new Map<string, T[]>()
  const foldedIds = new Set<string>()
  for (const row of rows) {
    if (row.origin !== 'subagent') continue
    const parentId = row.parentSession
    if (parentId === undefined || parentId === '') continue
    const parent = byParent.get(parentId)
    // 父不在这份清单里（被筛掉、被搜掉）就自己当顶层；父在**别的项目**里也别折过去——折过去子行
    // 会跑到父那一行底下，看着像长在那个项目里。那两条挂在「父在别处」的备注上（见 ManagePanel）。
    if (parent === undefined) continue
    if ((parent.cwd ?? '') !== (row.cwd ?? '')) continue
    const siblings = childrenOf.get(parentId)
    if (siblings === undefined) childrenOf.set(parentId, [row])
    else siblings.push(row)
    foldedIds.add(row.id)
  }
  return { roots: rows.filter((row) => !foldedIds.has(row.id)), childrenOf }
}
