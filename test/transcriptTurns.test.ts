// test/transcriptTurns.test.ts — 会话内容视图"一节到哪儿为止"的规则。
//
// 折叠把这件事变成了看得见的行为：节切错了，折起来的就不只是那一轮。这里钉的是边界来自日志
// （`turn/start` 开、`turn/end` 收）而不是"`turn` 字段相等"——真实日志里大多数事件不带 `turn`，
// 照字段切会把一轮劈成好几节。
import assert from 'node:assert/strict'
import test from 'node:test'

import { turnSections } from '../src/client/logic/transcriptTurns.ts'

/** 一条事件：`turn` 只有一部分事件带（这正是这条规则存在的理由）。 */
const at = (type: string, index: number, turn?: number) => (turn === undefined ? { type, index } : { type, index, turn })
/** 一节切成了什么样：`turn` + 各条的 index。 */
const shape = (sections: ReadonlyArray<{ turn: number | undefined; items: ReadonlyArray<{ index: number }> }>) =>
  sections.map((section) => [section.turn, section.items.map((one) => one.index)])

test('turn/start 到 turn/end 之间的都进这一节，中间不带 turn 的也算', () => {
  const sections = turnSections([
    at('user/message', 0),
    at('turn/start', 1, 1),
    at('step/start', 2, 1),
    at('user/message', 3),
    at('tool/call', 4),
    at('turn/end', 5, 1),
  ])
  assert.deepEqual(
    shape(sections),
    [
      [undefined, [0]],
      [1, [1, 2, 3, 4, 5]],
    ],
    '不带 turn 的那几条仍在第 1 轮里：它们是这一轮发生的事',
  )
})

test('一轮收掉之后、下一轮开始之前的是自己一节', () => {
  const sections = turnSections([
    at('turn/start', 0, 1),
    at('turn/end', 1, 1),
    at('session/end-seed', 2),
    at('turn/start', 3, 2),
    at('turn/end', 4, 2),
    at('session/end-seed', 5),
  ])
  assert.deepEqual(shape(sections), [
    [1, [0, 1]],
    [undefined, [2]],
    [2, [3, 4]],
    [undefined, [5]],
  ])
})

test('没有 turn/end 的一轮：下一个 turn/start 就是它的边界', () => {
  const sections = turnSections([
    at('turn/start', 0, 1),
    at('assistant/message', 1),
    at('turn/start', 2, 2),
    at('turn/end', 3, 2),
  ])
  assert.deepEqual(
    shape(sections),
    [
      [1, [0, 1]],
      [2, [2, 3]],
    ],
    '轮次被中断（日志里没有 turn/end）时不能把它后面的都吞进来',
  )
})

test('turn 是 0 也算一轮（假值不是"没有轮次"）', () => {
  const sections = turnSections([at('turn/start', 0, 0), at('turn/end', 1, 0)])
  assert.deepEqual(sections.map((section) => section.turn), [0])
})

test('空输入、通篇没有轮次、单条都不出岔子', () => {
  assert.deepEqual(turnSections([]), [])
  assert.deepEqual(shape(turnSections([at('permission/preset', 0), at('model/selection', 1)])), [
    [undefined, [0, 1]],
  ])
  assert.deepEqual(shape(turnSections([at('session/end-seed', 7)])), [[undefined, [7]]])
})
