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
  candidateRow,
  deleteFamilyNote,
  describeCwd,
  directoryTargetRows,
  filterPathRows,
  migrateFamilyNote,
  pathLabel,
  projectLabel,
  repoHost,
  repoName,
  sessionLabel,
} from '../src/client/logic/planRows.ts'

// 同 groups.test.ts：不 import `src/client/api.ts`（它会把 src/client 拉进没有 DOM 的 Host 工程）。

/** 只认键与参数的假翻译：断言里看得见"哪个键、带了什么参数"。 */
const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key

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


test('候选面板里一行：名字在第一行，路径与条数在第二行，整串留给悬浮提示', () => {
  assert.deepEqual(
    candidateRow({ path: '/home/u/dev/x', title: '测试项目', repo: 'github.com/he0119/x', count: 2 }, t),
    {
      name: '测试项目',
      meta: '/home/u/dev/x · list.sessionsInDir:{"count":2}',
      tip: 'github.com/he0119/x\n/home/u/dev/x\nlist.sessionsInDir:{"count":2}',
    },
  )
  // 名字退到项目名（与组头同一个 `projectLabel`），条数照旧在第二行
  assert.deepEqual(candidateRow({ path: '/home/u/dev/x', repo: 'github.com/he0119/x', count: 1 }, t), {
    name: 'x',
    meta: '/home/u/dev/x · list.sessionsInDir:{"count":1}',
    tip: 'github.com/he0119/x\n/home/u/dev/x\nlist.sessionsInDir:{"count":1}',
  })
  // 什么都没有的裸目录：两行都是路径
  assert.deepEqual(candidateRow({ path: '/a' }, t), { name: '/a', meta: '/a', tip: '/a' })
  // 盘上已经没有的目录：名字后面一枚标签，悬浮提示里补一句"为什么点不动"（面板据此把它置灰）
  assert.deepEqual(candidateRow({ path: '/gone', title: '旧项目', missing: true }, t), {
    name: '旧项目',
    meta: '/gone',
    missing: 'pathField.missing',
    tip: '/gone\npathField.missingTip',
  })
})

// ---- 候选筛选（`filterPathRows`）----
//
// 工作区一多，候选就是几十条，列表里只能一行行找。候选面板自带一个筛选框把这个列表收窄，判据是
// **行自己的事实**（路径 / 标题 / 项目身份），不是"渲染出来的那一整串"——那一串里
// 拼了「— 3 条会话」这样的装饰，拿它当关键词库会让「3」命中一堆行。这里钉死这两条。

test('候选筛选：路径、标题、项目身份都能命中，大小写不敏感', () => {
  const rows = [
    { path: '/home/u/dev/dsh-aperture', title: '光圈', repo: 'github.com/he0119/dsh-aperture' },
    { path: '/home/u/dev/dsh-session-manager' },
  ]
  assert.deepEqual(filterPathRows(rows, 'aperture').map((row) => row.path), ['/home/u/dev/dsh-aperture'])
  // 标题不在路径里也要命中：用户记的是自己给工作区起的名字
  assert.deepEqual(filterPathRows(rows, '光圈').map((row) => row.path), ['/home/u/dev/dsh-aperture'])
  assert.deepEqual(filterPathRows(rows, 'SESSION-MANAGER').map((row) => row.path), ['/home/u/dev/dsh-session-manager'])
  // 项目身份命中：同一个仓库在本机的两个克隆靠它一起被捞出来
  assert.deepEqual(filterPathRows(rows, 'github.com/he0119').map((row) => row.path), ['/home/u/dev/dsh-aperture'])
})

test('候选筛选：空白关键词原样返回（顺序不变、给的是新数组），没命中的就是空', () => {
  const rows = [{ path: '/b' }, { path: '/a', title: '甲' }]
  const all = filterPathRows(rows, '   ')
  assert.deepEqual(all, rows, '空关键词不筛')
  assert.notEqual(all, rows, '返回一份新数组：调用方把它当列表内容，不该拿到候选列表本身')
  assert.deepEqual(filterPathRows(rows, 'zzz-没有这个'), [])
})

test('候选筛选：不拿拼出来的那一串当关键词库（条数只是装饰，不参与匹配）', () => {
  const rows = [{ path: '/a', count: 3 }]
  assert.deepEqual(filterPathRows(rows, '3'), [], '「3 条会话」里的 3 不该把 /a 捞出来')
  assert.deepEqual(filterPathRows(rows, 'sessionsInDir'), [], '文案键名同理')
})

// ---- 一个目录怎么称呼：项目身份（git remote）与本机路径 ----
//
// 本机绝对路径是**机器特有**的：同一个项目在两台机器上可以落在完全不同的目录里，而 `host/owner/repo`
// 是仓库自己的名字。所以组头显示身份、把路径退到悬浮提示里；只有一行可用的那两处（目录字段的值控件、
// 导入页那个下拉框）里两个都留——那里没有第二行与悬浮提示可退，同一个仓库在本机的两个克隆只能靠路径
// 区分。

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
  assert.deepEqual(projectLabel({ path: '' }, t), { name: 'list.noCwdGroup', tip: 'list.noCwdGroup' })
})

test('项目名：取身份最后一段，末尾的 .git 不算（"认不出来就原样退回"的形状可能还带着它）', () => {
  assert.equal(repoName('github.com/he0119/dsh-session-manager'), 'dsh-session-manager')
  assert.equal(repoName('gitlab.example.com/Team/Repo'), 'Repo')
  assert.equal(repoName('/srv/git/thing.git'), 'thing')
  assert.equal(repoName('C:/repos/thing'), 'thing')
})

test('一行路径的称呼：身份取代标题那一栏，本机路径留着（三处目录字段的值控件都读它）', () => {
  assert.equal(pathLabel({ path: '/home/u/dev/x', title: '测试项目', repo: 'github.com/he0119/x' }), 'github.com/he0119/x — /home/u/dev/x')
  assert.equal(pathLabel({ path: '/home/u/dev/x', title: '测试项目' }), '测试项目 — /home/u/dev/x')
  assert.equal(pathLabel({ path: '/home/u/dev/x' }), '/home/u/dev/x')
})

test('目标候选：已登记工作区（同一路径只留一条）+ 当前值本身，且不带条数', () => {
  const workspaces = [
    { path: '/a', title: '工作区甲' },
    { path: '/a', title: '重复登记的同一条' },
    { path: '/b', title: '工作区乙' },
  ]
  // 当前值不在注册表里（可能是「浏览文件系统…」选回来的）：补一行，界面要让"列出来的"与"值控件上的"对得上
  assert.deepEqual(directoryTargetRows(workspaces, { '/a': 'github.com/he0119/a' }, '/tmp/new'), [
    { path: '/a', title: '工作区甲', repo: 'github.com/he0119/a' },
    { path: '/b', title: '工作区乙' },
    { path: '/tmp/new' },
  ])
  // 当前值就是某一条候选时不再补（列表里那一行自己就带 aria-current）
  assert.deepEqual(directoryTargetRows(workspaces, {}, '/b'), [
    { path: '/a', title: '工作区甲' },
    { path: '/b', title: '工作区乙' },
  ])
  // 还没选（空串）时不补行；没有工作区时就是空列表
  assert.deepEqual(directoryTargetRows(workspaces, {}), [
    { path: '/a', title: '工作区甲' },
    { path: '/b', title: '工作区乙' },
  ])
  assert.deepEqual(directoryTargetRows([], {}, ''), [])
})

test('目标候选：宿主说盘上已经没有的那些照旧列出来，但行上带 missing（面板据此置灰）', () => {
  // 注册表里的登记不保证盘上还有（项目文件夹被删掉、目录改了名）：这种候选**列出来**（"我登记过的
  // 工作区还在名单里"），但点不动——选它只会撞上宿主那句「目标工作区目录不存在」。
  assert.deepEqual(
    directoryTargetRows(
      [
        { path: '/a', title: '工作区甲', exists: true },
        { path: '/gone', title: '删掉的工作区', exists: false },
        // `exists` 缺席（旧宿主 / 没给这个字段）按"还在"处理：不在界面上替宿主猜
        { path: '/unknown' },
      ],
      {},
      '',
    ),
    [
      { path: '/a', title: '工作区甲' },
      { path: '/gone', title: '删掉的工作区', missing: true },
      { path: '/unknown', title: undefined },
    ],
  )
})
// ---- 删除预演：「这条是怎么进来的」 ----
//
// 删除会沿父子关系向下展开（见 `src/remove.ts` 的 `familyOf()`），所以预演清单里会出现用户**没勾过**
// 的会话。行上那枚标签就是它的解释：不挂，用户只会看到"我明明只选了一条，怎么要删三条"。

test('级联带进来的行：说"随父会话删"，提示里点名是哪一条（有标题用标题）', () => {
  assert.deepEqual(deleteFamilyNote({ via: { id: 'session-p', title: '搬家那次' } }, t), {
    text: 'manage.delete.via',
    tip: 'manage.delete.viaTip:{"name":"搬家那次"}',
  })
  // 读不到标题就退回 id：提示里至少还有一个能对得上日志的名字
  assert.deepEqual(deleteFamilyNote({ via: { id: 'session-p' } }, t), {
    text: 'manage.delete.via',
    tip: 'manage.delete.viaTip:{"name":"session-p"}',
  })
  // 标题是空白串与没有标题同一条路（`sessionLabel` 也是这个口径）
  assert.deepEqual(deleteFamilyNote({ via: { id: 'session-p', title: '  ' } }, t)?.tip, 'manage.delete.viaTip:{"name":"session-p"}')
})

test('没有出处时不挂标签（点名的那几条就是这样）', () => {
  assert.equal(deleteFamilyNote({}, t), undefined)
})

// 迁移那份清单里的同一枚标签：判据与称呼是同一处（`familyNote`），只有动词不同——迁移不删掉它，只是
// 把它一起搬走，说「随父删」就是一句错话（界面上的动作与标签必须说同一件事）。
test('迁移清单里：说"随父迁"，提示里点名是哪一条', () => {
  assert.deepEqual(migrateFamilyNote({ via: { id: 'session-p', title: '搬家那次' } }, t), {
    text: 'migrate.via',
    tip: 'migrate.viaTip:{"name":"搬家那次"}',
  })
  // 读不到标题同样退回 id（与删除那份同一个 `referentName`）
  assert.deepEqual(migrateFamilyNote({ via: { id: 'session-p' } }, t), {
    text: 'migrate.via',
    tip: 'migrate.viaTip:{"name":"session-p"}',
  })
})

test('迁移清单里没有出处时也不挂标签', () => {
  assert.equal(migrateFamilyNote({}, t), undefined)
})
