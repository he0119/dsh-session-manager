// test/sync-job-label.test.ts — 状态栏那一格「同步」此刻说哪一句。
//
// 为什么在这一层核：那一格 39px、单行，说什么全靠这四个分支；而"跑着"那种状态在冒烟夹具里种不出来
// （`syncJob` 是产物内部的模块级状态，只能靠真跑一趟同步才会变），所以分支本身必须单独钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { syncBarLabel } from '../src/client/logic/syncJobLabel.ts'

test('跑着、而且有逐条进度：报第几条 / 共几条', () => {
  const label = syncBarLabel({ running: true, progress: { done: 3, total: 7 }, done: null })
  assert.deepEqual(label, { key: 'sync.bar.running', params: { done: 3, total: 7 } })
})

test('跑着、但没有分母（认领来的那一趟）：只说"同步中"', () => {
  assert.deepEqual(syncBarLabel({ running: true, progress: null, done: null }), {
    key: 'sync.bar.runningUnknown',
  })
  // 分母是 0 的那一段（同步开头会先推一条"准备"）同样不编一个 0/0。
  assert.deepEqual(syncBarLabel({ running: true, progress: { done: 0, total: 0 }, done: null }), {
    key: 'sync.bar.runningUnknown',
  })
})

test('刚跑完：按自己跑的那一趟的两条数组报总条数', () => {
  const label = syncBarLabel({
    running: false,
    progress: null,
    done: { ok: true, result: { pulled: [1, 2], pushed: [3] } },
  })
  assert.deepEqual(label, { key: 'sync.bar.done', params: { count: 3 } })
})

test('刚跑完、认领来的那趟：按宿主给的计数报', () => {
  const label = syncBarLabel({
    running: false,
    progress: null,
    done: { ok: true, adopted: { pulled: 1, pushed: 0 } },
  })
  assert.deepEqual(label, { key: 'sync.bar.done', params: { count: 1 } })
})

test('跑完但宿主没留下条数：只说"同步完成"，不编一个 0', () => {
  assert.deepEqual(syncBarLabel({ running: false, progress: null, done: { ok: true } }), {
    key: 'sync.bar.donePlain',
  })
})

test('失败：说"同步失败"（原因在悬浮提示与同步那一面里）', () => {
  assert.deepEqual(syncBarLabel({ running: false, progress: null, done: { ok: false, error: '连不上' } }), {
    key: 'sync.bar.failed',
  })
})

test('没有那一趟：这一格不出现', () => {
  assert.equal(syncBarLabel({ running: false, progress: null, done: null }), null)
})
