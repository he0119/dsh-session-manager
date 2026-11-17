/**
 * 「上次同步没做到的那几条」在界面这一侧怎么读。
 *
 * 三处要用它、判据只该有一份：页头那枚状态的悬浮提示（说清是几条）、同步弹窗里那张「上次同步」的
 * 清单（按原因分组、逐条列、带 id 的给「只看这一条」）、以及同步跑完的结果页。
 *
 * 数据有两个来源，形状不一样：新宿主给 `leftovers`（点名版，带会话 id、原因分类与拆开的两半），旧宿主
 * 只给 `problems`（几句汇总）。这里退到 `problems` 就够了——那种记录里本来也没有 id 与分类可用。
 *
 * 分组只认 `kind`，不解析句子：宿主在造计划行的同时就把原因记下了（见 `SyncBlockReason`），句子改个
 * 措辞不会让清单跑到另一组去。认不出的分类一律落到「其它问题」，所以旧记录与以后新增的分类都画得出来。
 *
 * @module dsh-session-manager/client/operations/sync/syncLeftovers
 */

import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SessionManagerKey } from '../../shared/i18n/locales.ts'
import type { SyncLeftover, SyncLeftoverKind } from '../../api.ts'

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

/** 清单上一组：同一类原因的那几条。 */
export interface LeftoverGroup {
  key: SyncLeftoverKind
  items: SyncLeftover[]
}

/**
 * 分组的次序 = 用户下一步该做什么的顺序。
 *
 * 缺附件的会话缺内容（得等持有对象的那台机器推）、两边都写过的要做裁决、正开着的那条要重启 DSH、
 * 目录或映射对不上的要去改配置。四件事没有轻重之分，但「要补 / 要裁决」排前面，读的人先看到最要紧的
 * 两类。
 */
const GROUP_ORDER: readonly SyncLeftoverKind[] = ['attachment', 'fork', 'live', 'path', 'other']

/** 宿主给过、这一版认识的分类。认不出的（以后新增的）按「其它问题」画，不丢条目。 */
const KNOWN_KINDS: ReadonlySet<string> = new Set(GROUP_ORDER)

/**
 * 这一条落在哪一组。
 *
 * @param item 一条「没做到」。
 * @returns 分组键；`kind` 缺失或认不出时是 `other`。
 */
export function leftoverGroupOf(item: SyncLeftover): SyncLeftoverKind {
  return item.kind !== undefined && KNOWN_KINDS.has(item.kind) ? item.kind : 'other'
}

/**
 * 把条目按原因分组，空组不画；组内保持宿主给的顺序。
 *
 * @param items 一次同步的全部「没做到」。
 * @returns 按 {@link GROUP_ORDER} 排好的组。
 */
export function groupLeftovers(items: readonly SyncLeftover[]): LeftoverGroup[] {
  const buckets = new Map<SyncLeftoverKind, SyncLeftover[]>()
  for (const item of items) {
    const key = leftoverGroupOf(item)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [item])
    else bucket.push(item)
  }
  return GROUP_ORDER.flatMap((key) => {
    const bucket = buckets.get(key)
    return bucket === undefined ? [] : [{ key, items: bucket }]
  })
}

/** 每组默认只摆前几条：50 条的清单一次铺开，读的人找不到开头（展开由界面管）。 */
export const LEFTOVER_PREVIEW = 3

/** 分组键 → 那一枚标签上的话。 */
export const LEFTOVER_KEY: Record<SyncLeftoverKind, SessionManagerKey> = {
  attachment: 'sync.leftovers.group.attachment',
  fork: 'sync.leftovers.group.fork',
  live: 'sync.leftovers.group.live',
  path: 'sync.leftovers.group.path',
  other: 'sync.leftovers.group.other',
}

/**
 * 分组键 → 标签档位。
 *
 * 档位是语义，不是配色：缺附件与两边都写过都是"要注意、还不是失败"（`warning`）；正开着只是这一趟
 * 暂时绕开的分类（`info`）；目录或映射配错了同样要注意（`warning`）；「其它问题」是中性事实
 * （`neutral`）。四个具体分类不必四套颜色——组头的字本身就说得清，颜色只用来分"注意 / 信息 / 中性"。
 */
export const LEFTOVER_TONE: Record<SyncLeftoverKind, TagTone> = {
  attachment: 'warning',
  fork: 'warning',
  live: 'info',
  path: 'warning',
  other: 'neutral',
}
