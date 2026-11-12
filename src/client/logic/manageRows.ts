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
