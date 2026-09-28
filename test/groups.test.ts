// test/groups.test.ts — 导出列表的分组规则。
//
// 分组是纯函数（`src/client/groups.ts`），所以边界能在这里钉死；页面里只负责把组画出来。
// 重点不是"能分组"，而是那几条容易被后来的改动磨掉的规矩：
//
//   - 分组键是**目录**，不是注册表里的工作区 id：同一个目录下常有没登记的会话，
//     按 id 分组会把它们劈成两组，而用户嘴里"这个工作区的会话"指的是一整个目录；
//   - 已登记的工作区按注册表顺序在前（与界面别处的工作区顺序一致），未登记的目录按路径排序在后，
//     没有 cwd 的一组在最后；
//   - 组内最近的在前（否则每次刷新顺序都可能变，找刚刚那条会话要靠翻）；
//   - 空组不出现：没有会话的已登记工作区不进列表。
import assert from 'node:assert/strict'
import test from 'node:test'

import { groupSessions } from '../src/client/groups.ts'

// 注意这里**不 import** `src/client/api.ts` 的响应类型：Host 侧的 typecheck 工程
// `exclude` 了 `src/client`，但 import 会把它拉进来在"没有 DOM 的工程"里检查
// （TS2584 找不到 document）。分组用的是结构化参数，根本不需要那两个类型。

/** 造一条会话：只给分组用得到的字段，外加 dir 让它长得像 /state 给的那条。 */
function session(id: string, cwd: string | undefined, createdAt: number) {
  return {
    id,
    ...(cwd === undefined ? {} : { cwd }),
    createdAt,
    dir: cwd ?? '_no-cwd',
    bytes: 1024,
    files: [],
  }
}

function workspace(id: string, path: string, title: string) {
  return { id, path, title, sessionIds: [] }
}

const registry = [
  workspace('w2', '/home/u/dev/beta', '测试工作区'),
  workspace('w1', '/home/u/dev/alpha', '会话管理'),
]

test('分组：已登记工作区按注册表顺序，未登记目录按路径，没 cwd 的最后', () => {
  const groups = groupSessions(
    [
      session('c', '/home/u/dev/zeta', 3),
      session('a', '/home/u/dev/beta', 1),
      session('n', undefined, 9),
      session('b', '/home/u/dev/alpha', 2),
      session('d', '/home/u/dev/aardvark', 4),
    ],
    registry,
  )
  assert.deepEqual(
    groups.map((group) => group.path),
    ['/home/u/dev/beta', '/home/u/dev/alpha', '/home/u/dev/aardvark', '/home/u/dev/zeta', ''],
  )
  // 标题是路径的标签：登记过才有；没登记、没 cwd 的组只剩路径（页面自己换成"没有 cwd"）。
  assert.deepEqual(
    groups.map((group) => group.title),
    ['测试工作区', '会话管理', undefined, undefined, undefined],
  )
})

test('分组：组内最近的在前，同一毫秒按 id 定序', () => {
  const groups = groupSessions(
    [
      session('old', '/home/u/dev/alpha', 100),
      session('new', '/home/u/dev/alpha', 300),
      session('b2', '/home/u/dev/alpha', 200),
      session('a2', '/home/u/dev/alpha', 200),
    ],
    registry,
  )
  assert.deepEqual(
    groups[0]?.sessions.map((item) => item.id),
    ['new', 'a2', 'b2', 'old'],
  )
})

test('分组：没有会话的已登记工作区不产生空组', () => {
  const groups = groupSessions([session('solo', '/home/u/dev/zeta', 1)], registry)
  assert.deepEqual(
    groups.map((group) => group.path),
    ['/home/u/dev/zeta'],
  )
})

test('分组：注册表里同一路径出现两次时只出一组，标题取先出现的那个', () => {
  const groups = groupSessions(
    [session('x', '/home/u/dev/alpha', 1)],
    [...registry, workspace('w3', '/home/u/dev/alpha', '改过名的旧标题')],
  )
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.title, '会话管理')
  assert.equal(groups[0]?.sessions.length, 1)
})

test('分组：cwd 缺失与空串是同一组（空串不是一条路径）', () => {
  const groups = groupSessions(
    [session('missing', undefined, 2), session('empty', '', 1)],
    registry,
  )
  assert.deepEqual(
    groups.map((group) => [group.path, group.sessions.map((item) => item.id)]),
    [['', ['missing', 'empty']]],
  )
})

test('分组：空库给出空列表（页面据此显示"还没有会话"）', () => {
  assert.deepEqual(groupSessions([], registry), [])
})
