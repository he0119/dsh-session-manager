/**
 * "多久以前"那句话：页头那枚同步状态用它说"上一趟同步在什么时候"。
 *
 * 为什么是纯函数、只回键与数字：文案在字典里（`time.*`），这一层只判档位——判据能单独测，界面上不会
 * 出现"3 分钟前"和"3分钟前"两种写法。
 *
 * 档位：不到 1 分钟是"刚刚"，不到 1 小时按分钟，不到 24 小时按小时，再往上按天（不封顶：45 天前就写
 * 45 天前，比"很久以前"诚实）。
 *
 * @module dsh-session-manager/client/logic/relativeTime
 */

import type { Translate } from './locales.ts'

/** 一句话的档位：键 + 数量（"刚刚"没有数量）。 */
export type RelativeLabel =
  | { key: 'time.justNow' }
  | { key: 'time.minutes' | 'time.hours' | 'time.days'; count: number }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 把两个时刻的差折成一句话。
 *
 * 未来（时钟不同步、记录比现在还晚）按"刚刚"处理：说"−3 分钟前"没有意义，也不该让它变成一句报错。
 *
 * @param then 那个时刻（毫秒）。
 * @param now 现在（毫秒）。
 * @returns 档位与数量。
 */
export function relativeLabel(then: number, now: number): RelativeLabel {
  const gap = now - then
  if (!Number.isFinite(gap) || gap < MINUTE) return { key: 'time.justNow' }
  if (gap < HOUR) return { key: 'time.minutes', count: Math.floor(gap / MINUTE) }
  if (gap < DAY) return { key: 'time.hours', count: Math.floor(gap / HOUR) }
  return { key: 'time.days', count: Math.floor(gap / DAY) }
}

/**
 * 把"多久以前"直接翻成一句话。
 *
 * 页头那枚同步状态与「上次同步」那张清单都要说同一件事，句子只该有一套拼法：档位仍由上面那个纯函数判，
 * 这里只把键交给字典。
 *
 * @param t 翻译函数。
 * @param at 那个时刻（ISO 8601；解不出来时按"刚刚"说，不编一个负数）。
 * @param now 现在（毫秒，缺省取当下）。
 * @returns 一句"3 小时前"。
 */
export function agoLabel(t: Translate, at: string, now = Date.now()): string {
  const label = relativeLabel(Date.parse(at), now)
  return label.key === 'time.justNow' ? t('time.justNow') : t(label.key, { count: label.count })
}
