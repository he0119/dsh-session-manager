// 界面用的宿主端点：列会话、导出、导入（预演与落地），以及各条拒绝面。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { sessionDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry, validateRegistry, writeRegistryAtomic } from '../src/registry.ts'
import { createDavClient } from '../src/dav.ts'
import { SYNC_NAMESPACE_DIR } from '../src/sync.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { API_PREFIX, createApiHandlers, registerWebRoutes, type WebRouteLike } from '../src/web.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'
import { putRemoteSession, startDavFixture } from './dav-fixture.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const CWD_A = join(import.meta.dirname, '.sandbox', 'web-a')
const CWD_B = join(import.meta.dirname, '.sandbox', 'web-b')

interface Sandbox {
  base: string
  sessionsRoot: string
  registryPath: string
  registry: WorkspaceRegistryState
}

function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(CWD_A, { recursive: true })
  mkdirSync(CWD_B, { recursive: true })
  const registryPath = join(base, 'workspace.json')
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-a': { path: CWD_A, title: 'a', sessionIds: ['session-a'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    },
  }
  writeRegistryAtomic(registryPath, registry)
  return { base, sessionsRoot, registryPath, registry }
}

function writeSession(
  root: string,
  id: string,
  cwd: string,
  createdAt: number,
  options: { title?: string; origin?: 'subagent'; parentSession?: string } = {},
): void {
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: options.parentSession === undefined ? 0 : 1,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  }
  const lines = [
    JSON.stringify(header),
    JSON.stringify({ type: 'user/message', seq: 0, data: {} }),
    // 标题在 DSH 里是日志事件（最新一条生效），不是 header 字段——夹具得照这个样子写，
    // 否则测的就不是真实数据形状了（见 src/session-title.ts）。
    ...(options.title === undefined
      ? []
      : [JSON.stringify({ type: 'session/title', seq: 1, data: { title: options.title, source: { kind: 'fallback' } } })]),
  ]
  const dir = sessionDir(root, cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))),
  )
}

/** 写一份宿主的投影缓存记录（宿主自己列会话时读它，标题与空白判据都在里面）。 */
function writeProjectionCache(
  sandbox: Sandbox,
  id: string,
  record: { createdAt: number; cwd?: string; title?: string; blank?: boolean },
): void {
  const dir = join(sandbox.base, 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  const rows: Record<string, unknown> = {}
  if (record.title !== undefined) rows['title'] = { ver: 1, seq: 1, val: record.title }
  if (record.blank !== undefined) rows['sessionListMetadata'] = { ver: 1, seq: 1, val: { blank: record.blank, lastPromptAt: null } }
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: record.createdAt, ...(record.cwd === undefined ? {} : { cwd: record.cwd }) },
        rows,
      },
    }),
  )
}

function fakeReq(method: string, url: string, body?: Buffer): IncomingMessage {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
  emitter['method'] = method
  emitter['url'] = url
  emitter['destroy'] = (): void => {}
  queueMicrotask(() => {
    if (body && body.length > 0) emitter.emit('data', body)
    emitter.emit('end')
  })
  return emitter as unknown as IncomingMessage
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: Buffer
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  let headersSent = false
  const res = {
    get headersSent(): boolean {
      return headersSent
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
      headersSent = true
      return res
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) captured.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      headersSent = true
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

function json(res: Captured): Record<string, unknown> {
  return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
}

function deps(
  sandbox: Sandbox,
  extra: Partial<Parameters<typeof createApiHandlers>[0]> = {},
): Parameters<typeof createApiHandlers>[0] {
  return {
    paths: { sessionsRoot: sandbox.sessionsRoot, registryPath: sandbox.registryPath, backupRoot: join(sandbox.base, 'backups') },
    decodeAll,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
    pluginVersion: '0.0.0-test',
    ...extra,
  }
}

test('GET /state：列出会话与工作区，带上「未分组」的结论', async () => {
  const sandbox = makeSandbox('web-state')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '帮我安装到 web-dev 中' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_B, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)

  assert.equal(captured.status, 200)
  const body = json(captured)
  const sessions = body['sessions'] as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map((s) => s['id']).sort(), ['session-a', 'session-b'])
  // 新→旧
  assert.equal(sessions[0]!['id'], 'session-b')
  // 宿主只发结论（侧边栏会不会把它放进「未分组」），不发"有没有工作区认领"那个中间事实：
  // session-a 在册 → 不是；session-b 谁都没认领、又看得见 → 是。
  assert.equal(sessions.find((s) => s['id'] === 'session-a')!['ungrouped'], false)
  assert.equal(sessions.find((s) => s['id'] === 'session-b')!['ungrouped'], true)
  assert.equal('workspaceId' in sessions[0]!, false, '中间事实不再上线（界面一律读结论）')
  // 标题：界面靠它认会话（id 退到悬浮提示）。缓存不在时读的是日志开头那一段。
  assert.equal(sessions.find((s) => s['id'] === 'session-a')!['title'], '帮我安装到 web-dev 中')
  // 日志里没有标题事件的老会话：字段缺席，界面自己回落到 id（而不是空字符串）
  assert.equal(sessions.find((s) => s['id'] === 'session-b')!['title'], undefined)
  const workspaces = body['workspaces'] as Array<Record<string, unknown>>
  assert.deepEqual(workspaces.map((w) => w['id']), ['ws-a'])
  assert.deepEqual(body['problems'], [])
  // 没注入探测函数时按"这个宿主没有目录选择器"回：界面据此不显示「浏览…」，
  // 而不是显示一个点了必被宿主以 directory-picker/unavailable 拒绝的按钮。
  assert.equal(body['pickerKind'], null)
})

test('GET /state：子代理 / 空白 / 已归档即使没在册也不是「未分组」（侧边栏从不把它们放进那一组）', async () => {
  const sandbox = makeSandbox('web-state-ungrouped')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 1001, { origin: 'subagent', parentSession: 'session-a' })
  writeSession(sandbox.sessionsRoot, 'session-blank', CWD_A, 1002)
  writeSession(sandbox.sessionsRoot, 'session-archived', CWD_A, 1003)
  writeSession(sandbox.sessionsRoot, 'session-stray', CWD_B, 1004)
  writeProjectionCache(sandbox, 'session-blank', { createdAt: 1002, cwd: CWD_A, blank: true })
  writeRegistryAtomic(sandbox.registryPath, {
    ...sandbox.registry,
    global: { ...sandbox.registry.global, archivedSessionIds: ['session-archived'] },
  })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)
  const sessions = (json(captured)['sessions'] ?? []) as Array<Record<string, unknown>>
  const byId = new Map(sessions.map((s) => [String(s['id']), s]))

  // 只有"谁都没认领 **且** 侧边栏会显示"的那条算「未分组」；它同时说明另外四条为什么不算。
  assert.deepEqual(
    sessions.filter((s) => s['ungrouped'] === true).map((s) => s['id']),
    ['session-stray'],
  )
  assert.equal(byId.get('session-a')!['ungrouped'], false, '在册的不算')
  assert.equal(byId.get('session-child')!['ungrouped'], false, '子代理嵌在父会话下面，不在那一组里')
  assert.equal(byId.get('session-child')!['hidden'], 'subagent')
  // 界面靠这个字段把子代理缩进到父会话的下一级（判据与删除 / 迁移的级联展开是同一个 header 字段）
  assert.equal(byId.get('session-child')!['parentSession'], 'session-a')
  assert.equal('parentSession' in byId.get('session-a')!, false, '普通会话没有这个字段（不是空串）')
  assert.equal(byId.get('session-blank')!['ungrouped'], false, '空白默认不显示')
  assert.equal(byId.get('session-archived')!['ungrouped'], false, '已归档在默认归档过滤下不显示')
})

test('GET /state：标题优先读宿主投影缓存，缓存对不上身份才回落日志', async () => {
  const sandbox = makeSandbox('web-state-title')
  // 日志里是首条 fallback 标题，缓存里是用户改过的名字：缓存赢（它就是"最新一条"）。
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '日志里的老标题' })
  writeProjectionCache(sandbox, 'session-a', { createdAt: 1000, cwd: CWD_A, title: '缓存里的新标题' })
  // 缓存里的 createdAt 对不上（同 id 的另一条生命周期）：不认，回落日志。
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_B, 2000, { title: '日志里的标题' })
  writeProjectionCache(sandbox, 'session-b', { createdAt: 999, cwd: CWD_B, title: '别人的标题' })
  // 缓存里没这条记录（比如刚被本插件导入的会话）：回落日志。
  writeSession(sandbox.sessionsRoot, 'session-c', CWD_A, 3000, { title: '只在日志里的标题' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)

  const byId = new Map((json(captured)['sessions'] as Array<Record<string, unknown>>).map((s) => [s['id'], s]))
  assert.equal(byId.get('session-a')!['title'], '缓存里的新标题')
  assert.equal(byId.get('session-b')!['title'], '日志里的标题')
  assert.equal(byId.get('session-c')!['title'], '只在日志里的标题')
})

test('GET /state：读标题失败（注入的读取器抛错）不影响列出会话', async () => {
  const sandbox = makeSandbox('web-state-title-broken')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '标题' })

  const handlers = createApiHandlers({
    ...deps(sandbox),
    // 标题是装饰：它坏了（缓存格式变了、解码器不吃这段字节……）也只能少显示个名字，
    // 不能让整页会话都列不出来。
    resolveTitle: () => {
      throw new Error('标题读取器坏了')
    },
  })
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)

  assert.equal(captured.status, 200)
  const sessions = json(captured)['sessions'] as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map((s) => s['id']), ['session-a'])
  assert.equal(sessions[0]!['title'], undefined)
})

test('GET /state：宿主的选择器能力种类如实透给界面（native/browse）', async () => {
  const sandbox = makeSandbox('web-picker')

  const browse = createApiHandlers({ ...deps(sandbox), pickerKind: () => 'browse' })
  const browseRes = fakeRes()
  await browse['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), browseRes.res)
  assert.equal(json(browseRes.captured)['pickerKind'], 'browse')

  const native = createApiHandlers({ ...deps(sandbox), pickerKind: () => 'native' })
  const nativeRes = fakeRes()
  await native['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), nativeRes.res)
  assert.equal(json(nativeRes.captured)['pickerKind'], 'native')
})

test('POST /export：回一个可解析的包，文件名与内容都对', async () => {
  const sandbox = makeSandbox('web-export')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_B, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  const req = fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'] })))
  await handlers['POST /export']!(req, res)

  assert.equal(captured.status, 200)
  assert.match(captured.headers['content-disposition'] ?? '', /attachment; filename="dsh-sessions-1-2026-09-27T00-00-00-000\.dshsess"/)
  const { readBundle } = await import('../src/transfer.ts')
  const bundle = readBundle(captured.body)
  assert.deepEqual(bundle.sessions.map((s) => s.id), ['session-a'])
  assert.equal(bundle.sessions[0]!.cwd, CWD_A)
  assert.equal(bundle.source.pluginVersion, '0.0.0-test')
})

test('POST /export：会话不在库里就 404，空选择就 400', async () => {
  const sandbox = makeSandbox('web-export-errors')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))

  const missing = fakeRes()
  await handlers['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['nope'] }))),
    missing.res,
  )
  assert.equal(missing.captured.status, 404)

  const empty = fakeRes()
  await handlers['POST /export']!(fakeReq('POST', `${API_PREFIX}/export`, Buffer.from('{}')), empty.res)
  assert.equal(empty.captured.status, 400)

  const badJson = fakeRes()
  await handlers['POST /export']!(fakeReq('POST', `${API_PREFIX}/export`, Buffer.from('{')), badJson.res)
  assert.equal(badJson.captured.status, 400)
})

test('POST /export：单独导出子代理被拒；点名父会话时子代理跟着进包，条数报在响应头里', async () => {
  const sandbox = makeSandbox('web-export-subagent')
  writeSession(sandbox.sessionsRoot, 'session-parent', CWD_A, 1000, { title: '父会话' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 2000, { origin: 'subagent', parentSession: 'session-parent' })
  const handlers = createApiHandlers(deps(sandbox))
  const post = async (ids: string[]): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /export']!(
      fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ids }))),
      res,
    )
    return captured
  }

  const refused = await post(['session-child'])
  assert.equal(refused.status, 400)
  assert.match(String(json(refused)['error']), /请改点名它的父会话 父会话（session-parent）/)

  const packed = await post(['session-parent'])
  assert.equal(packed.status, 200)
  const { readBundle } = await import('../src/transfer.ts')
  const bundle = readBundle(packed.body)
  assert.deepEqual(bundle.sessions.map((session) => session.id), ['session-parent', 'session-child'])
  assert.match(packed.headers['content-disposition'] ?? '', /dsh-sessions-2-/)
  // 界面那句"已导出 N 条"读的就是这两个头（勾一条父会话时它比勾选数多）
  assert.equal(packed.headers['x-dsh-session-count'], '2')
  assert.ok(Number(packed.headers['x-dsh-session-bytes']) > 0)
})

test('POST /import：预演不写盘，落地后会话与注册表一起落盘', async () => {
  const source = makeSandbox('web-import-source')
  writeSession(source.sessionsRoot, 'session-a', CWD_A, 1000, { title: '被导出的会话' })
  const exportHandlers = createApiHandlers(deps(source))
  const exported = fakeRes()
  await exportHandlers['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'] }))),
    exported.res,
  )
  const bundleBytes = exported.captured.body

  // 空库 + 空注册表：模拟导进另一个实例
  const target = makeSandbox('web-import-target')
  rmSync(target.sessionsRoot, { recursive: true, force: true })
  mkdirSync(target.sessionsRoot, { recursive: true })
  writeRegistryAtomic(target.registryPath, {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  })

  const handlers = createApiHandlers(deps(target))
  const targetUrl = `${API_PREFIX}/import?targetCwd=${encodeURIComponent(CWD_B)}`

  const planned = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', targetUrl, bundleBytes), planned.res)
  assert.equal(planned.captured.status, 200)
  const planBody = json(planned.captured)
  assert.equal(planBody['ok'], true)
  assert.deepEqual(planBody['created'], ['session-a'])
  // 预演表里显示的是标题（id 退到悬浮提示）：它从包里的日志事件折出来，清单格式没为此改过。
  assert.equal((planBody['entries'] as Array<Record<string, unknown>>)[0]!['title'], '被导出的会话')
  assert.equal(existsSync(join(sessionDir(target.sessionsRoot, CWD_B, 'session-a'))), false, '预演不写盘')

  const applied = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${targetUrl}&mode=apply`, bundleBytes), applied.res)
  assert.equal(applied.captured.status, 200)
  const applyBody = json(applied.captured)
  assert.deepEqual(applyBody['written'], ['session-a'])
  assert.equal(applyBody['registryWritten'], true)
  assert.match(String(applyBody['note']), /重启/)

  const written = join(sessionDir(target.sessionsRoot, CWD_B, 'session-a'), 'session.v4.jsonl.zstd')
  assert.equal(existsSync(written), true)
  assert.equal(JSON.parse(decodeAll(readFileSync(written)).split('\n')[0]!).cwd, CWD_B)

  const registry = readRegistry(target.registryPath)
  assert.equal(validateRegistry(registry).ok, true)
  assert.deepEqual(registry.tables.workspaces[Object.keys(registry.tables.workspaces)[0]!]!.sessionIds, ['session-a'])
})

test('POST /import：包坏了、目标目录不合法、库已存在同 id，各自给出可读的拒绝', async () => {
  const sandbox = makeSandbox('web-import-errors')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))
  const good = fakeRes()
  await handlers['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'] }))),
    good.res,
  )
  const bundleBytes = good.captured.body
  const url = `${API_PREFIX}/import?targetCwd=${encodeURIComponent(CWD_B)}`

  const empty = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', url, Buffer.alloc(0)), empty.res)
  assert.equal(empty.captured.status, 400)

  const garbage = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', url, Buffer.from('这不是包')), garbage.res)
  assert.equal(garbage.captured.status, 400)
  assert.match(String(json(garbage.captured)['error']), /gzip/i)

  const noTarget = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${API_PREFIX}/import`, bundleBytes), noTarget.res)
  assert.equal(noTarget.captured.status, 400)

  const badTarget = fakeRes()
  await handlers['POST /import']!(
    fakeReq('POST', `${API_PREFIX}/import?targetCwd=${encodeURIComponent(join(sandbox.base, 'nowhere'))}`, bundleBytes),
    badTarget.res,
  )
  assert.equal(badTarget.captured.status, 400)
  assert.match(String(json(badTarget.captured)['error']), /不存在/)

  // 库里已有同 id：预演 ok=false、落地 409，都不覆盖
  const conflict = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', url, bundleBytes), conflict.res)
  assert.equal(conflict.captured.status, 200)
  assert.equal(json(conflict.captured)['ok'], false)

  const conflictApply = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${url}&mode=apply`, bundleBytes), conflictApply.res)
  assert.equal(conflictApply.captured.status, 409)
  assert.match(String(json(conflictApply.captured)['error']), /没有可导入的会话/)
})

test('registerWebRoutes：注册九条精确路由，方法不对回 405', async () => {
  const sandbox = makeSandbox('web-routes')
  const routes: WebRouteLike[] = []
  const dispose = registerWebRoutes(
    { register: (route) => { routes.push(route); return () => {} } },
    deps(sandbox),
  )
  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path}`),
    [
      `exact ${API_PREFIX}/state`,
      `exact ${API_PREFIX}/export`,
      `exact ${API_PREFIX}/import`,
      // `/sync` 两种方法共用一条（宿主的 register 对重复 path 会抛错）
      `exact ${API_PREFIX}/sync`,
      `exact ${API_PREFIX}/backups`,
      `exact ${API_PREFIX}/migrate`,
      `exact ${API_PREFIX}/rollback`,
      `exact ${API_PREFIX}/delete`,
      `exact ${API_PREFIX}/archive`,
    ],
  )

  const exportRoute = routes.find((route) => route.path.endsWith('/export'))!
  const { res, captured } = fakeRes()
  await exportRoute.handler(fakeReq('GET', `${API_PREFIX}/export`), res)
  assert.equal(captured.status, 405)

  // 一条路由两种方法：表里的每一种都放行，别的仍然 405
  const syncRoute = routes.find((route) => route.path.endsWith('/sync'))!
  const allowed = fakeRes()
  await syncRoute.handler(fakeReq('GET', `${API_PREFIX}/sync`), allowed.res)
  assert.equal(allowed.captured.status, 409, '方法放行了，只是这个宿主没配置同步')
  const rejected = fakeRes()
  await syncRoute.handler(fakeReq('DELETE', `${API_PREFIX}/sync`), rejected.res)
  assert.equal(rejected.captured.status, 405)
  assert.match(String(json(rejected.captured)['error']), /只接受 GET \/ POST/)
  dispose()
})

// ---- 会话管理：迁移 / 备份 / 回滚 ----

test('POST /migrate：mode 缺省只预演，预演结果里带上源/目标项目目录与注册表变更', async () => {
  const sandbox = makeSandbox('web-migrate-plan')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '要搬走的会话' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ from: CWD_A, to: CWD_B }))),
    res,
  )
  assert.equal(captured.status, 200)
  const body = json(captured)
  assert.equal(body['mode'], 'plan')
  assert.equal(body['ok'], true)
  assert.equal(body['applied'], false)
  const preview = body['preview'] as Record<string, unknown>
  assert.equal((preview['sessions'] as unknown[]).length, 1)
  // 预演里也带标题：迁移页挑会话与传输页用同一套口径（标题可见、id 退到悬浮提示）。
  assert.equal((preview['sessions'] as Array<Record<string, unknown>>)[0]!['title'], '要搬走的会话')
  // 项目目录名是**绝对路径**：join(会话根, projectKey(工作区目录))
  assert.equal(preview['sourceProjectDir'], join(sandbox.sessionsRoot, projectKey(CWD_A)))
  assert.equal(preview['targetProjectDir'], join(sandbox.sessionsRoot, projectKey(CWD_B)))
  assert.equal((preview['registryChange'] as Record<string, unknown>)['targetPath'], CWD_B)
  // 没注入 effectMode 时按保守说法回：注册表落盘还要重启才被承认。
  assert.equal(body['takesEffect'], 'restart-required')
  // 预演不写盘：会话还在源项目目录
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), true)
})

test('POST /migrate：带 sessionIds 时只搬点名的会话（界面「只选其中几条」走的就是这条路）', async () => {
  const sandbox = makeSandbox('web-migrate-subset')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ mode: 'apply', from: CWD_A, to: CWD_B, sessionIds: ['session-b'] })),
    ),
    res,
  )

  assert.equal(captured.status, 200)
  const body = json(captured)
  assert.equal(body['applied'], true)
  assert.deepEqual(
    ((body['preview'] as Record<string, unknown>)['sessions'] as { id: string }[]).map((s) => s.id),
    ['session-b'],
  )
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), true, '未点名的会话必须留在源项目目录')
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-b')), false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_B, 'session-b')), true)
  // 源工作区没被搬空 → 注册表里必须还在
  assert.deepEqual(readRegistry(sandbox.registryPath).tables.workspaces['ws-a']?.sessionIds, ['session-a'])
})

test('POST /migrate：勾中的父会话把子代理一起带走，条数报在 cascaded 里（界面据此说明）', async () => {
  const sandbox = makeSandbox('web-migrate-family')
  writeSession(sandbox.sessionsRoot, 'session-parent', CWD_A, 1000, { title: '父会话' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 1001, { origin: 'subagent', parentSession: 'session-parent' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ from: CWD_A, to: CWD_B, sessionIds: ['session-parent'] })),
    ),
    res,
  )

  assert.equal(captured.status, 200)
  const body = json(captured)
  const preview = body['preview'] as Record<string, unknown>
  const sessions = preview['sessions'] as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map((s) => s['id']), ['session-parent', 'session-child'])
  // 界面读的就是这个字段：`cascaded > 0` 才多说一句"其中 N 条是子代理会话"
  assert.equal(preview['cascaded'], 1)
  // `via` 带着点名那条的标题（有标题时界面用它认人，没有就退到 id）
  assert.deepEqual(sessions[1]!['via'], { id: 'session-parent', title: '父会话' }, '子代理要带着"是谁把它牵进来的"')
  assert.equal(sessions[1]!['registered'], false)
  // 级联不改变成员资格：只有点名的父会话进目标工作区
  assert.deepEqual((preview['registryChange'] as Record<string, unknown>)['added'], ['session-parent'])
})

test('POST /migrate：unowned 来源不带 from 也能预演（界面那个跨目录的「未分组」走这条路）', async () => {
  const sandbox = makeSandbox('web-migrate-unowned')
  // session-a 登记在 ws-a 名下，session-b 的 cwd 是同一个目录但谁都没认领 —— 未分组来源只认后者。
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ unowned: true, to: CWD_B }))),
    res,
  )
  assert.equal(captured.status, 200)
  const body = json(captured)
  const preview = body['preview'] as Record<string, unknown>
  assert.equal(preview['unowned'], true)
  assert.equal(preview['from'], '')
  assert.equal(preview['sourceProjectDir'], '')
  assert.deepEqual(preview['sourceProjectDirs'], [join(sandbox.sessionsRoot, projectKey(CWD_A))])
  assert.deepEqual((preview['sessions'] as { id: string }[]).map((s) => s.id), ['session-b'])
  // 预演不写盘
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-b')), true)

  // 两种源都不给：400，且错误信息要说清有两条路
  const denied = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ to: CWD_B }))),
    denied.res,
  )
  assert.equal(denied.captured.status, 400)
  assert.match(String((json(denied.captured) as Record<string, unknown>)['error']), /unowned/)
})

test('POST /migrate：mode=apply 真搬并回可回滚的备份；注入 effectMode 时如实回报', async () => {
  const sandbox = makeSandbox('web-migrate-apply')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

  const handlers = createApiHandlers({ ...deps(sandbox), effectMode: () => 'immediate' })
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ mode: 'apply', from: CWD_A, to: CWD_B }))),
    res,
  )
  assert.equal(captured.status, 200)
  const body = json(captured)
  assert.equal(body['mode'], 'apply')
  assert.equal(body['applied'], true)
  assert.equal(body['verified'], true, `复核应当通过：${JSON.stringify(body['problems'])}`)
  assert.equal(body['rewritten'], 1)
  assert.equal(body['moved'], 1)
  assert.equal(body['takesEffect'], 'immediate')
  assert.equal(typeof body['backupDir'], 'string')

  // 真的搬了：目标项目目录里有、源项目目录里没有、header.cwd 已改写
  const moved = sessionDir(sandbox.sessionsRoot, CWD_B, 'session-a')
  assert.equal(existsSync(moved), true)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), false)
  const header = JSON.parse(decodeAll(readFileSync(join(moved, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as {
    cwd?: string
    id?: string
  }
  assert.equal(header.cwd, CWD_B)
  assert.equal(header.id, 'session-a')

  // 备份列表里能看到这一条，带源/目标与会话数
  const backups = fakeRes()
  await handlers['GET /backups']!(fakeReq('GET', `${API_PREFIX}/backups`), backups.res)
  assert.equal(backups.captured.status, 200)
  const listed = json(backups.captured)['backups'] as Array<Record<string, unknown>>
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.['sessions'], 1)
  assert.equal(listed[0]?.['from'], CWD_A)
  assert.equal(listed[0]?.['to'], CWD_B)
})

test('POST /rollback：先 dryRun 看动作，再真回滚到原状', async () => {
  const sandbox = makeSandbox('web-rollback')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

  const handlers = createApiHandlers(deps(sandbox))
  const migrateRes = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ mode: 'apply', from: CWD_A, to: CWD_B }))),
    migrateRes.res,
  )
  const backupDir = json(migrateRes.captured)['backupDir'] as string
  assert.ok(backupDir)

  // dry-run：给动作清单，但不写
  const dry = fakeRes()
  await handlers['POST /rollback']!(
    fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir, dryRun: true }))),
    dry.res,
  )
  assert.equal(dry.captured.status, 200)
  assert.equal(json(dry.captured)['dryRun'], true)
  assert.ok((json(dry.captured)['actions'] as unknown[]).length > 0)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_B, 'session-a')), true, 'dry-run 不该动目录')

  // 真回滚
  const done = fakeRes()
  await handlers['POST /rollback']!(
    fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir }))),
    done.res,
  )
  assert.equal(done.captured.status, 200)
  assert.equal(json(done.captured)['dryRun'], false)
  assert.equal(json(done.captured)['restoredFiles'], 1)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_B, 'session-a')), false)
  const back = sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')
  assert.equal(existsSync(back), true)
  const header = JSON.parse(decodeAll(readFileSync(join(back, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as { cwd?: string }
  assert.equal(header.cwd, CWD_A)
})

test('POST /migrate：参数与状态问题各自给出可读的拒绝（400 / 409）', async () => {
  const sandbox = makeSandbox('web-migrate-refuse')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))

  const post = async (body: string): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /migrate']!(fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(body)), res)
    return captured
  }

  assert.equal((await post('{not json')).status, 400)
  assert.match(String(json(await post(JSON.stringify({ to: CWD_B })))['error']), /缺少源工作区目录/)
  assert.match(
    String(json(await post(JSON.stringify({ from: CWD_A, to: join(sandbox.base, 'nope') })))['error']),
    /目标工作区目录不存在/,
  )
  // 状态问题：源项目目录不存在 → 409（参数没问题，是库的状态说了不行）
  const missingProjectDir = await post(JSON.stringify({ from: join(sandbox.base, 'ghost'), to: CWD_B }))
  assert.equal(missingProjectDir.status, 409)
  assert.equal(json(missingProjectDir)['ok'], false)
  assert.ok((json(missingProjectDir)['preview'] as Record<string, unknown>)['problems'])
})

test('POST /rollback：只认本插件备份根下的目录', async () => {
  const sandbox = makeSandbox('web-rollback-guard')
  const handlers = createApiHandlers(deps(sandbox))

  const post = async (body: unknown): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /rollback']!(fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify(body))), res)
    return captured
  }

  assert.match(String(json(await post({}))['error']), /缺少备份目录/)
  assert.match(String(json(await post({ backupDir: sandbox.base }))['error']), /不在本插件的备份根下/)
  const empty = join(sandbox.base, 'backups', 'empty')
  mkdirSync(empty, { recursive: true })
  assert.match(String(json(await post({ backupDir: empty }))['error']), /没有 manifest\.json/)
})

// ---- 会话管理：可见性字段 / 删除 / 归档 ----

test('GET /state：会话行带上"侧边栏为什么不显示"，以及归档能力位', async () => {
  const sandbox = makeSandbox('web-state-visibility')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  // 子代理会话：header 里带 origin，侧边栏把它嵌在父会话下面
  writeSession(sandbox.sessionsRoot, 'session-sub', CWD_A, 2000, { origin: 'subagent' })
  // 空白会话：宿主投影缓存说它一轮都没开始过
  writeSession(sandbox.sessionsRoot, 'session-blank', CWD_B, 3000)
  writeProjectionCache(sandbox, 'session-a', { createdAt: 1000, cwd: CWD_A, blank: false })
  writeProjectionCache(sandbox, 'session-blank', { createdAt: 3000, cwd: CWD_B, blank: true })
  // 已归档：id 在注册表的归档集里（同时仍在 ws-a 的登记表里，归档不动记账）
  const registry = readRegistry(sandbox.registryPath)
  registry.global.archivedSessionIds = ['session-a']
  writeRegistryAtomic(sandbox.registryPath, registry)

  const handlers = createApiHandlers(deps(sandbox, { liveSessionIds: () => new Set(['session-sub']) }))
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)

  const body = json(captured)
  const rows = new Map((body['sessions'] as Array<Record<string, unknown>>).map((row) => [row['id'], row]))
  // 已归档（缓存里 blank: false，所以理由只能是归档）
  assert.equal(rows.get('session-a')!['hidden'], 'archived')
  assert.equal(rows.get('session-a')!['archived'], true)
  assert.equal(rows.get('session-a')!['blank'], false)
  // 子代理：理由来自 header，先于归档判
  assert.equal(rows.get('session-sub')!['hidden'], 'subagent')
  assert.equal(rows.get('session-sub')!['origin'], 'subagent')
  // 空白：理由来自宿主投影缓存
  assert.equal(rows.get('session-blank')!['hidden'], 'blank')
  assert.equal(rows.get('session-blank')!['blank'], true)
  // 活着的那条（删除要拒它）
  assert.equal(rows.get('session-sub')!['live'], true)
  assert.equal(rows.get('session-blank')!['live'], false)
  // 宿主没给归档能力位时按"改不了"（界面据此禁用按钮）
  assert.equal(body['archiveAvailable'], false)
})

test('GET /state：注入归档端口后 archiveAvailable 为 true', async () => {
  const sandbox = makeSandbox('web-state-archive-flag')
  const handlers = createApiHandlers(
    deps(sandbox, { registryOps: () => ({ archive: async () => {}, unarchive: async () => {} }) }),
  )
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)
  assert.equal(json(captured)['archiveAvailable'], true)
})

test('POST /delete：预演不写盘、落地先备份再删，二者共用同一份计划', async () => {
  const sandbox = makeSandbox('web-delete')
  const dir = sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '不要了的会话' })

  const handlers = createApiHandlers(deps(sandbox))
  const post = async (body: unknown): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /delete']!(fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify(body))), res)
    return captured
  }

  const planned = await post({ sessionIds: ['session-a'], mode: 'plan' })
  assert.equal(planned.status, 200)
  const planBody = json(planned)
  assert.equal(planBody['mode'], 'plan')
  assert.equal(planBody['applied'], false)
  const preview = planBody['preview'] as Record<string, unknown>
  assert.deepEqual((preview['entries'] as Array<Record<string, unknown>>).map((entry) => entry['id']), ['session-a'])
  assert.equal((preview['entries'] as Array<Record<string, unknown>>)[0]!['title'], '不要了的会话')
  assert.equal((preview['entries'] as Array<Record<string, unknown>>)[0]!['dir'], dir)
  assert.equal(existsSync(dir), true, '预演不许动磁盘')

  const applied = await post({ sessionIds: ['session-a'], mode: 'apply' })
  assert.equal(applied.status, 200)
  const applyBody = json(applied)
  assert.equal(applyBody['applied'], true)
  assert.equal(applyBody['verified'], true)
  assert.match(String(applyBody['summary']), /已删除 1 个会话/)
  assert.equal(typeof applyBody['backupDir'], 'string')
  assert.equal(existsSync(dir), false, '落地之后会话目录该没了')
  // 备份落在本插件的备份根下（「备份与回滚」那张卡读的就是它）
  assert.equal(existsSync(applyBody['backupDir'] as string), true)
})

test('POST /delete：删父会话时把子代理一起带上，预演里带着出处字段', async () => {
  const sandbox = makeSandbox('web-delete-family')
  writeSession(sandbox.sessionsRoot, 'session-parent', CWD_A, 1000, { title: '父会话' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 2000, { title: '子代理', origin: 'subagent', parentSession: 'session-parent' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /delete']!(
    fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify({ sessionIds: ['session-parent'], mode: 'plan' }))),
    res,
  )
  assert.equal(captured.status, 200)
  const preview = json(captured)['preview'] as Record<string, unknown>
  // 界面读的就是这几个字段（见 src/client/api.ts 的 DeleteEntry）：条数、级联计数与"跟着谁来的"
  assert.equal(preview['cascaded'], 1)
  const entries = preview['entries'] as Array<Record<string, unknown>>
  assert.deepEqual(entries.map((entry) => entry['id']), ['session-parent', 'session-child'])
  assert.equal(entries[0]!['via'], undefined)
  assert.deepEqual(entries[1]!['via'], { id: 'session-parent', title: '父会话' })
  assert.equal(entries[1]!['origin'], 'subagent')
  assert.match(String(json(captured)['summary']), /其中 1 条是子代理会话/)
})

test('POST /delete：状态不允许（会话不在库里）用 409 并把完整计划带回来', async () => {
  const sandbox = makeSandbox('web-delete-guard')
  const handlers = createApiHandlers(deps(sandbox))

  const { res, captured } = fakeRes()
  await handlers['POST /delete']!(
    fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify({ sessionIds: ['session-ghost'], mode: 'apply' }))),
    res,
  )
  assert.equal(captured.status, 409)
  const body = json(captured)
  assert.equal(body['ok'], false)
  assert.equal((body['preview'] as Record<string, unknown>)['ok'], false)
  assert.match(String((body['problems'] as string[]).join('\n')), /不在库里/)

  // 空选择是"参数说不清"，走 400
  const empty = fakeRes()
  await handlers['POST /delete']!(
    fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify({ sessionIds: [] }))),
    empty.res,
  )
  assert.equal(empty.captured.status, 400)
})

test('POST /archive：逐条调用宿主服务，部分失败不影响其余，并把失败原因摆出来', async () => {
  const sandbox = makeSandbox('web-archive')
  const calls: Array<{ op: string; id: string }> = []
  const handlers = createApiHandlers(
    deps(sandbox, {
      registryOps: () => ({
        archive: async (id: string) => {
          calls.push({ op: 'archive', id })
          if (id === 'session-busy') throw new Error('cannot archive session: the session is active (turn)')
        },
        unarchive: async (id: string) => {
          calls.push({ op: 'unarchive', id })
        },
      }),
    }),
  )

  const post = async (body: unknown): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /archive']!(fakeReq('POST', `${API_PREFIX}/archive`, Buffer.from(JSON.stringify(body))), res)
    return captured
  }

  const done = await post({ sessionIds: ['session-a', 'session-busy'], archived: true })
  assert.deepEqual(calls, [
    { op: 'archive', id: 'session-a' },
    { op: 'archive', id: 'session-busy' },
  ])
  // 一条被宿主拒了：整体报 409，但成功的那条与失败的原因都在正文里
  assert.equal(done.status, 409)
  const body = json(done)
  assert.equal(body['ok'], false)
  assert.deepEqual(body['archived'], ['session-a'])
  assert.deepEqual(body['failed'], [
    { id: 'session-busy', error: 'cannot archive session: the session is active (turn)' },
  ])
  assert.equal(body['takesEffect'], 'immediate')

  const undone = await post({ sessionIds: ['session-a'], archived: false })
  assert.equal(undone.status, 200)
  assert.equal(json(undone)['ok'], true)
  assert.deepEqual(calls[calls.length - 1], { op: 'unarchive', id: 'session-a' })
})

test('POST /archive：单独归档一条子代理被拒，点名父会话时子代理跟着一起归档', async () => {
  const sandbox = makeSandbox('web-archive-subagent')
  writeSession(sandbox.sessionsRoot, 'session-parent', CWD_A, 1000, { title: '父会话' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 2000, { origin: 'subagent', parentSession: 'session-parent' })
  const calls: Array<{ op: string; id: string }> = []
  const handlers = createApiHandlers(
    deps(sandbox, {
      registryOps: () => ({
        archive: async (id: string) => {
          calls.push({ op: 'archive', id })
        },
        unarchive: async (id: string) => {
          calls.push({ op: 'unarchive', id })
        },
      }),
    }),
  )
  const post = async (body: unknown): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /archive']!(fakeReq('POST', `${API_PREFIX}/archive`, Buffer.from(JSON.stringify(body))), res)
    return captured
  }

  // 子代理跟着父会话走：单独点它一律拒，并指名该点谁（宿主的归档服务一次都不该被调到）
  const lone = await post({ sessionIds: ['session-child'], archived: true })
  assert.equal(lone.status, 400)
  assert.match(
    String(json(lone)['error']),
    /session-child 是子代理会话（它跟着父会话走）：请改点名它的父会话 父会话（session-parent）/,
  )
  assert.deepEqual(calls, [], '被拒的请求一条都不该动')

  // 点名父会话：子代理跟着一起归档（族是一个单位）
  const family = await post({ sessionIds: ['session-parent'], archived: true })
  assert.equal(family.status, 200)
  assert.deepEqual(calls, [
    { op: 'archive', id: 'session-parent' },
    { op: 'archive', id: 'session-child' },
  ])
  assert.deepEqual(json(family)['archived'], ['session-parent', 'session-child'])
})

test('POST /archive：宿主没有 workspaceRegistry 时如实拒绝（不绕过去写注册表文件）', async () => {
  const sandbox = makeSandbox('web-archive-unavailable')
  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /archive']!(
    fakeReq('POST', `${API_PREFIX}/archive`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'] }))),
    res,
  )
  assert.equal(captured.status, 409)
  assert.match(String(json(captured)['error']), /workspaceRegistry/)
})

test('POST /rollback：删除备份走恢复（注册表不动），迁移备份照旧还原注册表', async () => {
  const sandbox = makeSandbox('web-rollback-delete')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))

  const created = fakeRes()
  await handlers['POST /delete']!(
    fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'], mode: 'apply' }))),
    created.res,
  )
  const backupDir = json(created.captured)['backupDir'] as string

  // 备份列表要能看出这份是"删除"留下的（界面据此把按钮写成「恢复」）
  const listed = fakeRes()
  await handlers['GET /backups']!(fakeReq('GET', `${API_PREFIX}/backups`), listed.res)
  const backups = json(listed.captured)['backups'] as Array<Record<string, unknown>>
  assert.equal(backups.find((backup) => backup['dir'] === backupDir)!['kind'], 'delete')

  const rolled = fakeRes()
  await handlers['POST /rollback']!(
    fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir }))),
    rolled.res,
  )
  assert.equal(rolled.captured.status, 200)
  const outcome = json(rolled.captured)
  assert.equal(outcome['registryRestored'], false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), true)
})

// ---- WebDAV 同步 ----

test('GET /state：带上同步配置的非敏感字段；没配时是 null', async () => {
  const sandbox = makeSandbox('web-sync-state')
  const plain = fakeRes()
  await createApiHandlers(deps(sandbox))['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), plain.res)
  assert.equal(json(plain.captured)['sync'], null, '没配置同步就是 null（界面据此不画那个区块）')

  const configured = fakeRes()
  await createApiHandlers(
    deps(sandbox, {
      syncInfo: () => ({ url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 2 }),
    }),
  )['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), configured.res)
  assert.deepEqual(json(configured.captured)['sync'], {
    url: 'https://dav.example.com/dsh',
    machineId: 'robot-a',
    mappings: 2,
  })
})

test('GET|POST /sync：这个宿主没配置同步时 409，且没有一个字节被写', async () => {
  const sandbox = makeSandbox('web-sync-off')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))
  for (const method of ['GET', 'POST']) {
    const { res, captured } = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq(method, `${API_PREFIX}/sync`), res)
    assert.equal(captured.status, 409)
    assert.match(String(json(captured)['error']), /没有配置 WebDAV 同步/)
  }
  // 「测试连接」走同一个 409：没有 url 就没有可探的远端（这句比"PROPFIND 失败"有用得多）。
  const probe = fakeRes()
  await handlers['GET|POST /sync']!(fakeReq('GET', `${API_PREFIX}/sync?mode=test`), probe.res)
  assert.equal(probe.captured.status, 409)
  assert.match(String(json(probe.captured)['error']), /没有配置 WebDAV 同步/)
  assert.deepEqual(readRegistry(sandbox.registryPath).tables.workspaces['ws-a']?.sessionIds, ['session-a'])
})

test('GET /sync?mode=test：只读探一次，把结论与"这次有没有凭据"一起回给界面', async () => {
  const sandbox = makeSandbox('web-sync-test')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const fixture = await startDavFixture({
    root: join(sandbox.base, 'dav'),
    auth: { username: 'webdav', password: 's3cret' },
  })
  const runtimeOf = (client: ReturnType<typeof createDavClient>, password: string | undefined) =>
    deps(sandbox, {
      sync: async () => ({
        settings: {
          url: fixture.url,
          machineId: 'robot-a',
          mapping: {},
          username: 'webdav',
          ...(password === undefined ? {} : { password }),
        },
        dav: client,
      }),
    })
  try {
    // 凭据不对：结论是 401，而"这次到底有没有密码"是另一件事——界面据此把 401 分成"还没填密码"
    // 与"服务器不认这套"，那两句的处置完全不同。
    const wrong = fakeRes()
    await createApiHandlers(runtimeOf(createDavClient({ baseUrl: fixture.url, username: 'webdav', password: 'nope' }), undefined))[
      'GET|POST /sync'
    ]!(fakeReq('GET', `${API_PREFIX}/sync?mode=test`), wrong.res)
    assert.equal(wrong.captured.status, 200)
    const denied = json(wrong.captured)
    assert.equal(denied['mode'], 'test')
    assert.equal(denied['code'], 'unauthenticated')
    assert.equal(denied['status'], 401)
    assert.equal(denied['hasPassword'], false, '这套设置里没有密码')
    assert.equal(denied['username'], 'webdav')
    assert.deepEqual(denied['machines'], [])
    assert.equal(denied['remote'] && (denied['remote'] as Record<string, unknown>)['url'], fixture.url)
    // 只读：凭据没过，第二次 PROPFIND 根本不发。
    assert.deepEqual(fixture.requests, ['PROPFIND /dav/'])

    // 凭据对了、远端还是空的：成功，且说得清"这一层还没建"。
    fixture.requests.length = 0
    const good = createDavClient({ baseUrl: fixture.url, username: 'webdav', password: 's3cret' })
    const ok = fakeRes()
    await createApiHandlers(runtimeOf(good, 's3cret'))['GET|POST /sync']!(
      fakeReq('GET', `${API_PREFIX}/sync?mode=test`),
      ok.res,
    )
    const first = json(ok.captured)
    assert.equal(first['code'], 'ok')
    assert.equal(first['namespaceExists'], false)
    assert.equal(first['hasPassword'], true)
    assert.deepEqual(fixture.requests, ['PROPFIND /dav/', `PROPFIND /dav/${SYNC_NAMESPACE_DIR}`])

    // 远端已经有机器格：报出来。
    await good.ensure(`${SYNC_NAMESPACE_DIR}/robot-a`)
    const listed = fakeRes()
    await createApiHandlers(runtimeOf(good, 's3cret'))['GET|POST /sync']!(
      fakeReq('GET', `${API_PREFIX}/sync?mode=test`),
      listed.res,
    )
    assert.deepEqual(json(listed.captured)['machines'], ['robot-a'])
    // 只读：这一轮里除了那两次 PROPFIND 与前面建目录的 MKCOL，没有 PUT / GET / DELETE。
    assert.deepEqual(
      fixture.requests.filter((line) => !line.startsWith('PROPFIND') && !line.startsWith('MKCOL')),
      [],
    )
  } finally {
    await fixture.close()
    rmSync(sandbox.base, { recursive: true, force: true })
  }
})

test('POST /sync?mode=apply：预演不落地，apply 拉下远端那条并登记进本机工作区', async () => {
  const sandbox = makeSandbox('web-sync')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const fixture = await startDavFixture({ root: join(sandbox.base, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const foreign = join(sandbox.base, 'foreign')
  mkdirSync(foreign, { recursive: true })
  const foreignRoot = join(sandbox.base, 'foreign-sessions')
  try {
    writeSession(foreignRoot, 'session-remote', foreign, 1500, { title: '远端那条' })
    await putRemoteSession(dav, 'robot-b', {
      id: 'session-remote',
      cwd: foreign,
      createdAt: 1500,
      title: '远端那条',
      logPath: join(sessionDir(foreignRoot, foreign, 'session-remote'), 'session.v4.jsonl.zstd'),
      logName: 'session.v4.jsonl.zstd',
      logVersion: 4,
    })

    const handlers = createApiHandlers(
      deps(sandbox, {
        sync: async () => ({
          settings: { url: fixture.url, machineId: 'robot-a', mapping: { [foreign]: CWD_A } },
          dav,
        }),
      }),
    )

    const preview = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq('GET', `${API_PREFIX}/sync`), preview.res)
    assert.equal(preview.captured.status, 200)
    const plan = json(preview.captured)
    assert.equal(plan['mode'], 'plan')
    assert.equal(plan['applied'], false)
    assert.deepEqual(plan['plan'] && (plan['plan'] as Record<string, unknown>)['pullIds'], ['session-remote'])
    assert.equal(
      existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-remote')),
      false,
      '预演一个字节都不落地',
    )

    const applied = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq('POST', `${API_PREFIX}/sync?mode=apply`), applied.res)
    assert.equal(applied.captured.status, 200)
    const outcome = json(applied.captured)
    assert.equal(outcome['mode'], 'apply')
    assert.equal(outcome['applied'], true)
    assert.deepEqual(outcome['pulled'], ['session-remote'])
    assert.equal(outcome['registryWritten'], true)
    // 没有 effectMode 注入时按保守说法回（"重启最稳妥"）
    assert.equal(outcome['takesEffect'], 'restart-required')

    const landed = join(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-remote'), 'session.v4.jsonl.zstd')
    const header = JSON.parse(decodeAll(readFileSync(landed)).split('\n')[0] ?? '{}') as { cwd?: string }
    assert.equal(header.cwd, CWD_A, 'cwd 要改写成这台机器的路径')
    const registry = readRegistry(sandbox.registryPath)
    assert.deepEqual([...(registry.tables.workspaces['ws-a']?.sessionIds ?? [])].sort(), ['session-a', 'session-remote'])
    assert.equal(validateRegistry(registry).ok, true, '同步完的注册表仍然满足启动不变式')
  } finally {
    await fixture.close()
    rmSync(sandbox.base, { recursive: true, force: true })
  }
})
