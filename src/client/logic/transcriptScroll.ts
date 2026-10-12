// src/client/logic/transcriptScroll.ts — 会话内容视图"什么时候去接下一页"这一条判断。
//
// 单独放一处是因为它有两道门，两处都要用它：正文那一层的 scroll（人滚到底了）与读完每一页之后的
// 那次复查（这一页根本撑不满一屏时，"滚到底"这个动作永远发生不了——整页只有一条超大事件的日志
// 就是这样，`maxTotalChars` 把它切在一条上，列表连滚动条都没有）。两处各写一遍迟早会走形。
//
// 没有 DOM 依赖：传进来的是滚动的三个量，所以这条判断能直接用几个数测。

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
