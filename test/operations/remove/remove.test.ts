// 删除会话：预览 → 备份 → 真删 → 复核 → 从备份恢复。
//
// 这是本插件唯一一处**真删用户数据**的路径（宿主没有删会话的能力，见 src/operations/remove/remove.ts 的说明），所以
// 这里把每一步都钉死：宿主内存里活着的拒删、不在库里的拒删、删除前必须先落下备份、删完目录真的没了、
// 恢复之后字节（含 session.lock）一粒不差地回来、而**注册表从头到尾没被动过**。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { readManifest } from '../../../src/shared/journal.ts'
import { rollbackMigration } from '../../../src/operations/migrate/migrate.ts'
import { sessionDir } from '../../../src/shared/paths.ts'
import { readRegistry, writeRegistryAtomic } from '../../../src/shared/registry.ts'
import { createTitleResolver } from '../../../src/shared/log/session-title.ts'
import type { ProjectionCacheReader, ProjectionCacheRecord } from '../../../src/shared/library/projection-cache.ts'
import { planRemoval, runRemoval, type RemoveDeps } from '../../../src/operations/remove/remove.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../../../src/shared/types.ts'
import { encodeRawFrame } from '../../../src/shared/log/zstd-frame.ts'
import { sandboxDir } from '../../fixtures/sandbox.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

interface Sandbox {
  base: string
  sessionsRoot: string
  registryPath: string
  backupRoot: string
  cwdA: string
}

function makeSandbox(name: string): Sandbox {
  const base = sandboxDir(name)
  rmSync(base, { recursive: true, force: true })
  const sessionsRoot = join(base, 'sessions')
  const backupRoot = join(base, 'backups')
  const cwdA = join(base, 'dir-a')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(cwdA, { recursive: true })
  const registryPath = join(base, 'workspace.json')
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-a': {
          path: cwdA,
          title: 'a',
          sessionIds: ['session-doomed'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeRegistryAtomic(registryPath, registry)
  return { base, sessionsRoot, registryPath, backupRoot, cwdA }
}

/** 写一条会话：日志（可带标题）+ 一个 `session.lock`（宿主的锁文件，删除/恢复都得跟着走）。 */
function writeSession(
  sandbox: Sandbox,
  id: string,
  createdAt: number,
  options: { title?: string; parentSession?: string; origin?: 'subagent'; cwd?: string } = {},
): string {
  const cwd = options.cwd ?? sandbox.cwdA
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: options.parentSession === undefined ? 0 : 1,
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  }
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    ...(options.title === undefined ? [] : [JSON.stringify({ type: 'session/title', seq: 1, data: { title: options.title } })]),
  ]
  const dir = sessionDir(sandbox.sessionsRoot, cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))))
  writeFileSync(join(dir, 'session.lock'), '')
  return dir
}

/**
 * 写一条子智能体会话：header 里带 `parentSession` 与 `origin`（宿主建子会话时两边一起写，
 * 见 test/shared/log/session-log.test.ts）。
 */
function writeSubagent(sandbox: Sandbox, id: string, parent: string, createdAt: number, options: { title?: string; cwd?: string } = {}): string {
  return writeSession(sandbox, id, createdAt, { ...options, parentSession: parent, origin: 'subagent' })
}

function deps(sandbox: Sandbox, extra: Partial<RemoveDeps> = {}): RemoveDeps {
  return {
    sessionsRoot: sandbox.sessionsRoot,
    registryPath: sandbox.registryPath,
    backupRoot: sandbox.backupRoot,
    decodeAll,
    // 与界面那条路一致：预览里按标题认会话（见 session-title.ts）
    resolveTitle: createTitleResolver({ decodeAll }),
    now: new Date('2026-09-27T00:00:00.000Z'),
    ...extra,
  }
}

test('预览：列清会删什么，一个字节都不写', async () => {
  const sandbox = makeSandbox('remove-plan')
  const dir = writeSession(sandbox, 'session-doomed', 1000, { title: '不要了的会话' })

  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: false })
  assert.equal(run.applied, false)
  assert.equal(run.plan.ok, true, run.plan.problems.join('; '))
  assert.deepEqual(run.plan.entries.map((e) => e.id), ['session-doomed'])
  assert.deepEqual(run.plan.entries.map((e) => e.title), ['不要了的会话'])
  assert.equal(run.plan.files, 1)
  assert.equal(existsSync(dir), true, '预览不许动磁盘')
  assert.equal(existsSync(sandbox.backupRoot), false, '预览不许建备份目录')
})

test('执行：先备份（整份会话目录）再删，复核通过；空掉的项目目录顺手清掉', async () => {
  const sandbox = makeSandbox('remove-apply')
  const dir = writeSession(sandbox, 'session-doomed', 1000)
  const before = readFileSync(join(dir, 'session.v4.jsonl.zstd'))

  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: true })
  assert.equal(run.applied, true)
  assert.equal(run.verified, true, run.problems.join('; '))
  assert.equal(existsSync(dir), false, '会话目录该没了')
  assert.deepEqual(run.removedProjectDirs, [dirname(dir)], '源项目目录空了就该删掉')

  // 备份里那份是完整的（日志 + 锁文件都在），清单记的是删除类型
  const backupDir = run.backupDir!
  const { manifest } = readManifest(backupDir)
  assert.equal(manifest.kind, 'delete')
  assert.equal(manifest.sessions.length, 1)
  const backed = manifest.sessions[0]!
  assert.equal(backed.sourceDir, dir)
  assert.equal(readFileSync(join(backed.targetDir, 'session.v4.jsonl.zstd')).equals(before), true)
  assert.equal(existsSync(join(backed.targetDir, 'session.lock')), true)
})

test('恢复：从备份把整个会话目录搬回原位（含 session.lock），注册表不动', async () => {
  const sandbox = makeSandbox('remove-restore')
  const dir = writeSession(sandbox, 'session-doomed', 1000)
  const before = readFileSync(join(dir, 'session.v4.jsonl.zstd'))
  const registryBefore = readFileSync(sandbox.registryPath, 'utf8')

  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: true })
  assert.equal(run.verified, true, run.problems.join('; '))
  // 删完顺手把注册表改坏一点，用来证明"恢复不还原注册表"（删除本来就没碰过它）
  const registry = readRegistry(sandbox.registryPath)
  registry.tables.workspaces['ws-a']!.sessionIds = ['session-something-else']
  writeRegistryAtomic(sandbox.registryPath, registry)
  const mutated = readFileSync(sandbox.registryPath, 'utf8')

  // 先看动作清单（dry-run 不写入磁盘）
  const dry = await rollbackMigration({ backupRoot: sandbox.backupRoot }, { backupDir: run.backupDir!, dryRun: true })
  assert.equal(dry.registryRestored, false)
  assert.equal(dry.actions.some((action) => action.startsWith('registry untouched')), true)
  assert.equal(existsSync(dir), false, 'dry-run 不许写入磁盘')

  const outcome = await rollbackMigration({ backupRoot: sandbox.backupRoot }, { backupDir: run.backupDir! })
  assert.equal(outcome.dryRun, false)
  assert.equal(outcome.restoredFiles, 1)
  assert.equal(outcome.registryRestored, false)
  // 目录连同锁文件一起回来了，字节与原样一致
  assert.equal(existsSync(dir), true)
  assert.equal(readFileSync(join(dir, 'session.v4.jsonl.zstd')).equals(before), true)
  assert.equal(existsSync(join(dir, 'session.lock')), true)
  assert.equal(statSync(dir).isDirectory(), true)
  // 注册表保持"删除之后被改坏的那份"，没有被备份里的快照覆盖
  assert.equal(readFileSync(sandbox.registryPath, 'utf8'), mutated)
  assert.notEqual(readFileSync(sandbox.registryPath, 'utf8'), registryBefore)
})

test('预览：标题优先取扫描那一趟读到的投影记录，一条会话只问一次', async () => {
  const sandbox = makeSandbox('remove-projection')
  writeSession(sandbox, 'session-doomed', 1000, { title: '日志里的名字' })
  const reads: string[] = []
  const projection: ProjectionCacheReader = (query) => {
    reads.push(query.id)
    const record: ProjectionCacheRecord = { title: '投影里的名字' }
    return record
  }
  // resolveTitle 走的是真读取器：记录里有标题就不去日志里找（见 session-title.ts）。
  const plan = await planRemoval(deps(sandbox, { projection }), { sessionIds: ['session-doomed'] })
  assert.equal(plan.entries[0]?.title, '投影里的名字', '标题从扫描读到的记录里取，不再读一遍日志')
  assert.deepEqual(reads, ['session-doomed'], '一条会话只问一次记录')
})

test('宿主内存里活着的会话拒删：进 problems，不进待删条目（预览与执行都拦住）', async () => {
  const sandbox = makeSandbox('remove-live')
  writeSession(sandbox, 'session-doomed', 1000)
  const withLive = deps(sandbox, { liveSessionIds: () => new Set(['session-doomed']) })

  const plan = await planRemoval(withLive, { sessionIds: ['session-doomed'] })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.entries, [])
  assert.match(plan.problems.join('\n'), /session-doomed 还开着（宿主把它留在内存里）/)
  // 拒绝的那句话必须给出出路：Web 端没有单条关闭的动作，"先关掉它"是做不到的。
  assert.match(plan.problems.join('\n'), /重启 DSH 之后再删/)
  const run = await runRemoval(withLive, { sessionIds: ['session-doomed'] }, { apply: true })
  assert.equal(run.applied, false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, sandbox.cwdA, 'session-doomed')), true)
})

test('不在库里的 id 与空选择各自给出可读的拒绝，别的会话不受影响', async () => {
  const sandbox = makeSandbox('remove-unknown')
  writeSession(sandbox, 'session-doomed', 1000)

  const empty = await runRemoval(deps(sandbox), { sessionIds: [] }, { apply: true })
  assert.equal(empty.applied, false)
  assert.deepEqual(empty.plan.problems, ['缺少要删除的会话（sessionIds）'])

  const unknown = await runRemoval(deps(sandbox), { sessionIds: ['session-doomed', 'session-ghost'] }, { apply: false })
  assert.equal(unknown.plan.ok, false)
  assert.deepEqual(unknown.plan.problems, ['session-ghost 不在库里：可能已经删掉了。'])
  // 结论那句话不再把问题拼进来：拼进去之后弹窗里同一句话会出现两次（结论一次、清单一次）。
  assert.equal(unknown.summary, '这次一条都没删。')
  assert.equal(unknown.summary.includes('不在库里'), false, '原因只在清单里说一遍')
  // 计划不 ok 时执行阶段整体拒绝，连那条存在的也不删
  const apply = await runRemoval(deps(sandbox), { sessionIds: ['session-doomed', 'session-ghost'] }, { apply: true })
  assert.equal(apply.applied, false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, sandbox.cwdA, 'session-doomed')), true)
})

test('删两条同目录的会话：项目目录要等两条都删完才空，随后被清掉', async () => {
  const sandbox = makeSandbox('remove-two')
  const first = writeSession(sandbox, 'session-one', 1000)
  const second = writeSession(sandbox, 'session-two', 2000)

  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-one', 'session-two'] }, { apply: true })
  assert.equal(run.verified, true, run.problems.join('; '))
  assert.equal(run.dirsRemoved, 2)
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
  assert.deepEqual(run.removedProjectDirs.length, 1)
  // 两条都在同一份备份里
  const { manifest } = readManifest(run.backupDir!)
  assert.deepEqual(manifest.sessions.map((s) => s.id).sort(), ['session-one', 'session-two'])
})

// ---- 子智能体跟着父会话走 ----
//
// 子会话在外壳侧边栏里只挂在父会话的 `subagentCatalog` 下（父日志里的 catalog 事件），父日志一没，
// 它就再没有别的入口。所以"删父"必须把整族带走，否则盘上会留下"本插件看得见、侧边栏看不见"的残留。

test('级联：点名父会话 → 全部后代一起进计划（多级、跨项目目录），并标出是谁把它带进来的', async () => {
  const sandbox = makeSandbox('remove-family')
  const otherCwd = join(sandbox.base, 'dir-b')
  writeSession(sandbox, 'session-parent', 1000, { title: '父会话' })
  writeSubagent(sandbox, 'session-child', 'session-parent', 2000, { title: '子智能体甲' })
  // 隔一层：孙代理的父是子智能体，不是被点名的那条——族的边界是"全部后代"，不是"直接子"
  writeSubagent(sandbox, 'session-grand', 'session-child', 3000, { title: '孙代理' })
  // 另一个项目目录里的后代：父子关系不靠目录，靠 header 里的 parentSession
  writeSubagent(sandbox, 'session-far', 'session-parent', 4000, { cwd: otherCwd })
  // 与这次删除无关的一条，验证"没被牵连"
  writeSession(sandbox, 'session-bystander', 5000)

  const plan = await planRemoval(deps(sandbox), { sessionIds: ['session-parent'] })
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.cascaded, 3, '三条后代是级联进来的')
  assert.deepEqual(
    plan.entries.map((entry) => entry.id).sort(),
    ['session-child', 'session-far', 'session-grand', 'session-parent'],
  )
  assert.equal(plan.entries[0]!.id, 'session-parent', '点名的排在最前，随后才是它牵出来的那些')
  // 点名的那条不说"跟着谁"；三条后代都指向点名的父会话（连隔一层的孙代理也是）
  assert.equal(plan.entries[0]!.via, undefined)
  for (const id of ['session-child', 'session-grand', 'session-far']) {
    const entry = plan.entries.find((item) => item.id === id)!
    assert.deepEqual(entry.via, { id: 'session-parent', title: '父会话' }, `${id} 要说清是跟着谁来的`)
    assert.equal(entry.origin, 'subagent')
  }
  // 预览摘要要把多出来的条数说出来，否则用户只会看到"我只勾了一条、它要删四条"
  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-parent'] }, { apply: false })
  assert.match(run.summary, /将删除 4 个会话/)
  assert.match(run.summary, /其中 3 条是子智能体会话/)
})

test('级联：多级同族一起删时，执行把整族装进同一份备份、目录一并清掉', async () => {
  const sandbox = makeSandbox('remove-family-apply')
  const parentDir = writeSession(sandbox, 'session-parent', 1000)
  const childDir = writeSubagent(sandbox, 'session-child', 'session-parent', 2000)
  const grandDir = writeSubagent(sandbox, 'session-grand', 'session-child', 3000)

  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-parent'] }, { apply: true })
  assert.equal(run.applied, true)
  assert.equal(run.verified, true, run.problems.join('; '))
  assert.equal(run.dirsRemoved, 3)
  for (const dir of [parentDir, childDir, grandDir]) assert.equal(existsSync(dir), false, `${dir} 该没了`)
  assert.match(run.summary, /其中 2 条是子智能体会话/)
  const { manifest } = readManifest(run.backupDir!)
  assert.deepEqual(manifest.sessions.map((s) => s.id).sort(), ['session-child', 'session-grand', 'session-parent'])
})

test('只删一条子智能体：父会话还在库里 → 拒绝，并告诉用户该点名谁', async () => {
  const sandbox = makeSandbox('remove-child-only')
  writeSession(sandbox, 'session-parent', 1000, { title: '父会话' })
  writeSubagent(sandbox, 'session-child', 'session-parent', 2000, { title: '子智能体' })

  const plan = await planRemoval(deps(sandbox), { sessionIds: ['session-child'] })
  assert.equal(plan.ok, false, '子智能体不能被单独操作')
  assert.equal(plan.entries.length, 0, '拒绝的计划里不该有要删的条目')
  assert.match(
    plan.problems.join('; '),
    /session-child 是子智能体，跟着父会话走：请改点名它的父会话 父会话（session-parent）。/,
  )

  // 点了父会话就不一样了：子智能体跟着它一起走
  const withParent = await planRemoval(deps(sandbox), { sessionIds: ['session-parent'] })
  assert.equal(withParent.ok, true, withParent.problems.join('; '))
  assert.deepEqual(withParent.entries.map((entry) => entry.id), ['session-parent', 'session-child'])
})

test('嵌套的单独子智能体：拒掉外层之后，里层的父也一起退出计划，于是同样被拒', async () => {
  const sandbox = makeSandbox('remove-lone-nested')
  writeSession(sandbox, 'session-p', 1000)
  writeSubagent(sandbox, 'session-r', 'session-p', 2000)
  writeSubagent(sandbox, 'session-m', 'session-r', 3000)
  writeSubagent(sandbox, 'session-x', 'session-m', 4000)

  // 点名 session-r（父 session-p 没点名）与它子树里的 session-x：两条都算"单独"，整个计划一条都不该列
  const plan = await planRemoval(deps(sandbox), { sessionIds: ['session-r', 'session-x'] })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.entries, [], '被拒的那些不该出现在"要删的东西"里')
  assert.equal(plan.problems.length, 2, plan.problems.join('; '))
  assert.match(plan.problems.join('; '), /session-r 是子智能体/)
  assert.match(plan.problems.join('; '), /session-x 是子智能体/)
})

test('孤儿（父会话已经不在库里）：没有可跟随的会话，允许单独收拾', async () => {
  const sandbox = makeSandbox('remove-orphan')
  writeSubagent(sandbox, 'session-orphan', 'session-gone', 1000)

  const plan = await planRemoval(deps(sandbox), { sessionIds: ['session-orphan'] })
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.entries.length, 1)
})

test('父子都被点名：两条都算"点名"，谁也不是顺带进来的', async () => {
  const sandbox = makeSandbox('remove-both-named')
  writeSession(sandbox, 'session-parent', 1000)
  writeSubagent(sandbox, 'session-child', 'session-parent', 2000)

  const plan = await planRemoval(deps(sandbox), { sessionIds: ['session-parent', 'session-child'] })
  assert.equal(plan.cascaded, 0)
  assert.deepEqual(plan.entries.map((entry) => entry.id), ['session-parent', 'session-child'])
  assert.equal(plan.entries[1]!.via, undefined, '自己点名的条目不说"跟着谁"')
})

test('坏数据里的环（A 的父是 B、B 的父是 A）不会让展开转不出来', async () => {
  const sandbox = makeSandbox('remove-cycle')
  writeSubagent(sandbox, 'session-a', 'session-b', 1000)
  writeSubagent(sandbox, 'session-b', 'session-a', 2000)

  const plan = await planRemoval(deps(sandbox), { sessionIds: ['session-a'] })
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.deepEqual(plan.entries.map((entry) => entry.id).sort(), ['session-a', 'session-b'])
  assert.equal(plan.cascaded, 1)
})

test('活着的后代挡住整族：计划不 ok、执行一条都不删，问题里说明它是跟着谁来的', async () => {
  const sandbox = makeSandbox('remove-family-live')
  const parentDir = writeSession(sandbox, 'session-parent', 1000, { title: '父会话' })
  const childDir = writeSubagent(sandbox, 'session-child', 'session-parent', 2000)
  const withLive = deps(sandbox, { liveSessionIds: () => new Set(['session-child']) })

  const plan = await planRemoval(withLive, { sessionIds: ['session-parent'] })
  assert.equal(plan.ok, false)
  // 活着的后代不进条目（界面不该把它列成待删项），但它的存在挡住整个计划
  assert.deepEqual(plan.entries.map((entry) => entry.id), ['session-parent'])
  assert.match(plan.problems.join('\n'), /session-child 还开着（宿主把它留在内存里）/)
  assert.match(plan.problems.join('\n'), /子智能体，跟着 父会话 一起删/)

  const run = await runRemoval(withLive, { sessionIds: ['session-parent'] }, { apply: true })
  assert.equal(run.applied, false)
  assert.equal(existsSync(parentDir), true)
  assert.equal(existsSync(childDir), true)
})

test('删除勾了「同时删除远端」：把那几条交给远端那一步，结论写进结果与那句提示', async () => {
  const sandbox = makeSandbox('remove-remote')
  writeSession(sandbox, 'session-doomed', 1000, { title: '连远端一起删' })
  const calls: string[][] = []
  const run = await runRemoval(
    deps(sandbox, {
      remoteRemove: async (ids) => {
        calls.push([...ids])
        return { removed: 1, bytes: 4096, others: ['robot-b'], problems: [] }
      },
    }),
    { sessionIds: ['session-doomed'], alsoRemote: true },
    { apply: true },
  )
  assert.deepEqual(calls, [['session-doomed']], '交给远端那一步的就是这次删掉的会话')
  assert.deepEqual(run.remote, { removed: 1, bytes: 4096, others: ['robot-b'], problems: [] })
  assert.match(run.summary, /远端这一格也清掉了（1 个包）/)
  assert.match(run.summary, /robot-b 上的副本会在它下次同步时删掉/, '别的机器那份要说清什么时候删')
  assert.doesNotMatch(run.summary, /复核：通过/, '成功的那一次不说复核（失败才说）')
  assert.doesNotMatch(run.summary, /个日志文件/, '日志文件数是收据，不进提示条')
  assert.doesNotMatch(run.summary, /backups\//, '备份目录不进提示条（「撤销」与「备份与回滚」都能到）')
  assert.equal(run.verified, true, run.problems.join('; '))
})

test('远端一个包都没删、别处也没有副本时，提示条里不提远端（那句"删掉 0 个包"是噪音）', async () => {
  const sandbox = makeSandbox('remove-remote-nothing')
  writeSession(sandbox, 'session-doomed', 1000)
  const run = await runRemoval(
    deps(sandbox, {
      remoteRemove: async () => ({ removed: 0, bytes: 0, others: [], problems: [] }),
    }),
    { sessionIds: ['session-doomed'], alsoRemote: true },
    { apply: true },
  )
  assert.equal(run.summary, '已删除 1 个会话。', '结果 + 收据都不进来')
  assert.equal(run.remote?.removed, 0, '远端那一步照旧跑过（结论还在结果里，只是不写进提示）')
})

test('删除的预览那句也不再报文件数与字节数', async () => {
  const sandbox = makeSandbox('remove-plan-short')
  writeSession(sandbox, 'session-doomed', 1000)
  const run = await runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: false })
  assert.equal(run.summary, '将删除 1 个会话，先备份再删。')
})

test('没勾「同时删除远端」时不碰远端（那一步一次都不调）', async () => {
  const sandbox = makeSandbox('remove-local-only')
  writeSession(sandbox, 'session-doomed', 1000)
  let called = 0
  const run = await runRemoval(
    deps(sandbox, {
      remoteRemove: async () => {
        called += 1
        return { removed: 0, bytes: 0, others: [], problems: [] }
      },
    }),
    { sessionIds: ['session-doomed'] },
    { apply: true },
  )
  assert.equal(called, 0)
  assert.equal(run.remote, undefined, '没删远端就没有那一项')
  assert.doesNotMatch(run.summary, /远端：/)
})

test('远端那一步失败：本地删除照旧完成，问题清单里说清后果', async () => {
  const sandbox = makeSandbox('remove-remote-fail')
  writeSession(sandbox, 'session-doomed', 1000)
  const run = await runRemoval(
    deps(sandbox, {
      remoteRemove: async () => ({
        removed: 0,
        bytes: 0,
        others: [],
        problems: ['写远端索引失败，这次删除记录没留下（下次同步可能把这些会话又拉回来）：502'],
      }),
    }),
    { sessionIds: ['session-doomed'], alsoRemote: true },
    { apply: true },
  )
  assert.equal(run.applied, true, '本机那份已经删了（也备份了），远端失败不该把它吞掉')
  assert.equal(run.verified, true, '本机这份删干净了：复核只判本机那一步')
  assert.match(run.problems.join('; '), /下次同步可能把这些会话又拉回来/, '远端那一步的原话进问题清单')
})
