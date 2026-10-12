// test/transcriptScroll.test.ts — 会话内容视图"什么时候去接下一页"这一条判断。
//
// 这条判断只有几个数，但它有两道门：人把正文滚到底（滚动区那一层的 scroll），以及读完每一页之后的复查
// （这一页撑不满一屏时，"滚到底"这个动作永远不会发生——整页只有一条超大事件的日志就是这样）。
// 两道门走同一个函数，所以这里把它的四种情形钉死：还差得远不动、贴底就接、撑不满一屏也接、
// 已经在读或者没有下一页时一次都不多发。
import assert from 'node:assert/strict'
import test from 'node:test'

import { NEAR_BOTTOM, shouldLoadMore } from '../src/client/logic/transcriptScroll.ts'

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
