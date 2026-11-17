// test/client/operations/sync/sync-job-label.test.ts — 状态栏那一格「同步」此刻说哪一句。
//
// 为什么在这一层核：那一格 39px、单行，说什么全靠这几个分支；而"跑着"那种状态在冒烟测试的示例数据里种不出来
// （`syncJob` 是产物内部的模块级状态，只能靠真跑一趟同步才会变），所以分支本身必须单独钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { syncBarLabel, type SyncBarSource } from '../../../../src/client/operations/sync/syncJobLabel.ts'
import { emptyTally, foldBarTally, type SyncBarTally } from '../../../../src/client/operations/sync/syncBarTally.ts'
import type { ProgressEvent } from '../../../../src/client/api.ts'

/** 把几条进度事件折成状态栏要的那一份。 */
function tallyOf(...events: ProgressEvent[]): SyncBarTally {
  return events.reduce(foldBarTally, emptyTally())
}

const event = (phase: string, done: number, total: number): ProgressEvent =>
  ({ phase, done, total }) as ProgressEvent

/** 跑着的那一趟（没给事件 = 一条进度都还没到）。 */
function running(...events: ProgressEvent[]): SyncBarSource {
  return { running: true, tally: tallyOf(...events), done: null }
}

test('跑着、在搬会话：报"会话搬到第几条 / 共几条"（拉取那几条并进来）', () => {
  // 先拉 2 条（跑完），再推 7 条、推到第 3 条：一共搬完 2 + 2 = 4 条，这一趟共 9 条。
  const label = syncBarLabel(
    running(event('pull', 0, 2), event('pull', 1, 2), event('push', 0, 7), event('push', 2, 7)),
  )
  assert.deepEqual(label, { key: 'sync.bar.runningSessions', params: { done: 4, total: 9 } })
})

test('跑着、最后一条是认本机仓库：仍报会话那边，不拿目录数当会话数', () => {
  // 这一条就是改了的地方：原来会把 `repo` 那段的 20/21 直接摆出来。
  const label = syncBarLabel(running(event('push', 1, 7), event('repo', 20, 21)))
  assert.deepEqual(label, { key: 'sync.bar.runningSessions', params: { done: 1, total: 7 } })
})

test('跑着、会话与附件对象都在动：两串数一起报', () => {
  const label = syncBarLabel(
    running(event('push', 0, 9), event('attach', 0, 2), event('attach', 1, 2), event('push', 1, 9)),
  )
  // 那批对象在收到推送段下一条事件时已经跑完（2/2），会话那边是第 2 条。
  assert.deepEqual(label, {
    key: 'sync.bar.runningBoth',
    params: { done: 1, total: 9, objectsDone: 2, objectsTotal: 2 },
  })
})

test('跑着、只有附件对象在动（补对象那一趟）：只报附件', () => {
  const label = syncBarLabel(running(event('attach', 0, 2), event('attach', 1, 2)))
  assert.deepEqual(label, { key: 'sync.bar.runningObjects', params: { objectsDone: 1, objectsTotal: 2 } })
})

test('跑着、但一条有分母的进度都还没有（认领来的那趟 / 刚按下）：只说"同步中"', () => {
  assert.deepEqual(syncBarLabel(running()), { key: 'sync.bar.runningUnknown' })
  // 分母是 0 的那一段（读远端索引、写注册表）同样不编一个 0/0。
  assert.deepEqual(syncBarLabel(running(event('remote', 0, 0), event('registry', 0, 0))), {
    key: 'sync.bar.runningUnknown',
  })
})

test('刚跑完：按自己跑的那一趟的两条数组报总条数', () => {
  const label = syncBarLabel({
    running: false,
    tally: emptyTally(),
    done: { ok: true, result: { pulled: [1, 2], pushed: [3] } },
  })
  assert.deepEqual(label, { key: 'sync.bar.done', params: { count: 3 } })
})

test('刚跑完、认领来的那趟：按宿主给的计数报', () => {
  const label = syncBarLabel({
    running: false,
    tally: emptyTally(),
    done: { ok: true, adopted: { pulled: 1, pushed: 0 } },
  })
  assert.deepEqual(label, { key: 'sync.bar.done', params: { count: 1 } })
})

test('跑完但宿主没留下条数：只说"同步完成"，不编一个 0', () => {
  assert.deepEqual(syncBarLabel({ running: false, tally: emptyTally(), done: { ok: true } }), {
    key: 'sync.bar.donePlain',
  })
})

test('失败：说"同步失败"（原因在悬浮提示与同步那一面里）', () => {
  assert.deepEqual(
    syncBarLabel({ running: false, tally: emptyTally(), done: { ok: false, error: '连不上' } }),
    { key: 'sync.bar.failed' },
  )
})

test('没有那一趟：这一格不出现', () => {
  assert.equal(syncBarLabel({ running: false, tally: emptyTally(), done: null }), null)
})
