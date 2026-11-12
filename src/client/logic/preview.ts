// src/client/logic/preview.ts — 右栏「开头两轮」那一段的取法。
//
// 为什么不把整份时间线交给右栏：这一栏宽 340px，读者只想知道"这条在聊什么"。整份时间线里有思考块、
// 工具入参与结果、系统事件，铺进来会把两轮对话埋掉；所以只取前两轮，每轮各留一条人的消息与一条
// 助手的回答，其余由「打开完整内容」负责。
//
// 轮次的边界与内容视图共用同一套规则（[transcriptTurns.ts](./transcriptTurns.ts)）：`turn/start`
// 开一节、`turn/end` 收掉。这一层只做"从一节里挑哪两条"，不另判轮次。

import type { TranscriptItem } from '../../transcript.ts'
import { turnSections } from './transcriptTurns.ts'

/** 右栏里的一轮：一条人的消息 + 一条助手的回答，都可能是空的。 */
export interface PreviewTurn {
  /** 日志里那个轮次号（原样显示，不重排）。 */
  turn: number
  /** 人发的消息；这一轮没有（或只有标题模型那种合成消息）时为 null。 */
  user: string | null
  /** 这一轮最后一条有文字的助手消息；没有文字回答时为 null。 */
  answer: string | null
}

/** 取前几轮；库里绝大多数会话两轮就够看出在聊什么。 */
export const PREVIEW_TURNS = 2

/** 一条条目有没有可摆出来的文字（空串与纯空白都算没有）。 */
function spoken(item: TranscriptItem): string | null {
  if (typeof item.text !== 'string') return null
  const text = item.text.trim()
  return text === '' ? null : text
}

/**
 * 从一页条目里取前两轮。
 *
 * 只认**人发**的用户消息（`synthetic` 是标题模型那种调用，不是人说的话）；助手的回答取这一轮里
 * **最后**一条有文字的，前面那些流式片段不再重复。轮次之外的条目（建会话、选模型、末尾收尾）不单独
 * 成段；整页一条轮次都没有时，退回"第一条人的消息 + 第一条回答"，至少能看出这条是不是空的。
 */
export function previewTurns(
  items: readonly TranscriptItem[],
  maxTurns: number = PREVIEW_TURNS,
  dropPartialLast: boolean = false,
): PreviewTurn[] {
  const sections = turnSections(items).filter((section) => section.turn !== undefined)
  const hadTurns = sections.length > 0
  // 这一页正好切在第二轮中间：没有 `turn/end` 的最后一节只有半句话（往往还是"我先改一下"的过渡句），
  // 不如不摆。日志本身在下一轮没结束时也缺 `turn/end`（被打断），所以只在“后面还有页”时丢。
  if (
    dropPartialLast &&
    sections.length > 0 &&
    !sections[sections.length - 1].items.some((item) => item.type === 'turn/end')
  ) {
    sections.pop()
  }
  const turns: PreviewTurn[] = []
  for (const section of sections) {
    if (section.turn === undefined) continue
    const user = section.items
      .filter((item) => item.kind === 'user' && item.synthetic !== true)
      .map(spoken)
      .find((text) => text !== null)
    const answer = [...section.items]
      .reverse()
      .filter((item) => item.kind === 'assistant')
      .map(spoken)
      .find((text) => text !== null)
    turns.push({ turn: section.turn, user: user ?? null, answer: answer ?? null })
    if (turns.length >= maxTurns) break
  }
  if (turns.length > 0) return turns
  // 原本有轮次、只是最后那一节被当成半截丢掉了：不再退回整页——那会把同一段半句话又捡回来。
  if (hadTurns) return []

  // 没有轮次边界（老日志、或这一页刚好只到开场）：退回整页的第一条人的消息与第一条回答。
  const user = items
    .filter((item) => item.kind === 'user' && item.synthetic !== true)
    .map(spoken)
    .find((text) => text !== null)
  const answer = items
    .filter((item) => item.kind === 'assistant')
    .map(spoken)
    .find((text) => text !== null)
  return user === undefined && answer === undefined
    ? []
    : [{ turn: 1, user: user ?? null, answer: answer ?? null }]
}
