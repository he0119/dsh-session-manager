// test/client/operations/sync/remoteRows.test.ts — 右栏那行「远端」摆什么、说什么。
//
// 判据只有一份（`remoteRowsOf()`）：读着、读不到、远端没有、可能不全、有几处位置。最容易写错的是
// 最后两种混起来的那一档——某台机器的索引没读到时说"远端没有这条会话"是假话，而假话在界面上看起来
// 与真话一模一样，所以用测试把它钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { remoteRowsOf } from '../../../../src/client/operations/sync/remoteRows.ts'
import type { RemoteLibraryState } from '../../../../src/client/operations/sync/remoteLibrary.ts'

/** 一处位置。 */
const place = (machine: string, bytes = 1024) => ({
  machine,
  path: `dsh-session-manager/${machine}/session-a.dshsess`,
  bytes,
})

/** 读到的那一份（`sessions` 用普通对象写，函数里转成 Map）。 */
function ready(
  sessions: Record<string, ReturnType<typeof place>[]>,
  problems: string[] = [],
): RemoteLibraryState {
  return {
    status: 'ready',
    at: 1,
    machines: Object.keys(sessions),
    sessions: new Map(Object.entries(sessions)),
    problems,
  }
}

test('远端有这一条：给出位置清单，不多说一句', () => {
  const rows = remoteRowsOf(ready({ 'session-a': [place('robot-a')] }), 'session-a')
  assert.deepEqual(rows.places.map((item) => item.machine), ['robot-a'])
  assert.equal(rows.note, undefined, '读到了就不要再解释')
})

test('远端没有这一条：说"没有"，不是空着', () => {
  assert.deepEqual(remoteRowsOf(ready({}), 'session-a'), {
    places: [],
    note: { key: 'manage.detail.remoteNone' },
  })
})

test('有机器没读到索引时不说"没有"：改说可能不全（哪怕别处也没读到位置）', () => {
  const rows = remoteRowsOf(ready({}, ['读远端 robot-b/index.json 失败：404']), 'session-a')
  assert.deepEqual(rows.note, { key: 'manage.detail.remotePartial', vars: { count: 1 } })
  assert.deepEqual(rows.places, [])
})

test('读不全但别处读到了位置：位置照给，后面补一句可能不全', () => {
  const rows = remoteRowsOf(ready({ 'session-a': [place('robot-a')] }, ['读远端 robot-b/index.json 失败']), 'session-a')
  assert.equal(rows.places.length, 1, '读到的那一处照给')
  assert.deepEqual(rows.note, { key: 'manage.detail.remotePartial', vars: { count: 1 } })
})

test('还没读 / 正在读：说一句"正在读"', () => {
  assert.deepEqual(remoteRowsOf({ status: 'idle' }, 'session-a'), {
    places: [],
    note: { key: 'manage.detail.remoteLoading' },
  })
  assert.deepEqual(remoteRowsOf({ status: 'loading' }, 'session-a'), {
    places: [],
    note: { key: 'manage.detail.remoteLoading' },
  })
})

test('读失败：把原因原样带上，不是一句"读不到"', () => {
  assert.deepEqual(remoteRowsOf({ status: 'failed', error: 'fetch failed' }, 'session-a'), {
    places: [],
    note: { key: 'manage.detail.remoteFailed', vars: { reason: 'fetch failed' } },
  })
})

test('同一 id 在几台机器的格子里都有：按宿主给的顺序全列出来', () => {
  const rows = remoteRowsOf(ready({ 'session-a': [place('robot-a'), place('robot-b')] }), 'session-a')
  assert.deepEqual(rows.places.map((item) => item.machine), ['robot-a', 'robot-b'])
})
