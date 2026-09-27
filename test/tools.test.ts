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

import { Context } from '@deepseek-ai/cordis'
import { decompress } from 'fzstd'

import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import {
  directoryPickerKind,
  effectMode,
  registerTools,
  type MigrateToolResult,
  type PlanToolResult,
  type PluginConfig,
} from '../src/tools.ts'
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

/**
 * 由一个**兄弟** fiber 提供服务。
 *
 * "兄弟"这件事是刻意的：从根 context 上 `provide` 的服务会在 Context 代理"往上找父 fiber"的
 * 回退路径里被读到，越权的属性读法（`ctx.workspaceRegistry`）于是也能蒙对。真实 profile 里
 * workspaceRegistry 由 `dsh-workspace` 这个**兄弟**条目提供，那种写法必抛。
 */
async function startSibling(host: Context, service: string, value: unknown): Promise<unknown> {
  const fiber = host.plugin({
    name: `fixture:${service}`,
    inject: [],
    apply: (ctx: Context) => {
      ctx.provide(service, value)
    },
  })
  await fiber.await()
  return fiber
}

/**
 * 造一个**真实 Cordis 宿主**并在真实 fiber 里注册工具。
 *
 * 为什么不用纯对象假装 ctx：Cordis 的 Context 是 Proxy，服务属性只有在当前 fiber 的 `inject`
 * 里声明过才可读，否则同步抛 `cannot get property "X" without inject`——**即使那个服务确实存在**。
 * 纯对象上 `ctx.workspaceRegistry` 读得到，于是"假 ctx 全绿、装进 profile 一调工具就炸"。
 * 这里因此提供真实服务（各由兄弟条目提供）、开一个声明了 inject 的 fiber，并 `await` 它激活完成。
 *
 * @param config - 插件路径配置。
 * @param options.registry - 是否提供 workspaceRegistry，以及它是否有 reassignSessions。
 * @param options.picker - 是否提供 directoryPicker，以及它报的是哪种能力（`broken` = 形状不认）。
 */
async function makeHost(
  config: PluginConfig,
  options: { registry?: 'absent' | 'plain' | 'capable'; picker?: 'absent' | 'browse' | 'native' | 'broken' } = {},
): Promise<{ ctx: Context; defs: CapturedTool[] }> {
  const defs: CapturedTool[] = []
  const host = new Context()
  await startSibling(host, 'tools', {
    register: (def: unknown): (() => void) => {
      defs.push(def as CapturedTool)
      return () => {}
    },
  })
  const mode = options.registry ?? 'absent'
  if (mode !== 'absent') {
    await startSibling(host, 'workspaceRegistry', mode === 'capable' ? { reassignSessions: (): void => {} } : {})
  }
  const picker = options.picker ?? 'absent'
  if (picker === 'browse' || picker === 'native') {
    // 宿主的目录选择器是"能力位"服务：capability() 报出它这一只是哪一种。
    await startSibling(host, 'directoryPicker', { capability: () => ({ kind: picker }) })
  } else if (picker === 'broken') {
    await startSibling(host, 'directoryPicker', { capability: () => ({ kind: 'something-else' }) })
  }

  const fiber = host.plugin({
    name: 'test-host',
    inject: ['tools'],
    apply: (ctx: Context) => {
      registerTools(ctx, config)
    },
  })
  await fiber.await()
  return { ctx: fiber.ctx, defs }
}

function byName(defs: CapturedTool[]): Map<string, CapturedTool> {
  return new Map(defs.map((d) => [d.name, d]))
}

async function run(tool: CapturedTool, args: Record<string, unknown>): Promise<unknown> {
  return tool.execute(args, {})
}

test('工具注册：4 个工具，名称与归一化 schema 符合宿主契约', async () => {
  const sb = makeSandbox('tools')
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })

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

test('目录选择器：宿主报哪种能力就照哪种走，没有/形状不认时按"没有"处理', async () => {
  const sb = makeSandbox('picker')
  const config = { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot }

  // 界面据此决定目录字段上的「浏览…」是开页面内浏览器还是弹系统对话框；
  // 两者互斥（native 只有 pick、browse 只有 list），所以猜测的代价是按钮点了必报错。
  assert.equal(directoryPickerKind((await makeHost(config)).ctx), null, '宿主没有该服务')
  assert.equal(directoryPickerKind((await makeHost(config, { picker: 'browse' })).ctx), 'browse')
  assert.equal(directoryPickerKind((await makeHost(config, { picker: 'native' })).ctx), 'native')
  // 认不出的 kind 或压根读不到服务时都退回 null：界面少一个按钮，总好过 /state 整个 500。
  assert.equal(directoryPickerKind((await makeHost(config, { picker: 'broken' })).ctx), null)
  assert.equal(directoryPickerKind({}), null)
  assert.equal(directoryPickerKind(undefined), null)
  assert.equal(directoryPickerKind({ get: () => ({ capability: () => { throw new Error('还没装配好') } }) }), null)

  rmSync(sb.base, { recursive: true, force: true })
})

test('生效模式：上游无 reassign 时如实报 restart-required，有则报 immediate', async () => {
  const sb = makeSandbox('mode')
  const config = { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot }

  // 在真实 fiber 上读：服务没声明进 inject，属性写法会抛「without inject」，必须走 ctx.get。
  const absent = await makeHost(config)
  assert.equal(effectMode(absent.ctx), 'restart-required')

  const plain = await makeHost(config, { registry: 'plain' })
  assert.equal(effectMode(plain.ctx), 'restart-required', '提供了服务但没有 reassignSessions')

  const capable = await makeHost(config, { registry: 'capable' })
  assert.equal(effectMode(capable.ctx), 'immediate')

  // 连 ctx 形状都不对时也必须给个答案，而不是抛。
  assert.equal(effectMode({}), 'restart-required')
  assert.equal(effectMode(undefined), 'restart-required')

  rmSync(sb.base, { recursive: true, force: true })
})

test('工具端到端：plan(只读) → migrate(dry-run) → migrate(apply) → verify → rollback', async () => {
  const sb = makeSandbox('e2e')
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
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
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
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
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const m = byName(defs)

  const tool = m.get('plan_session_migration')!
  const value = await run(tool, { from: sb.fromDir, to: sb.toDir })
  const blocks = tool.output.render({ from: sb.fromDir, to: sb.toDir }, value)
  assert.ok(Array.isArray(blocks))
  assert.equal(blocks[0]?.type, 'text')
  assert.ok(blocks[0]?.text.includes('迁移'))

  rmSync(sb.base, { recursive: true, force: true })
})
