// 删除会话：预演 → 备份 → 真删 → 复核 → 从备份恢复。
//
// 这是本插件唯一一处**真删用户数据**的路径（宿主没有删会话的能力，见 src/remove.ts 的说明），所以
// 这里把每一步都钉死：宿主内存里活着的拒删、不在库里的拒删、删除前必须先落下备份、删完目录真的没了、
// 恢复之后字节（含 session.lock）一粒不差地回来、而**注册表从头到尾没被动过**。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { readManifest } from '../src/journal.ts'
import { rollbackMigration } from '../src/migrate.ts'
import { sessionDir } from '../src/paths.ts'
import { readRegistry, writeRegistryAtomic } from '../src/registry.ts'
import { createTitleResolver } from '../src/session-title.ts'
import { planRemoval, runRemoval, type RemoveDeps } from '../src/remove.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

interface Sandbox {
  base: string
  sessionsRoot: string
  registryPath: string
  backupRoot: string
  cwdA: string
}

function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
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
function writeSession(sandbox: Sandbox, id: string, createdAt: number, options: { title?: string } = {}): string {
  const header: SessionHeader = { type: 'session', version: 4, id, createdAt, cwd: sandbox.cwdA, isSeeded: false, delegationDepth: 0 }
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'turn/start', seq: 0, data: { turn: 1 } }),
    ...(options.title === undefined ? [] : [JSON.stringify({ type: 'session/title', seq: 1, data: { title: options.title } })]),
  ]
  const dir = sessionDir(sandbox.sessionsRoot, sandbox.cwdA, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))))
  writeFileSync(join(dir, 'session.lock'), '')
  return dir
}

function deps(sandbox: Sandbox, extra: Partial<RemoveDeps> = {}): RemoveDeps {
  return {
    sessionsRoot: sandbox.sessionsRoot,
    registryPath: sandbox.registryPath,
    backupRoot: sandbox.backupRoot,
    decodeAll,
    // 与界面那条路一致：预演里按标题认会话（见 session-title.ts）
    resolveTitle: createTitleResolver({ decodeAll }),
    now: new Date('2026-09-27T00:00:00.000Z'),
    ...extra,
  }
}

test('预演：列清会删什么，一个字节都不写', () => {
  const sandbox = makeSandbox('remove-plan')
  const dir = writeSession(sandbox, 'session-doomed', 1000, { title: '不要了的会话' })

  const run = runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: false })
  assert.equal(run.applied, false)
  assert.equal(run.plan.ok, true, run.plan.problems.join('; '))
  assert.deepEqual(run.plan.entries.map((e) => e.id), ['session-doomed'])
  assert.deepEqual(run.plan.entries.map((e) => e.title), ['不要了的会话'])
  assert.equal(run.plan.files, 1)
  assert.equal(existsSync(dir), true, '预演不许动磁盘')
  assert.equal(existsSync(sandbox.backupRoot), false, '预演不许建备份目录')
})

test('执行：先备份（整份会话目录）再删，复核通过；空掉的项目目录顺手清掉', () => {
  const sandbox = makeSandbox('remove-apply')
  const dir = writeSession(sandbox, 'session-doomed', 1000)
  const before = readFileSync(join(dir, 'session.v4.jsonl.zstd'))

  const run = runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: true })
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

test('恢复：从备份把整个会话目录搬回原位（含 session.lock），注册表不动', () => {
  const sandbox = makeSandbox('remove-restore')
  const dir = writeSession(sandbox, 'session-doomed', 1000)
  const before = readFileSync(join(dir, 'session.v4.jsonl.zstd'))
  const registryBefore = readFileSync(sandbox.registryPath, 'utf8')

  const run = runRemoval(deps(sandbox), { sessionIds: ['session-doomed'] }, { apply: true })
  assert.equal(run.verified, true, run.problems.join('; '))
  // 删完顺手把注册表改坏一点，用来证明"恢复不还原注册表"（删除本来就没碰过它）
  const registry = readRegistry(sandbox.registryPath)
  registry.tables.workspaces['ws-a']!.sessionIds = ['session-something-else']
  writeRegistryAtomic(sandbox.registryPath, registry)
  const mutated = readFileSync(sandbox.registryPath, 'utf8')

  // 先看动作清单（dry-run 不写盘）
  const dry = rollbackMigration({ backupRoot: sandbox.backupRoot }, { backupDir: run.backupDir!, dryRun: true })
  assert.equal(dry.registryRestored, false)
  assert.equal(dry.actions.some((action) => action.startsWith('registry untouched')), true)
  assert.equal(existsSync(dir), false, 'dry-run 不许写盘')

  const outcome = rollbackMigration({ backupRoot: sandbox.backupRoot }, { backupDir: run.backupDir! })
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

test('宿主内存里活着的会话拒删：进 problems，不进待删条目（预演与执行都拦住）', () => {
  const sandbox = makeSandbox('remove-live')
  writeSession(sandbox, 'session-doomed', 1000)
  const withLive = deps(sandbox, { liveSessionIds: () => new Set(['session-doomed']) })

  const plan = planRemoval(withLive, { sessionIds: ['session-doomed'] })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.entries, [])
  assert.match(plan.problems.join('\n'), /还在宿主内存里活着/)
  const run = runRemoval(withLive, { sessionIds: ['session-doomed'] }, { apply: true })
  assert.equal(run.applied, false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, sandbox.cwdA, 'session-doomed')), true)
})

test('不在库里的 id 与空选择各自给出可读的拒绝，别的会话不受影响', () => {
  const sandbox = makeSandbox('remove-unknown')
  writeSession(sandbox, 'session-doomed', 1000)

  const empty = runRemoval(deps(sandbox), { sessionIds: [] }, { apply: true })
  assert.equal(empty.applied, false)
  assert.deepEqual(empty.plan.problems, ['缺少要删除的会话（sessionIds）'])

  const unknown = runRemoval(deps(sandbox), { sessionIds: ['session-doomed', 'session-ghost'] }, { apply: false })
  assert.equal(unknown.plan.ok, false)
  assert.deepEqual(unknown.plan.problems, ['session session-ghost 不在库里（可能已经被删掉了）'])
  // 计划不 ok 时执行阶段整体拒绝，连那条存在的也不删
  const apply = runRemoval(deps(sandbox), { sessionIds: ['session-doomed', 'session-ghost'] }, { apply: true })
  assert.equal(apply.applied, false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, sandbox.cwdA, 'session-doomed')), true)
})

test('删两条同目录的会话：项目目录要等两条都删完才空，随后被清掉', () => {
  const sandbox = makeSandbox('remove-two')
  const first = writeSession(sandbox, 'session-one', 1000)
  const second = writeSession(sandbox, 'session-two', 2000)

  const run = runRemoval(deps(sandbox), { sessionIds: ['session-one', 'session-two'] }, { apply: true })
  assert.equal(run.verified, true, run.problems.join('; '))
  assert.equal(run.dirsRemoved, 2)
  assert.equal(existsSync(first), false)
  assert.equal(existsSync(second), false)
  assert.deepEqual(run.removedProjectDirs.length, 1)
  // 两条都在同一份备份里
  const { manifest } = readManifest(run.backupDir!)
  assert.deepEqual(manifest.sessions.map((s) => s.id).sort(), ['session-one', 'session-two'])
})
