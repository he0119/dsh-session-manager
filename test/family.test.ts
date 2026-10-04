// 「子智能体跟着父会话走」：展开判据（src/family.ts）与它在迁移这条路上的落地。
//
// 为什么迁移也要按族走：子会话在外壳侧边栏里没有自己的位置（那一行只从父会话日志里的
// `subagent/catalog` 长出来）。父会话搬去别的目录、子会话留在原地，族就被拆成两半——侧边栏里看着
// 还挂在父下面，而它的日志在旧目录里，下一次"清掉旧项目"就会把它一起带走。更糟的是它**永远搬不动**：
// 候选里没有它（侧边栏看不见），点名点到它又会被拒（那是向上的牵连）。
//
// 所以：候选仍然只有侧边栏看得见的那批（见 test/hidden.test.ts），但**选中一条候选就带上它的全部
// 后代**——多级、跨项目目录都带上，各自改写 cwd、各自搬目录、进同一份备份。成员资格不变：子智能体本来
// 不在册，搬完还是不在册。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { applyPlan, verifyAppliedPlan } from '../src/execute.ts'
import { familyOf, loneSubagents } from '../src/family.ts'
import { readManifest, rollback } from '../src/journal.ts'
import { buildRelocationPlan } from '../src/plan.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import type { DiscoveredSession } from '../src/discovery.ts'
import type { DecodeAll, SessionMove, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

// ---- 展开判据本身 ----

/**
 * 只带 `familyOf()` 要用的那几个字段：id、header.parentSession、header.origin。
 *
 * 给了 `parentSession` 的默认写成**子智能体**（`origin: "subagent"`，真实库里这两条一起写）；要造
 * 「有父指针但不是子智能体」的分叉用 `fork()`。
 */
const session = (id: string, parentSession?: string, options: { subagent?: boolean } = {}): DiscoveredSession => {
  const asSubagent = parentSession !== undefined && options.subagent !== false
  return {
    id,
    dirName: id,
    dir: `/sessions/p/${id}`,
    cwd: '/p',
    createdAt: 1,
    header: {
      type: 'session',
      version: 4,
      id,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(asSubagent ? { origin: 'subagent' as const } : {}),
    },
    files: [],
  } as DiscoveredSession
}

/**
 * 分叉：`sessions.fork()` 出来的会话——有 `parentSession`、没有 `origin`、`isSeeded: true`。
 * 它是一份自洽的普通会话（源会话的已完成轮次被拷进它自己的日志），不跟着父走。
 */
const fork = (id: string, parentSession: string): DiscoveredSession => session(id, parentSession, { subagent: false })

const idsOf = (members: ReturnType<typeof familyOf>): string[] => members.map((member) => member.session.id)

test('展开：点名的一条在前，随后是全部子智能体后代（多级），同一条只出现一次', () => {
  const library = [
    session('P'),
    session('c1', 'P'),
    session('c2', 'P'),
    session('g1', 'c1'),
    session('g2', 'g1'),
    session('other'),
  ]
  const family = familyOf(library, [library[0]!])
  assert.equal(idsOf(family)[0], 'P', '点名的排在最前')
  assert.deepEqual(idsOf(family).slice(1).sort(), ['c1', 'c2', 'g1', 'g2'])
  assert.equal(family.length, 5, '六条里只有 other 不在族里')
  // 每条都记着"是哪条点名的把它牵进来的"
  for (const member of family) assert.equal(member.root.id, 'P')
})

test('展开：点名两条时各自成族、共享的后代不重复；父与子同时被点名时按点名处理', () => {
  const library = [session('P'), session('Q'), session('shared', 'P'), session('q1', 'Q')]
  const both = familyOf(library, [library[0]!, library[1]!])
  assert.deepEqual(idsOf(both), ['P', 'shared', 'Q', 'q1'])
  assert.equal(both.filter((member) => member.session.id === 'shared').length, 1, '共享的后代只能出现一次')

  // 父与子都被点名：子在点名那一轮就收进来了，展开父时不会又把它当成"顺带进来的"
  const named = familyOf(library, [library[2]!, library[0]!])
  assert.deepEqual(idsOf(named), ['shared', 'P'])
  assert.equal(named.find((member) => member.session.id === 'shared')?.root.id, 'shared')
})

test('展开：分叉不跟着父走（父被删 / 被迁都不带它），但分叉自己的子智能体照旧跟着它', () => {
  const library = [session('P'), session('c1', 'P'), fork('f1', 'P'), session('g1', 'f1'), fork('f2', 'c1')]
  const family = familyOf(library, [library[0]!])
  assert.deepEqual(idsOf(family), ['P', 'c1'], 'f1 是分叉（独立会话），f2 挂在子智能体 c1 下面但也是分叉——都不进来')

  const fromFork = familyOf(library, [library[2]!])
  assert.deepEqual(idsOf(fromFork), ['f1', 'g1'], '点名分叉时，挂在它下面的子智能体跟着它走')
})

test('单独点名的子智能体：父会话还在库里、又没被点名时才挑出来', () => {
  const library = [session('P'), session('c1', 'P'), session('g1', 'c1'), fork('f1', 'P'), session('orphan', 'gone')]
  assert.deepEqual(loneSubagents(library, new Set(['c1'])), [{ id: 'c1', parentId: 'P' }])
  assert.deepEqual(loneSubagents(library, new Set(['g1'])), [{ id: 'g1', parentId: 'c1' }], '隔一层也一样')
  assert.deepEqual(loneSubagents(library, new Set(['c1', 'P'])), [], '父会话也在这次点名里，就不是"单独"')
  assert.deepEqual(loneSubagents(library, new Set(['orphan'])), [], '父会话不在库里的孤儿没有可跟随的会话')
  assert.deepEqual(loneSubagents(library, new Set(['f1'])), [], '分叉不是子智能体，这条规则管不到它')
  assert.deepEqual(loneSubagents(library, new Set(['P'])), [], '普通会话本来就该被单独点名')
})

test('展开：坏数据里的环不会转不出来；自己指向自己也不算一条边', () => {
  const loop = [session('a', 'b'), session('b', 'a')]
  assert.deepEqual(idsOf(familyOf(loop, [loop[0]!])).sort(), ['a', 'b'])
  const self = [session('self', 'self')]
  assert.deepEqual(idsOf(familyOf(self, [self[0]!])), ['self'])
})

// ---- 迁移这条路 ----

let clock = 0
function makeLog(id: string, cwd: string, extra: Record<string, unknown> = {}): Buffer {
  const createdAt = ++clock
  const header = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, ...extra }
  return Buffer.concat([
    encodeRawFrame(JSON.stringify(header) + '\n'),
    encodeRawFrame(JSON.stringify({ type: 'turn/start', seq: 0, time: createdAt, data: { turn: 1 } }) + '\n'),
  ])
}

interface Sandbox {
  root: string
  registryPath: string
  registry: WorkspaceRegistryState
  backupRoot: string
  dirA: string
  dirB: string
  dirTarget: string
  logs: Record<string, Buffer>
  dirOf: (id: string) => string
}

/**
 * 沙箱布局：
 *   dirA（已登记 ws-a，只认领 session-parent）—— 父会话与它的两条直系后代，外加一条没在册的旁观者；
 *   dirB —— **另一个项目目录**里住着父会话的另一个后代（父会话被单独迁走过一次就会长成这样）；
 *   dirTarget —— 目标目录（不在注册表里 → 这次要新建一条工作区记录）。
 */
function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const dirA = join(base, 'dir-a')
  const dirB = join(base, 'dir-b')
  const dirTarget = join(base, 'target')
  for (const dir of [dirA, dirB, dirTarget]) mkdirSync(dir, { recursive: true })

  const root = join(base, 'dsh', 'sessions')
  const logs: Record<string, Buffer> = {
    'session-parent': makeLog('session-parent', dirA, { delegationDepth: 0 }),
    'session-child': makeLog('session-child', dirA, { origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }),
    'session-grand': makeLog('session-grand', dirA, { origin: 'subagent', parentSession: 'session-child', delegationDepth: 2 }),
    // 跨项目目录的后代：cwd 是 dirB，日志因此落在 dirB 的项目目录里
    'session-far': makeLog('session-far', dirB, { origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }),
    // 与这族无关、也没在册的一条旁观者：用来验证"未在册"这条拦截仍然只管候选
    'session-stray': makeLog('session-stray', dirA, { delegationDepth: 0 }),
  }
  const place = (cwd: string, id: string): void => {
    const dir = join(root, projectKey(cwd), id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), logs[id]!)
  }
  for (const [id, cwd] of [
    ['session-parent', dirA],
    ['session-child', dirA],
    ['session-grand', dirA],
    ['session-stray', dirA],
    ['session-far', dirB],
  ] as const) {
    place(cwd, id)
  }

  const registryPath = join(base, 'dsh', 'storages', 'workspace.json')
  mkdirSync(join(base, 'dsh', 'storages'), { recursive: true })
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-a': {
          path: dirA,
          title: 'a',
          sessionIds: ['session-parent'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')

  return {
    root,
    registryPath,
    registry,
    backupRoot: join(base, 'backups'),
    dirA,
    dirB,
    dirTarget,
    logs,
    dirOf: (id: string) => {
      for (const cwd of [dirA, dirB, dirTarget]) {
        const dir = join(root, projectKey(cwd), id)
        if (existsSync(dir)) return dir
      }
      throw new Error(`session ${id} not found in the sandbox`)
    },
  }
}

const opts = (sb: Sandbox, extra: Record<string, unknown> = {}) => ({
  root: sb.root,
  registry: sb.registry,
  from: sb.dirA,
  to: sb.dirTarget,
  decodeAll,
  sessionIds: ['session-parent'],
  ...extra,
})

test('迁移：点名父会话 → 全部后代一起进计划（多级、跨项目目录），并标出是谁把它带进来的', () => {
  const sb = makeSandbox('family-migrate-plan')
  const plan = buildRelocationPlan(opts(sb))

  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.sessions[0]?.id, 'session-parent', '点名的排在最前')
  // 其余按层展开（直接子在前、孙代理在后），层内按发现顺序（新→旧）
  assert.deepEqual(
    plan.sessions.map((s: SessionMove) => s.id).slice(1).sort(),
    ['session-child', 'session-far', 'session-grand'],
  )
  assert.equal(plan.cascaded, 3)
  // 点名的那条不说"跟着谁"；三条后代都指向点名的那条（隔一层的孙代理也是）
  assert.equal(plan.sessions[0]?.via, undefined)
  for (const id of ['session-child', 'session-grand', 'session-far']) {
    assert.deepEqual(plan.sessions.find((s: SessionMove) => s.id === id)?.via, { id: 'session-parent' })
  }
  // 每条会话各自的源：父与同目录的后代是 dirA，跨目录那条是自己的 cwd（dirB）
  const fromById = new Map(plan.sessions.map((s: SessionMove) => [s.id, s.from]))
  assert.equal(fromById.get('session-parent'), sb.dirA)
  assert.equal(fromById.get('session-far'), sb.dirB, '跨目录的后代按自己的 cwd 定源目录')
  // 目标：整族都落在目标项目目录里
  for (const s of plan.sessions) {
    assert.equal(s.to, sb.dirTarget)
    assert.equal(s.targetDir, join(sb.root, projectKey(sb.dirTarget), s.id))
  }
  // 成员资格不变：只有点名的父会话进目标工作区，三条子智能体本来不在册、搬完也不在册
  assert.deepEqual(plan.sessions.map((s: SessionMove) => s.registered), [true, false, false, false])
  assert.equal(plan.registryChange?.createdTarget, true)
  assert.deepEqual(plan.registryChange?.added, ['session-parent'])
  assert.deepEqual(plan.registryChange?.adoptedFromUnowned, [])
  // 源工作区被摘空之后整条记录会被删掉（宿主的工作区只能拥有真实存在的会话）
  assert.deepEqual(plan.registryChange?.removedSources, [{ workspaceId: 'ws-a', path: sb.dirA }])
  assert.equal(plan.nextRegistry?.tables.workspaces['ws-a'], undefined)
  // 旁观者没被牵连（它不在这次点名里）
  assert.equal(plan.sessions.some((s: SessionMove) => s.id === 'session-stray'), false)
})

test('迁移：「连同未分组的会话」关掉时不挡跟着走的子智能体，但仍挡未在册的候选', () => {
  const sb = makeSandbox('family-migrate-include-unowned')

  // 子智能体本来就没在册——它跟着父走，不该被"未分组"那个开关拦下
  const following = buildRelocationPlan(opts(sb, { includeUnowned: false }))
  assert.equal(following.ok, true, following.problems.join('; '))
  assert.equal(following.cascaded, 3)

  // 而一个真正没在册的**候选**（用户点得到的那条）照旧拦：开关管的是候选，不是族
  const stray = buildRelocationPlan(opts(sb, { sessionIds: ['session-stray'], includeUnowned: false }))
  assert.equal(stray.ok, false)
  assert.deepEqual(stray.problems, ['session session-stray is not accounted by any workspace (use includeUnowned)'])
  assert.equal(stray.sessions.length, 1, '没在册的那条不进计划，但级联展开照旧发生（它名下没有后代）')
  assert.equal(stray.cascaded, 0)
})

test('迁移：整族搬过去（各自改写 cwd、清掉两个空项目目录），回滚把整族按清单搬回来', () => {
  const sb = makeSandbox('family-migrate-apply')
  const plan = buildRelocationPlan(opts(sb))
  assert.equal(plan.ok, true, plan.problems.join('; '))

  const result = applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot })
  assert.equal(result.rewritten, 4)
  assert.equal(result.moved, 4)
  const verified = verifyAppliedPlan(plan, { decodeAll })
  assert.equal(verified.ok, true, verified.problems.join('; '))
  assert.equal(verified.checked, 4)

  // 源项目目录：dirA 里还剩旁观者（不能删），dirB 被搬空（要删）
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirA))), true, '还有别的会话的项目目录不能删')
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirB))), false, '搬空的项目目录要删掉')

  // 每条都真的在目标项目目录里，且 header 的 cwd 已经改写成目标
  for (const id of ['session-parent', 'session-child', 'session-grand', 'session-far']) {
    const dir = join(sb.root, projectKey(sb.dirTarget), id)
    assert.equal(existsSync(dir), true, `${id} 该在目标项目目录里`)
    const header = JSON.parse(decodeAll(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as {
      cwd?: string
      parentSession?: string
    }
    assert.equal(header.cwd, sb.dirTarget)
    // 父子关系是 header 里的字段，改写 cwd 不该碰它
    if (id !== 'session-parent') assert.equal(header.parentSession, id === 'session-grand' ? 'session-child' : 'session-parent')
  }

  // 备份清单：整族一份，源目录按每条会话自己的位置记
  const { manifest } = readManifest(result.backupDir)
  assert.deepEqual(
    manifest.sessions.map((s) => s.id).sort(),
    ['session-child', 'session-far', 'session-grand', 'session-parent'],
  )
  assert.deepEqual(
    [...new Set(manifest.sessions.map((s) => basename(dirname(s.sourceDir))))].sort(),
    [projectKey(sb.dirA), projectKey(sb.dirB)].sort(),
  )

  // 注册表：目标记录收下父会话，ws-a 被摘空
  const registry = readRegistry(sb.registryPath)
  const targetId = plan.registryChange!.targetId
  assert.deepEqual(registry.tables.workspaces[targetId]?.sessionIds, ['session-parent'])
  assert.equal(registry.tables.workspaces['ws-a'], undefined, '摘空之后源工作区记录不再存在')

  // 回滚：整族按清单回到各自的源项目目录，字节一模一样
  const rolled = rollback(manifest, { backupDir: result.backupDir })
  assert.equal(rolled.restoredFiles, 4)
  for (const id of ['session-parent', 'session-child', 'session-grand', 'session-far']) {
    const dir = sb.dirOf(id)
    assert.deepEqual(readFileSync(join(dir, 'session.v4.jsonl.zstd')), sb.logs[id], `${id} 的字节要一模一样`)
  }
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirB), 'session-far')), true, '跨目录那条要回到 dirB')
  const after = readRegistry(sb.registryPath)
  assert.deepEqual(Object.keys(after.tables.workspaces), ['ws-a'])
  assert.deepEqual(after.tables.workspaces['ws-a']?.sessionIds, ['session-parent'])
})
