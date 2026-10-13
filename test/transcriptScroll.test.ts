// test/transcriptScroll.test.ts — 会话内容视图跟"滚到哪儿了"有关的两条判断。
//
// 这条判断只有几个数，但它有两道门：人把正文滚到底（滚动区那一层的 scroll），以及读完每一页之后的复查
// （这一页撑不满一屏时，"滚到底"这个动作永远不会发生——整页只有一条超大事件的日志就是这样）。
// 两道门走同一个函数，所以这里把它的四种情形钉死：还差得远不动、贴底就接、撑不满一屏也接、
// 已经在读或者没有下一页时一次都不多发。
//
// 另一条是"画面正中那一条是第几个"（页头右端写着它）：它按纵坐标二分，所以这里既钉边界（缝里算下一条、
// 底下没有了算最后一条），也钉"不多探"——条目多起来时它必须是几次探测，不是整列表读一遍。
import assert from 'node:assert/strict'
import test from 'node:test'

import { NEAR_BOTTOM, centerPosition, shouldLoadMore } from '../src/client/logic/transcriptScroll.ts'

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
