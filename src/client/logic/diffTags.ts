/**
 * 差异视图的两张"分类"对照表：**关系** → 一枚标签，**种类** → 一枚标签。
 *
 * 为什么单独放在逻辑层：这两张表是纯数据，没有 DOM、没有 React，可以由 `node --test` 直接核——
 * 界面那一层只能靠真实 GUI 量，而"哪个分类该落在哪一档"是**判据**，判据要能被单测钉住。
 *
 * 档位的选择都是语义，不是配色：官方 `Tag` 对每一档都写明了用途（信息分类 / 需要注意 / 中性事实 /
 * 更淡的说法 / 只读默认）。所以：
 *
 * - 三种关系里只有**真分叉**是要人做决定的，落在 `warning`；续写只是信息上的区别（`info`）；完全一致
 *   没什么要做的事，落在最安静的 `quiet`。
 * - 种类那一套沿用内容视图的语义（那边是事件卡左侧那条色边）：用户=品牌蓝（`info`）、助手=灰
 *   （`neutral`）、思考=更淡的灰（`quiet`）、工具调用/结果=琥珀（`warning`）、系统=绿（`success`）、
 *   事件没有专属颜色，留成只读默认（`outline`）。在「内容」页认识的颜色，到这一页还是那个意思。
 * - 两边各一档，且**必须不同**：本机 `info`、远端 `neutral`——两块尾巴要一眼分得开。
 *
 * @module dsh-session-manager/client/logic/diffTags
 */

import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'

import type { DiffRelation } from '../../session-diff.ts'
import type { TranscriptKind } from '../../transcript.ts'
import type { SessionManagerKey } from './locales.ts'

/** 关系 → 档位。 */
export const RELATION_TONE: Record<DiffRelation, TagTone> = {
  same: 'quiet',
  'local-extends': 'info',
  'remote-extends': 'info',
  forked: 'warning',
}

/** 关系 → 文案键。 */
export const RELATION_KEY: Record<DiffRelation, SessionManagerKey> = {
  same: 'sync.diff.relation.same',
  'local-extends': 'sync.diff.relation.extends',
  'remote-extends': 'sync.diff.relation.extends',
  forked: 'sync.diff.relation.forked',
}

/** 一条尾巴属于哪一边（`side` 就是 `session-diff` 那份报告里的两侧）。 */
export type DiffSide = 'local' | 'remote'

/** 哪一边 → 档位（两档不同，两块尾巴才分得开）。 */
export const SIDE_TONE: Record<DiffSide, TagTone> = {
  local: 'info',
  remote: 'neutral',
}

/** 种类 → 档位（与内容视图那条色边同一套语义）。 */
export const KIND_TONE: Record<TranscriptKind, TagTone> = {
  user: 'info',
  assistant: 'neutral',
  reasoning: 'quiet',
  'tool-call': 'warning',
  'tool-result': 'warning',
  system: 'success',
  event: 'outline',
}
