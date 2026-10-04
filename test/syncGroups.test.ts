// test/syncGroups.test.ts — 「同步」弹窗那三张计划表的分组规则。
//
// 分组是纯函数（`src/client/logic/syncGroups.ts`），边界在这里钉死；页面只负责把组画出来。
// 重点不是"能分组"，而是那几条容易被后来的改动磨掉的规矩：
//
//   - 分组键取的是**本机那个目录**（拉取看落地后的 `toCwd`、推看 `cwd`）：用户是从"我哪个项目
//     要动"这个角度读计划的，远端那半边的路径只是"从哪儿来"；
//   - 唯一的例外是**没有映射**的拉取行：本机根本没有那个项目可分组，退到远端路径当组头——
//     那正是要用户补的那条映射；
//   - 组的次序与会话列表那边同一套（已登记工作区 → 其余路径按路径排序 → 没有 cwd 的最后一组），
//     同一个目录在两处排的位置必须一样；
//   - 组内**保持计划给的顺序**：那是宿主算出来的先后，界面不再给一个顺序；
//   - 拉取行的悬浮提示只在真的改写时补一句"从哪到哪"。
import assert from 'node:assert/strict'
import test from 'node:test'

import { groupKey, orderProjectPaths, workspaceTitles } from '../src/client/logic/groups.ts'
import { groupSyncRows, syncProjectOf, syncPullTip } from '../src/client/logic/syncGroups.ts'

// 同 groups.test.ts：不 import `src/client/api.ts`（它会把 src/client 拉进没有 DOM 的 Host 工程）。

function workspace(path: string, title: string) {
  return { path, title }
}

const registry = [workspace('/home/u/dev/beta', '测试工作区'), workspace('/home/u/dev/alpha', '会话管理')]

/** 分组结果压成好断言的样子：`[路径, [组内那几行]]`。 */
function shape<T>(groups: readonly { path: string; title?: string; rows: readonly T[] }[]) {
  return groups.map((group) => [group.path, group.rows])
}

test('拉取行：分组键是落地后的本机目录', () => {
  // 映射把远端的 /home/b/dev/x 落到了本机的 alpha：组头该是 alpha，不是远端那条路径。
  assert.equal(
    syncProjectOf({ fromCwd: '/home/b/dev/x', toCwd: '/home/u/dev/alpha' }, 'pull'),
    '/home/u/dev/alpha',
  )
})

test('拉取行且没有映射：退到远端那条路径——那正是要补的映射', () => {
  assert.equal(syncProjectOf({ fromCwd: '/home/b/dev/x' }, 'pull'), '/home/b/dev/x')
})

test('拉取行且本来没有 cwd：归"没有 cwd"那一组（落 _no-cwd）', () => {
  assert.equal(syncProjectOf({}, 'pull'), '')
})

test('推送行：分组键就是本机的 cwd，没有 cwd 的归空串那一组', () => {
  assert.equal(syncProjectOf({ cwd: '/home/u/dev/alpha' }, 'push'), '/home/u/dev/alpha')
  assert.equal(syncProjectOf({ fromCwd: '/home/b/dev/x' }, 'push'), '', '推送不看远端路径')
  assert.equal(syncProjectOf({}, 'push'), '')
})

test('组的次序：已登记工作区在前（按注册表顺序），其余按路径排序，没有 cwd 的最后一组', () => {
  const rows = [
    '/zzz/other',
    '/home/u/dev/alpha',
    '',
    '/home/u/dev/beta',
    '/aaa/first',
  ].map((path, index) => ({ id: `s-${index}`, project: path }))
  const groups = groupSyncRows(rows, (row) => row.project, registry)
  assert.deepEqual(
    groups.map((group) => group.path),
    ['/home/u/dev/beta', '/home/u/dev/alpha', '/aaa/first', '/zzz/other', ''],
    '没在注册表里的路径按路径排序，没有 cwd 的一组永远在最后',
  )
})

test('组的标题来自工作区（未登记的目录没有标题，组头就显示路径本身）', () => {
  const rows = [
    { id: 's-1', project: '/home/u/dev/alpha' },
    { id: 's-2', project: '/home/b/dev/x' },
  ]
  const groups = groupSyncRows(rows, (row) => row.project, registry)
  assert.equal(groups[0]?.title, '会话管理')
  assert.equal(groups[1]?.title, undefined)
})

test('组内保持计划给的顺序，不重排', () => {
  const rows = [
    { id: 'p-3', project: '/home/u/dev/alpha' },
    { id: 'p-1', project: '/home/u/dev/alpha' },
    { id: 'p-2', project: '/home/u/dev/alpha' },
  ]
  const groups = groupSyncRows(rows, (row) => row.project, registry)
  assert.deepEqual(
    groups[0]?.rows.map((row) => row.id),
    ['p-3', 'p-1', 'p-2'],
  )
})

test('同一个项目下的行归一组，两个方向的行互不干扰', () => {
  const rows = [
    { side: 'pull' as const, entry: { id: 'a', fromCwd: '/home/b/dev/x', toCwd: '/home/u/dev/alpha' } },
    { side: 'push' as const, entry: { id: 'b', cwd: '/home/u/dev/alpha' } },
    { side: 'pull' as const, entry: { id: 'c', fromCwd: '/home/b/dev/x' } },
  ]
  const groups = groupSyncRows(rows, (row) => syncProjectOf(row.entry, row.side), registry)
  assert.deepEqual(shape(groups), [
    ['/home/u/dev/alpha', [rows[0], rows[1]]],
    ['/home/b/dev/x', [rows[2]]],
  ])
})

test('分组键的哨兵：没有 cwd 那一组的 React key 撞不上任何真实路径', () => {
  // 页面拿 `groupKey(group.path)` 当 key 与身份，空串必须换成一个路径不可能等于的键。
  assert.equal(groupKey(''), '\u0000no-cwd')
  assert.equal(groupKey('/home/u/dev/alpha'), '/home/u/dev/alpha')
})

test('拉取行的悬浮提示：只有真的改写了才补"从哪到哪"', () => {
  const t = (key: string, params?: Record<string, unknown>): string =>
    key === 'cwdRewritten' ? `${String(params?.from)} → ${String(params?.to)}` : key
  assert.equal(
    syncPullTip({ fromCwd: '/home/b/dev/x', toCwd: '/home/u/dev/alpha' }, '标题\nid', t),
    '标题\nid\n/home/b/dev/x → /home/u/dev/alpha',
  )
  assert.equal(syncPullTip({ fromCwd: '/x', toCwd: '/x' }, '标题', t), '标题', '两端一样就没有可说的')
  assert.equal(syncPullTip({ toCwd: '/x' }, '标题', t), '标题', '没有来源（本来就没有 cwd）不补')
  assert.equal(syncPullTip({ fromCwd: '/b/x' }, '标题', t), '标题', '没有目标（没有映射）由组头说')
})

test('排序与标题这两条规则与列表那边共用同一份实现', () => {
  // 「同一个目录在两处排的位置一样」不是巧合，是一份实现：这两条被抽到了 groups.ts。
  // 这里只钉"它们确实对外可用且口径如此"；组内顺序、空组不出现在 groups.test.ts。
  assert.deepEqual(orderProjectPaths(['/b', '/a', ''], registry), ['/a', '/b', ''])
  assert.deepEqual([...workspaceTitles(registry)], [
    ['/home/u/dev/beta', '测试工作区'],
    ['/home/u/dev/alpha', '会话管理'],
  ])
})
