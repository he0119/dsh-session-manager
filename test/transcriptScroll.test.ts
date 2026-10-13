// test/transcriptScroll.test.ts — 会话内容视图跟"滚到哪儿了"有关的两条判断。
//
// 这条判断只有几个数，但它有两道门：人把正文滚到底（滚动区那一层的 scroll），以及读完每一页之后的复查
// （这一页撑不满一屏时，"滚到底"这个动作永远不会发生——整页只有一条超大事件的日志就是这样）。
// 两道门走同一个函数，所以这里把它的四种情形钉死：还差得远不动、贴底就接、撑不满一屏也接、
// 已经在读或者没有下一页时一次都不多发。
//
// 另一条是"画面正中那一条是第几个"（页头右端写着它）：它按纵坐标二分，所以这里既钉边界（缝里算下一条、
// 底下没有了算最后一条），也钉"不多探"——条目多起来时它必须是几次探测，不是整列表读一遍；还钉折起来的
// 轮次里的那些卡不算（它们的矩形可能全是 0，也可能照旧占着位置，两种都会让"顺序单调"这个前提不成立）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { NEAR_BOTTOM, centerCard, centerPosition, shouldLoadMore } from '../src/client/logic/transcriptScroll.ts'

/** 滚动容器的三条量。1000 高的内容配 300 高的视口时，`scrollTop = 700` 就是真的到底了。 */
const box = (scrollTop: number) => ({ scrollHeight: 1000, scrollTop, clientHeight: 300 })
const bottom = 1000 - 300

test('贴底（留了一点提前量）就去接下一页', () => {
  assert.equal(shouldLoadMore(box(bottom), true, false), true, '真的到底了')
  assert.equal(shouldLoadMore(box(bottom - NEAR_BOTTOM), true, false), true, '还差一个提前量')
  assert.equal(shouldLoadMore(box(bottom - NEAR_BOTTOM - 1), true, false), false, '差得更多就再等等')
  assert.equal(shouldLoadMore(box(0), true, false), false, '人在顶上')
})

test('撑不满一屏时也接下一页，否则那一页之后没有下一步', () => {
  const oneHugeEvent = { scrollHeight: 200, scrollTop: 0, clientHeight: 300 }
  assert.equal(shouldLoadMore(oneHugeEvent, true, false), true)
})

test('已经在读、或者没有下一页时一次都不多发', () => {
  assert.equal(shouldLoadMore(box(bottom), true, true), false, '有一次读取在路上')
  assert.equal(shouldLoadMore(box(bottom), false, false), false, '解析层没给 nextCursor，就是读完了')
  assert.equal(shouldLoadMore({ scrollHeight: 200, scrollTop: 0, clientHeight: 300 }, false, false), false)
})

/** 每张卡 60 高、间隔 8，于是第 i 条的下沿是 `(i + 1) * 68 - 8`。 */
const cardBottom = (position: number) => (position + 1) * 68 - 8

test('画面正中那条线落在哪一张卡上，就报哪一条', () => {
  assert.equal(centerPosition(10, cardBottom, 30), 0, '第一条中间')
  assert.equal(centerPosition(10, cardBottom, 100), 1, '第二条中间')
  assert.equal(centerPosition(10, cardBottom, 0), 0, '第一条上面（顶上那一屏还没滚）')
  assert.equal(centerPosition(10, cardBottom, 5000), 9, '最后一条下面（底下没有更多了）')
})

test('正中那条线落在两张卡之间的缝里，算下一条', () => {
  // 第 0 条占 0..60，缝是 60..68
  assert.equal(centerPosition(10, cardBottom, 60), 1, '正好贴在第 0 条下沿：往缝里看，看到的是第 1 条')
  assert.equal(centerPosition(10, cardBottom, 64), 1, '缝中间')
  assert.equal(centerPosition(10, cardBottom, 59), 0, '还差一点没出第 0 条')
})

test('一条都没有时报 undefined，条数多的时候也不整列表探一遍', () => {
  assert.equal(centerPosition(0, cardBottom, 100), undefined)
  let probes = 0
  const counted = (position: number): number => {
    probes += 1
    return cardBottom(position)
  }
  assert.equal(centerPosition(1000, counted, 34_000), 500)
  assert.ok(probes <= 12, `二分最多十来次探测，实际 ${String(probes)} 次`)
})

test('折起来的轮次里的卡不算进"画面正中"', () => {
  /** 四条卡：0、1、2、3，每条 68 高、间隔 8，下沿依次 60、128、196、264。 */
  const card = (index: number, folded = false) => ({
    index,
    bottom: (index + 1) * 68 - 8,
    height: 68,
    folded,
  })
  assert.equal(centerCard([card(0), card(1), card(2), card(3)], 30), 0, '第一条中间')
  // 第 1 条折起来：0 的下沿是 60，中心线 100 越过它，下一条看得见的是 2（下沿 196）
  assert.equal(centerCard([card(0), card(1, true), card(2), card(3)], 100), 2)
  assert.equal(centerCard([card(0), card(1, true), card(2), card(3)], 200), 3, '第三条中间')
})

test('浏览器没把折起来的内容移出排版时，也不能让它算进画面正中', () => {
  const keepingLayout = { index: 1, bottom: 128, height: 68, folded: true }
  const cards = [
    { index: 0, bottom: 60, height: 68, folded: false },
    keepingLayout,
    { index: 2, bottom: 196, height: 68, folded: false },
  ]
  assert.equal(centerCard(cards, 100), 2, '它折着就不算，即便矩形还占着位置')

  // 另一头：浏览器把内容藏得没有排版（矩形全 0）时，`closest()` 那条看不出差别，得靠高度剔掉。
  // 中心线落在末尾那一段没有矩形的卡上时，能看出剔没剔：留着它们，末尾的"最后一条"会落到没排版的卡上。
  const noLayout = [
    { index: 0, bottom: 60, height: 68, folded: false },
    { index: 1, bottom: 128, height: 68, folded: false },
    { index: 2, bottom: 0, height: 0, folded: false },
    { index: 3, bottom: 0, height: 0, folded: false },
  ]
  assert.equal(centerCard(noLayout, 100), 1, '没有矩形的卡不算，报最后一条看得见的')
  assert.equal(centerCard(noLayout, 300), 1, '中心线跑到它们后面时也一样')
})

test('整份都折起来、或者一条都没有时，没有"画面正中"这一条', () => {
  assert.equal(centerCard([{ index: 0, bottom: 60, height: 68, folded: true }], 30), undefined)
  assert.equal(centerCard([], 30), undefined)
})
