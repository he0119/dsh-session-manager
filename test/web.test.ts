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
  // 没注入探测函数时按"这个宿主没有目录选择器"回：界面据此不显示「浏览…」，
  // 而不是显示一个点了必被宿主以 directory-picker/unavailable 拒绝的按钮。
  assert.equal(body['pickerKind'], null)
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

test('registerWebRoutes：注册六条精确路由，方法不对回 405', async () => {
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
      `exact ${API_PREFIX}/backups`,
      `exact ${API_PREFIX}/migrate`,
      `exact ${API_PREFIX}/rollback`,
    ],
  )

  const exportRoute = routes.find((route) => route.path.endsWith('/export'))!
  const { res, captured } = fakeRes()
  await exportRoute.handler(fakeReq('GET', `${API_PREFIX}/export`), res)
  assert.equal(captured.status, 405)
  dispose()
})

// ---- 会话管理：迁移 / 备份 / 回滚 ----

test('POST /migrate：mode 缺省只预演，预演结果里带上源/目标桶与注册表变更', async () => {
  const sandbox = makeSandbox('web-migrate-plan')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

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
  // 桶名是**绝对路径**：join(会话根, projectKey(工作区目录))
  assert.equal(preview['sourceBucket'], join(sandbox.sessionsRoot, projectKey(CWD_A)))
  assert.equal(preview['targetBucket'], join(sandbox.sessionsRoot, projectKey(CWD_B)))
  assert.equal((preview['registryChange'] as Record<string, unknown>)['targetPath'], CWD_B)
  // 没注入 effectMode 时按保守说法回：注册表落盘还要重启才被承认。
  assert.equal(body['takesEffect'], 'restart-required')
  // 预演不写盘：会话还在源桶
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
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), true, '未点名的会话必须留在源桶')
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-b')), false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_B, 'session-b')), true)
  // 源工作区没被搬空 → 账本里必须还在
  assert.deepEqual(readRegistry(sandbox.registryPath).tables.workspaces['ws-a']?.sessionIds, ['session-a'])
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

  // 真的搬了：目标桶里有、源桶里没有、header.cwd 已改写
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
  // 状态问题：源桶不存在 → 409（参数没问题，是库的状态说了不行）
  const missingBucket = await post(JSON.stringify({ from: join(sandbox.base, 'ghost'), to: CWD_B }))
  assert.equal(missingBucket.status, 409)
  assert.equal(json(missingBucket)['ok'], false)
  assert.ok((json(missingBucket)['preview'] as Record<string, unknown>)['problems'])
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
