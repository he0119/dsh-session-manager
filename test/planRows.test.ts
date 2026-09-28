// test/planRows.test.ts — 列表/表格里一行的写法：cwd 那一格说什么，以及一条会话怎么称呼。
//
// 这一格在用户截图上错过：一次 20 条**全部跳过**的导入，每一行的 cwd 都写着
// 「保持无 cwd（落 _no-cwd）」，而那些会话明明都有 cwd（截图里第一条就在
// /home/uy_sun/dev/dsh-aperture），并且它们根本不会被写盘。等于把"什么都不会发生"说成了
// "你的会话要被丢进无 cwd 项目目录"。根因是那一格只判断 `toCwd === undefined`——跳过的行按设计也没有
// `toCwd`（见 `src/transfer.ts` 的 ImportEntry），于是两支不同的情况被合并成了一句错话。
//
// 判定抽成了 `src/client/planRows.ts`（纯函数），所以三支分支能在这里逐个钉死。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNOWNED_SOURCE,
  describeCwd,
  migrationMatching,
  migrationSourceRows,
  optionLabel,
  sessionLabel,
  unownedSessions,
} from '../src/client/planRows.ts'

// 同 groups.test.ts：不 import `src/client/api.ts`（它会把 src/client 拉进没有 DOM 的 Host 工程）。

test('跳过的行：说"跳过"，不说 cwd 会怎样', () => {
  // 这条就是截图里那一条：有 cwd、但库里已经有同 id，所以不会写盘。
  const plan = describeCwd({ action: 'skip', fromCwd: '/home/uy_sun/dev/dsh-aperture' })
  assert.deepEqual(plan, { kind: 'skip' })
})

test('会写的行且有 cwd：给出"从哪到哪"', () => {
  const plan = describeCwd({
    action: 'create',
    fromCwd: '/home/uy_sun/dev/alpha',
    toCwd: '/home/uy_sun/test',
  })
  assert.deepEqual(plan, { kind: 'rewrite', from: '/home/uy_sun/dev/alpha', to: '/home/uy_sun/test' })
})

test('包里没有 cwd 的会话：才会落 _no-cwd', () => {
  assert.deepEqual(describeCwd({ action: 'create' }), { kind: 'keepNoCwd' })
})

test('会写、有目标路径但包里没记原 cwd（坏数据）：原路径退成占位符，别显示成空', () => {
  assert.deepEqual(describeCwd({ action: 'create', toCwd: '/home/uy_sun/test' }), {
    kind: 'rewrite',
    from: '—',
    to: '/home/uy_sun/test',
  })
})

// ---- 一行会话怎么称呼（`sessionLabel`）----
//
// 以前列表里到处是 `session-9f3c…`：uuid 对人是零信息，用户是在"我上次问那个问题的会话"这一层挑
// 会话的。改成显示标题、id 退到悬浮提示；这里钉死四种输入下的输出。

const ID = 'session-24ee5b02-4a73-47f0-8212-0434efeb8062'

test('有标题：行上显示标题，悬浮提示里"完整标题 + id"两行', () => {
  assert.deepEqual(sessionLabel({ id: ID, title: '帮我安装到 web-dev 中' }), {
    text: '帮我安装到 web-dev 中',
    tip: `帮我安装到 web-dev 中\n${ID}`,
    kind: 'title',
  })
})

test('没有标题：回落到 id，并且不在提示里重复一遍', () => {
  assert.deepEqual(sessionLabel({ id: ID }), { text: ID, tip: ID, kind: 'id' })
})

test('空白标题当没有标题：别显示一行空格，也别把 id 藏起来', () => {
  assert.deepEqual(sessionLabel({ id: ID, title: '   ' }), { text: ID, tip: ID, kind: 'id' })
})

test('标题两边的空白裁掉：宿主写进来的可能带换行（提示是两行的，多一行就错位了）', () => {
  assert.deepEqual(sessionLabel({ id: ID, title: ' 修一下图标\n' }), {
    text: '修一下图标',
    tip: `修一下图标\n${ID}`,
    kind: 'title',
  })
})


// ---- 迁移页的来源：目录候选与「未分组」（`migrationSourceRows` / `migrationMatching`）----
//
// 「未分组」是外壳侧边栏的说法（注册表没认领的会话），本插件按目录分组，于是它必须作为一个**单独的
// 来源**出现，否则那批会话只能一个目录一个目录地勾——"这两个目录里没在册的那两条"本来是一件事。
// 这一批会跨目录，所以本文件把候选、匹配与那个哨兵值都钉住（界面那层只能靠人眼验收）。

/** 只带判据要用的两个字段：cwd 与归属（同源文件里的 SourceSubject）。 */
const s = (id: string, cwd: string | undefined, workspaceId?: string) => ({ id, cwd, workspaceId })
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key

test('未分组来源覆盖的会话：注册表没认领 + 有 cwd，两个条件缺一不可', () => {
  const list = [
    s('owned', '/a', 'ws-1'),
    s('orphan', '/a'),
    s('no-cwd', undefined),
    s('empty-cwd', ''),
  ]
  assert.deepEqual(unownedSessions(list).map((x) => x.id), ['orphan'])
})

test('源候选：已登记工作区在前、其余目录按路径排、未分组在最后且带上条数', () => {
  const rows = migrationSourceRows(
    [s('owned', '/b', 'ws-1'), s('orphan-1', '/a'), s('orphan-2', '/a'), s('owned-2', '/a', 'ws-2')],
    [{ path: '/b', title: '工作区乙' }],
    t,
  )
  assert.deepEqual(rows, [
    { path: '/b', title: '工作区乙', count: 1 },
    { path: '/a', count: 3 },
    { path: UNOWNED_SOURCE, label: 'ungroupedSource', count: 2 },
  ])
})

test('源候选：没有未登记在册的会话时，那一行不出现（别摆一个点了必然报错的选项）', () => {
  const rows = migrationSourceRows([s('owned', '/a', 'ws-1')], [{ path: '/a', title: '甲' }], t)
  assert.equal(rows.some((row) => row.path === UNOWNED_SOURCE), false)
})

test('候选文案：未分组那一行用自己的文案，不把哨兵值漏出来', () => {
  assert.equal(optionLabel({ path: UNOWNED_SOURCE, label: '未分组', count: 3 }, t), '未分组 — sessionsInDir:{"count":3}')
  assert.equal(optionLabel({ path: '/a', count: 2 }, t), '/a — sessionsInDir:{"count":2}')
})

test('源匹配：目录按 cwd 匹配，未分组给的就是跨目录的那一批，空值不匹配任何会话', () => {
  const list = [s('owned', '/a', 'ws-1'), s('orphan-a', '/a'), s('orphan-b', '/b')]
  assert.deepEqual(migrationMatching(list, '/a').map((x) => x.id), ['owned', 'orphan-a'])
  assert.deepEqual(migrationMatching(list, UNOWNED_SOURCE).map((x) => x.id), ['orphan-a', 'orphan-b'])
  assert.deepEqual(migrationMatching(list, ''), [])
})

test('哨兵值不像一个路径：目录值永远是绝对路径或空串，撞不上它', () => {
  assert.equal(UNOWNED_SOURCE.startsWith('/'), false)
  assert.equal(UNOWNED_SOURCE.includes('\\'), false)
})

// ---- 侧边栏看不见的会话不进候选（子代理 / 空白 / 已归档）----
//
// 判据在宿主侧算一次（`src/visibility.ts`），界面只读 `/state` 上的 `hidden` 字段。这里钉住的是
// "界面照这个字段筛"这一步：漏筛任何一处，界面报的条数就会大于宿主真正会搬的条数。

/** 带 hidden 的行（界面从 /state 拿到的就是这个形状）。 */
const h = (id: string, cwd: string | undefined, workspaceId?: string, hidden?: string) => ({
  id,
  cwd,
  workspaceId,
  hidden,
})

test('未分组来源：侧边栏不显示的会话不进候选（就算它没在册、也有 cwd）', () => {
  const list = [
    h('orphan-visible', '/a'),
    h('orphan-subagent', '/a', undefined, 'subagent'),
    h('orphan-blank', '/a', undefined, 'blank'),
    h('orphan-archived', '/a', undefined, 'archived'),
  ]
  assert.deepEqual(unownedSessions(list).map((x) => x.id), ['orphan-visible'])
})

test('目录来源：候选与条数都只数看得见的那批', () => {
  const list = [
    h('owned', '/a', 'ws-1'),
    h('owned-archived', '/a', 'ws-1', 'archived'),
    h('orphan-subagent', '/a', undefined, 'subagent'),
  ]
  assert.deepEqual(migrationMatching(list, '/a').map((x) => x.id), ['owned'])
  // 条数是"会进候选的条数"，不是"库里有几条"
  assert.deepEqual(migrationSourceRows(list, [{ path: '/a', title: '甲' }], t), [
    { path: '/a', title: '甲', count: 1 },
  ])
  // 一个目录里全是看不见的会话：它连候选行都不出现（未登记工作区那一条）
  const hiddenOnly = [h('orphan-blank', '/b', undefined, 'blank')]
  assert.deepEqual(migrationSourceRows(hiddenOnly, [], t), [])
})
