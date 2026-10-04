// test/groups.test.ts — 导出列表的分组规则。
//
// 分组是纯函数（`src/client/logic/groups.ts`），所以边界能在这里钉死；页面里只负责把组画出来。
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

import { MAX_NEST_DEPTH, groupKey, groupSessions, lockedParentOf, nestSessions } from '../src/client/logic/groups.ts'

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

test('组的稳定键：路径本身，没有 cwd 的那一组换成一个撞不上的键', () => {
  // key 与折叠状态都拿它当身份（见 sessionList.useGroupCollapse），所以哨兵只写一处
  assert.equal(groupKey('/home/u/dev/alpha'), '/home/u/dev/alpha')
  assert.equal(groupKey(''), '\u0000no-cwd', '没有 cwd 的那一组不能用空串：折叠状态与 React key 都靠它')
  // 真实路径不可能是这个（NUL 不在文件名的字符集里），所以撞不上
  assert.ok(!groupKey('').includes('/'))
})

// ---- 子代理缩进到父会话的下一级（`nestSessions`）----
//
// 这一层是**显示**关系：列表里的父子与删除/迁移的级联展开读的是同一条边（`parentSession` +
// `origin === "subagent"`），所以缩进错了不会抛错、不会崩，只会让"删父会话会带上谁"与眼睛看到的对不上。
// 边界各自钉一条。

/**
 * 造一条带父指针的会话（缩进只用到 id / parentSession / origin / cwd / createdAt）。
 * 给了 `parentSession` 的默认是**子代理**（`origin: "subagent"`）；分叉用 `forkLink()`。
 */
function link(id: string, parentSession?: string, cwd = '/home/u/dev/alpha', options: { subagent?: boolean } = {}) {
  const asSubagent = parentSession !== undefined && options.subagent !== false
  return {
    id,
    ...(parentSession === undefined ? {} : { parentSession }),
    ...(asSubagent ? { origin: 'subagent' } : {}),
    cwd,
    createdAt: 1,
  }
}

/** 分叉：有 `parentSession`、没有 `origin`（`sessions.fork()` 出来的那种自洽会话），不该缩进。 */
function forkLink(id: string, parentSession: string, cwd = '/home/u/dev/alpha') {
  return link(id, parentSession, cwd, { subagent: false })
}

test('缩进：子代理排在父会话后面、缩进一级，孙代再深一级', () => {
  const rows = nestSessions([link('child', 'parent'), link('parent'), link('grand', 'child')], [link('parent'), link('child', 'parent'), link('grand', 'child')], new Set(['parent', 'child', 'grand']))
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth]), [
    ['parent', 0],
    ['child', 1],
    ['grand', 2],
  ])
  // 输入里子排在父前面也照样把子树收到父下面：顶层行的相对顺序由"根"决定，子行永远紧跟它的父
  const reordered = nestSessions([link('child', 'parent'), link('parent')], [link('parent'), link('child', 'parent')], new Set(['parent', 'child']))
  assert.deepEqual(reordered.map((row) => [row.session.id, row.depth]), [
    ['parent', 0],
    ['child', 1],
  ])
  assert.equal(reordered.length, 2, '一条不多一条不少')
})

test('缩进：父会话在别的目录组里时留在自己这组，缩进一级并给出父所在的目录', () => {
  const rows = nestSessions(
    [link('child', 'parent', '/home/u/dev/alpha')],
    [link('parent', undefined, '/home/u/dev/beta'), link('child', 'parent', '/home/u/dev/alpha')],
    new Set(['parent', 'child']),
  )
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth, row.parentPath]), [
    ['child', 1, '/home/u/dev/beta'],
  ])
})

test('缩进：父会话没在当前视图里（被筛掉 / 不在库里）时按普通行画，不凭空多一级', () => {
  const library = [link('parent'), link('child', 'parent')]
  // 父被筛选条筛掉了：它不在 visibleIds 里
  const filtered = nestSessions([link('child', 'parent')], library, new Set(['child']))
  assert.deepEqual(filtered.map((row) => [row.session.id, row.depth, row.parentPath]), [['child', 0, undefined]])
  // 父压根不在库里（孤儿）
  const orphan = nestSessions([link('child', 'gone')], [link('child', 'gone')], new Set(['child']))
  assert.deepEqual(orphan.map((row) => [row.session.id, row.depth]), [['child', 0]])
  // 父会话的 cwd 是空串：仍然是缩进一级，只是没有可写的目录
  const noCwd = nestSessions([link('child', 'parent')], [link('parent', undefined, ''), link('child', 'parent')], new Set(['parent', 'child']))
  assert.deepEqual(noCwd.map((row) => [row.session.id, row.depth, row.parentPath]), [['child', 1, undefined]])
})

test('缩进：分叉按普通行画不缩进，而它自己的子代理照旧缩进到它下面', () => {
  const rows = nestSessions(
    [forkLink('fork', 'parent'), link('parent'), link('sub', 'fork')],
    [link('parent'), forkLink('fork', 'parent'), link('sub', 'fork')],
    new Set(['parent', 'fork', 'sub']),
  )
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth]), [
    ['fork', 0],
    ['sub', 1],
    ['parent', 0],
  ], '分叉是顶层行（顺序仍按输入），它的子代理跟着它缩进一级')

  // 分叉排在父后面（真实库里分叉通常比父新）也不能被收进父的子树里
  const after = nestSessions(
    [link('parent'), forkLink('fork', 'parent')],
    [link('parent'), forkLink('fork', 'parent')],
    new Set(['parent', 'fork']),
  )
  assert.deepEqual(after.map((row) => [row.session.id, row.depth]), [
    ['parent', 0],
    ['fork', 0],
  ], '父在前也一样：分叉不缩进')
})

test('缩进：坏数据里的环不会让会话消失，也不会无限递归', () => {
  const rows = nestSessions(
    [link('a', 'b'), link('b', 'a')],
    [link('a', 'b'), link('b', 'a')],
    new Set(['a', 'b']),
  )
  assert.deepEqual(rows.map((row) => row.session.id).sort(), ['a', 'b'], '环路里的会话也得画出来')
  assert.equal(rows.length, 2)
  // 自己当自己的父：同样只画一次
  const self = nestSessions([link('self', 'self')], [link('self', 'self')], new Set(['self']))
  assert.deepEqual(self.map((row) => [row.session.id, row.depth]), [['self', 0]])
})

test('缩进：级数封顶（更深的链条按最后一级算，别把标题挤没）', () => {
  const chain = ['s1', 's2', 's3', 's4', 's5']
  const library = chain.map((id, index) => link(id, index === 0 ? undefined : chain[index - 1]!))
  const rows = nestSessions(library, library, new Set(chain))
  assert.deepEqual(rows.map((row) => [row.session.id, row.depth]), [
    ['s1', 0],
    ['s2', 1],
    ['s3', 2],
    ['s4', 3],
    ['s5', MAX_NEST_DEPTH],
  ])
})

test('能不能单独勾：只有"子代理 + 父会话在库里"才不能（判据与宿主那几条路同源）', () => {
  const parent = link('p', undefined)
  const child = link('c', 'p')
  const grand = link('g', 'c')
  const orphan = link('o', 'gone')
  const fork = forkLink('f', 'p')
  const library = new Map([parent, child, grand, orphan, fork].map((session) => [session.id, session]))

  assert.equal(lockedParentOf(child, library)?.id, 'p', '子代理要跟着父会话，不能单独勾')
  assert.equal(lockedParentOf(grand, library)?.id, 'c', '隔一层也一样（父是它那一级的父）')
  assert.equal(lockedParentOf(parent, library), undefined, '普通会话照旧能单独勾')
  assert.equal(lockedParentOf(orphan, library), undefined, '父会话不在库里的孤儿没有可跟随的会话')
  assert.equal(lockedParentOf(fork, library), undefined, '分叉不是子代理，照旧能单独勾')
  assert.equal(lockedParentOf(child, new Map()), undefined, '库是空的（父不在里面）时也不能把它锁死')
})
