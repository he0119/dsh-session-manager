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
  attachmentPort,
  attachAutoPushToSessions,
  directoryPickerKind,
  resolveAutoPushRuntime,
  effectMode,
  liveSessionIds,
  registerTools,
  hostCheckpointPort,
  hostRegistryPort,
  titleRefreshPort,
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
  /** 点名的那些会话 id（源就是它们；个别用例自己收紧成一条）。 */
  ids: string[]
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
  // session-a 的子智能体：不在册、侧边栏看不见，但**跟着父会话走**——工具层的 `cascaded` 就用它核。
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
  return {
    base,
    root,
    registryPath,
    registry,
    fromDir,
    toDir,
    projectDirName,
    logs,
    // 源就是点名的那些会话（没有"源目录"这个参数了）：夹具里这两条，个别用例自己收紧。
    ids: ['session-a', 'session-b'],
    backupRoot: join(base, 'backups'),
  }
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
 * @param options.registry - 假宿主的工作区注册表：`absent` = 没有这个服务；`plain` = 齐全；
 *   `no-refresh` = 缺"按磁盘重看一眼"那两件（认形状失败）；传一份注册表则连内容一起模拟（复用目标
 *   工作区返回同一个 id、源空了能被删掉）。
 * @param options.persistence - 假宿主的会话持久化：`absent` = 没有这个服务，`ready` = 有。
 * @param options.wrongTargetId - 故意让"复用目标工作区"返回一个错的 id（验插件当场停下报需要重启）。
 * @param options.attachFails - 让挂靠抛错（验失败路径不把一次成功的迁移说成失败）。
 * @param options.onCall - 每次调用宿主动作记一笔（台账：验调用顺序与"改在落盘之后"）。
 * @param options.mutateOnRefresh - "按磁盘重看一眼"时顺手改一下注册表文件（验落盘后的 id 复核会报出来）。
 * @param options.picker - 是否提供 directoryPicker，以及它报的是哪种能力（`broken` = 形状不认）。
 */
async function makeHost(
  config: PluginConfig,
  options: {
    registry?: 'absent' | 'plain' | 'no-refresh' | WorkspaceRegistryState
    persistence?: 'absent' | 'ready'
    wrongTargetId?: string
    attachFails?: boolean
    onCall?: (call: string) => void
    mutateOnRefresh?: (registryPath: string) => void
    picker?: 'absent' | 'browse' | 'native' | 'broken'
    /** 宿主内存里活着的会话 id（有 `sessions` 服务才问得出来；缺省 = 这个宿主没有那个服务）。 */
    liveSessions?: string[]
  } = {},
): Promise<{ ctx: Context; defs: CapturedTool[] }> {
  const defs: CapturedTool[] = []
  const host = new Context()
  await startSibling(host, 'tools', {
    register: (def: unknown): (() => void) => {
      defs.push(def as CapturedTool)
      return () => {}
    },
  })

  const registryOption = options.registry ?? 'absent'
  if (registryOption !== 'absent') {
    // 假宿主尽量像真的：工作区按路径复用（同一条路径返回同一个 id）、挂/摘真的改成员表、
    // 源空了能被删掉。它**不写文件**——文件那一步仍然由插件自己走，这正是要测的接缝。
    const workspaces = new Map<string, { id: string; path: string; sessionIds: string[] }>()
    const state = typeof registryOption === 'object' ? registryOption : undefined
    for (const [id, rec] of Object.entries(state?.tables.workspaces ?? {})) {
      workspaces.set(id, { id, path: rec.path, sessionIds: [...rec.sessionIds] })
    }
    let minted = 0
    const entityOf = (id: string): Record<string, unknown> | undefined => {
      const rec = workspaces.get(id)
      if (rec === undefined) return undefined
      return {
        id: rec.id,
        get sessionIds() {
          return [...rec.sessionIds]
        },
        attachSession: async (sessionId: string) => {
          if (options.attachFails === true) throw new Error('夹具：挂靠失败')
          options.onCall?.(`attach:${sessionId}`)
          if (!rec.sessionIds.includes(sessionId)) rec.sessionIds.push(sessionId)
        },
        insertSessionBefore: async (sessionId: string) => {
          options.onCall?.(`move-end:${sessionId}`)
          rec.sessionIds = [...rec.sessionIds.filter((s) => s !== sessionId), sessionId]
        },
        detachSession: async (sessionId: string) => {
          options.onCall?.(`detach:${sessionId}`)
          rec.sessionIds = rec.sessionIds.filter((s) => s !== sessionId)
        },
      }
    }
    const registry: Record<string, unknown> = {
      create: async (path: string): Promise<{ id: string }> => {
        for (const rec of workspaces.values()) {
          if (rec.path === path) {
            options.onCall?.(`reuse:${path}`)
            if (options.wrongTargetId !== undefined) return { id: options.wrongTargetId }
            return { id: rec.id }
          }
        }
        minted += 1
        const id = `ws-new-${minted}`
        workspaces.set(id, { id, path, sessionIds: [] })
        options.onCall?.(`create:${path}`)
        return { id }
      },
      get: (id: string) => entityOf(id),
      delete: async (id: string) => {
        options.onCall?.(`remove:${id}`)
        return workspaces.delete(id)
      },
      replaceHeaderIndex: async (headers: readonly unknown[]) => {
        options.onCall?.(`refresh:${headers.length}`)
        if (config.registryPath !== undefined) options.mutateOnRefresh?.(config.registryPath)
      },
      indexLiveSessions: async () => {
        options.onCall?.('index-live')
      },
    }
    if (registryOption === 'no-refresh') {
      delete registry['replaceHeaderIndex']
      delete registry['indexLiveSessions']
    }
    await startSibling(host, 'workspaceRegistry', registry)
  }
  if ((options.persistence ?? 'absent') !== 'absent') {
    await startSibling(host, 'sessionPersistence', { list: async () => [{ header: { id: 'session-a', cwd: 'x' } }] })
  }
  if (options.liveSessions !== undefined) {
    // 宿主内存里那份（`ctx.sessions.list()`）：迁移要按它把搬不动的那几条挑出来。
    await startSibling(host, 'sessions', { list: () => options.liveSessions!.map((id) => ({ id })) })
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

  // required 被正确归一化（sessionIds/to 必填；apply 可选）
  const migrate = m.get('migrate_sessions')!
  assert.ok(migrate.parameters.required?.includes('sessionIds'))
  assert.ok(migrate.parameters.required?.includes('to'))
  assert.ok(!(migrate.parameters.required ?? []).includes('apply'))
  // 数组参数带 items
  assert.equal(migrate.parameters.properties?.['sessionIds']?.['type'], 'array')
  assert.deepEqual(migrate.parameters.properties?.['sessionIds']?.['items'], { type: 'string' })

  rmSync(sb.base, { recursive: true, force: true })
})

test('工具开关：在配置里关掉一个就不注册它，别的照旧', async () => {
  const sb = makeSandbox('switches')

  // 只关掉唯一会"真搬东西"的那个：其余四个照旧注册，名称一个不少。
  const partial = await makeHost({
    sessionsRoot: sb.root,
    registryPath: sb.registryPath,
    backupRoot: sb.backupRoot,
    tools: { migrate: false },
  })
  assert.equal(partial.defs.length, 4)
  assert.equal(byName(partial.defs).has('migrate_sessions'), false, '关掉的工具不该出现在宿主那份清单里')
  for (const n of ['plan_session_migration', 'rollback_session_migration', 'verify_workspace_sessions', 'sync_sessions']) {
    assert.ok(byName(partial.defs).has(n), `${n} 没被关掉，应当照旧注册`)
  }

  // 显式写 `true` 与干脆不写都是开：判断"关"只认 `false`。
  const explicit = await makeHost({
    sessionsRoot: sb.root,
    registryPath: sb.registryPath,
    backupRoot: sb.backupRoot,
    tools: { plan: true, migrate: true, rollback: true, verify: true, sync: true },
  })
  assert.equal(explicit.defs.length, 5)

  // 五个全关：一个都不注册（插件照常装配，只是没有工具）。
  const none = await makeHost({
    sessionsRoot: sb.root,
    registryPath: sb.registryPath,
    backupRoot: sb.backupRoot,
    tools: { plan: false, migrate: false, rollback: false, verify: false, sync: false },
  })
  assert.deepEqual(none.defs, [])

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

test('生效模式：拿得到宿主那套动作就报 immediate，其余一律如实报 restart-required', async () => {
  const sb = makeSandbox('mode')
  const config = { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot }

  // 在真实 fiber 上读：服务没声明进 inject，属性写法会抛「without inject」，必须走 ctx.get。
  // 连 ctx 形状都不对时也必须给个答案，而不是抛。
  assert.equal(effectMode((await makeHost(config)).ctx), 'restart-required', '什么服务都没有：只能重启')
  assert.equal(effectMode({}), 'restart-required')
  assert.equal(effectMode(undefined), 'restart-required')
  assert.equal(effectMode((await makeHost(config, { registry: 'plain' })).ctx), 'restart-required', '没有会话持久化：刷不了索引')
  assert.equal(
    effectMode((await makeHost(config, { registry: 'plain', persistence: 'ready' })).ctx),
    'immediate',
    '齐全：能当场把账改掉',
  )
  // 形状不认（少了"按磁盘重看一眼"那两件）时退回"需要重启"，绝不猜。
  assert.equal(
    effectMode((await makeHost(config, { registry: 'no-refresh', persistence: 'ready' })).ctx),
    'restart-required',
  )

  // 端口本身：把活儿转给宿主那几件动作，形状不认就给 undefined。
  const fakeCtx = (registry: unknown, persistence: unknown = {}): unknown => ({
    get: (name: string) =>
      name === 'workspaceRegistry' ? registry : name === 'sessionPersistence' ? persistence : undefined,
  })
  const ready = {
    create: async () => ({ id: 'ws-1' }),
    get: () => undefined,
    delete: async () => true,
    replaceHeaderIndex: async () => {},
    indexLiveSessions: async () => {},
  }
  assert.ok(hostRegistryPort(fakeCtx(ready, { list: async () => [] })))
  assert.equal(hostRegistryPort(fakeCtx(undefined, { list: async () => [] })), undefined, '没有注册表服务')
  assert.equal(hostRegistryPort(fakeCtx(ready, undefined)), undefined, '没有会话持久化：刷不了索引')
  assert.equal(hostRegistryPort(fakeCtx({ ...ready, replaceHeaderIndex: undefined }, { list: async () => [] })), undefined)
  assert.equal(hostRegistryPort(fakeCtx({ ...ready, indexLiveSessions: undefined }, { list: async () => [] })), undefined)
  assert.equal(hostRegistryPort(fakeCtx({ ...ready, create: undefined }, { list: async () => [] })), undefined)
  assert.equal(hostRegistryPort(fakeCtx(ready, {})), undefined, '持久化没有 list()')

  rmSync(sb.base, { recursive: true, force: true })
})

test('改完注册表交给宿主自己做：顺序、id 复核、失败退路', async () => {
  const configOf = (sb: Sandbox): PluginConfig => ({
    sessionsRoot: sb.root,
    registryPath: sb.registryPath,
    backupRoot: sb.backupRoot,
  })

  // ---- 成功：宿主那几件动作按"先重看磁盘、再改归属、源空了才删"的顺序被叫到 ----
  const ok = makeSandbox('effect-ok')
  const calls: string[] = []
  const atRefresh: string[] = []
  const { defs } = await makeHost(configOf(ok), {
    registry: ok.registry,
    persistence: 'ready',
    onCall: (call) => {
      calls.push(call)
      // 台账记的是**那一刻文件里的归属**：刷新若不是发生在落盘之后，这里就读不到 session-b。
      if (call.startsWith('refresh:')) {
        atRefresh.push(readRegistry(ok.registryPath).tables.workspaces['ws-temp']?.sessionIds.join(',') ?? '还没落盘')
      }
    },
  })
  // 只读的预演不许碰宿主：它一个字节都没写，只说"执行时会怎样"。
  const planned = (await run(byName(defs).get('migrate_sessions')!, { sessionIds: ok.ids, to: ok.toDir })) as MigrateToolResult
  assert.equal(planned.applied, false)
  assert.equal(planned.takesEffect, 'immediate', '预演按探测说"执行时会当场生效"')
  assert.match(planned.summary, /执行时由宿主自己改/)
  assert.equal(calls.length, 0, '预演不打扰宿主')
  assert.deepEqual(readRegistry(ok.registryPath), ok.registry, '预演不得改注册表')

  const applied = (await run(byName(defs).get('migrate_sessions')!, {
    sessionIds: ok.ids,
    to: ok.toDir,
    apply: true,
  })) as MigrateToolResult
  assert.equal(applied.applied, true)
  assert.equal(applied.verified, true, applied.problems.join('; '))
  assert.equal(applied.takesEffect, 'immediate')
  assert.match(applied.summary, /无需重启 DSH/)
  assert.deepEqual(atRefresh, ['session-b,session-a'], '刷新必须在注册表落盘之后发生')
  // 复用已有工作区（同一个 id）→ 按计划顺序挂到末尾 → 源侧摘空 → 删掉空工作区
  assert.deepEqual(calls, [
    'refresh:1',
    'index-live',
    `reuse:${ok.toDir}`,
    'attach:session-b',
    'move-end:session-b',
    'attach:session-a',
    'move-end:session-a',
    'detach:session-a',
    'detach:session-b',
    'remove:ws-dl',
  ])
  assert.deepEqual(readRegistry(ok.registryPath).tables.workspaces['ws-temp']?.sessionIds, ['session-b', 'session-a'])

  // ---- 目标工作区 id 对不上：当场停下，如实报"需要重启"，绝不悄悄换个 id ----
  const wrong = makeSandbox('effect-wrong-id')
  const wrongHost = await makeHost(configOf(wrong), {
    registry: wrong.registry,
    persistence: 'ready',
    wrongTargetId: 'ws-someone-else',
  })
  const wrongRun = (await run(byName(wrongHost.defs).get('migrate_sessions')!, {
    sessionIds: wrong.ids,
    to: wrong.toDir,
    apply: true,
  })) as MigrateToolResult
  assert.equal(wrongRun.applied, true, 'id 对不上不改"迁移成不成功"')
  assert.equal(wrongRun.takesEffect, 'restart-required')
  assert.match(wrongRun.summary, /目标工作区 id 与计划不符/)

  // ---- 挂靠失败：迁移仍然算成功（文件已经写好），如实报"仍需重启" ----
  const bad = makeSandbox('effect-fail')
  const failing = await makeHost(configOf(bad), { registry: bad.registry, persistence: 'ready', attachFails: true })
  const degraded = (await run(byName(failing.defs).get('migrate_sessions')!, {
    sessionIds: bad.ids,
    to: bad.toDir,
    apply: true,
  })) as MigrateToolResult
  assert.equal(degraded.applied, true, '宿主没接住不该把一次成功的迁移说成失败')
  assert.equal(degraded.takesEffect, 'restart-required')
  assert.match(degraded.summary, /宿主没接住这次改动（夹具：挂靠失败）/)
  assert.match(degraded.summary, /重启 DSH/)
  assert.ok(degraded.backupDir && existsSync(degraded.backupDir), '失败也不该顺手回滚')
  assert.deepEqual(readRegistry(bad.registryPath).tables.workspaces['ws-temp']?.sessionIds, ['session-b', 'session-a'])

  // ---- 会话 id 被动过：落盘后的复核必须报出来（迁移本身仍算做过） ----
  const tampered = makeSandbox('effect-id-tamper')
  const tampering = await makeHost(configOf(tampered), {
    registry: tampered.registry,
    persistence: 'ready',
    mutateOnRefresh: (registryPath) => {
      const text = readFileSync(registryPath, 'utf8').replaceAll('session-a', 'session-a-renamed')
      writeFileSync(registryPath, text)
    },
  })
  const caught = (await run(byName(tampering.defs).get('migrate_sessions')!, {
    sessionIds: tampered.ids,
    to: tampered.toDir,
    apply: true,
  })) as MigrateToolResult
  assert.equal(caught.applied, true)
  assert.equal(caught.verified, false, 'id 被改过就必须复核失败')
  assert.match(caught.problems.join('; '), /session-a 在落盘结果里没了（id 不该变）/)
  assert.match(caught.problems.join('; '), /多了计划外的会话 session-a-renamed/)

  // ---- 回滚：为了原样保住工作区 id，走整份写回文件，如实报"需要重启" ----
  const rb = (await run(byName(defs).get('rollback_session_migration')!, { backupDir: applied.backupDir })) as {
    takesEffect: string
    summary: string
  }
  // 探测说有那套动作，回滚却仍然报"需要重启"——这正是"整份写回文件"那条路的痕迹。
  assert.equal(rb.takesEffect, 'restart-required')
  assert.match(rb.summary, /工作区 id 原样保留/)
  assert.deepEqual(calls.filter((c) => c.startsWith('reuse:')).length, 1, '回滚不该再叫宿主改一次')

  // ---- 宿主持在内存里的一条：搬不动，留在原处、留在源工作区里，并且必须报出来 ----
  const held = makeSandbox('effect-live-hold')
  const holding = await makeHost(configOf(held), {
    registry: held.registry,
    persistence: 'ready',
    liveSessions: ['session-b'],
  })
  const heldRun = (await run(byName(holding.defs).get('migrate_sessions')!, {
    sessionIds: held.ids,
    to: held.toDir,
    apply: true,
  })) as MigrateToolResult
  assert.equal(heldRun.applied, true)
  assert.equal(heldRun.liveSkipped, 1, '工具层也要报出宿主持着几条：那是模型唯一看得见的一面')
  assert.match(heldRun.summary, /另有 1 条会话宿主持在内存里（还活着），这次没搬：session-b/)
  assert.deepEqual(readRegistry(held.registryPath).tables.workspaces['ws-dl']?.sessionIds, ['session-b'], '活会话仍归源工作区')
  assert.deepEqual(readRegistry(held.registryPath).tables.workspaces['ws-temp']?.sessionIds, ['session-a'])

  // ---- 侧边栏不显示的会话（已归档）同样搬不走：源工作区留着，工具返回值里必须报出条数 ----
  const hidden = makeSandbox('effect-hidden-stranded')
  const hiddenRegistry: WorkspaceRegistryState = {
    ...hidden.registry,
    global: { ...hidden.registry.global, archivedSessionIds: ['session-b'] },
  }
  writeFileSync(hidden.registryPath, JSON.stringify(hiddenRegistry, null, 2) + '\n')
  const hiding = await makeHost(configOf(hidden), { registry: hiddenRegistry, persistence: 'ready' })
  // 只点名看得见的那条：已归档的 session-b 勾不动（界面上那一行是灰的），它因此留在源工作区里。
  const hiddenRun = (await run(byName(hiding.defs).get('migrate_sessions')!, {
    sessionIds: ['session-a'],
    to: hidden.toDir,
    apply: true,
  })) as MigrateToolResult
  assert.equal(hiddenRun.applied, true)
  assert.equal(hiddenRun.stranded, 1, '工具层也要报出"侧边栏不显示因而没搬"的条数：模型只有这一面')
  assert.match(hiddenRun.summary, /另有 1 条会话侧边栏不显示（已归档 1），这次不搬：session-b/)
  assert.match(hiddenRun.summary, /那几块工作区因此不会被删/)
  assert.deepEqual(
    readRegistry(hidden.registryPath).tables.workspaces['ws-dl']?.sessionIds,
    ['session-b'],
    '搬不走的那条仍归源工作区（源工作区因此不会被删）',
  )
  assert.deepEqual(readRegistry(hidden.registryPath).tables.workspaces['ws-temp']?.sessionIds, ['session-a'])

  rmSync(ok.base, { recursive: true, force: true })
  rmSync(wrong.base, { recursive: true, force: true })
  rmSync(bad.base, { recursive: true, force: true })
  rmSync(tampered.base, { recursive: true, force: true })
  rmSync(held.base, { recursive: true, force: true })
  rmSync(hidden.base, { recursive: true, force: true })
})

test('工具端到端：plan(只读) → migrate(dry-run) → migrate(apply) → verify → rollback', async () => {
  const sb = makeSandbox('e2e')
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const m = byName(defs)

  // ---- plan：只读 ----
  const plan = (await run(m.get('plan_session_migration')!, { sessionIds: sb.ids, to: sb.toDir })) as PlanToolResult
  assert.equal(plan.ok, true, plan.problems.join('; '))
  // 两条候选 + 跟着 session-a 走的那条子智能体
  assert.equal(plan.sessions, 3)
  assert.equal(plan.cascaded, 1)
  assert.equal(plan.files, 3)
  assert.equal(plan.takesEffect, 'restart-required')
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'plan 不得改注册表')
  assert.deepEqual(readFileSync(join(sb.root, sb.projectDirName, 'session-a', 'session.v4.jsonl.zstd')), sb.logs['a'])

  // ---- migrate：默认 dry-run ----
  const dry = (await run(m.get('migrate_sessions')!, { sessionIds: sb.ids, to: sb.toDir })) as MigrateToolResult
  assert.equal(dry.applied, false)
  assert.equal(dry.cascaded, 1)
  assert.equal(dry.rewritten, 0)
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'dry-run 不得改注册表')

  // ---- migrate：apply ----
  const applied = (await run(m.get('migrate_sessions')!, { sessionIds: sb.ids, to: sb.toDir, apply: true })) as MigrateToolResult
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

  await assert.rejects(() => run(m.get('plan_session_migration')!, { to: sb.toDir }), /to|required/i)
  await assert.rejects(() => run(m.get('migrate_sessions')!, {}), /from|to|required/i)
  // sessionIds 必须是字符串数组（schema 由数组归一化而来）
  await assert.rejects(
    () => run(m.get('plan_session_migration')!, { sessionIds: [1, 2], to: sb.toDir }),
    /sessionIds|string/i,
  )

  rmSync(sb.base, { recursive: true, force: true })
})

test('工具渲染：render 返回原生内容块', async () => {
  const sb = makeSandbox('render')
  const { defs } = await makeHost({ sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot })
  const m = byName(defs)

  const tool = m.get('plan_session_migration')!
  const value = await run(tool, { sessionIds: sb.ids, to: sb.toDir })
  const blocks = tool.output.render({ sessionIds: sb.ids, to: sb.toDir }, value)
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
    // 预演也要回答"执行后要不要重启"（与界面那条路同一个口径）：调用方得能在落地**之前**提醒用户。
    assert.equal(preview.takesEffect, 'restart-required', '预演按探测说，而不是"这次什么都没干"')
    assert.ok(
      preview.summary.endsWith('执行后需要重启 DSH 才会生效；重启前请勿再改任何工作区。'),
      `预演正文里也要有这句：${preview.summary}`,
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

test('补齐列表元数据的端口：认形状，按宿主自己的两步走（读日志 → 写回检查点）', async () => {
  const calls: string[] = []
  const loaded = { session: { id: 's-1', version: 4 }, inheritedEventCount: 7, events: [{ type: 'session' }] }
  const fakeCtx = (query: unknown, cache: unknown): unknown => ({
    get: (name: string) => (name === 'sessionQuery' ? query : name === 'sessionProjectionCache' ? cache : undefined),
  })
  const readyQuery = {
    readSession: async (id: string): Promise<typeof loaded> => {
      calls.push(`read:${id}`)
      return loaded
    },
  }
  const readyCache = {
    coldSnapshot: (meta: unknown, inheritedEventCount: unknown, events: readonly unknown[]): void => {
      calls.push('coldSnapshot')
      // 转手的三件必须原样是宿主 readSession() 交给我们的那三件：换一个名字、少一件都会写错检查点。
      assert.equal(meta, loaded.session)
      assert.equal(inheritedEventCount, loaded.inheritedEventCount)
      assert.equal(events, loaded.events)
    },
  }

  assert.equal(hostCheckpointPort(fakeCtx(undefined, readyCache)), undefined, '没有 sessionQuery：补不了')
  assert.equal(hostCheckpointPort(fakeCtx(readyQuery, undefined)), undefined, '没有投影缓存：补不了')
  assert.equal(hostCheckpointPort(fakeCtx({}, readyCache)), undefined, 'readSession 形状不认')
  assert.equal(hostCheckpointPort(fakeCtx(readyQuery, {})), undefined, 'coldSnapshot 形状不认')
  assert.equal(hostCheckpointPort({}), undefined, '连 ctx 形状都不对时也必须给个答案，而不是抛')

  const port = hostCheckpointPort(fakeCtx(readyQuery, readyCache))
  assert.ok(port, '两件都齐：端口拿得到')
  await port.warm('s-1')
  assert.deepEqual(calls, ['read:s-1', 'coldSnapshot'], '顺序不能反：没有事件就没有可折的东西')
})

/**
 * 一套照宿主语义做出来的假件，只做"临时挂载 → 重算 → 写盘 → 摘掉"这条路上用到的几件。
 *
 * 三处**必须照宿主原样**，不然就测不出它：
 *
 * - `prepare()` 还原会话时可能自己补一条 `session/end-seed`：宿主的 `Session.fromRestore` 构造函数
 *   只要发现 seed 的最后一条不是它就补一条，于是内存副本比磁盘多一条、后面每条 seq 都大 1；
 * - `append()` 的 seq 取"当前内存日志的条数"，与宿主一致；
 * - 写句柄的游标是**磁盘上的条数**，追加之前逐条核 seq 连续（宿主的 `assertContiguous`）。
 *
 * 另外照宿主那样把"活会话的 append 按 id 路由给已登记写句柄"也做出来：靠 `sessions.flush()` 冲盘
 * 那条旧路在这里会如实报出 `append seq mismatch … expected N at index 0, got N+1`。
 */
interface FakeRetitleEvent {
  type: string
  seq: number
}

interface FakeRetitleSession {
  id: string
  log: FakeRetitleEvent[]
  snapshotEvents(fromSeq?: number): ReadonlyArray<FakeRetitleEvent>
  append(type: string): void
}

type FakeTitleSnapshot = { title?: string; source?: { kind?: string } } | undefined

interface FakeRetitleHost {
  ctx: unknown
  calls: string[]
  /** 磁盘上的事件：下标就是 seq。 */
  disk: FakeRetitleEvent[]
  /** `sessionTitle.get()` 现在答什么（也就是重算之前的那份快照）。 */
  current: FakeTitleSnapshot
  /** 下一次 `sessionTitle.refresh()` 干什么（默认往会话里 append 一条标题并返回 provider 快照）。 */
  onRefresh: (session: FakeRetitleSession) => Promise<FakeTitleSnapshot>
  /** 让下一次写盘的 `append()` 失败（模拟磁盘上已经被别人写过了、游标对不上）。 */
  failAppend?: Error
  /** 让写句柄的 `close()` 失败。 */
  failClose?: Error
  /** 这条会话此刻是不是还挂在宿主内存里。 */
  isLive(): boolean
  /** 把会话挂成"宿主自己开着的"那一条（活会话那条分支用）。 */
  makeLive(): FakeRetitleSession
  services: Record<string, unknown>
}

function fakeRetitleHost(options: { stored?: number; endsWithSeed?: boolean } = {}): FakeRetitleHost {
  const stored = options.stored ?? 2
  const disk: FakeRetitleEvent[] = []
  for (let seq = 0; seq < stored; seq += 1) {
    const isLast = seq === stored - 1
    disk.push({ type: isLast && options.endsWithSeed === true ? 'session/end-seed' : 'turn/end', seq })
  }

  const calls: string[] = []
  const header = { id: 's-1', version: 4, createdAt: 1 }
  let live: FakeRetitleSession | undefined
  /** 宿主那条"活会话的 append 按 id 路由给写句柄"的路：句柄开着就收进它的缓冲。 */
  let routed: FakeRetitleEvent[] | undefined

  /** 宿主写盘的那一步：先核 seq 连续（`assertContiguous`），再落到磁盘上。 */
  const writeBatch = async (events: readonly FakeRetitleEvent[]): Promise<void> => {
    calls.push(`write:${String(events.length)}`)
    if (host.failAppend !== undefined) throw host.failAppend
    const cursor = disk.length
    for (const [index, event] of events.entries()) {
      if (event.seq !== cursor + index) {
        throw new Error(`append seq mismatch for "s-1": expected ${String(cursor + index)} at index ${String(index)}, got ${String(event.seq)}`)
      }
    }
    for (const event of events) disk.push({ type: event.type, seq: event.seq })
  }

  const makeSession = (log: FakeRetitleEvent[]): FakeRetitleSession => ({
    id: 's-1',
    log,
    snapshotEvents: (fromSeq = 0) => log.slice(fromSeq),
    append: (type) => {
      const event = { type, seq: log.length }
      log.push(event)
      calls.push(`append:${type}`)
      // 活会话的 append 一律发给"已登记写句柄"那一条（没有句柄就不发）。
      routed?.push({ type: event.type, seq: event.seq })
    },
  })

  const sessions = {
    get: (id: string): unknown => {
      calls.push(`get:${id}`)
      return live
    },
    prepare: (id: string, prepared: unknown): unknown => {
      calls.push(`prepare:${id}`)
      const seed = (prepared as { seed: ReadonlyArray<FakeRetitleEvent> }).seed
      const log = seed.map((event) => ({ type: event.type, seq: event.seq }))
      // 宿主 `Session.fromRestore`：seed 的最后一条不是 `session/end-seed` 就自己补一条。
      if (log.at(-1)?.type !== 'session/end-seed') log.push({ type: 'session/end-seed', seq: log.length })
      return makeSession(log)
    },
    enter: (target: unknown): (() => void) => {
      calls.push('enter')
      live = target as FakeRetitleSession
      return () => {
        calls.push('detach')
        live = undefined
      }
    },
    announce: (): void => {
      calls.push('announce')
    },
    /** 宿主 `session/flush` 上的持久化监听器：把路由过来的事件排干写盘（旧路子用的就是它）。 */
    flush: async (): Promise<boolean> => {
      calls.push('flush')
      if (routed !== undefined && routed.length > 0) await writeBatch(routed.splice(0))
      return true
    },
  }

  const sessionQuery = {
    readSession: async (id: string) => {
      calls.push(`read:${id}`)
      return { session: header, inheritedEventCount: 0, events: disk.map((event) => ({ ...event })) }
    },
  }

  const sessionTitle = {
    get: (): FakeTitleSnapshot => {
      calls.push('titles:get')
      return host.current
    },
    refresh: async (target: unknown): Promise<FakeTitleSnapshot> => {
      calls.push('titles:refresh')
      return host.onRefresh(target as FakeRetitleSession)
    },
  }

  const sessionPersistence = {
    open: async (id: string, access: string) => {
      calls.push(`open:${id}:${access}`)
      const buffered: FakeRetitleEvent[] = []
      routed = buffered
      return {
        append: async (events: readonly FakeRetitleEvent[]): Promise<void> => {
          await writeBatch(events)
        },
        close: async (): Promise<void> => {
          calls.push('close')
          routed = undefined
          // 宿主的 close 先把路由过来的缓冲排干，再放锁。
          if (buffered.length > 0) await writeBatch(buffered.splice(0))
          if (host.failClose !== undefined) throw host.failClose
        },
      }
    },
  }

  const host: FakeRetitleHost = {
    ctx: { get: (name: string) => host.services[name] },
    calls,
    disk,
    current: undefined,
    onRefresh: async (session) => {
      session.append('session/title')
      return { title: '重算出来的名字', source: { kind: 'provider' } }
    },
    isLive: () => live !== undefined,
    makeLive: () => {
      const session = makeSession(disk.map((event) => ({ ...event })))
      live = session
      return session
    },
    services: { sessions, sessionQuery, sessionTitle, sessionPersistence },
  }
  return host
}

test('重新生成名称的端口：新事件由自己开的写句柄写盘，且无论成败都把会话摘掉', async () => {
  const retitleCtx = (parts: Record<string, unknown>): unknown => ({
    get: (name: string) => parts[name],
  })
  const shapeHost = fakeRetitleHost()
  const all = shapeHost.services

  // 四件缺一不可：任何一件不在，界面那一侧就该按"这个宿主没有这个能力"禁用按钮，而不是半套上场。
  assert.equal(titleRefreshPort(retitleCtx({})), undefined, '什么都没有')
  assert.equal(titleRefreshPort(retitleCtx({ ...all, sessions: undefined })), undefined, '没有 sessions')
  assert.equal(titleRefreshPort(retitleCtx({ ...all, sessionQuery: undefined })), undefined, '没有 sessionQuery')
  assert.equal(titleRefreshPort(retitleCtx({ ...all, sessionTitle: undefined })), undefined, '没有 sessionTitle')
  assert.equal(
    titleRefreshPort(retitleCtx({ ...all, sessionPersistence: undefined })),
    undefined,
    '没有持久化：写不了盘，宁可说没有这个能力',
  )
  assert.equal(titleRefreshPort(retitleCtx({ ...all, sessions: { get: () => undefined } })), undefined, 'sessions 形状不认')
  assert.equal(titleRefreshPort(retitleCtx({ ...all, sessionPersistence: {} })), undefined, '持久化形状不认')
  assert.equal(titleRefreshPort({}), undefined, '连 ctx 形状都不对时也必须给个答案，而不是抛')

  // 写盘不再经 `sessions.flush()`，所以它缺席不影响这条能力在不在。
  const sessionsWithoutFlush = { ...(all.sessions as Record<string, unknown>) }
  delete sessionsWithoutFlush.flush
  assert.ok(titleRefreshPort(retitleCtx({ ...all, sessions: sessionsWithoutFlush })), '不需要 flush 也算有这个能力')

  // 一、日志停在 turn/end（246 条）：`prepare()` 会补一条 end-seed，它和标题一起写下去，seq 正好接上
  //    磁盘游标——这正是旧路子写不动的那一批。
  const trailingTurn = fakeRetitleHost({ stored: 246 })
  trailingTurn.current = { title: '你应该参考 https://github.com/he011', source: { kind: 'fallback' } }
  assert.deepEqual(await titleRefreshPort(trailingTurn.ctx)!.refresh('s-1'), { status: 'retitled', title: '重算出来的名字' })
  assert.equal(trailingTurn.isLive(), false, '临时挂载必须摘掉')
  assert.deepEqual(trailingTurn.calls, [
    'get:s-1',
    'read:s-1',
    'prepare:s-1',
    'enter',
    'announce',
    'titles:get',
    'titles:refresh',
    'append:session/title',
    'open:s-1:write',
    'write:2',
    'close',
    'detach',
  ], '写盘要排在卸载之前：自己开句柄写下去，再把会话还回去')
  assert.deepEqual(
    trailingTurn.disk.slice(246),
    [
      { type: 'session/end-seed', seq: 246 },
      { type: 'session/title', seq: 247 },
    ],
    '磁盘上真的多出这两条：补的那条标记接住游标，标题跟在它后面',
  )

  // 二、日志本来就停在 end-seed（362 条）：`prepare()` 不再补，只写标题那一条。
  const trailingSeed = fakeRetitleHost({ stored: 362, endsWithSeed: true })
  trailingSeed.current = { title: '旧名字', source: { kind: 'provider' } }
  trailingSeed.onRefresh = async (session) => {
    session.append('session/title')
    return { title: '新名字', source: { kind: 'provider' } }
  }
  assert.deepEqual(await titleRefreshPort(trailingSeed.ctx)!.refresh('s-1'), { status: 'retitled', title: '新名字' })
  assert.deepEqual(trailingSeed.disk.slice(362), [{ type: 'session/title', seq: 362 }])

  // 三、用户手动改过名：一次模型调用都不发，也不为那条标记单独写盘（那只是还原过程的记账）。
  const pinned = fakeRetitleHost({ stored: 246 })
  pinned.current = { title: '我自己改的名字', source: { kind: 'user' } }
  assert.deepEqual(await titleRefreshPort(pinned.ctx)!.refresh('s-1'), { status: 'skipped', reason: 'pinned' })
  assert.deepEqual(pinned.calls, ['get:s-1', 'read:s-1', 'prepare:s-1', 'enter', 'announce', 'titles:get', 'detach'])
  assert.equal(pinned.disk.length, 246, '什么都没变，就不要给日志添一条空记号')
  assert.equal(pinned.isLive(), false)

  // 四、`includePinned` 显式打开时（一次性清理那些"标题是脚本 / 导入写的"会话）：照样重算并写盘。
  const unpinned = fakeRetitleHost({ stored: 246 })
  unpinned.current = { title: '脚本写下的名字', source: { kind: 'user' } }
  assert.deepEqual(await titleRefreshPort(unpinned.ctx)!.refresh('s-1', { includePinned: true }), {
    status: 'retitled',
    title: '重算出来的名字',
  })
  assert.equal(unpinned.disk.at(-1)?.type, 'session/title', '连 user 源一起重算时也要落盘')

  // 五、重算之后还是同一条 provider 标题：报"没变"，但 provider 确实又写了一条事件，照旧落盘。
  const unchanged = fakeRetitleHost({ stored: 246 })
  unchanged.current = { title: '已经挺好的标题', source: { kind: 'provider' } }
  unchanged.onRefresh = async (session) => {
    session.append('session/title')
    return { title: '已经挺好的标题', source: { kind: 'provider' } }
  }
  assert.deepEqual(await titleRefreshPort(unchanged.ctx)!.refresh('s-1'), {
    status: 'unchanged',
    title: '已经挺好的标题',
  })
  assert.equal(unchanged.disk.length, 248, '标记 + 标题，两条都要落盘')

  // 六、还是没有标题（没有用户消息）：如实说这条没什么可命名的，磁盘一个字都不动。
  const empty = fakeRetitleHost({ stored: 246 })
  empty.current = undefined
  empty.onRefresh = async () => undefined
  assert.deepEqual(await titleRefreshPort(empty.ctx)!.refresh('s-1'), { status: 'skipped', reason: 'no-human-message' })
  assert.equal(empty.disk.length, 246)
  assert.equal(empty.isLive(), false)

  // 七、这条会话没有过主模型请求：宿主那句话是"本来就无从取名"，不是失败；挂载照样摘干净。
  const refusing = fakeRetitleHost({ stored: 246 })
  refusing.current = { title: '首句前几个词', source: { kind: 'fallback' } }
  refusing.onRefresh = async () => {
    throw new Error('session-title-llm: no logged request route is available; configure provider and model together')
  }
  assert.deepEqual(await titleRefreshPort(refusing.ctx)!.refresh('s-1'), {
    status: 'skipped',
    reason: 'no-request-route',
  })
  assert.equal(refusing.isLive(), false)

  // 但别的失败**照样抛**：模型超时、输入超预算那类必须让编排层记成 failed，不能被吞成"跳过"。
  const broken = fakeRetitleHost({ stored: 246 })
  broken.current = { title: '首句前几个词', source: { kind: 'fallback' } }
  broken.onRefresh = async () => {
    throw new Error('session-title-llm: 请求超时')
  }
  await assert.rejects(() => titleRefreshPort(broken.ctx)!.refresh('s-1'), /请求超时/)
  assert.equal(broken.isLive(), false, '重算抛错也要把会话摘掉')

  // 八、写盘被挡住（磁盘上已经被别人写过，游标对不上）：如实报错，而且会话照样摘掉。
  //    这一条正是缺陷的第二种表现：报错之后手没放干净，这条会话就留在宿主内存里当"活会话"，
  //    之后每次点都走活会话那条路——算得出、报成功、写不进。
  const blocked = fakeRetitleHost({ stored: 246 })
  blocked.current = { title: '旧名字', source: { kind: 'provider' } }
  blocked.failAppend = new Error('append seq mismatch for "s-1": expected 248 at index 0, got 246')
  await assert.rejects(() => titleRefreshPort(blocked.ctx)!.refresh('s-1'), /append seq mismatch/)
  assert.equal(blocked.isLive(), false, '写盘失败也必须把会话摘掉：漏一条它就一直在列表里挂"活动中"、还删不掉')

  // 九、句柄关不掉：如实报错，会话照样摘掉，而标题已经写下去了。
  const closeFails = fakeRetitleHost({ stored: 246 })
  closeFails.current = { title: '旧名字', source: { kind: 'provider' } }
  closeFails.failClose = new Error('session "s-1": close failed to release its write lock')
  await assert.rejects(() => titleRefreshPort(closeFails.ctx)!.refresh('s-1'), /close failed/)
  assert.equal(closeFails.disk.at(-1)?.type, 'session/title', '关句柄失败不该把已经写好的标题抹掉')
  assert.equal(closeFails.isLive(), false)

  // 十、会话**已经在**宿主内存里（用户正开着这条）：直接用活会话重算，不读日志、不挂载、
  //    也不碰写句柄（写句柄按 id 独占，抢来开第二个会直接抛 AlreadyOwned）。
  const liveHost = fakeRetitleHost({ stored: 246 })
  const liveSession = liveHost.makeLive()
  liveHost.current = { title: '旧标题', source: { kind: 'fallback' } }
  liveHost.onRefresh = async (session) => {
    session.append('session/title')
    return { title: '新标题', source: { kind: 'provider' } }
  }
  assert.deepEqual(await titleRefreshPort(liveHost.ctx)!.refresh('s-1'), { status: 'retitled', title: '新标题' })
  assert.deepEqual(liveHost.calls, ['get:s-1', 'titles:get', 'titles:refresh', 'append:session/title'], '活会话那条路上不该出现读日志 / 挂载 / 写句柄')
  assert.equal(liveHost.isLive(), true, '活会话不该被摘掉')
  assert.equal(liveSession.log.at(-1)?.type, 'session/title')
})

// ── 事件层接线：turn/end → 落盘 → touched() ─────────────────────────────────────
//
// 这一组测的是自动推送的**事件入口**。顺序是它的全部要点：`turn/end` 到的时候日志还没落盘（宿主的
// checkpoint 策略不管 `turn/end`），而推送读的是磁盘字节——所以必须"先冲盘、再说该推了"。顺序反了
// 就会推上去一份缺最后几步的半截会话。

/**
 * 一个只带 `get('sessions')` 与 `on()` 的最小宿主上下文。
 *
 * `calls` 是**一条**日志：`flush` 与 `dispose` 都往它里面写，测试也能用 `onCall` 把别处（比如调度器的
 * `touched()`）的调用并进来。先后关系只能这样测——两条各记各的数组只能核"都发生了"。
 */
function eventHost(options: {
  /** 显式 `null` = 这个宿主没有 `sessions` 服务；缺省 = 有一个记事的。 */
  sessions?: unknown
  withOn?: boolean
} = {}): {
  ctx: unknown
  calls: string[]
  emit: (session: unknown, event: unknown) => void
  onCall?: (entry: string) => void
} {
  const calls: string[] = []
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const result: {
    ctx: unknown
    calls: string[]
    emit: (session: unknown, event: unknown) => void
    onCall?: (entry: string) => void
  } = { ctx: undefined, calls, emit: () => {} }

  const note = (entry: string): void => {
    calls.push(entry)
    result.onCall?.(entry)
  }

  /*
   * `sessions` 缺席只有一种写法：显式传 `null`。不写成"缺省就是没有"——那样最容易踩的坑是
   * `eventHost()` 这种无参调用安静地变成"这个宿主没有会话服务"，然后断言全落空却看不出为什么。
   */
  const sessions =
    options.sessions === null
      ? undefined
      : {
          flush: async (session: unknown) => {
            note(`flush:${String((session as { id?: string } | undefined)?.id)}`)
            return true
          },
          ...((options.sessions ?? {}) as object),
        }

  result.ctx = {
    get: (serviceName: string) => (serviceName === 'sessions' ? sessions : undefined),
    ...(options.withOn === false
      ? {}
      : {
          on: (name: string, listener: (...args: unknown[]) => void) => {
            const list = listeners.get(name) ?? []
            list.push(listener)
            listeners.set(name, list)
            return () => {
              const current = listeners.get(name) ?? []
              listeners.set(name, current.filter((item) => item !== listener))
              note('dispose')
            }
          },
        }),
  }
  result.emit = (session: unknown, event: unknown): void => {
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
  }
  return result
}

test('事件接线：turn/end 先落盘、再说该推了（顺序错了会推半截会话）', async () => {
  /*
   * 这是事件层的**核心断言**：`flush` 必须排在 `touched()` 前面。反过来的话推送会读到一份还没落盘的
   * 日志——宿主的 checkpoint 策略只覆盖模型请求 / 工具派发 / 步进三处，`turn/end` 不在其中，所以这不是
   * 一个"理论上可能"的竞态。
   *
   * 两条各记各的数组**测不出先后**（那样只能核"都发生了"）。所以两边往**同一条**日志里写，最后比这条
   * 日志的顺序。
   */
  const host = eventHost()
  const log: string[] = []
  const timer = {
    touched: () => log.push('touched'),
  } as unknown as Parameters<typeof attachAutoPushToSessions>[1]
  host.onCall = (entry) => log.push(entry)

  const detach = attachAutoPushToSessions(host.ctx, timer)
  host.emit({ id: 's-1' }, { type: 'turn/end', turn: 3, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(log, ['flush:s-1', 'touched'], '先冲盘、再说该推了——顺序反了就是推半截会话')
  detach()
})

test('事件接线：每个会话事件都重置安静窗口，但只有 turn/end 会先冲盘', async () => {
  /*
   * "人还在用的时候不许推"就靠这一句：`turn/start`、`step/end`、工具派发、`turn/end` 一连串下来，
   * 每个事件都把窗口往后推，于是连着写多久就多久不推。只有 `turn/end` 那一次先冲盘——其余种类冲盘是
   * 白费（`step/end` 一次模型调用就一条），而推之前磁盘上必须是新的。
   */
  const host = eventHost()
  const order: string[] = []
  const timer = { touched: () => order.push('touched') } as unknown as Parameters<typeof attachAutoPushToSessions>[1]
  attachAutoPushToSessions(host.ctx, timer)

  for (const type of ['step/end', 'step/start', 'session/created', 'assistant/message', 'turn/start']) {
    host.emit({ id: 's-1' }, { type })
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(order.length, 5, '五个事件各把窗口往后推了一次')
  assert.ok(order.every((entry) => entry === 'touched'))
  assert.deepEqual(host.calls, [], '这些种类都不冲盘')

  order.length = 0
  host.emit({ id: 's-1' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['touched'], 'turn/end 也重置窗口')
  assert.equal(host.calls.length, 1, 'turn/end 先冲一次盘（推之前磁盘上必须是新的）')
})

test('事件接线：冲盘失败也照旧推（吞掉，不打断宿主派发）', async () => {
  /*
   * `flush` 只决定"这次读得到多新"，推的活儿本身没错。吞掉的代价是这一次可能推一份略旧的会话，下一轮
   * 或兜底的定时器会补上；而把异常抛进宿主的事件通道会打断它自己的派发，代价大得多。
   */
  const host = eventHost({
    sessions: {
      flush: async () => {
        throw new Error('盘满了')
      },
    },
  })
  const order: string[] = []
  const problems: string[] = []
  const timer = { touched: () => order.push('touched') } as unknown as Parameters<typeof attachAutoPushToSessions>[1]
  attachAutoPushToSessions(host.ctx, timer, (message) => problems.push(message))

  host.emit({ id: 's-1' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['touched'], '冲盘失败不影响"该推了"')
  assert.equal(problems.length, 1, '记了一笔')
  assert.match(problems[0] ?? '', /盘满了/, '原话带上，方便查')
})

test('事件接线：没有 sessions 服务 / 没有 on() 时安静地退化成"只有定时器"', async () => {
  /*
   * `sessions` 是**可选服务**（不进 `inject`）：没有它的 profile 照旧只有工具，插件不该因此起不来。
   * 这时事件层缺席，兜底的定时器仍然工作——所以这里只要求"不抛、返回一个能调的卸载函数"。
   */
  const order: string[] = []
  const timer = { touched: () => order.push('touched') } as unknown as Parameters<typeof attachAutoPushToSessions>[1]

  const noSessions = eventHost({ sessions: null })
  const detachA = attachAutoPushToSessions(noSessions.ctx, timer)
  assert.equal(typeof detachA, 'function', '照样返回卸载函数')
  noSessions.emit({ id: 's-1' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, [], '没有会话服务时不触发')

  // `sessions` 在、但没有 `flush`：同样退化。
  const noFlush = eventHost({ sessions: { flush: undefined } })
  attachAutoPushToSessions(noFlush.ctx, timer)
  noFlush.emit({ id: 's-1' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, [], '拿不到 flush 时不触发')

  // 没有 `on()` 的上下文：不抛。
  const noOn = eventHost({ withOn: false })
  assert.equal(typeof attachAutoPushToSessions(noOn.ctx, timer), 'function')
  assert.deepEqual(order, [])
})

test('事件接线：卸载函数摘掉监听', async () => {
  const host = eventHost()
  const order: string[] = []
  const timer = { touched: () => order.push('touched') } as unknown as Parameters<typeof attachAutoPushToSessions>[1]
  const detach = attachAutoPushToSessions(host.ctx, timer)

  host.emit({ id: 's-1' }, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(order.length, 1)

  detach()
  host.emit({ id: 's-1' }, { type: 'turn/end', turn: 2, reason: { kind: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(order.length, 1, '摘掉之后不再触发')
})

/**
 * 造一个**真的**自动推送运行时：真配置（`sync.autoPush`）、真本地库、真 WebDAV 夹具、真调度器。
 *
 * 用它测那些"接线接对了没有"的事：配置读到了、凭据解析出来了、`run()` 真的走到了远端。
 */
async function makeAutoPushHost(): Promise<{
  timer: import('../src/sync.ts').AutoPushTimer
  cleanup: () => void
}> {
  const sb = makeSandbox('auto-push-runtime')
  const fixture = await startDavFixture({ root: join(sb.base, 'dav') })
  const config: PluginConfig = {
    sessionsRoot: sb.root,
    registryPath: sb.registryPath,
    backupRoot: sb.backupRoot,
    sync: { url: fixture.url, machineId: 'robot-a', autoPush: true },
  }
  const host = new Context()
  await startSibling(host, 'tools', { register: () => () => {} })
  const resolved = await resolveAutoPushRuntime(host, config, {
    sessionsRoot: sb.root,
    registryPath: sb.registryPath,
    backupRoot: sb.backupRoot,
  })
  assert.ok(resolved !== undefined, '配了 sync.url 就该造出运行时')
  return {
    timer: resolved.timer,
    cleanup: () => {
      void fixture.close()
      rmSync(sb.base, { recursive: true, force: true })
    },
  }
}


test('resolveAutoPushRuntime：叫它就跑，接连两轮都不该被"间隔"挡住', async () => {
  /*
   * 兜底定时器删掉之后，`tick()` 只剩"现在就推"这一个意思——原来那道"距上次不到间隔就不跑"的闸
   * 跟着一起没了。这一条用真配置、真本地库、真 WebDAV 走一遍：第二次紧接着第一次跑，必须真跑起来
   * （闸如果回来了，这里会拿到 `skip: 'interval'`）。
   */
  const host = await makeAutoPushHost()
  try {
    const first = await host.timer.tick()
    assert.equal(first.ran, true, '第一轮真跑')
    const second = await host.timer.tick()
    assert.equal(second.ran, true, '紧接着再来一次照跑（没有间隔闸）')
  } finally {
    host.timer.stop()
    host.cleanup()
  }
})

test('附件端口：文件引用要把名字交给宿主（缺名字算不出本机路径）', () => {
  const id = 'sha256:' + 'ab'.repeat(32)
  const calls: Array<{ method: string; ref: Record<string, unknown> }> = []
  // 假宿主照 `dsh-attachment-local` 的判据：`fileHostPath()` 只认带合法名字的引用，缺名字直接抛错
  // （真宿主里是 `ensureFileReference()` 那道校验）；`imageHostPath()` 只读 id。
  const store = {
    imageHostPath(ref: Record<string, unknown>): string {
        calls.push({ method: 'image', ref })
        return `/lib/objects/${String(ref['attachmentId']).slice(7, 9)}/${String(ref['attachmentId']).slice(7)}`
      },
    fileHostPath(ref: Record<string, unknown>): string {
      calls.push({ method: 'file', ref })
      const name = ref['name']
      if (typeof name !== 'string' || name.length === 0) {
        throw new Error('File attachment reference is invalid.')
      }
      return `/lib/files/${String(ref['attachmentId']).slice(7, 9)}/${String(ref['attachmentId']).slice(7)}/${name}`
    },
  }
  // 宿主上下文只需要一个 `get()`（`optionalService()` 就是这么探服务有没有的）。
  const ctx = { get: (name: string) => (name === 'attachments' ? store : undefined) }
  const port = attachmentPort(ctx)
  assert.notEqual(port, undefined)

  // 文件：名字要真的交下去，落点也按宿主那条带名字的路径。
  assert.equal(
    port?.pathOf({ id, kind: 'file', name: 'notes.txt' }),
    `/lib/files/ab/${'ab'.repeat(32)}/notes.txt`,
  )
  assert.deepEqual(calls.at(-1), { method: 'file', ref: { attachmentId: id, name: 'notes.txt' } })

  // 引用里没有名字：算不出路径——宿主会抛，端口吞成 undefined（由调用方如实报"这一个落不了"），
  // 不做成崩溃，也不猜一个名字出来。
  assert.equal(port?.pathOf({ id, kind: 'file' }), undefined)

  // 图片：只交 id，名字（如果有）不参与。
  assert.equal(port?.pathOf({ id, kind: 'image' }), `/lib/objects/ab/${'ab'.repeat(32)}`)
  assert.deepEqual(calls.at(-1), { method: 'image', ref: { attachmentId: id } })

  // 宿主没有附件服务：端口整个缺席（调用方据此什么都不说）。
  assert.equal(attachmentPort({ get: () => undefined }), undefined)
})
