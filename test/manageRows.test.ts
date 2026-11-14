// test/manageRows.test.ts — 「会话」页平铺表格的筛与排。
//
// 为什么单拎出来测：排序错了不会抛错、不会崩，只会让"按大小排"变成一句谎话；而界面冒烟里的假钩子
// 点不动表头，重新渲染也不会发生。筛同理：选了一个项目却还列着别的目录，只有用户会看出来。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  defaultDir,
  foldSubagents,
  groupPickState,
  sessionsInProject,
  sortSessions,
} from '../src/client/logic/manageRows.ts'

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

test('项目行勾选框：全勾 / 勾一半 / 一条可勾的都没有', () => {
  const group = [
    { id: 'a', locked: false },
    { id: 'b', locked: false },
    { id: 'c', locked: true },
  ]
  const selectable = (row: { locked: boolean }) => !row.locked

  assert.deepEqual(groupPickState(group, [], selectable), {
    checked: false,
    indeterminate: false,
    available: true,
  })
  // 只勾了能单独勾的两条里的一条：横杠，不是"没动过"
  assert.deepEqual(groupPickState(group, ['a'], selectable), {
    checked: false,
    indeterminate: true,
    available: true,
  })
  // 可勾的都勾上就算整组勾上；跟着父会话走的那条（c）不算在内
  assert.deepEqual(groupPickState(group, ['a', 'b'], selectable), {
    checked: true,
    indeterminate: false,
    available: true,
  })
  // 一条可勾的都没有：不画勾选框（空组 / 整组都是子智能体）
  assert.deepEqual(groupPickState([{ id: 'c', locked: true }], [], selectable), {
    checked: false,
    indeterminate: false,
    available: false,
  })
  assert.deepEqual(groupPickState([], [], selectable), {
    checked: false,
    indeterminate: false,
    available: false,
  })
})

test('折叠：子智能体挂到父会话下面，父不在这一份里就自己当顶层', () => {
  const list = [
    { id: 'p', cwd: '/home/u/dev/alpha' },
    { id: 'c1', cwd: '/home/u/dev/alpha', origin: 'subagent', parentSession: 'p' },
    { id: 'c2', cwd: '/home/u/dev/alpha', origin: 'subagent', parentSession: 'p' },
    { id: 'lone', cwd: '/home/u/dev/alpha' },
    // 父在别的项目里：折过去会让子行看着像长在那个项目里，于是它自己当顶层
    { id: 'x', cwd: '/home/u/dev/beta', origin: 'subagent', parentSession: 'p' },
    // 父这一份里压根没有（被筛掉、被搜掉、或父已经没了）
    { id: 'o', cwd: '/home/u/dev/alpha', origin: 'subagent', parentSession: 'gone' },
    // 分叉：有父指针但没有 origin，是自洽的普通会话，不折
    { id: 'f', cwd: '/home/u/dev/alpha', parentSession: 'p' },
  ]
  const tree = foldSubagents(list)
  assert.deepEqual(tree.roots.map((row) => row.id), ['p', 'lone', 'x', 'o', 'f'], '顶层行保持原来的顺序')
  assert.deepEqual((tree.childrenOf.get('p') ?? []).map((row) => row.id), ['c1', 'c2'], '子行也保持顺序')
  assert.equal(tree.childrenOf.has('c1'), false, '没挂子行的那几条不进表')
})

test('折叠：孙辈挂在子会话下面，一层只挂直接子会话', () => {
  const list = [
    { id: 'p', cwd: '/home/u/dev/alpha' },
    { id: 'c', cwd: '/home/u/dev/alpha', origin: 'subagent', parentSession: 'p' },
    { id: 'g', cwd: '/home/u/dev/alpha', origin: 'subagent', parentSession: 'c' },
  ]
  const tree = foldSubagents(list)
  assert.deepEqual(tree.roots.map((row) => row.id), ['p'])
  assert.deepEqual((tree.childrenOf.get('p') ?? []).map((row) => row.id), ['c'], '直接子会话只有 c')
  assert.deepEqual((tree.childrenOf.get('c') ?? []).map((row) => row.id), ['g'], 'g 挂在 c 下面')
})
