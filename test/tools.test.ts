// 工具层验证：用**真实的 @deepseek-ai/dsh-tools** 调 defineTool，
// 确认 4 个工具的定义能通过宿主的参数/输出 schema 归一化，并且真的能跑通。
//
// defineTool 在注册前就会把 parameters / output.schema 转成 JSON Schema，
// 形状不对即抛错；execute 又会先按 parameters 校验实参。
// 因此这组测试等价于"工具契约"的验证，无需把插件装进 profile。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import { decompress } from 'fzstd'

import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import { effectMode, registerTools, type MigrateToolResult, type PlanToolResult } from '../src/tools.ts'
import type { DecodeAll, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

/** 归一化后的工具定义（defineTool 的产物形状）。 */
interface CapturedTool {
  name: string
  description: string
  parameters: { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[] }
  output: {
    schema: { type?: string; properties?: Record<string, unknown>; required?: string[] }
    render: (args: unknown, value: unknown) => Array<{ type: string; text: string }>
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

let clock = 0
function makeLog(id: string, cwd: string, n: number): Buffer {
  const createdAt = ++clock
  const frames = [
    encodeRawFrame(JSON.stringify({ type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }) + '\n'),
  ]
  for (let i = 0; i < n; i++) {
    frames.push(
      encodeRawFrame(JSON.stringify({ type: 'user/message', seq: i, time: createdAt + i, data: { turn: 1, content: [{ type: 'text', text: `${cwd} #${i}` }] } }) + '\n'),
    )
  }
  return Buffer.concat(frames)
}

interface Sandbox {
  base: string
  root: string
  registryPath: string
  registry: WorkspaceRegistryState
  fromDir: string
  toDir: string
  bucket: string
  logs: Record<string, Buffer>
  backupRoot: string
}

function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const fromDir = join(base, 'downloads')
  const toDir = join(base, 'work', 'temp')
  mkdirSync(fromDir, { recursive: true })
  mkdirSync(toDir, { recursive: true })
  const root = join(base, 'dsh', 'sessions')
  const bucket = projectKey(fromDir)
  mkdirSync(join(root, bucket, 'session-a'), { recursive: true })
  mkdirSync(join(root, bucket, 'session-b'), { recursive: true })
  mkdirSync(join(root, projectKey(toDir)), { recursive: true })

  const logs: Record<string, Buffer> = { a: makeLog('session-a', fromDir, 8), b: makeLog('session-b', fromDir, 4) }
  writeFileSync(join(root, bucket, 'session-a', 'session.v4.jsonl.zstd'), logs['a']!)
  writeFileSync(join(root, bucket, 'session-b', 'session.v4.jsonl.zstd'), logs['b']!)

  const registryPath = join(base, 'dsh', 'storages', 'workspace.json')
  mkdirSync(join(base, 'dsh', 'storages'), { recursive: true })
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-dl', 'ws-temp'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-dl': { path: fromDir, title: 'downloads', sessionIds: ['session-a', 'session-b'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        'ws-temp': { path: toDir, title: 'temp', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
  return { base, root, registryPath, registry, fromDir, toDir, bucket, logs, backupRoot: join(base, 'backups') }
}

/** 假的 host ctx：捕获注册的工具；workspaceRegistry 可选（决定生效模式）。 */
function fakeCtx(options: { withReassign?: boolean } = {}): { ctx: Context; defs: CapturedTool[] } {
  const defs: CapturedTool[] = []
  const ctx: Record<string, unknown> = {
    tools: {
      register: (def: unknown): (() => void) => {
        defs.push(def as CapturedTool)
        return () => {}
      },
    },
    logger: { info: (): void => {} },
  }
  if (options.withReassign) ctx['workspaceRegistry'] = { reassignSessions: (): void => {} }
  return { ctx: ctx as unknown as Context, defs }
}

function byName(defs: CapturedTool[]): Map<string, CapturedTool> {
  return new Map(defs.map((d) => [d.name, d]))
}

async function run(tool: CapturedTool, args: Record<string, unknown>): Promise<unknown> {
  return tool.execute(args, {})
}

test('工具注册：4 个工具，名称与归一化 schema 符合宿主契约', () => {
  const sb = makeSandbox('tools')
  const { ctx, defs } = fakeCtx()
  registerTools(ctx, { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })

  assert.equal(defs.length, 4)
  const m = byName(defs)
  for (const n of ['plan_session_migration', 'migrate_sessions', 'rollback_session_migration', 'verify_workspace_sessions']) {
    const d = m.get(n)
    assert.ok(d, `缺少工具 ${n}`)
    assert.equal(typeof d.description, 'string')
    assert.ok(d.description.length > 40, `${n} 的 description 过短`)
    // parameters / output.schema 已被归一化为 JSON Schema
    assert.equal(d.parameters.type, 'object')
    assert.ok(Object.keys(d.parameters.properties ?? {}).length > 0)
    assert.equal(d.output.schema.type, 'object')
    assert.ok(Object.keys(d.output.schema.properties ?? {}).length > 0)
    assert.equal(typeof d.output.render, 'function')
    assert.equal(typeof d.execute, 'function')
  }

  // required 被正确归一化（from/to 必填；apply 可选）
  const migrate = m.get('migrate_sessions')!
  assert.ok(migrate.parameters.required?.includes('from'))
  assert.ok(migrate.parameters.required?.includes('to'))
  assert.ok(!(migrate.parameters.required ?? []).includes('apply'))
  // 数组参数带 items
  assert.equal(migrate.parameters.properties?.['sessionIds']?.['type'], 'array')
  assert.deepEqual(migrate.parameters.properties?.['sessionIds']?.['items'], { type: 'string' })

  rmSync(sb.base, { recursive: true, force: true })
})

test('生效模式：上游无 reassign 时如实报 restart-required，有则报 immediate', () => {
  const sb = makeSandbox('mode')
  const plain = fakeCtx()
  registerTools(plain.ctx, { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  assert.equal(effectMode(plain.ctx), 'restart-required')
  assert.equal(effectMode({}), 'restart-required')

  const capable = fakeCtx({ withReassign: true })
  assert.equal(effectMode(capable.ctx), 'immediate')

  rmSync(sb.base, { recursive: true, force: true })
})

test('工具端到端：plan(只读) → migrate(dry-run) → migrate(apply) → verify → rollback', async () => {
  const sb = makeSandbox('e2e')
  const { ctx, defs } = fakeCtx()
  registerTools(ctx, { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const m = byName(defs)

  // ---- plan：只读 ----
  const plan = (await run(m.get('plan_session_migration')!, { from: sb.fromDir, to: sb.toDir })) as PlanToolResult
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.sessions, 2)
  assert.equal(plan.files, 2)
  assert.equal(plan.takesEffect, 'restart-required')
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'plan 不得改注册表')
  assert.deepEqual(readFileSync(join(sb.root, sb.bucket, 'session-a', 'session.v4.jsonl.zstd')), sb.logs['a'])

  // ---- migrate：默认 dry-run ----
  const dry = (await run(m.get('migrate_sessions')!, { from: sb.fromDir, to: sb.toDir })) as MigrateToolResult
  assert.equal(dry.applied, false)
  assert.equal(dry.rewritten, 0)
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'dry-run 不得改注册表')

  // ---- migrate：apply ----
  const applied = (await run(m.get('migrate_sessions')!, { from: sb.fromDir, to: sb.toDir, apply: true })) as MigrateToolResult
  assert.equal(applied.applied, true)
  assert.equal(applied.rewritten, 2)
  assert.equal(applied.moved, 2)
  assert.equal(applied.verified, true, applied.problems.join('; '))
  assert.ok(applied.backupDir && existsSync(applied.backupDir))
  assert.match(applied.summary, /重启 DSH/)

  // 注册表：账本转移（按"新→旧"，session-b 的 createdAt 更大）
  const reg = readRegistry(sb.registryPath)
  assert.deepEqual(reg.tables.workspaces['ws-temp']?.sessionIds, ['session-b', 'session-a'])
  assert.equal(reg.tables.workspaces['ws-dl'], undefined)

  // ---- verify ----
  const v = (await run(m.get('verify_workspace_sessions')!, { dir: sb.toDir })) as {
    ok: boolean
    checked: number
    bucket: string
    problems: string[]
  }
  assert.equal(v.ok, true, v.problems.join('; '))
  assert.equal(v.checked, 2)
  assert.equal(v.bucket, join(sb.root, projectKey(sb.toDir)))

  // ---- rollback ----
  const rb = (await run(m.get('rollback_session_migration')!, { backupDir: applied.backupDir })) as {
    sessions: number
    restoredFiles: number
    registryRestored: boolean
  }
  assert.equal(rb.sessions, 2)
  assert.ok(rb.restoredFiles >= 2)
  assert.equal(rb.registryRestored, true)
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, '注册表须完全还原')
  assert.deepEqual(readFileSync(join(sb.root, sb.bucket, 'session-a', 'session.v4.jsonl.zstd')), sb.logs['a'], '日志须逐字节还原')

  rmSync(sb.base, { recursive: true, force: true })
})

test('工具实参校验：缺必填项被宿主 schema 拒绝', async () => {
  const sb = makeSandbox('args')
  const { ctx, defs } = fakeCtx()
  registerTools(ctx, { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const m = byName(defs)

  await assert.rejects(() => run(m.get('plan_session_migration')!, { from: sb.fromDir }), /to|required/i)
  await assert.rejects(() => run(m.get('migrate_sessions')!, {}), /from|to|required/i)
  // sessionIds 必须是字符串数组（schema 由数组归一化而来）
  await assert.rejects(
    () => run(m.get('plan_session_migration')!, { from: sb.fromDir, to: sb.toDir, sessionIds: [1, 2] }),
    /sessionIds|string/i,
  )

  rmSync(sb.base, { recursive: true, force: true })
})

test('工具渲染：render 返回原生内容块', async () => {
  const sb = makeSandbox('render')
  const { ctx, defs } = fakeCtx()
  registerTools(ctx, { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const m = byName(defs)

  const tool = m.get('plan_session_migration')!
  const value = await run(tool, { from: sb.fromDir, to: sb.toDir })
  const blocks = tool.output.render({ from: sb.fromDir, to: sb.toDir }, value)
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks[0]?.type, 'text')
  assert.ok(blocks[0]?.text.includes('迁移'))

  rmSync(sb.base, { recursive: true, force: true })
})
