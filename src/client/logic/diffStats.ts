/**
 * 差异视图"两边 / 计数"的呈现判据：两条尾巴**都要**出块（0 条那块也报一句），顶部三格计数把账摆全。
 *
 * 为什么钉这一条：零条那半块整块不渲染时，分类只剩一侧——「远端独有 0 条」这句结论是隐形的，看着
 * 像"这一侧还没查"。摆出来之后，一页里三条分类（共同 / 本机独有 / 远端独有）都在，0 也是数字。
 *
 * 顺序固定：本机那块在前、远端在后，与三格计数同一个方向（共同 / 本机独有 / 远端独有）。
 *
 * @module dsh-session-manager/client/logic/diffStats
 */

import type { DiffTail, SessionDiff } from '../../session-diff.ts'
import type { SessionManagerKey } from './locales.ts'
import type { DiffSide } from './diffTags.ts'

/** 一边一块：两块都在，0 条那块也进列表（空块的那句说明由界面给）。 */
export type SideBlock = { side: DiffSide; tail: DiffTail }

export function sideBlocks(diff: SessionDiff): SideBlock[] {
  return [
    { side: 'local', tail: diff.localTail },
    { side: 'remote', tail: diff.remoteTail },
  ]
}

/** 顶部三格：共同 / 本机独有 / 远端独有。 */
export type StatKey = 'common' | 'local' | 'remote'
export type StatCell = { key: StatKey; count: number }

export const STAT_KEY: Record<StatKey, SessionManagerKey> = {
  common: 'sync.diff.stat.common',
  local: 'sync.diff.stat.local',
  remote: 'sync.diff.stat.remote',
}

/**
 * 0 条那一侧该说的那句话。
 *
 * 两侧分开：只说「这一侧没有多出来的」，读的人不知道是本机还是远端——两块长得一样，光靠位置猜不算
 * 说清楚。
 */
export type TailEmptyKey = 'sync.diff.tail.empty.local' | 'sync.diff.tail.empty.remote'

export function tailEmptyKey(side: DiffSide): TailEmptyKey {
  return side === 'local' ? 'sync.diff.tail.empty.local' : 'sync.diff.tail.empty.remote'
}

export function statCells(diff: SessionDiff): StatCell[] {
  return [
    { key: 'common', count: diff.common },
    { key: 'local', count: diff.localTail.count },
    { key: 'remote', count: diff.remoteTail.count },
  ]
}
