/**
 * 右栏「远端」那一格画什么（纯函数，判据只此一份）。
 *
 * 三种状态混在这里容易各写一遍：读着、读到了（可能有几处、可能不全）、读不到。把它们收成一份
 * `{ places, note }`，组件只负责摆位置——于是"某台机器的索引没读到时不许说『远端没有』"这条判据
 * 有测试盯着（见 `test/remoteRows.test.ts`），不必靠读 JSX 才发现。
 *
 * @module dsh-session-manager/client/logic/remoteRows
 */

import type { RemotePlacement } from '../api.ts'
import type { RemoteLibraryState } from './remoteLibrary.ts'

/** 那一句要说的话（键名直接给用，文案在 locales.ts）。 */
export type RemoteNoteKey =
  | 'manage.detail.remoteLoading'
  | 'manage.detail.remoteNone'
  | 'manage.detail.remoteFailed'
  | 'manage.detail.remotePartial'

/** 一句话及其占位符。 */
export interface RemoteNote {
  key: RemoteNoteKey
  vars?: { reason: string } | { count: number }
}

/** 这一格的内容：位置清单（可能为空）+ 最多一句说明。 */
export interface RemoteRows {
  places: readonly RemotePlacement[]
  note?: RemoteNote
}

/**
 * 这条会话在远端的那几处，以及该补的一句话。
 *
 * @param state 远端地图现在什么样（`off` 由调用方跳过：没配同步时整行不出现）。
 * @param sessionId 右栏正开着的那条会话。
 * @returns 位置清单与说明。
 */
export function remoteRowsOf(state: RemoteLibraryState, sessionId: string): RemoteRows {
  if (state.status === 'idle' || state.status === 'loading') {
    return { places: [], note: { key: 'manage.detail.remoteLoading' } }
  }
  if (state.status === 'off') {
    // 调用方不画这一行；这里仍然给一句"正在读"，免得任何一个状态落到空白的 `<dd>` 上。
    return { places: [], note: { key: 'manage.detail.remoteLoading' } }
  }
  if (state.status === 'failed') {
    return { places: [], note: { key: 'manage.detail.remoteFailed', vars: { reason: state.error } } }
  }
  const places = state.sessions.get(sessionId) ?? []
  if (state.problems.length > 0) {
    /*
     * 读的时候有机器没读成功：这时候说"远端没有这条会话"可能是假话（它就在那台没读到的机器里）。
     * 所以一律改说"可能不全"，有没有读到别处的位置都这样说。
     */
    return { places, note: { key: 'manage.detail.remotePartial', vars: { count: state.problems.length } } }
  }
  if (places.length === 0) return { places, note: { key: 'manage.detail.remoteNone' } }
  return { places }
}
