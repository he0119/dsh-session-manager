/**
 * 「上次同步没做到的那几条」在界面这一侧怎么读。
 *
 * 两处要用它、判据只该有一份：页头那枚状态的悬浮提示（说清是几条、各是什么）与同步弹窗里那张
 * 「上次同步」的清单（逐条列、带 id 的给「只看这一条」）。
 *
 * 数据有两个来源，形状不一样：新宿主给 `leftovers`（点名版，带会话 id），旧宿主只给 `problems`
 * （几句汇总）。这里退到 `problems` 就够了——那种记录里本来也没有 id 可用。
 *
 * @module dsh-session-manager/client/logic/syncLeftovers
 */

import type { SyncLeftover } from '../api.ts'

/** 能报"没做到"的那两种形状（`SyncResponse` 与 `SyncRunRecord` 都满足）。 */
export interface LeftoverSource {
  leftovers?: readonly SyncLeftover[] | undefined
  problems?: readonly string[] | undefined
}

/**
 * 这一趟"没做到"的条目。
 *
 * 有 `leftovers` 就用它（它已经把 `problems` 那几句收进去了，见宿主 `collectLeftovers()`）；没有就按
 * 汇总句一条一句地列——旧记录里只有这一种。
 *
 * @param source 一次同步的响应，或者磁盘上那条记录（都没有时传 `null`/`undefined`）。
 * @returns 条目清单；一件事都没有时是空数组。
 */
export function leftoversOf(source: LeftoverSource | null | undefined): SyncLeftover[] {
  const detailed = source?.leftovers ?? []
  if (detailed.length > 0) return [...detailed]
  return (source?.problems ?? []).map((message) => ({ message }))
}
