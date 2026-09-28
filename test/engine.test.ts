// 端到端：在隔离沙箱里造出"多帧日志 + 注册表"，跑 plan → apply → verify → rollback，
// 并逐字节断言回滚后与原始状态完全一致。
//
// 关键：cwd 用**沙箱里的真实目录**，而不是编造的字符串——因为计划层会用
// existsSync(to) 校验目标目录真实存在，用假路径测不出真行为。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { applyPlan, verifyAppliedPlan } from '../src/execute.ts'
import { readManifest, rollback } from '../src/journal.ts'
import { buildRelocationPlan, describePlan } from '../src/plan.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import type { DecodeAll, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

let clock = 0
function makeLog(id: string, cwd: string, nEvents: number): Buffer {
  const createdAt = ++clock
  const frames = [
    encodeRawFrame(
      JSON.stringify({ type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }) + '\n',
    ),
  ]
  for (let i = 0; i < nEvents; i++) {
    const type = i === 0 ? 'turn/start' : i === nEvents - 1 ? 'turn/end' : 'user/message'
    frames.push(
      encodeRawFrame(
        JSON.stringify({ type, seq: i, time: createdAt + i, data: { turn: 1, content: [{ type: 'text', text: `在 ${cwd} 下做事 #${i}` }] } }) +
          '\n',
      ),
    )
  }
  return Buffer.concat(frames)
}

interface Sandbox {
  base: string
  root: string
  registryPath: string
  registry: WorkspaceRegistryState
  logs: Record<string, Buffer>
  fromDir: string
  toDir: string
  sourceProjectDirName: string
  targetProjectDir: string
  backupRoot: string
}

/** 造一个完整隔离沙箱（cwd 为真实目录）。 */
function makeSandbox(name: string, options: { unowned?: boolean } = {}): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })

  const fromDir = join(base, 'downloads')
  const toDir = join(base, 'work', 'temp')
  mkdirSync(fromDir, { recursive: true })
  mkdirSync(toDir, { recursive: true })

  const root = join(base, 'dsh', 'sessions')
  const sourceProjectDirName = projectKey(fromDir)
  const targetProjectDir = projectKey(toDir)
  mkdirSync(join(root, sourceProjectDirName, 'session-a'), { recursive: true })
  mkdirSync(join(root, sourceProjectDirName, 'session-b'), { recursive: true })
  mkdirSync(join(root, targetProjectDir), { recursive: true })

  const logs: Record<string, Buffer> = { a: makeLog('session-a', fromDir, 40), b: makeLog('session-b', fromDir, 12) }
  writeFileSync(join(root, sourceProjectDirName, 'session-a', 'session.v4.jsonl.zstd'), logs['a']!)
  writeFileSync(join(root, sourceProjectDirName, 'session-b', 'session.v4.jsonl.zstd'), logs['b']!)
  if (options.unowned) {
    mkdirSync(join(root, sourceProjectDirName, 'session-c'), { recursive: true })
    logs['c'] = makeLog('session-c', fromDir, 3)
    writeFileSync(join(root, sourceProjectDirName, 'session-c', 'session.v4.jsonl.zstd'), logs['c']!)
  }

  const registryPath = join(base, 'dsh', 'storages', 'workspace.json')
  mkdirSync(join(base, 'dsh', 'storages'), { recursive: true })
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-downloads', 'ws-temp'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-downloads': {
          path: fromDir,
          title: 'downloads',
          sessionIds: ['session-a', 'session-b'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'ws-temp': {
          path: toDir,
          title: 'temp',
          sessionIds: ['session-live'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')

  return { base, root, registryPath, registry, logs, fromDir, toDir, sourceProjectDirName, targetProjectDir, backupRoot: join(base, 'backups') }
}

const opts = (sb: Sandbox, extra: Record<string, unknown> = {}) => ({
  root: sb.root,
  registry: sb.registry,
  from: sb.fromDir,
  to: sb.toDir,
  decodeAll,
  ...extra,
})

test('端到端：plan → apply → verify → rollback 全链路', () => {
  const sb = makeSandbox('e2e')
  const srcA = join(sb.root, sb.sourceProjectDirName, 'session-a', 'session.v4.jsonl.zstd')

  // ---- plan（dry-run：不得写任何字节） ----
  const plan = buildRelocationPlan(opts(sb))
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.sessions.length, 2)
  assert.equal(plan.registryChange?.added.length, 2)
  assert.equal(plan.registryChange?.createdTarget, false)
  assert.match(describePlan(plan), /迁移 2 个会话/)
  assert.equal(existsSync(join(sb.root, sb.targetProjectDir, 'session-a')), false, 'dry-run 不得移动目录')
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'dry-run 不得改注册表')
  assert.deepEqual(readFileSync(srcA), sb.logs['a'], 'dry-run 不得改日志')

  // ---- apply ----
  const applied = applyPlan(plan, {
    registryPath: sb.registryPath,
    decodeAll,
    backupRoot: sb.backupRoot,
    now: new Date('2026-09-27T00:00:00Z'),
  })
  assert.equal(applied.rewritten, 2)
  assert.equal(applied.moved, 2)
  assert.ok(existsSync(join(applied.backupDir, 'manifest.json')))
  assert.ok(existsSync(join(applied.backupDir, 'execution.log')))
  assert.equal(existsSync(join(sb.root, sb.sourceProjectDirName)), false, '空源项目目录应被清理')

  // ---- verify（等价于宿主的 corrupt 判据） ----
  const verified = verifyAppliedPlan(plan, { decodeAll })
  assert.equal(verified.ok, true, verified.problems.join('; '))
  assert.equal(verified.checked, 2)

  // 日志：header 换新 cwd，正文逐行不变，旧路径作为历史保留
  const after = decodeAll(readFileSync(join(sb.root, sb.targetProjectDir, 'session-a', 'session.v4.jsonl.zstd')))
  const before = decodeAll(sb.logs['a']!)
  const aLines = after.split('\n')
  const bLines = before.split('\n')
  assert.equal(aLines.length, bLines.length)
  assert.equal((JSON.parse(aLines[0] ?? '{}') as { cwd?: string }).cwd, sb.toDir)
  for (let i = 1; i < bLines.length; i++) assert.equal(aLines[i], bLines[i], `正文第 ${i} 行不得改动`)
  assert.ok(after.includes(JSON.stringify(sb.fromDir).slice(1, -1)), '正文里的旧路径是历史事实，必须保留')

  // 注册表：注册表转移、空工作区被删、顺序与表键一致
  const reg = readRegistry(sb.registryPath)
  // 注册表按"新→旧"排列（session-b 的 createdAt 更大），追加在既有会话之后
  assert.deepEqual(reg.tables.workspaces['ws-temp']?.sessionIds, ['session-live', 'session-b', 'session-a'])
  assert.equal(reg.tables.workspaces['ws-downloads'], undefined)
  assert.deepEqual(reg.global.workspaceIds, ['ws-temp'])

  // ---- rollback ----
  const { manifest } = readManifest(applied.backupDir)
  const rolled = rollback(manifest, { backupDir: applied.backupDir })
  assert.ok(rolled.restoredFiles >= 2)
  assert.equal(rolled.registryRestored, true)

  // 逐字节回到原状
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, '注册表必须完全还原')
  assert.deepEqual(readFileSync(srcA), sb.logs['a'], '日志必须逐字节还原')
  assert.deepEqual(readFileSync(join(sb.root, sb.sourceProjectDirName, 'session-b', 'session.v4.jsonl.zstd')), sb.logs['b'])
  assert.equal(existsSync(join(sb.root, sb.targetProjectDir, 'session-a')), false, '目标侧应被清空')

  rmSync(sb.base, { recursive: true, force: true })
})

test('未登记会话：默认连带迁移，includeUnowned=false 时报问题', () => {
  const sb = makeSandbox('unowned', { unowned: true })
  const lenient = buildRelocationPlan(opts(sb))
  assert.equal(lenient.ok, true, lenient.problems.join('; '))
  assert.equal(lenient.sessions.length, 3)
  assert.equal(lenient.sessions.find((s) => s.id === 'session-c')?.registered, false)

  const strict = buildRelocationPlan(opts(sb, { includeUnowned: false }))
  assert.equal(strict.ok, false)
  assert.match(strict.problems.join(';'), /not registered in any workspace/)

  rmSync(sb.base, { recursive: true, force: true })
})

test('计划层拒绝：目标不存在 / 源目标同路径 / 有损项目目录名碰撞', () => {
  const sb = makeSandbox('reject')

  const missing = buildRelocationPlan(opts(sb, { to: join(sb.base, 'nope', 'missing') }))
  assert.equal(missing.ok, false)
  assert.match(missing.problems.join(';'), /target directory does not exist/)

  const same = buildRelocationPlan(opts(sb, { to: sb.fromDir }))
  assert.equal(same.ok, false)
  assert.match(same.problems.join(';'), /identical/)

  // projectKey 把分隔符折叠成 '-'，因此 '…\collide\downloads' 与 '…\collide-downloads' 同名
  const collideDir = sb.base + '-downloads'
  mkdirSync(collideDir, { recursive: true })
  assert.equal(projectKey(collideDir), projectKey(sb.fromDir), '前置条件：两者确实同名')
  const collide = buildRelocationPlan(opts(sb, { to: collideDir }))
  assert.equal(collide.ok, false)
  assert.match(collide.problems.join(';'), /projectKey collision/)

  rmSync(sb.base, { recursive: true, force: true })
  rmSync(collideDir, { recursive: true, force: true })
})

test('applyPlan 拒绝执行有问题的计划；源项目目录消失后再次计划会如实报错', () => {
  const sb = makeSandbox('refuse')
  const bad = buildRelocationPlan(opts(sb, { to: sb.fromDir }))
  assert.equal(bad.ok, false)
  assert.throws(
    () => applyPlan(bad, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot }),
    /refusing to apply/,
  )

  const plan = buildRelocationPlan(opts(sb))
  applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot, now: new Date('2026-09-27T00:00:00Z') })
  const again = buildRelocationPlan(opts(sb))
  assert.equal(again.ok, false)
  assert.match(again.problems.join(';'), /source project directory does not exist/)

  rmSync(sb.base, { recursive: true, force: true })
})

test('多帧回归：一条事件一帧，单帧解码器会截断', () => {
  const sb = makeSandbox('frames')
  const buf = readFileSync(join(sb.root, sb.sourceProjectDirName, 'session-a', 'session.v4.jsonl.zstd'))
  let magic = 0
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) magic++
  }
  assert.ok(magic >= 41, `应探测到多帧（实际 ${magic} 个候选）`)
  // 1 行 header + 40 条事件 = 41 行
  assert.equal(decodeAll(buf).split('\n').filter(Boolean).length, 41)
  rmSync(sb.base, { recursive: true, force: true })
})
