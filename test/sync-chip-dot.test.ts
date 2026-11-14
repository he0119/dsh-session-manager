// test/sync-chip-dot.test.ts — 页头那枚同步状态点哪一档颜色。
//
// 五档各自对应"本地已知的哪一件事实"，次序即优先级；这里把矩阵摆开，是因为它们互相压：
// 一趟失败不能因为"自动推送开着"就变绿，一次"有遗留"也不能因为跑完就变回灰。
import assert from 'node:assert/strict'
import test from 'node:test'

import { syncChipDot, syncChipNote } from '../src/client/logic/syncChipDot.ts'

/** 没有任何事实的那一份（没跑、没记录、没开自动推送）。 */
const idle = { running: false, done: null, lastRun: null, autoPush: false }

test('什么都没有：灰点', () => {
  assert.equal(syncChipDot(idle), 'idle')
})

test('跑着：转圈（压过其余一切）', () => {
  assert.equal(syncChipDot({ ...idle, running: true }), 'ongoing')
  assert.equal(syncChipDot({ ...idle, running: true, autoPush: true }), 'ongoing', '自动推送开着也先看跑着没有')
  assert.equal(
    syncChipDot({ ...idle, running: true, lastRun: { ok: false } }),
    'ongoing',
    '上一趟失败、这一趟跑着——现在是"跑着"',
  )
})

test('失败：红点', () => {
  assert.equal(syncChipDot({ ...idle, done: { ok: false } }), 'error', '这一页刚跑的那趟没成')
  assert.equal(syncChipDot({ ...idle, lastRun: { ok: false } }), 'error', '磁盘上记着的那次没成（重启之后还在）')
})

test('失败压过"自动推送开着"：一趟没成不能被一枚绿点盖住', () => {
  assert.equal(syncChipDot({ ...idle, autoPush: true, lastRun: { ok: false } }), 'error')
  assert.equal(syncChipDot({ ...idle, autoPush: true, done: { ok: false } }), 'error')
})

test('跑完了但有遗留：黄点', () => {
  assert.equal(
    syncChipDot({ ...idle, lastRun: { ok: true, problems: ['缺映射：a'] } }),
    'warning',
    '有几条没做到',
  )
  assert.equal(
    syncChipDot({ ...idle, lastRun: { ok: true, pendingRestart: true } }),
    'warning',
    '改动要重启才生效',
  )
  assert.equal(
    syncChipDot({ ...idle, done: { ok: true, result: { problems: ['目标目录不存在：b'] } } }),
    'warning',
    '刚跑完那趟的遗留（结果在内存里，比磁盘上那条更早）',
  )
  assert.equal(
    syncChipDot({ ...idle, done: { ok: true, result: { problems: [] } }, lastRun: { ok: true, problems: [] } }),
    'idle',
    '空数组 = 没有遗留',
  )
  assert.equal(
    syncChipDot({ ...idle, done: { ok: true, result: undefined }, lastRun: { ok: true, problems: ['c'] } }),
    'warning',
    '认领来的那趟没有完整结果，就按磁盘上那条判',
  )
})

test('黄点压过绿点：有遗留就不算"太平"', () => {
  assert.equal(syncChipDot({ ...idle, autoPush: true, lastRun: { ok: true, problems: ['a'] } }), 'warning')
})

test('自动推送开着：绿点', () => {
  assert.equal(syncChipDot({ ...idle, autoPush: true }), 'done')
  assert.equal(syncChipDot({ ...idle, autoPush: true, lastRun: { ok: true } }), 'done', '跑得干净、自动推送开着')
})

test('按钮上的那句提示：每档一句短话', () => {
  assert.deepEqual(syncChipNote({ ...idle, running: true }), { key: 'sync.chip.noteRunning' }, '跑着')
  assert.deepEqual(
    syncChipNote({ ...idle, lastRun: { ok: false, error: '401 Unauthorized' } }),
    { key: 'sync.chip.noteFailed', params: { reason: '401 Unauthorized' } },
    '红了就把宿主/远端的原话带出来——"为什么红了"是这一档最常被问的',
  )
  assert.deepEqual(
    syncChipNote({ ...idle, lastRun: { ok: false } }),
    { key: 'sync.chip.noteFailedPlain' },
    '没有原话时退到一句不带原因的',
  )
  assert.deepEqual(
    syncChipNote({ ...idle, done: { ok: false, error: '连接被重置' }, lastRun: { ok: false, error: '旧的那条' } }),
    { key: 'sync.chip.noteFailed', params: { reason: '连接被重置' } },
    '这一页刚跑的那趟优先（它的原话最新）',
  )
  assert.deepEqual(
    syncChipNote({ ...idle, lastRun: { ok: true, problems: ['a', 'b'] } }),
    { key: 'sync.chip.noteProblems', params: { count: 2 } },
    '报出没做到的条数（哪几条在弹窗里）',
  )
  assert.deepEqual(
    syncChipNote({ ...idle, lastRun: { ok: true, pendingRestart: true } }),
    { key: 'sync.chip.noteRestart' },
    '说明要重启',
  )
  assert.equal(syncChipNote(idle), null, '没事时不多说一句')
  assert.deepEqual(syncChipNote({ ...idle, autoPush: true }), { key: 'sync.chip.noteAuto' }, '绿点：自动推送开着')
  assert.deepEqual(
    syncChipNote({ ...idle, autoPush: true, autoPushSync: true }),
    { key: 'sync.chip.noteAutoSync' },
    '双向那一档说的是自动同步（它会动本机）',
  )
  assert.deepEqual(
    syncChipNote({ ...idle, lastRun: { ok: true, problems: ['a'], pendingRestart: true } }),
    { key: 'sync.chip.noteProblems', params: { count: 1 } },
    '两件都有时先说没做到的条数',
  )
})
