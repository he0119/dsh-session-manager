// 工具层验证：用**真实的 @deepseek-ai/dsh-tools** 调 defineTool，
// 确认 5 个工具的定义能通过宿主的参数/输出 schema 归一化，并且真的能跑通。
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

import { createDavClient } from '../src/dav.ts'
import { projectionCacheDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import { remoteBundlePath, remoteIndexPath } from '../src/sync.ts'
import {
  archiveOps,
  directoryPickerKind,
  effectMode,
  liveSessionIds,
  registerTools,
  type MigrateToolResult,
  type PlanToolResult,
  type SyncToolResult,
} from '../src/tools.ts'
import type { PluginConfig } from '../src/config.ts'
import type { DecodeAll, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'
import { putRemoteSession, startDavFixture } from './dav-fixture.ts'

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
function makeLog(id: string, cwd: string, n: number, extra: Record<string, unknown> = {}): Buffer {
  const createdAt = ++clock
  const frames = [
    encodeRawFrame(
      JSON.stringify({ type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, ...extra }) + '\n',
    ),
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
  projectDirName: string
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
  const projectDirName = projectKey(fromDir)
  mkdirSync(join(root, projectDirName, 'session-a'), { recursive: true })
  mkdirSync(join(root, projectDirName, 'session-b'), { recursive: true })
  // session-a 的子代理：不在册、侧边栏看不见，但**跟着父会话走**——工具层的 `cascaded` 就用它核。
  mkdirSync(join(root, projectDirName, 'session-child'), { recursive: true })
  mkdirSync(join(root, projectKey(toDir)), { recursive: true })

  const logs: Record<string, Buffer> = {
    a: makeLog('session-a', fromDir, 8),
    b: makeLog('session-b', fromDir, 4),
    child: makeLog('session-child', fromDir, 3, { origin: 'subagent', parentSession: 'session-a', delegationDepth: 1 }),
  }
  writeFileSync(join(root, projectDirName, 'session-a', 'session.v4.jsonl.zstd'), logs['a']!)
  writeFileSync(join(root, projectDirName, 'session-b', 'session.v4.jsonl.zstd'), logs['b']!)
  writeFileSync(join(root, projectDirName, 'session-child', 'session.v4.jsonl.zstd'), logs['child']!)

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
  return { base, root, registryPath, registry, fromDir, toDir, projectDirName, logs, backupRoot: join(base, 'backups') }
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

test('工具注册：5 个工具，名称与归一化 schema 符合宿主契约', async () => {
  const sb = makeSandbox('tools')
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })

  assert.equal(defs.length, 5)
  const m = byName(defs)
  for (const n of [
    'plan_session_migration',
    'migrate_sessions',
    'rollback_session_migration',
    'verify_workspace_sessions',
    'sync_sessions',
  ]) {
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
  // 两条候选 + 跟着 session-a 走的那条子代理
  assert.equal(plan.sessions, 3)
  assert.equal(plan.cascaded, 1)
  assert.equal(plan.files, 3)
  assert.equal(plan.takesEffect, 'restart-required')
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'plan 不得改注册表')
  assert.deepEqual(readFileSync(join(sb.root, sb.projectDirName, 'session-a', 'session.v4.jsonl.zstd')), sb.logs['a'])

  // ---- migrate：默认 dry-run ----
  const dry = (await run(m.get('migrate_sessions')!, { from: sb.fromDir, to: sb.toDir })) as MigrateToolResult
  assert.equal(dry.applied, false)
  assert.equal(dry.cascaded, 1)
  assert.equal(dry.rewritten, 0)
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'dry-run 不得改注册表')

  // ---- migrate：apply ----
  const applied = (await run(m.get('migrate_sessions')!, { from: sb.fromDir, to: sb.toDir, apply: true })) as MigrateToolResult
  assert.equal(applied.applied, true)
  assert.equal(applied.cascaded, 1)
  assert.equal(applied.rewritten, 3)
  assert.equal(applied.moved, 3)
  assert.equal(applied.verified, true, applied.problems.join('; '))
  assert.ok(applied.backupDir && existsSync(applied.backupDir))
  assert.match(applied.summary, /重启 DSH/)

  // 注册表：注册表转移（按"新→旧"，session-b 的 createdAt 更大）
  const reg = readRegistry(sb.registryPath)
  assert.deepEqual(reg.tables.workspaces['ws-temp']?.sessionIds, ['session-b', 'session-a'])
  assert.equal(reg.tables.workspaces['ws-dl'], undefined)

  // ---- verify ----
  const v = (await run(m.get('verify_workspace_sessions')!, { dir: sb.toDir })) as {
    ok: boolean
    checked: number
    projectDir: string
    problems: string[]
  }
  assert.equal(v.ok, true, v.problems.join('; '))
  assert.equal(v.checked, 3)
  assert.equal(v.projectDir, join(sb.root, projectKey(sb.toDir)))

  // ---- rollback ----
  const rb = (await run(m.get('rollback_session_migration')!, { backupDir: applied.backupDir })) as {
    sessions: number
    restoredFiles: number
    registryRestored: boolean
  }
  assert.equal(rb.sessions, 3)
  assert.ok(rb.restoredFiles >= 3)
  assert.equal(rb.registryRestored, true)
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, '注册表须完全还原')
  assert.deepEqual(readFileSync(join(sb.root, sb.projectDirName, 'session-a', 'session.v4.jsonl.zstd')), sb.logs['a'], '日志须逐字节还原')

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

test('归档端口：服务在且形状对就交出去，缺席/形状不认时给 undefined（界面据此禁用按钮）', async () => {
  const host = new Context()
  await startSibling(host, 'tools', { register: (): (() => void) => () => {} })

  // 只有一半能力（缺 unarchiveSession）＝形状不认，不能交付：交付了界面就会显示一个点了报错的按钮。
  await startSibling(host, 'workspaceRegistry', { archiveSession: (): void => {} })
  const half = host.plugin({ name: 'half', inject: ['tools'], apply: (ctx: Context) => {} })
  await half.await()
  assert.equal(archiveOps(half.ctx), undefined)

  // 两位都在：交出去的端口要真的把调用转给宿主服务（这里拿它当台账）。
  const calls: string[] = []
  const host2 = new Context()
  await startSibling(host2, 'tools', { register: (): (() => void) => () => {} })
  await startSibling(host2, 'workspaceRegistry', {
    archiveSession: (id: string) => { calls.push(`archive:${id}`) },
    unarchiveSession: (id: string) => { calls.push(`unarchive:${id}`) },
  })
  const fiber = host2.plugin({ name: 'full', inject: ['tools'], apply: (ctx: Context) => {} })
  await fiber.await()
  const ops = archiveOps(fiber.ctx)
  assert.ok(ops, '两位都在时该交付')
  await ops.archive('session-a')
  await ops.unarchive('session-b')
  assert.deepEqual(calls, ['archive:session-a', 'unarchive:session-b'])

  // 形状完全不认识时也不许抛（`/state` 会读它）。
  assert.equal(archiveOps({}), undefined)
  assert.equal(archiveOps(undefined), undefined)
  assert.equal(archiveOps({ get: () => ({ archiveSession: 'not a function' }) }), undefined)
})

test('活着的会话：读宿主内存 store 的 id；没有那个服务时按空集（判断不了，不是"都不活着"）', async () => {
  const host = new Context()
  await startSibling(host, 'tools', { register: (): (() => void) => () => {} })
  await startSibling(host, 'sessions', { list: () => [{ id: 'session-live' }, { id: 'session-open' }, {}] })
  const fiber = host.plugin({ name: 'live', inject: ['tools'], apply: (ctx: Context) => {} })
  await fiber.await()

  assert.deepEqual([...liveSessionIds(fiber.ctx)].sort(), ['session-live', 'session-open'])
  // 服务缺席 / ctx 形状不对 / list 抛错：一律空集——删除那条路径不该因为读不到内存 store 就整个打挂。
  assert.equal(liveSessionIds({}).size, 0)
  assert.equal(liveSessionIds(undefined).size, 0)
  assert.equal(liveSessionIds({ get: () => ({ list: () => { throw new Error('store 还没装好') } }) }).size, 0)
})

test('sync_sessions：没配 sync.url 时如实说"没配置"（不发任何请求）', async () => {
  const sb = makeSandbox('tools-sync-off')
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const result = (await run(byName(defs).get('sync_sessions')!, {})) as SyncToolResult
  assert.equal(result.ok, false)
  assert.equal(result.applied, false)
  assert.match(result.problems.join('\n'), /没有配置 WebDAV 同步/)
  rmSync(sb.base, { recursive: true, force: true })
})

test('sync_sessions：空白会话不上传（工具侧也读宿主投影缓存），并在 notes 里报一句', async () => {
  // 工具与界面两条路各建一份编排，但"宿主说这条空不空白"必须是同一个来源（注册表旁边的投影缓存）。
  // 这条钉住工具侧真的接上了那个来源：接错了的表现是空白会话被推送。
  const sb = makeSandbox('tools-sync-blank')
  const fixture = await startDavFixture({ root: join(sb.base, 'dav') })
  try {
    const logPath = join(sb.root, sb.projectDirName, 'session-a', 'session.v4.jsonl.zstd')
    const header = JSON.parse(decodeAll(readFileSync(logPath)).split('\n')[0] ?? '{}') as {
      id: string
      createdAt: number
      cwd: string
    }
    const cacheDir = projectionCacheDir(sb.registryPath)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(
      join(cacheDir, 'session-a.json'),
      JSON.stringify({
        version: 7,
        record: {
          identity: { formatVersion: 4, createdAt: header.createdAt, cwd: header.cwd },
          rows: { sessionListMetadata: { ver: 1, seq: 1, val: { blank: true, lastPromptAt: null } } },
        },
      }),
    )
    const config: PluginConfig = {
      sessionsRoot: sb.root,
      registryPath: sb.registryPath,
      backupRoot: sb.backupRoot,
      sync: { url: fixture.url, machineId: 'robot-a', mapping: {} },
    }
    const { defs } = await makeHost(config)
    const applied = (await run(byName(defs).get('sync_sessions')!, { apply: true })) as SyncToolResult
    assert.equal(applied.ok, true)
    assert.deepEqual(applied.pushed.sort(), ['session-b', 'session-child'], '空白那条不上传')
    assert.deepEqual(applied.notes, ['跳过 1 条空白会话（建出来但一轮都没开始过）：session-a'])
    // 自己那格索引里也不该有它（别的机器因此看不到这条空白会话）。
    const index = JSON.parse(readFileSync(join(fixture.root, remoteIndexPath('robot-a')), 'utf8')) as {
      entries: Array<{ id: string }>
    }
    assert.deepEqual(index.entries.map((entry) => entry.id).sort(), ['session-b', 'session-child'])
    assert.equal(existsSync(join(fixture.root, remoteBundlePath('robot-a', 'session-a'))), false)
  } finally {
    await fixture.close()
    rmSync(sb.base, { recursive: true, force: true })
  }
})

test('sync_sessions：预演只读、apply 才落地；远端那条按映射改写成目标路径', async () => {
  const sb = makeSandbox('tools-sync')
  const fixture = await startDavFixture({ root: join(sb.base, 'dav') })
  const uploader = createDavClient({ baseUrl: fixture.url })
  const foreignCwd = join(sb.base, 'foreign')
  mkdirSync(foreignCwd, { recursive: true })
  const id = 'remote-1'
  try {
    // 远端那台机器贡献的一条会话：打一个真的包放上去（格式与「导出」一模一样）。
    const dir = join(sb.base, 'foreign-sessions', projectKey(foreignCwd), id)
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(logPath, makeLog(id, foreignCwd, 2))
    await putRemoteSession(uploader, 'robot-b', {
      id,
      cwd: foreignCwd,
      createdAt: 1,
      logPath,
      logName: 'session.v4.jsonl.zstd',
      logVersion: 4,
    })

    const config: PluginConfig = {
      sessionsRoot: sb.root,
      registryPath: sb.registryPath,
      backupRoot: sb.backupRoot,
      sync: { url: fixture.url, machineId: 'robot-a', mapping: { [foreignCwd]: sb.toDir } },
    }
    const { defs } = await makeHost(config)
    const sync = byName(defs).get('sync_sessions')!

    const preview = (await run(sync, {})) as SyncToolResult
    assert.equal(preview.applied, false)
    assert.deepEqual(preview.pulled, [id])
    assert.deepEqual(preview.pushed.sort(), ['session-a', 'session-b', 'session-child'], '本机三条都要推')
    assert.equal(preview.machines.includes('robot-b'), true)
    assert.equal(
      existsSync(join(sb.root, projectKey(sb.toDir), id)),
      false,
      '预演不落地：库里不该多出这条',
    )

    const applied = (await run(sync, { apply: true })) as SyncToolResult
    assert.equal(applied.applied, true)
    assert.deepEqual(applied.pulled, [id])
    assert.equal(applied.ok, true)
    assert.equal(applied.takesEffect, 'restart-required', '没有 workspaceRegistry 时要如实说需要重启')

    const landed = join(sb.root, projectKey(sb.toDir), id, 'session.v4.jsonl.zstd')
    assert.ok(existsSync(landed), 'apply 之后应当落在映射到的目标项目目录里')
    const header = JSON.parse(decodeAll(readFileSync(landed)).split('\n')[0] ?? '{}') as { cwd?: string }
    assert.equal(header.cwd, sb.toDir, 'header 的 cwd 要改写成这台机器的路径')
    // 推送的那几条也真的在远端：索引与包都写了自己那一格
    assert.ok(existsSync(join(fixture.root, remoteIndexPath('robot-a'))))
    assert.ok(existsSync(join(fixture.root, remoteBundlePath('robot-a', 'session-a'))))
  } finally {
    await fixture.close()
    rmSync(sb.base, { recursive: true, force: true })
  }
})
