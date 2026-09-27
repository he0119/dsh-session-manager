// 界面用的宿主端点：列会话、导出、导入（预演与落地），以及各条拒绝面。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { sessionDir } from '../src/paths.ts'
import { readRegistry, validateRegistry, writeRegistryAtomic } from '../src/registry.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { API_PREFIX, createApiHandlers, registerWebRoutes, type WebRouteLike } from '../src/web.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

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

function writeSession(root: string, id: string, cwd: string, createdAt: number): void {
  const header: SessionHeader = { type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }
  const text = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'user/message', seq: 0, data: {} })}\n`
  const dir = sessionDir(root, cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat(text.split('\n').slice(0, -1).map((line) => encodeRawFrame(`${line}\n`))),
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

function deps(sandbox: Sandbox): Parameters<typeof createApiHandlers>[0] {
  return {
    paths: { sessionsRoot: sandbox.sessionsRoot, registryPath: sandbox.registryPath, backupRoot: join(sandbox.base, 'backups') },
    decodeAll,
    now: () => new Date('2026-09-27T00:00:00.000Z'),
    pluginVersion: '0.0.0-test',
  }
}

test('GET /state：列出会话与工作区，带上注册表归属', async () => {
  const sandbox = makeSandbox('web-state')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
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
  assert.equal(sessions.find((s) => s['id'] === 'session-a')!['workspaceId'], 'ws-a')
  assert.equal(sessions.find((s) => s['id'] === 'session-b')!['workspaceId'], undefined)
  const workspaces = body['workspaces'] as Array<Record<string, unknown>>
  assert.deepEqual(workspaces.map((w) => w['id']), ['ws-a'])
  assert.deepEqual(body['problems'], [])
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

test('POST /import：预演不写盘，落地后会话与注册表一起落盘', async () => {
  const source = makeSandbox('web-import-source')
  writeSession(source.sessionsRoot, 'session-a', CWD_A, 1000)
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

test('registerWebRoutes：注册三条精确路由，方法不对回 405', async () => {
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
    ],
  )

  const exportRoute = routes.find((route) => route.path.endsWith('/export'))!
  const { res, captured } = fakeRes()
  await exportRoute.handler(fakeReq('GET', `${API_PREFIX}/export`), res)
  assert.equal(captured.status, 405)
  dispose()
})
