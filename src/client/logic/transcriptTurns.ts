// src/client/logic/transcriptTurns.ts — 会话内容视图按"回合"分节的规则。
//
// 节的边界由日志自己说：`turn/start` 开一节，`turn/end` 收掉它。为什么不按"`turn` 字段相等"切：
// 那个字段只有一部分事件带（`turn/start`、`step/start`、`system/message` 这种有，`user/message`、
// 工具调用与结果、`agent/inbox/spliced` 大多没有），照它切会把一回合劈成好几节、标题重复出现，
// 折起来也会把同一回合的另一半留在外面。
//
// 一回合之外的那些（开头建会话、选模型、写权限，末尾的会话收尾）自己成一节：它们没有标题可折，
// 视图照原样摆出来。回合被中断、日志里没有 `turn/end` 时，下一个 `turn/start` 或日志末尾就是它的边界。

/** 一节：同一个回合的那些条目（`turn` 缺席表示这批不属于任何一回合）。 */
export interface TranscriptSection<T> {
  turn: number | undefined
  items: T[]
}

/**
 * 按回合切节，顺序与条目顺序一致。
 *
 * @param items 已经过筛选、按事件顺序排好的条目。
 */
export function turnSections<T extends { turn?: number; type: string }>(
  items: readonly T[],
): Array<TranscriptSection<T>> {
  const sections: Array<TranscriptSection<T>> = []
  /** 正在积累的那一节（`turn/end` 一到就收掉）。 */
  let open: TranscriptSection<T> | undefined
  for (const item of items) {
    if (item.type === 'turn/start' && item.turn !== undefined) {
      open = { turn: item.turn, items: [item] }
      sections.push(open)
      continue
    }
    if (open !== undefined) {
      open.items.push(item)
      if (item.type === 'turn/end') open = undefined
      continue
    }
    const last = sections[sections.length - 1]
    if (last !== undefined && last.turn === undefined) last.items.push(item)
    else sections.push({ turn: undefined, items: [item] })
  }
  return sections
}
