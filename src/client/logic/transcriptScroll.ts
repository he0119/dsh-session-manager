// src/client/logic/transcriptScroll.ts — 会话内容视图跟"滚到哪儿了"有关的两条判断。
//
// 一条是"什么时候去接下一页"：它有两道门，两处都要用它——正文那一层的 scroll（人滚到底了）与读完
// 每一页之后的那次复查（这一页根本撑不满一屏时，"滚到底"这个动作永远发生不了：整页只有一条超大事件的
// 日志就是这样，`maxTotalChars` 把它切在一条上，列表连滚动条都没有）。两处各写一遍迟早会走形。
//
// 另一条是"画面正中那一条是第几个"：页头右端写着它，人滚到哪儿就知道自己读到哪儿了。它按纵坐标二分，
// 不动 DOM。
//
// 没有 DOM 依赖：传进来的是几个数，所以这两条判断能直接用几个数测。

/** 距底多近就算"滚到底了"：留一点提前量，读到那儿就开始接，人不用真的停在最后一行。 */
export const NEAR_BOTTOM = 120

/**
 * 现在该不该去读下一段？
 *
 * 判据只有一条：离底不超过 `NEAR_BOTTOM` 就算到底了。撑不满一屏的容器也落在这一条里（差值是负的），
 * 所以不必为它单开一支。
 *
 * @param box 滚动容器的三条量（`scrollHeight` / `scrollTop` / `clientHeight`）。
 * @param hasMore 解析层还给了 `nextCursor`（没有就是读到日志末尾了）。
 * @param busy 已经有一次读取在路上（不叠第二次）。
 */
export function shouldLoadMore(
  box: { scrollHeight: number; scrollTop: number; clientHeight: number },
  hasMore: boolean,
  busy: boolean,
): boolean {
  if (busy || !hasMore) return false
  return box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM
}

/**
 * 画面正中那一条是哪一个（0 起的位置）。
 *
 * 二分找"下沿越过中心线"的第一条：条目在文档里按顺序排、纵坐标单调（一张卡一行，不并排），所以只要
 * O(log n) 次探测，不必整列表读一遍矩形。中心线落在两张卡之间的缝里时算**下一条**（缝里看到的就是
 * 它）；落到最后一条下面算最后一条，落到第一条上面算第一条。
 *
 * @param count 一共几条。
 * @param bottomOf 第 i 条的下沿（视口坐标）。
 * @param centerY 画面正中那条线（视口坐标）。
 */
export function centerPosition(
  count: number,
  bottomOf: (position: number) => number,
  centerY: number,
): number | undefined {
  if (count <= 0) return undefined
  let low = 0
  let high = count - 1
  /** 先当"在最后一条下面"：没有任何一条的下沿越过中心线时就是它。 */
  let answer = count - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (bottomOf(middle) > centerY) {
      answer = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return answer
}
