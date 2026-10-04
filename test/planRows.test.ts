// test/planRows.test.ts — 列表/表格里一行的写法：cwd 那一格说什么，以及一条会话怎么称呼。
//
// 这一格在用户截图上错过：一次 20 条**全部跳过**的导入，每一行的 cwd 都写着
// 「保持无 cwd（落 _no-cwd）」，而那些会话明明都有 cwd（截图里第一条就在
// /home/uy_sun/dev/dsh-aperture），并且它们根本不会被写盘。等于把"什么都不会发生"说成了
// "你的会话要被丢进无 cwd 项目目录"。根因是那一格只判断 `toCwd === undefined`——跳过的行按设计也没有
// `toCwd`（见 `src/transfer.ts` 的 ImportEntry），于是两支不同的情况被合并成了一句错话。
//
// 判定抽成了 `src/client/logic/planRows.ts`（纯函数），所以三支分支能在这里逐个钉死。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNOWNED_SOURCE,
  deleteFamilyNote,
  describeCwd,
  migrateFamilyNote,
  migrationMatching,
  migrationSourceRows,
  optionLabel,
  pathLabel,
  projectLabel,
  repoHost,
  repoName,
  sessionLabel,
  unownedSessions,
} from '../src/client/logic/planRows.ts'

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
// 「未分组」是外壳侧边栏那个组（谁都没认领 **且** 默认视图下会显示），本插件按目录分组，于是它必须
// 作为一个**单独的来源**出现，否则那批会话只能一个目录一个目录地勾——"这两个目录里没在册的那两条"
// 本来是一件事。这一批会跨目录，所以本文件把候选、匹配与那个哨兵值都钉住（界面那层只能靠人眼验收）。

/** 只带判据要用的两个字段：cwd 与宿主算好的「未分组」（同源文件里的 SourceSubject）。 */
const s = (id: string, cwd: string | undefined, ungrouped?: boolean) => ({ id, cwd, ungrouped })
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key

test('未分组来源覆盖的会话：宿主说它在那一组 + 有 cwd，两个条件缺一不可', () => {
  const list = [
    s('claimed', '/a', false),
    s('orphan', '/a', true),
    s('no-cwd', undefined, true),
    s('empty-cwd', '', true),
  ]
  assert.deepEqual(unownedSessions(list).map((x) => x.id), ['orphan'])
})

test('未分组来源不自己推判据：看起来"没在册、也没被隐藏"但宿主没标 ungrouped 的行不收', () => {
  // 这条夹具是刻意不真实的（真实 /state 会给这种行 ungrouped: true）。它钉的是**界面不许自己再推
  // 一遍**：以前的判据是"没有 workspaceId 就算未分组"，于是子代理/空白/已归档这些侧边栏根本不放进
  // 那一组的会话也被算进来了。现在只有宿主说在那一组里才算。
  const list = [{ id: 'looks-unowned', cwd: '/a' }]
  assert.deepEqual(unownedSessions(list), [])
})

test('源候选：已登记工作区在前、其余目录按路径排、未分组在最后且带上条数', () => {
  const rows = migrationSourceRows(
    [s('owned', '/b', false), s('orphan-1', '/a', true), s('orphan-2', '/a', true), s('owned-2', '/a', false)],
    [{ path: '/b', title: '工作区乙' }],
    t,
  )
  assert.deepEqual(rows, [
    { path: '/b', title: '工作区乙', count: 1 },
    { path: '/a', count: 3 },
    { path: UNOWNED_SOURCE, label: 'ungroupedSource', count: 2 },
  ])
})

test('源候选：没有落在「未分组」里的会话时，那一行不出现（别摆一个点了必然报错的选项）', () => {
  const rows = migrationSourceRows([s('owned', '/a', false)], [{ path: '/a', title: '甲' }], t)
  assert.equal(rows.some((row) => row.path === UNOWNED_SOURCE), false)
})

test('候选文案：未分组那一行用自己的文案，不把哨兵值漏出来', () => {
  assert.equal(optionLabel({ path: UNOWNED_SOURCE, label: '未分组', count: 3 }, t), '未分组 — sessionsInDir:{"count":3}')
  assert.equal(optionLabel({ path: '/a', count: 2 }, t), '/a — sessionsInDir:{"count":2}')
})

// ---- 一个目录怎么称呼：项目身份（git remote）与本机路径 ----
//
// 本机绝对路径是**机器特有**的：同一个项目在两台机器上可以落在完全不同的目录里，而 `host/owner/repo`
// 是仓库自己的名字。所以组头显示身份、把路径退到悬浮提示里；下拉框里两个都留（`<option>` 没有悬浮
// 提示，而同一个仓库在本机的两个克隆只能靠路径区分）。

test('组头：只摆名字 + 一枚主机标签，项目身份与本机路径一起进悬浮提示', () => {
  // 已登记的工作区：名字是用户起的标题（身份不顶掉人的名字），身份与路径各占提示里的一行
  assert.deepEqual(projectLabel({ path: '/home/u/dev/x', title: '测试项目', repo: 'github.com/he0119/x' }, t), {
    name: '测试项目',
    tip: 'github.com/he0119/x\n/home/u/dev/x',
    host: 'github.com',
  })
  // 未登记：名字取身份最后一段（原来这里是整条本机路径）
  assert.deepEqual(projectLabel({ path: '/opt/work/x', repo: 'git.hehome.xyz/he0910/x' }, t), {
    name: 'x',
    tip: 'git.hehome.xyz/he0910/x\n/opt/work/x',
    host: 'git.hehome.xyz',
  })
})

test('主机名：取身份第一段（认不出来而原样退回的形状整条当标签）', () => {
  assert.equal(repoHost('github.com/he0119/dsh-session-manager'), 'github.com')
  assert.equal(repoHost('git.hehome.xyz/hehome/smart-home-deploy'), 'git.hehome.xyz')
  // 裸路径那种"认不出来就原样退回"的身份没有主机段，整条当标签（少见，nowrap 兜住）
  assert.equal(repoHost('/srv/git/thing'), '/srv/git/thing')
  assert.equal(repoHost('thing'), 'thing')
})

test('组头：没有身份时名字照旧（标题，未登记就只剩路径），提示里给本机路径', () => {
  assert.deepEqual(projectLabel({ path: '/home/u/dev/x', title: '测试项目' }, t), {
    name: '测试项目',
    tip: '/home/u/dev/x',
  })
  assert.deepEqual(projectLabel({ path: '/home/u/dev/x' }, t), { name: '/home/u/dev/x', tip: '/home/u/dev/x' })
})

test('组头：没有 cwd 的那一组照旧用自己的文案，身份与路径都不参与', () => {
  assert.deepEqual(projectLabel({ path: '' }, t), { name: 'noCwdGroup', tip: 'noCwdGroup' })
})

test('项目名：取身份最后一段，末尾的 .git 不算（"认不出来就原样退回"的形状可能还带着它）', () => {
  assert.equal(repoName('github.com/he0119/dsh-session-manager'), 'dsh-session-manager')
  assert.equal(repoName('gitlab.example.com/Team/Repo'), 'Repo')
  assert.equal(repoName('/srv/git/thing.git'), 'thing')
  assert.equal(repoName('C:/repos/thing'), 'thing')
})

test('下拉框：身份取代标题那一栏，本机路径留着（那里没有悬浮提示可退）', () => {
  assert.equal(pathLabel({ path: '/home/u/dev/x', title: '测试项目', repo: 'github.com/he0119/x' }), 'github.com/he0119/x — /home/u/dev/x')
  assert.equal(pathLabel({ path: '/home/u/dev/x', title: '测试项目' }), '测试项目 — /home/u/dev/x')
  assert.equal(pathLabel({ path: '/home/u/dev/x' }), '/home/u/dev/x')
  assert.equal(
    optionLabel({ path: '/home/u/dev/x', title: '测试项目', repo: 'github.com/he0119/x', count: 2 }, t),
    'github.com/he0119/x — /home/u/dev/x — sessionsInDir:{"count":2}',
  )
})

test('源候选把身份带在行上（界面文案只读行，不再自己查表）', () => {
  const rows = migrationSourceRows(
    [s('owned', '/b', false)],
    [{ path: '/b', title: '工作区乙' }],
    t,
    { '/b': 'github.com/he0119/b' },
  )
  assert.deepEqual(rows, [{ path: '/b', title: '工作区乙', count: 1, repo: 'github.com/he0119/b' }])
  // 没有身份的目录：行上就没有这个字段（界面据此退回路径）
  assert.deepEqual(migrationSourceRows([s('other', '/c', false)], [], t), [{ path: '/c', count: 1 }])
})

test('源匹配：目录按 cwd 匹配，未分组给的就是跨目录的那一批，空值不匹配任何会话', () => {
  const list = [s('owned', '/a', false), s('orphan-a', '/a', true), s('orphan-b', '/b', true)]
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

/** 带 hidden 的行（界面从 /state 拿到的就是这个形状：宿主在那一组里 + 看不见的原因）。 */
const h = (id: string, cwd: string | undefined, ungrouped?: boolean, hidden?: string) => ({
  id,
  cwd,
  ungrouped,
  hidden,
})

test('未分组来源：只收宿主说在那一组里的那些（子代理 / 空白 / 已归档都不在那一组里）', () => {
  const list = [
    h('orphan-visible', '/a', true),
    h('orphan-subagent', '/a', false, 'subagent'),
    h('orphan-blank', '/a', false, 'blank'),
    h('orphan-archived', '/a', false, 'archived'),
  ]
  assert.deepEqual(unownedSessions(list).map((x) => x.id), ['orphan-visible'])
})

test('目录来源：候选与条数都只数看得见的那批', () => {
  const list = [
    h('owned', '/a', false),
    h('owned-archived', '/a', false, 'archived'),
    h('orphan-subagent', '/a', false, 'subagent'),
  ]
  assert.deepEqual(migrationMatching(list, '/a').map((x) => x.id), ['owned'])
  // 条数是"会进候选的条数"，不是"库里有几条"
  assert.deepEqual(migrationSourceRows(list, [{ path: '/a', title: '甲' }], t), [
    { path: '/a', title: '甲', count: 1 },
  ])
  // 一个目录里全是看不见的会话：它连候选行都不出现（未登记工作区那一条）
  const hiddenOnly = [h('orphan-blank', '/b', false, 'blank')]
  assert.deepEqual(migrationSourceRows(hiddenOnly, [], t), [])
})

// ---- 删除预演：「这条是怎么进来的」 ----
//
// 删除会沿父子关系向下展开（见 `src/remove.ts` 的 `familyOf()`），所以预演清单里会出现用户**没勾过**
// 的会话。行上那枚标签就是它的解释：不挂，用户只会看到"我明明只选了一条，怎么要删三条"。

test('级联带进来的行：说"随父会话删"，提示里点名是哪一条（有标题用标题）', () => {
  assert.deepEqual(deleteFamilyNote({ via: { id: 'session-p', title: '搬家那次' } }, t), {
    text: 'manageDeleteVia',
    tip: 'manageDeleteViaTip:{"name":"搬家那次"}',
  })
  // 读不到标题就退回 id：提示里至少还有一个能对得上日志的名字
  assert.deepEqual(deleteFamilyNote({ via: { id: 'session-p' } }, t), {
    text: 'manageDeleteVia',
    tip: 'manageDeleteViaTip:{"name":"session-p"}',
  })
  // 标题是空白串与没有标题同一条路（`sessionLabel` 也是这个口径）
  assert.deepEqual(deleteFamilyNote({ via: { id: 'session-p', title: '  ' } }, t)?.tip, 'manageDeleteViaTip:{"name":"session-p"}')
})

test('没有出处时不挂标签（点名的那几条就是这样）', () => {
  assert.equal(deleteFamilyNote({}, t), undefined)
})

// 迁移那份清单里的同一枚标签：判据与称呼是同一处（`familyNote`），只有动词不同——迁移不删掉它，只是
// 把它一起搬走，说「随父删」就是一句错话（界面上的动作与标签必须说同一件事）。
test('迁移清单里：说"随父迁"，提示里点名是哪一条', () => {
  assert.deepEqual(migrateFamilyNote({ via: { id: 'session-p', title: '搬家那次' } }, t), {
    text: 'migrateVia',
    tip: 'migrateViaTip:{"name":"搬家那次"}',
  })
  // 读不到标题同样退回 id（与删除那份同一个 `referentName`）
  assert.deepEqual(migrateFamilyNote({ via: { id: 'session-p' } }, t), {
    text: 'migrateVia',
    tip: 'migrateViaTip:{"name":"session-p"}',
  })
})

test('迁移清单里没有出处时也不挂标签', () => {
  assert.equal(migrateFamilyNote({}, t), undefined)
})
