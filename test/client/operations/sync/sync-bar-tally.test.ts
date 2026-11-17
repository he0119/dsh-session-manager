// test/client/operations/sync/sync-bar-tally.test.ts — 状态栏那两串数怎么从进度事件里折出来。
//
// 为什么在这一层核：状态栏那一格只有 39px，跑着时它报的数是"还剩几条会话要搬"，而宿主推来的最后一条
// 事件可能是 `repo`（本机仓库目录）或 `tidy`（远端包）——那个数字与用户在等的进度无关。折法有三处容易
// 错：换段时要把上一段的总数并进来、附件对象是按会话一批一批来的、其余各段一个数都不该动。这三处
// 在界面冒烟里都种不出来（`syncJob` 是产物内部的模块级状态，只有真跑一趟同步才变），所以单独钉。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachmentTallyOf,
  emptyTally,
  foldBarTally,
  type SyncBarTally,
} from '../../../../src/client/operations/sync/syncBarTally.ts'
import type { ProgressEvent } from '../../../../src/client/api.ts'

const event = (phase: string, done: number, total: number): ProgressEvent =>
  ({ phase, done, total }) as ProgressEvent

/** 把一串事件折成一个结果（真实那一路也是一条一条折的）。 */
const fold = (events: readonly ProgressEvent[], from: SyncBarTally = emptyTally()): SyncBarTally =>
  events.reduce(foldBarTally, from)

test('拉取那一段：报这一段的第几条 / 共几条', () => {
  const tally = fold([event('pull', 0, 3), event('pull', 1, 3), event('pull', 2, 3)])
  assert.deepEqual(tally.sessions, { done: 2, total: 3 })
  assert.equal(attachmentTallyOf(tally), null, '一段附件事件都没有时不提附件')
})

test('拉取跑完接着推送：上一段的条数并进来，分母是这一趟要搬的会话总数', () => {
  const tally = fold([
    event('pull', 0, 3),
    event('pull', 2, 3),
    event('push', 0, 84),
    event('push', 1, 84),
  ])
  // 拉取那 3 条已经搬完（换段了），推送段又搬完 1 条：4 / 87——不是 1 / 84，也不是 85。
  assert.deepEqual(tally.sessions, { done: 4, total: 87 })
})

test('只有推送的一段（本机没有要拉的）：分母就是推送的条数', () => {
  const tally = fold([event('push', 0, 5), event('push', 4, 5)])
  assert.deepEqual(tally.sessions, { done: 4, total: 5 })
})

test('附件对象按会话一批一批来：前面几批处理完的并进来，分母跟着补齐', () => {
  const tally = fold([
    // 第一条会话引用 3 个对象。
    event('attach', 0, 3),
    event('attach', 1, 3),
    event('attach', 2, 3),
    // 第二条会话引用 2 个：`done === 0` 就是新的一批，上一批算处理完。
    event('attach', 0, 2),
    event('attach', 1, 2),
  ])
  assert.deepEqual(attachmentTallyOf(tally), { done: 4, total: 5 })
})

test('附件那一批跑完之后界面又动了别的段：整批算完，不停在最后一格', () => {
  const tally = fold([
    event('attach', 0, 3),
    event('attach', 1, 3),
    event('attach', 2, 3),
    // 这一批的最后一条（"开始处理第 3 个"）来了，接着回到会话那一段。
    event('push', 5, 9),
  ])
  assert.deepEqual(attachmentTallyOf(tally), { done: 3, total: 3 })
})

test('前后两批对象个数一样多：靠 done 回到 0 认出新的一批', () => {
  const tally = fold([
    event('attach', 0, 2),
    event('attach', 1, 2),
    event('attach', 0, 2),
    event('attach', 1, 2),
    event('push', 1, 4),
  ])
  assert.deepEqual(attachmentTallyOf(tally), { done: 4, total: 4 })
})

test('会话与附件对象各记各的：两条进度互不覆盖', () => {
  const tally = fold([event('push', 0, 10), event('attach', 0, 2), event('attach', 1, 2), event('push', 1, 10)])
  assert.deepEqual(tally.sessions, { done: 1, total: 10 })
  assert.deepEqual(attachmentTallyOf(tally), { done: 2, total: 2 })
})

test('算计划那几段（扫库、认仓库、比对、读远端索引）一个数都不动', () => {
  const before = fold([event('pull', 0, 4), event('push', 1, 9)])
  for (const phase of ['scan', 'remote', 'repo', 'compare', 'relate', 'backup', 'registry', 'tidy', 'warm']) {
    const after = foldBarTally(before, event(phase, 7, 21))
    assert.equal(after, before, `${phase} 那一段不该改状态栏上的数`)
  }
})

test('分母是 0 的事件什么都不改：不编一个 0/0', () => {
  const before = emptyTally()
  assert.equal(foldBarTally(before, event('pull', 0, 0)), before)
  assert.equal(foldBarTally(before, event('attach', 0, 0)), before)
})

test('新的一趟从空的一份开始：上一趟的数不会漏到下一趟', () => {
  const tally = fold([event('pull', 0, 3)])
  const fresh = emptyTally()
  assert.notEqual(fresh, tally, '每次都是一份新的对象，改一份不会动到另一份')
  assert.deepEqual(fresh, { phase: null, carried: 0, sessions: null, objectsBase: 0, objects: null })
})
