// test/manageRows.test.ts — 「会话」页平铺表格的筛与排。
//
// 为什么单拎出来测：排序错了不会抛错、不会崩，只会让"按大小排"变成一句谎话；而界面冒烟里的假钩子
// 点不动表头，重新渲染也不会发生。筛同理：选了一个项目却还列着别的目录，只有用户会看出来。
import assert from 'node:assert/strict'
import test from 'node:test'

import { defaultDir, sessionsInProject, sortSessions } from '../src/client/logic/manageRows.ts'

const rows = [
  { id: 'b', title: 'bravo', cwd: '/home/u/dev/beta', createdAt: 20, bytes: 300 },
  { id: 'a', title: 'alpha', cwd: '/home/u/dev/alpha', createdAt: 30, bytes: 100 },
  { id: 'c', cwd: '/home/u/dev/alpha', createdAt: 10, bytes: 200 },
  { id: 'd', title: 'delta', createdAt: 40, bytes: 400 },
]

test('排序：时间与大小默认从大到小，标题默认 A→Z', () => {
  assert.equal(defaultDir('time'), 'desc')
  assert.equal(defaultDir('size'), 'desc')
  assert.equal(defaultDir('title'), 'asc')

  assert.deepEqual(
    sortSessions(rows, { key: 'time', dir: 'desc' }).map((row) => row.id),
    ['d', 'a', 'b', 'c'],
  )
  assert.deepEqual(
    sortSessions(rows, { key: 'time', dir: 'asc' }).map((row) => row.id),
    ['c', 'b', 'a', 'd'],
  )
  assert.deepEqual(
    sortSessions(rows, { key: 'size', dir: 'desc' }).map((row) => row.id),
    ['d', 'b', 'c', 'a'],
  )
})

test('排序：标题读行上那个称呼，没有标题的用 id；同名再按 id 定序', () => {
  // alpha / bravo / c（没有标题，称呼就是 id）/ delta
  assert.deepEqual(
    sortSessions(rows, { key: 'title', dir: 'asc' }).map((row) => row.id),
    ['a', 'b', 'c', 'd'],
  )
  const sameTitle = [
    { id: 'z', title: '同名', createdAt: 1, bytes: 1 },
    { id: 'a', title: '同名', createdAt: 1, bytes: 1 },
  ]
  assert.deepEqual(
    sortSessions(sameTitle, { key: 'title', dir: 'asc' }).map((row) => row.id),
    ['a', 'z'],
  )
  // 不改入参
  assert.equal(rows[0].id, 'b')
})

test('按项目筛：null 全部；空串是没有 cwd 的那一组', () => {
  assert.equal(sessionsInProject(rows, null).length, 4)
  assert.deepEqual(
    sessionsInProject(rows, '/home/u/dev/alpha').map((row) => row.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    sessionsInProject(rows, '').map((row) => row.id),
    ['d'],
  )
})
