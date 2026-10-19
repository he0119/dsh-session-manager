// 界面用的宿主端点：列会话、导出、导入（预演与落地），以及各条拒绝面。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { encodeSegment, projectionCacheDir, sessionDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry, validateRegistry, writeRegistryAtomic } from '../src/registry.ts'
import { createDavClient } from '../src/dav.ts'
import type { AttachmentPort, AttachmentRef } from '../src/attachments.ts'
import { SYNC_NAMESPACE_DIR } from '../src/sync.ts'
import type { DecodeAll, ProgressEvent, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { API_PREFIX, createApiHandlers, registerWebRoutes, type ApiDeps, type WebRouteLike } from '../src/web.ts'
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
  options: {
    title?: string
    origin?: 'subagent'
    parentSession?: string
    /** 让这条会话的日志引用一个附件对象（字节不在日志里，在附件库，见 attachments.ts）。 */
    attachment?: { ref: AttachmentRef; bytes: number }
    /** 额外的日志行（造续写 / 分叉用；seq 由调用方自己编）。 */
    eventLines?: string[]
  } = {},
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
    ...(options.attachment === undefined
      ? []
      : [
          JSON.stringify({
            type: 'user/message',
            seq: 1,
            data: {
              content: [
                {
                  type: options.attachment.ref.kind,
                  attachment: {
                    attachmentId: options.attachment.ref.id,
                    mediaType: 'image/png',
                    width: 1,
                    height: 1,
                    bytes: options.attachment.bytes,
                    name: 'image.png',
                  },
                },
              ],
            },
          }),
        ]),
    // 标题在 DSH 里是日志事件（最新一条生效），不是 header 字段——夹具得照这个样子写，
    // 否则测的就不是真实数据形状了（见 src/session-title.ts）。
    ...(options.title === undefined
      ? []
      : [JSON.stringify({ type: 'session/title', seq: 1, data: { title: options.title, source: { kind: 'fallback' } } })]),
    ...(options.eventLines ?? []),
  ]
  const dir = sessionDir(root, cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))),
  )
}

/** 内容寻址 id：与宿主 `sha256:<hex>` 同一口径。 */
function attachmentIdOf(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** 假的附件库：与宿主同形的两个目录 + 纯路径计算的端口（见 src/attachments.ts）。 */
function makeAttachmentStore(base: string): {
  root: string
  port: AttachmentPort
  put(ref: AttachmentRef, bytes: Buffer): string
} {
  const root = join(base, 'attachments')
  const pathOf = (ref: AttachmentRef): string => {
    const hex = ref.id.slice('sha256:'.length)
    // 与宿主同形：文件落在 `files/<前两位>/<sha>/<名字>`，名字缺了算不出路径。
    if (ref.kind === 'image') return join(root, 'objects', hex.slice(0, 2), hex)
    if (ref.name === undefined || ref.name === '') throw new Error('文件对象缺名字')
    return join(root, 'files', hex.slice(0, 2), hex, ref.name)
  }
  return {
    root,
    port: { pathOf },
    put(ref, bytes) {
      const path = pathOf(ref)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, bytes)
      return path
    },
  }
}

/** 写一份"事件行自己给"的日志（解析类用例要各种怪形状，`writeSession` 那几个字段不够用）。 */
function writeRawSession(
  root: string,
  id: string,
  cwd: string,
  createdAt: number,
  events: Array<unknown>,
): void {
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const lines = [
    JSON.stringify(header),
    // 字符串按原样写进去（坏行、半截 JSON 这类用例要的就是"不是合法事件"）。
    ...events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event))),
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
  let ended = false
  const push = (chunk: Buffer | string): void => {
    captured.body = Buffer.concat([captured.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
  }
  const res = {
    get headersSent(): boolean {
      return headersSent
    },
    get writableEnded(): boolean {
      return ended
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
      headersSent = true
      return res
    },
    // SSE 要的正是这两下：多次 `write` 累积成一条流，`end` 收尾。一次性响应只调用一次 `end`，
    // 语义与原来一致（原来那个实现是覆盖，这里换成追加）。
    write(chunk: Buffer | string) {
      push(chunk)
      return true
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) push(chunk)
      headersSent = true
      ended = true
    },
  }
  return { res: res as unknown as ServerResponse, captured }
}

/**
 * 把一次响应体拆成 SSE 事件（`data:` 行，事件之间空行）。
 *
 * 同步的落地那一次走的就是这个形状（见 src/web.ts 的 sendEventStream）：`progress` 每条一次、
 * `result` 收尾。
 */
function events(res: Captured): Array<Record<string, unknown>> {
  return res.body
    .toString('utf8')
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>)
}

function rawJson(res: Captured): Record<string, unknown> {
  return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
}

/**
 * 这次响应正文里"业务那一份"。
 *
 * 长动作（`/state`、`/migrate`、`/delete`、`/rollback`、`/import`、`/archive`）回的是事件流：结果在
 * 收尾那条 `{type:'result'}` 里；流开始之前就被挡下的那些错（参数不对、能力不具备）仍然是一次性
 * JSON。两种形状在这里分流一次，下面每个用例照旧只读"业务那一份"。
 */
function payload(res: Captured): Record<string, unknown> {
  const contentType = res.headers['content-type'] ?? ''
  if (!contentType.includes('text/event-stream')) return rawJson(res)
  const event = events(res).find((item) => item['type'] === 'result')
  assert.ok(event !== undefined, '事件流必须以一条 result 收尾')
  return event['result'] as Record<string, unknown>
}

/** 这次响应报的进度事件（按顺序），用来核"每段报没报、分母对不对"。 */
function progressOf(res: Captured): Array<Record<string, unknown>> {
  return events(res)
    .filter((item) => item['type'] === 'progress')
    .map((item) => item['progress'] as Record<string, unknown>)
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

/**
 * `/meta` 那七项：界面在清单回来之前要画的就是它们。
 *
 * 单独列出来是为了"两份取值必须一致"那条断言（见下面两个用例）：一组键、一处来源，漂了就红。
 */
const META_KEYS = [
  'sessionsRoot',
  'registryPath',
  'pickerKind',
  'archiveAvailable',
  'retitleAvailable',
  'attachments',
  'sync',
] as const

test('GET /meta：位置与能力位先答出来，一条会话都不读', async () => {
  const sandbox = makeSandbox('web-meta')
  // 库里真放一条会话：`/meta` 若顺手扫库，下面那两条"贵"的入口就会被调到（当场红）。
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '不该被 /meta 读到' })
  /** 扫库与问项目身份这两条路的入口被调用了几次。 */
  let touched = 0
  const handlers = createApiHandlers(
    deps(sandbox, {
      pickerKind: () => 'browse',
      registryOps: () => ({ archive: async () => {}, unarchive: async () => {} }),
      syncInfo: () => ({ url: 'https://dav.example/dsh', machineId: 'laptop', mappings: 2 }),
      // 这两条是"贵"的那两条路：`/meta` 碰它们就说明它并不便宜，所以让它当场红。
      resolveTitle: () => {
        touched += 1
        throw new Error('/meta 不该读标题')
      },
      repos: async () => {
        touched += 1
        throw new Error('/meta 不该问项目身份')
      },
    }),
  )
  const { res, captured } = fakeRes()
  await handlers['GET /meta']!(fakeReq('GET', `${API_PREFIX}/meta`), res)

  assert.equal(captured.status, 200)
  assert.deepEqual(payload(captured), {
    sessionsRoot: sandbox.sessionsRoot,
    registryPath: sandbox.registryPath,
    pickerKind: 'browse',
    archiveAvailable: true,
    // 这一处没给 `titleRefresh`（假宿主没有名称服务）：能力位按"没有"答。
    retitleAvailable: false,
    // 同理没给 `attachments`：界面据此不在"没有会话要搬"时提附件对象那一趟。
    attachments: false,
    sync: { url: 'https://dav.example/dsh', machineId: 'laptop', mappings: 2 },
  })
  assert.equal(touched, 0, '/meta 不该读标题、也不该问项目身份')

  // 库那个目录**不存在**（机器上还没建、或被删了）时照样答得出位置：这一份不依赖库能读。
  const gone = join(sandbox.base, 'gone')
  const bare = fakeRes()
  await createApiHandlers(
    deps(sandbox, { paths: { sessionsRoot: gone, registryPath: sandbox.registryPath, backupRoot: join(sandbox.base, 'backups') } }),
  )['GET /meta']!(fakeReq('GET', `${API_PREFIX}/meta`), bare.res)
  assert.equal(bare.captured.status, 200)
  assert.equal(payload(bare.captured)['sessionsRoot'], gone)
})

test('/state 与 /meta：同一批字段是同一份取值（界面按"超集"读它）', async () => {
  const sandbox = makeSandbox('web-meta-same')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  /** 两种宿主各核一遍：能力位为真与为假都要逐字相同（只核一边就抓不到"自己算一遍"那种漂）。 */
  const store = makeAttachmentStore(sandbox.base)
  const configurations: Array<{
    name: string
    archiveAvailable: boolean
    retitleAvailable: boolean
    attachments: boolean
    deps: Parameters<typeof deps>[1]
  }> = [
    {
      name: '有归档服务与 native 选择器',
      archiveAvailable: true,
      retitleAvailable: true,
      attachments: true,
      deps: {
        pickerKind: () => 'native',
        registryOps: () => ({ archive: async () => {}, unarchive: async () => {} }),
        titleRefresh: () => ({ refresh: async () => ({ status: 'unchanged', title: '随便' }) }),
        attachments: () => store.port,
        syncInfo: () => ({ url: 'https://dav.example/dsh', machineId: 'desktop', mappings: 0 }),
      },
    },
    {
      // 档案端口**在**、但它说这个宿主没有那个服务（`src/index.ts` 的探测就是这样答"没有"的）：
      // 按"端口在不在"判就把 false 算成 true 了，这一组专门拦那种写法。标题那一枚同理。
      name: '端口在、服务不在；没配同步',
      archiveAvailable: false,
      retitleAvailable: false,
      attachments: false,
      deps: {
        pickerKind: () => null,
        registryOps: () => undefined,
        titleRefresh: () => undefined,
        attachments: () => undefined,
        syncInfo: () => undefined,
      },
    },
  ]
  for (const configuration of configurations) {
    const handlers = createApiHandlers(deps(sandbox, configuration.deps))
    const call = async (suffix: string): Promise<Record<string, unknown>> => {
      const { res, captured } = fakeRes()
      await handlers[`GET ${suffix}`]!(fakeReq('GET', `${API_PREFIX}${suffix}`), res)
      return payload(captured)
    }
    const meta = await call('/meta')
    const state = await call('/state')
    assert.equal(meta['archiveAvailable'], configuration.archiveAvailable, configuration.name)
    assert.equal(meta['retitleAvailable'], configuration.retitleAvailable, configuration.name)
    // 附件库那一枚按"端口给没给"答：`attachments: () => undefined`（宿主没有这个服务）必须是 false，
    // 否则界面会对一台补不了对象的机器承诺"确认之后还会对一遍"。
    assert.equal(meta['attachments'], configuration.attachments, configuration.name)
    assert.deepEqual(
      Object.fromEntries(META_KEYS.map((key) => [key, state[key]])),
      meta,
      `/state 是 /meta 的超集：这七项必须逐字相同（${configuration.name}）`,
    )
    // 反过来：清单只在那一份里
    assert.deepEqual(meta['sessions'], undefined)
    assert.equal((state['sessions'] as unknown[]).length, 1)
  }
})

test('GET /state：列出会话与工作区，带上「未分组」的结论', async () => {
  const sandbox = makeSandbox('web-state')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '帮我安装到 web-dev 中' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_B, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)

  assert.equal(captured.status, 200)
  const body = payload(captured)
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

test('GET /state：子智能体 / 空白 / 已归档即使没在册也不是「未分组」（侧边栏从不把它们放进那一组）', async () => {
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
  const sessions = (payload(captured)['sessions'] ?? []) as Array<Record<string, unknown>>
  const byId = new Map(sessions.map((s) => [String(s['id']), s]))

  // 只有"谁都没认领 **且** 侧边栏会显示"的那条算「未分组」；它同时说明另外四条为什么不算。
  assert.deepEqual(
    sessions.filter((s) => s['ungrouped'] === true).map((s) => s['id']),
    ['session-stray'],
  )
  assert.equal(byId.get('session-a')!['ungrouped'], false, '在册的不算')
  assert.equal(byId.get('session-child')!['ungrouped'], false, '子智能体嵌在父会话下面，不在那一组里')
  assert.equal(byId.get('session-child')!['hidden'], 'subagent')
  // 界面靠这个字段把子智能体缩进到父会话的下一级（判据与删除 / 迁移的级联展开是同一个 header 字段）
  assert.equal(byId.get('session-child')!['parentSession'], 'session-a')
  assert.equal('parentSession' in byId.get('session-a')!, false, '普通会话没有这个字段（不是空串）')
  assert.equal(byId.get('session-blank')!['ungrouped'], false, '空白默认不显示')
  assert.equal(byId.get('session-archived')!['ungrouped'], false, '已归档在默认归档过滤下不显示')
})

test('GET /state：登记过、但目录已经改名的会话算「未分组」，工作区的成员表里也没有它', async () => {
  const sandbox = makeSandbox('web-state-stale-record')
  // 目录不在了（真实库里的样子：改名 / 搬走之后那条登记还留在注册表里）。这条会话的 cwd **逐字就是**
  // 那条记录的 path，但宿主建成员索引要先把它 realpath 出来——解析不出来就不算成员（见 accounting.ts）。
  const gone = join(sandbox.base, 'gone-dir')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-stale', gone, 1001)
  writeRegistryAtomic(sandbox.registryPath, {
    ...sandbox.registry,
    global: { ...sandbox.registry.global, workspaceIds: ['ws-gone', 'ws-a'] },
    tables: {
      workspaces: {
        'ws-gone': {
          ...sandbox.registry.tables.workspaces['ws-a']!,
          path: gone,
          title: 'gone',
          sessionIds: ['session-stale'],
        },
        'ws-a': { ...sandbox.registry.tables.workspaces['ws-a']!, sessionIds: ['session-a'] },
      },
    },
  })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)
  const body = payload(captured)
  const sessions = body['sessions'] as Array<Record<string, unknown>>
  const byId = new Map(sessions.map((s) => [String(s['id']), s]))
  assert.equal(byId.get('session-stale')!['ungrouped'], true, '登记还在，但目录没了：外壳那边就是「未分组」')
  assert.equal(byId.get('session-a')!['ungrouped'], false, 'cwd 解析得出来且等于记录的 path 的才是真成员')
  // 工作区那一栏报的是**认领**的那份（宿主发给渲染层的也是这份）：登记里 cwd 已经对不上的不算成员
  const workspaces = body['workspaces'] as Array<Record<string, unknown>>
  assert.deepEqual(
    workspaces.map((w) => [w['id'], w['sessionIds']]),
    [
      ['ws-gone', []],
      ['ws-a', ['session-a']],
    ],
  )
  // 目标候选靠 `exists` 把"盘上还在的"与"只剩一条登记的"分开（见 CandidatePanel）：目录没了的
  // 那条候选在界面上挂标签、点不动，不标的话两者长得一模一样、点下去只会撞上「目标工作区目录不存在」。
  assert.deepEqual(
    workspaces.map((w) => [w['id'], w['exists']]),
    [
      ['ws-gone', false],
      ['ws-a', true],
    ],
    '每条工作区各报一次"盘上还有没有这个目录"',
  )
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

  const byId = new Map((payload(captured)['sessions'] as Array<Record<string, unknown>>).map((s) => [s['id'], s]))
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
  const sessions = payload(captured)['sessions'] as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map((s) => s['id']), ['session-a'])
  assert.equal(sessions[0]!['title'], undefined)
})

test('GET /state：宿主的选择器能力种类如实透给界面（native/browse）', async () => {
  const sandbox = makeSandbox('web-picker')

  const browse = createApiHandlers({ ...deps(sandbox), pickerKind: () => 'browse' })
  const browseRes = fakeRes()
  await browse['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), browseRes.res)
  assert.equal(payload(browseRes.captured)['pickerKind'], 'browse')

  const native = createApiHandlers({ ...deps(sandbox), pickerKind: () => 'native' })
  const nativeRes = fakeRes()
  await native['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), nativeRes.res)
  assert.equal(payload(nativeRes.captured)['pickerKind'], 'native')
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

test('POST /export：单独导出子智能体被拒；点名父会话时子智能体跟着进包，条数报在响应头里', async () => {
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
  assert.match(String(payload(refused)['error']), /请改点名它的父会话 父会话（session-parent）/)

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
  const planBody = payload(planned.captured)
  assert.equal(planBody['ok'], true)
  assert.deepEqual(planBody['created'], ['session-a'])
  // 预演表里显示的是标题（id 退到悬浮提示）：它从包里的日志事件折出来，清单格式没为此改过。
  assert.equal((planBody['entries'] as Array<Record<string, unknown>>)[0]!['title'], '被导出的会话')
  assert.equal(existsSync(join(sessionDir(target.sessionsRoot, CWD_B, 'session-a'))), false, '预演不写盘')

  const applied = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${targetUrl}&mode=apply`, bundleBytes), applied.res)
  assert.equal(applied.captured.status, 200)
  const applyBody = payload(applied.captured)
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

test('POST /import：落地之后请宿主把列表元数据折出来，补不上也不影响落地', async () => {
  const source = makeSandbox('web-import-warm-source')
  writeSession(source.sessionsRoot, 'session-a', CWD_A, 1000, { title: '被导出的会话' })
  const exportHandlers = createApiHandlers(deps(source))
  const exported = fakeRes()
  await exportHandlers['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'] }))),
    exported.res,
  )
  const bundleBytes = exported.captured.body

  const target = makeSandbox('web-import-warm')
  rmSync(target.sessionsRoot, { recursive: true, force: true })
  mkdirSync(target.sessionsRoot, { recursive: true })
  writeRegistryAtomic(target.registryPath, {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  })

  // 宿主那两条服务"能调但读不动"：这一步只补派生数据，落地必须照旧算成功。
  const warmed: string[] = []
  const handlers = createApiHandlers(
    deps(target, {
      hostCheckpoints: () => ({
        warm: async (sessionId: string): Promise<void> => {
          warmed.push(sessionId)
          throw new Error('日志读不动')
        },
      }),
    }),
  )
  const applied = fakeRes()
  await handlers['POST /import']!(
    fakeReq('POST', `${API_PREFIX}/import?targetCwd=${encodeURIComponent(CWD_B)}&mode=apply`, bundleBytes),
    applied.res,
  )
  assert.equal(applied.captured.status, 200, '补不上列表元数据不该把落地说成失败')
  const body = payload(applied.captured)
  assert.deepEqual(body['written'], ['session-a'])
  assert.deepEqual(warmed, ['session-a'], '刚落地的会话要各补一次')
  assert.equal((body['warm'] as Record<string, unknown>)['failed'], 1)
  assert.match(String(body['note']), /没补上/)
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
  assert.match(String(payload(garbage.captured)['error']), /gzip/i)

  const noTarget = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${API_PREFIX}/import`, bundleBytes), noTarget.res)
  assert.equal(noTarget.captured.status, 400)

  const badTarget = fakeRes()
  await handlers['POST /import']!(
    fakeReq('POST', `${API_PREFIX}/import?targetCwd=${encodeURIComponent(join(sandbox.base, 'nowhere'))}`, bundleBytes),
    badTarget.res,
  )
  assert.equal(badTarget.captured.status, 400)
  assert.match(String(payload(badTarget.captured)['error']), /不存在/)

  // 库里已有同 id：预演 ok=false、落地也是"结果"（`ok:false` + 原话），一个字节都不覆盖。
  // 落地那份现在从事件流的 `result` 里回（流已经开始了，不能再改 HTTP 状态）。
  const conflict = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', url, bundleBytes), conflict.res)
  assert.equal(conflict.captured.status, 200)
  assert.equal(payload(conflict.captured)['ok'], false)

  const conflictApply = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${url}&mode=apply`, bundleBytes), conflictApply.res)
  assert.equal(conflictApply.captured.status, 200)
  assert.equal(
    conflictApply.captured.headers['content-type'],
    'text/event-stream; charset=utf-8',
    '落地开始干活之后回的是事件流：状态码早就发出去了，结论只能从 result 里读',
  )
  assert.equal(payload(conflictApply.captured)['ok'], false)
  // 一件都不会发生（会话都在库里、包里的附件对象本机也都有）时落地在写盘之前就被挡下。
  assert.match(String(payload(conflictApply.captured)['error']), /没有可导入的内容/)
})

test('registerWebRoutes：注册十四条精确路由，方法不对回 405', async () => {
  const sandbox = makeSandbox('web-routes')
  const routes: WebRouteLike[] = []
  const dispose = registerWebRoutes(
    { register: (route) => { routes.push(route); return () => {} } },
    deps(sandbox),
  )
  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path}`),
    [
      `exact ${API_PREFIX}/meta`,
      `exact ${API_PREFIX}/state`,
      `exact ${API_PREFIX}/transcript`,
      `exact ${API_PREFIX}/sync-diff`,
      `exact ${API_PREFIX}/export`,
      `exact ${API_PREFIX}/import`,
      // `/sync` 两种方法共用一条（宿主的 register 对重复 path 会抛错）
      `exact ${API_PREFIX}/sync`,
      // 自动推送只有一个方向（点一次就是真跑），所以是 GET 一条。
      `exact ${API_PREFIX}/auto-push`,
      `exact ${API_PREFIX}/backups`,
      `exact ${API_PREFIX}/migrate`,
      `exact ${API_PREFIX}/rollback`,
      `exact ${API_PREFIX}/delete`,
      `exact ${API_PREFIX}/archive`,
      `exact ${API_PREFIX}/retitle`,
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
  assert.match(String(payload(rejected.captured)['error']), /只接受 GET \/ POST/)
  dispose()
})

// ---- 会话管理：迁移 / 备份 / 回滚 ----

test('POST /migrate：mode 缺省只预演，预演结果里带上来源/目标项目目录与注册表变更', async () => {
  const sandbox = makeSandbox('web-migrate-plan')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '要搬走的会话' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'], to: CWD_B }))),
    res,
  )
  assert.equal(captured.status, 200)
  const body = payload(captured)
  assert.equal(body['mode'], 'plan')
  assert.equal(body['ok'], true)
  assert.equal(body['applied'], false)
  const preview = body['preview'] as Record<string, unknown>
  assert.equal((preview['sessions'] as unknown[]).length, 1)
  // 预演里也带标题：迁移页挑会话与传输页用同一套口径（标题可见、id 退到悬浮提示）。
  assert.equal((preview['sessions'] as Array<Record<string, unknown>>)[0]!['title'], '要搬走的会话')
  // 项目目录名是**绝对路径**：join(会话根, projectKey(工作区目录))；来源是**一列**（勾选可以跨目录）
  assert.deepEqual(preview['sourceProjectDirs'], [join(sandbox.sessionsRoot, projectKey(CWD_A))])
  assert.deepEqual(preview['sessionIds'], ['session-a'])
  assert.equal(preview['targetProjectDir'], join(sandbox.sessionsRoot, projectKey(CWD_B)))
  assert.equal((preview['registryChange'] as Record<string, unknown>)['targetPath'], CWD_B)
  // 没注入 effectMode 时按保守说法回：注册表落盘还要重启才被承认。
  assert.equal(body['takesEffect'], 'restart-required')
  // 预演不写盘：会话还在源项目目录
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), true)
})

test('POST /migrate：只搬点名的那些会话（源就是它们，未点名的留在原处）', async () => {
  const sandbox = makeSandbox('web-migrate-subset')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-b'], to: CWD_B })),
    ),
    res,
  )

  assert.equal(captured.status, 200)
  const body = payload(captured)
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

test('POST /migrate：宿主持着的会话不搬，预演里报出 liveSkipped（源工作区不被摘空）', async () => {
  const sandbox = makeSandbox('web-migrate-live')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)
  // 两条都登记在 ws-a 名下：被宿主持着的那条要看得出来"留在源工作区里"。
  writeRegistryAtomic(sandbox.registryPath, {
    ...sandbox.registry,
    tables: {
      workspaces: {
        'ws-a': { ...sandbox.registry.tables.workspaces['ws-a']!, sessionIds: ['session-a', 'session-b'] },
      },
    },
  })

  const handlers = createApiHandlers(deps(sandbox, { liveSessionIds: () => new Set(['session-b']) }))
  const planned = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'], to: CWD_B })),
    ),
    planned.res,
  )
  assert.equal(planned.captured.status, 200)
  const preview = payload(planned.captured)['preview'] as Record<string, unknown>
  assert.deepEqual((preview['sessions'] as { id: string }[]).map((s) => s.id), ['session-a'])
  // 界面读的就是这个字段（`preview.liveSkipped.length > 0` 才多说一句"这次没搬"）。
  assert.deepEqual((preview['liveSkipped'] as { id: string }[]).map((s) => s.id), ['session-b'])
  assert.deepEqual(preview['strandedSources'], [], '没有搬不走的隐藏会话时这一项是空的（面板照旧读它）')
  assert.match(String(payload(planned.captured)['summary']), /另有 1 条会话宿主持在内存里/)

  const applied = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-a', 'session-b'], to: CWD_B })),
    ),
    applied.res,
  )
  assert.equal(applied.captured.status, 200)
  assert.equal(payload(applied.captured)['applied'], true)
  // 活会话的日志一个字节都不许动，归属也留在源工作区（源工作区因此不会被删掉）
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-b')), true)
  assert.deepEqual(readRegistry(sandbox.registryPath).tables.workspaces['ws-a']?.sessionIds, ['session-b'])
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_B, 'session-b')), false)

  // 只点名那条活着的：计划层说清"全在宿主手里、重启再迁"，而不是含糊的"没选中会话"。
  //
  // 这一条**依旧不用 409**：干活那一段是事件流，状态码在第一条事件之前就发出去了。结论落在 `result`
  // 的正文里（与"目标目录不存在"那条同一个理由）。
  const named = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ sessionIds: ['session-b'], to: CWD_B }))),
    named.res,
  )
  assert.equal(named.captured.status, 200)
  assert.equal(payload(named.captured)['ok'], false)
  assert.match((payload(named.captured)['problems'] as string[]).join('; '), /every ticked session is live in the host/)
  assert.match((payload(named.captured)['problems'] as string[]).join('; '), /restart DSH, then migrate them/)
})

test('POST /migrate：侧边栏不显示的会话搬不走、源工作区因此留着，预演里报出 strandedSources', async () => {
  const sandbox = makeSandbox('web-migrate-stranded')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-blank', CWD_A, 2000)
  // 宿主判这条"一个回合都没开始过"（空白会话，侧边栏不显示）——判据在投影缓存里，见 visibility.ts。
  const cacheDir = projectionCacheDir(sandbox.registryPath)
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, `${encodeSegment('session-blank')}.json`),
    JSON.stringify({
      record: { identity: { createdAt: 2000, cwd: CWD_A }, rows: { sessionListMetadata: { val: { blank: true } } } },
    }),
  )
  writeRegistryAtomic(sandbox.registryPath, {
    ...sandbox.registry,
    tables: {
      workspaces: {
        'ws-a': { ...sandbox.registry.tables.workspaces['ws-a']!, sessionIds: ['session-a', 'session-blank'] },
      },
    },
  })

  const handlers = createApiHandlers(deps(sandbox))
  const planned = fakeRes()
  // 只勾看得见的那条：空白会话那一行在界面上是灰的（勾不动），它因此留在源工作区里。
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'], to: CWD_B }))),
    planned.res,
  )
  assert.equal(planned.captured.status, 200)
  const body = payload(planned.captured)
  const preview = body['preview'] as Record<string, unknown>
  assert.deepEqual((preview['sessions'] as { id: string }[]).map((s) => s.id), ['session-a'])
  // 界面读的就是这个字段（`preview.strandedSources.length > 0` 才多说一句"那块工作区不会被删"）。
  assert.deepEqual(
    (preview['strandedSources'] as Array<{ members: Array<{ id: string; reason: string }> }>).map((source) =>
      source.members.map((member) => `${member.id}:${member.reason}`),
    ),
    [['session-blank:blank']],
  )
  assert.match(String(body['summary']), /另有 1 条会话侧边栏不显示（空白 1），这次不搬：session-blank/)
  assert.match(String(body['summary']), /那几块工作区因此不会被删/)

  const applied = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-a'], to: CWD_B })),
    ),
    applied.res,
  )
  assert.equal(applied.captured.status, 200)
  assert.equal(payload(applied.captured)['applied'], true)
  // 搬不走的留在原处、归属不变：源工作区记录因此还在（这正是用户看见的那块"残留工作区"）。
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-blank')), true)
  assert.deepEqual(readRegistry(sandbox.registryPath).tables.workspaces['ws-a']?.sessionIds, ['session-blank'])
})

test('POST /migrate：勾中的父会话把子智能体一起带走，条数报在 cascaded 里（界面据此说明）', async () => {
  const sandbox = makeSandbox('web-migrate-family')
  writeSession(sandbox.sessionsRoot, 'session-parent', CWD_A, 1000, { title: '父会话' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 1001, { origin: 'subagent', parentSession: 'session-parent' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ sessionIds: ['session-parent'], to: CWD_B })),
    ),
    res,
  )

  assert.equal(captured.status, 200)
  const body = payload(captured)
  const preview = body['preview'] as Record<string, unknown>
  const sessions = preview['sessions'] as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map((s) => s['id']), ['session-parent', 'session-child'])
  // 界面读的就是这个字段：`cascaded > 0` 才多说一句"其中 N 条是子智能体会话"
  assert.equal(preview['cascaded'], 1)
  // `via` 带着点名那条的标题（有标题时界面用它认人，没有就退到 id）
  assert.deepEqual(sessions[1]!['via'], { id: 'session-parent', title: '父会话' }, '子智能体要带着"是谁把它牵进来的"')
  assert.equal(sessions[1]!['registered'], false)
  // 级联不改变成员资格：只有点名的父会话进目标工作区
  assert.deepEqual((preview['registryChange'] as Record<string, unknown>)['added'], ['session-parent'])
})

test('POST /migrate：来源目录已经被删掉也照旧能迁（少了 sessionIds 就 400）', async () => {
  const sandbox = makeSandbox('web-migrate-deleted-source')
  // 项目文件夹**已经被删掉**（这个路径从来没建过），会话与日志都还在库里：header 里的 cwd 还是它。
  // 外壳侧边栏把这批会话显示在「未分组」那一组里，而这只是标签——勾上它们照旧能迁。
  const gone = join(import.meta.dirname, '.sandbox', 'web-gone-project')
  rmSync(gone, { recursive: true, force: true })
  writeSession(sandbox.sessionsRoot, 'session-a', gone, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', gone, 2000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'], to: CWD_B })),
    ),
    res,
  )
  assert.equal(captured.status, 200)
  const preview = payload(captured)['preview'] as Record<string, unknown>
  assert.deepEqual(preview['sessionIds'], ['session-a', 'session-b'])
  assert.deepEqual(preview['sourceProjectDirs'], [join(sandbox.sessionsRoot, projectKey(gone))])
  assert.deepEqual((preview['sessions'] as { id: string }[]).map((s) => s.id).sort(), ['session-a', 'session-b'])
  // 来源目录本身不在盘上这件事不该被当成问题：日志与 header 里的 cwd 都还在。
  assert.equal(payload(captured)['ok'], true)
  // 预演不写盘
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, gone, 'session-b')), true)

  // 少了 sessionIds：400 —— 源只有"点名了哪几条"这一条路（空数组同理）。
  for (const body of [{ to: CWD_B }, { to: CWD_B, sessionIds: [] }]) {
    const denied = fakeRes()
    await handlers['POST /migrate']!(
      fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify(body))),
      denied.res,
    )
    assert.equal(denied.captured.status, 400)
    assert.match(String((payload(denied.captured) as Record<string, unknown>)['error']), /缺少要迁移的会话/)
  }
})

test('POST /migrate：勾选跨目录——两个来源目录里的会话一次搬到同一个目标', async () => {
  const sandbox = makeSandbox('web-migrate-cross-dir')
  const otherDir = join(sandbox.base, 'other')
  mkdirSync(otherDir, { recursive: true })
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-c', otherDir, 3000)

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq(
      'POST',
      `${API_PREFIX}/migrate`,
      Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-a', 'session-c'], to: CWD_B })),
    ),
    res,
  )

  assert.equal(captured.status, 200)
  const body = payload(captured)
  assert.equal(body['applied'], true)
  const preview = body['preview'] as Record<string, unknown>
  // 两个来源目录都报出来（按路径排序），目标只有一个
  assert.deepEqual(
    preview['sourceProjectDirs'],
    [join(sandbox.sessionsRoot, projectKey(CWD_A)), join(sandbox.sessionsRoot, projectKey(otherDir))].sort(),
  )
  assert.equal(preview['targetProjectDir'], join(sandbox.sessionsRoot, projectKey(CWD_B)))
  // 两条各自从自己的目录搬进目标项目目录，header 的 cwd 都改成目标
  for (const id of ['session-a', 'session-c']) {
    const dir = sessionDir(sandbox.sessionsRoot, CWD_B, id)
    assert.equal(existsSync(dir), true, `${id} 该落在目标项目目录里`)
    const header = JSON.parse(decodeAll(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as {
      cwd?: string
    }
    assert.equal(header.cwd, CWD_B)
  }
  // 两个来源项目目录都被搬空 → 都清掉
  assert.equal(existsSync(join(sandbox.sessionsRoot, projectKey(CWD_A))), false)
  assert.equal(existsSync(join(sandbox.sessionsRoot, projectKey(otherDir))), false)
  // 注册表：两条都挂到目标工作区（ws-a 被摘空后删掉）
  const registry = readRegistry(sandbox.registryPath)
  assert.equal(registry.tables.workspaces['ws-a'], undefined)
  assert.deepEqual(
    Object.values(registry.tables.workspaces).flatMap((record) => record.sessionIds).sort(),
    ['session-a', 'session-c'],
  )
})

/**
 * 一个"像真宿主"的假宿主：工作区按路径复用、挂/摘真的改成员表。
 *
 * 它**不写文件**——文件那一步仍由插件自己走（这正是要测的接缝）。`onRefresh` 拿来做台账：
 * 记下的必须是"那一刻文件里的归属"，才说明刷新发生在落盘之后。
 */
function fakeHostPort(options: { onRefresh?: (registryPath: string) => void; attachFails?: boolean } = {}): ApiDeps['hostRegistry'] {
  const workspaces = new Map<string, { id: string; path: string; sessionIds: string[] }>()
  let minted = 0
  return () => ({
    refreshIndex: async () => {},
    ensureWorkspace: async (path: string) => {
      for (const rec of workspaces.values()) if (rec.path === path) return rec.id
      minted += 1
      const id = `ws-host-${minted}`
      workspaces.set(id, { id, path, sessionIds: [] })
      return id
    },
    attachSession: async (workspaceId: string, sessionId: string) => {
      if (options.attachFails === true) throw new Error('夹具：挂靠失败')
      const rec = workspaces.get(workspaceId)
      if (rec !== undefined && !rec.sessionIds.includes(sessionId)) rec.sessionIds.push(sessionId)
    },
    detachSession: async (workspaceId: string, sessionId: string) => {
      const rec = workspaces.get(workspaceId)
      if (rec !== undefined) rec.sessionIds = rec.sessionIds.filter((s) => s !== sessionId)
    },
    members: async (workspaceId: string) => [...(workspaces.get(workspaceId)?.sessionIds ?? [])],
    removeWorkspace: async (workspaceId: string) => {
      workspaces.delete(workspaceId)
    },
  })
}

test('POST /migrate：mode=apply 真搬并回可回滚的备份；有那套动作时由宿主自己改', async () => {
  const sandbox = makeSandbox('web-migrate-apply')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

  // 台账：刷新必须在注册表落盘之后才发生，所以这里顺手记下那一刻文件里的归属。
  const calls: string[] = []
  const host = fakeHostPort()
  const base = host!()!
  // 包一层，只为了在"重看磁盘"那一刻记一笔。
  const port: NonNullable<ApiDeps['hostRegistry']> = () => ({
    ...base,
    refreshIndex: async (): Promise<void> => {
      const registry = readRegistry(sandbox.registryPath)
      const target = Object.values(registry.tables.workspaces).find((record) => record.path === CWD_B)
      calls.push(target?.sessionIds.join(',') ?? '没有 CWD_B 的工作区记录')
    },
  })
  const handlers = createApiHandlers({ ...deps(sandbox), hostRegistry: port })
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-a'], to: CWD_B }))),
    res,
  )
  assert.equal(captured.status, 200)
  const body = payload(captured)
  assert.equal(body['mode'], 'apply')
  assert.equal(body['applied'], true)
  assert.equal(body['verified'], true, `复核应当通过：${JSON.stringify(body['problems'])}`)
  assert.equal(body['rewritten'], 1)
  assert.equal(body['moved'], 1)
  assert.equal(body['takesEffect'], 'immediate')
  assert.equal(typeof body['backupDir'], 'string')
  assert.deepEqual(calls, ['session-a'], '刷新要真的发生，且发生在注册表落盘之后')
  assert.match(String(body['summary']), /无需重启 DSH/)

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
  const listed = payload(backups.captured)['backups'] as Array<Record<string, unknown>>
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.['sessions'], 1)
  assert.equal(listed[0]?.['from'], CWD_A)
  assert.equal(listed[0]?.['to'], CWD_B)
})

test('POST /migrate：宿主没接住时如实报"需要重启"，而不是照探测说无需重启', async () => {
  const sandbox = makeSandbox('web-migrate-effect-fail')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

  let calls = 0
  const host = fakeHostPort()
  const base = host!()!
  const handlers = createApiHandlers({
    ...deps(sandbox),
    // 探测说有那套动作（否则 `takesEffect` 本来就该是 restart-required），但真跑起来会失败。
    hostRegistry: () => ({
      ...base,
      refreshIndex: async (): Promise<void> => {
        calls += 1
        throw new Error('夹具：宿主没接住')
      },
    }),
  })
  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-a'], to: CWD_B }))),
    res,
  )
  assert.equal(captured.status, 200)
  const body = payload(captured)
  assert.equal(calls, 1, '要真的试过才谈得上"失败"')
  assert.equal(body['applied'], true, '宿主没接住不该把迁移说成失败')
  assert.equal(body['verified'], true)
  assert.equal(body['takesEffect'], 'restart-required', '界面能说的"无需重启"必须来自真实结果')
  assert.match(String(body['summary']), /宿主没接住这次改动（夹具：宿主没接住）/)
})

test('POST /rollback：先 dryRun 看动作，再真回滚到原状', async () => {
  const sandbox = makeSandbox('web-rollback')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

  const handlers = createApiHandlers(deps(sandbox))
  const migrateRes = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ mode: 'apply', sessionIds: ['session-a'], to: CWD_B }))),
    migrateRes.res,
  )
  const backupDir = payload(migrateRes.captured)['backupDir'] as string
  assert.ok(backupDir)

  // dry-run：给动作清单，但不写
  const dry = fakeRes()
  await handlers['POST /rollback']!(
    fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir, dryRun: true }))),
    dry.res,
  )
  assert.equal(dry.captured.status, 200)
  assert.equal(payload(dry.captured)['dryRun'], true)
  assert.ok((payload(dry.captured)['actions'] as unknown[]).length > 0)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_B, 'session-a')), true, 'dry-run 不该动目录')

  // 真回滚
  const done = fakeRes()
  await handlers['POST /rollback']!(
    fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir }))),
    done.res,
  )
  assert.equal(done.captured.status, 200)
  assert.equal(payload(done.captured)['dryRun'], false)
  assert.equal(payload(done.captured)['restoredFiles'], 1)
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
  assert.match(String(payload(await post(JSON.stringify({ to: CWD_B })))['error']), /缺少要迁移的会话/)
  assert.match(
    String(payload(await post(JSON.stringify({ sessionIds: ['session-a'], to: join(sandbox.base, 'nope') })))['error']),
    /目标工作区目录不存在/,
  )
  // 状态问题：点名的那条不在库里 → 计划本身 ok=false（参数没问题，是库的状态说了不行）。
  //
  // 这一条**不再用 409**：干活那一段是事件流，状态码在第一条事件之前就发出去了。结论因此落在
  // `result` 的正文里（`ok` 与 `preview.problems` 与原来那份一字不差），界面读的就是它。
  const missingProjectDir = await post(JSON.stringify({ sessionIds: ['session-ghost'], to: CWD_B }))
  assert.equal(missingProjectDir.status, 200)
  assert.equal(
    missingProjectDir.headers['content-type'],
    'text/event-stream; charset=utf-8',
    '流一旦开始，HTTP 状态就固定了；"计划有问题"是结果，不是传输层的错',
  )
  assert.equal(payload(missingProjectDir)['ok'], false)
  assert.ok((payload(missingProjectDir)['preview'] as Record<string, unknown>)['problems'])
})

test('POST /rollback：只认本插件备份根下的目录', async () => {
  const sandbox = makeSandbox('web-rollback-guard')
  const handlers = createApiHandlers(deps(sandbox))

  const post = async (body: unknown): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /rollback']!(fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify(body))), res)
    return captured
  }

  assert.match(String(payload(await post({}))['error']), /缺少备份目录/)
  assert.match(String(payload(await post({ backupDir: sandbox.base }))['error']), /不在本插件的备份根下/)
  const empty = join(sandbox.base, 'backups', 'empty')
  mkdirSync(empty, { recursive: true })
  assert.match(String(payload(await post({ backupDir: empty }))['error']), /没有 manifest\.json/)
})

// ---- 会话管理：可见性字段 / 删除 / 归档 ----

test('GET /state：会话行带上"侧边栏为什么不显示"，以及归档能力位', async () => {
  const sandbox = makeSandbox('web-state-visibility')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  // 子智能体会话：header 里带 origin，侧边栏把它嵌在父会话下面
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

  const body = payload(captured)
  const rows = new Map((body['sessions'] as Array<Record<string, unknown>>).map((row) => [row['id'], row]))
  // 已归档（缓存里 blank: false，所以理由只能是归档）
  assert.equal(rows.get('session-a')!['hidden'], 'archived')
  assert.equal(rows.get('session-a')!['archived'], true)
  assert.equal(rows.get('session-a')!['blank'], false)
  // 子智能体：理由来自 header，先于归档判
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
  assert.equal(payload(captured)['archiveAvailable'], true)
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
  const planBody = payload(planned)
  assert.equal(planBody['mode'], 'plan')
  assert.equal(planBody['applied'], false)
  const preview = planBody['preview'] as Record<string, unknown>
  assert.deepEqual((preview['entries'] as Array<Record<string, unknown>>).map((entry) => entry['id']), ['session-a'])
  assert.equal((preview['entries'] as Array<Record<string, unknown>>)[0]!['title'], '不要了的会话')
  assert.equal((preview['entries'] as Array<Record<string, unknown>>)[0]!['dir'], dir)
  assert.equal(existsSync(dir), true, '预演不许动磁盘')

  const applied = await post({ sessionIds: ['session-a'], mode: 'apply' })
  assert.equal(applied.status, 200)
  const applyBody = payload(applied)
  assert.equal(applyBody['applied'], true)
  assert.equal(applyBody['verified'], true)
  assert.match(String(applyBody['summary']), /已删除 1 个会话/)
  assert.equal(typeof applyBody['backupDir'], 'string')
  assert.equal(existsSync(dir), false, '落地之后会话目录该没了')
  // 备份落在本插件的备份根下（「备份与回滚」那张卡读的就是它）
  assert.equal(existsSync(applyBody['backupDir'] as string), true)
})

test('POST /delete：删父会话时把子智能体一起带上，预演里带着出处字段', async () => {
  const sandbox = makeSandbox('web-delete-family')
  writeSession(sandbox.sessionsRoot, 'session-parent', CWD_A, 1000, { title: '父会话' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 2000, { title: '子智能体', origin: 'subagent', parentSession: 'session-parent' })

  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['POST /delete']!(
    fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify({ sessionIds: ['session-parent'], mode: 'plan' }))),
    res,
  )
  assert.equal(captured.status, 200)
  const preview = payload(captured)['preview'] as Record<string, unknown>
  // 界面读的就是这几个字段（见 src/client/api.ts 的 DeleteEntry）：条数、级联计数与"跟着谁来的"
  assert.equal(preview['cascaded'], 1)
  const entries = preview['entries'] as Array<Record<string, unknown>>
  assert.deepEqual(entries.map((entry) => entry['id']), ['session-parent', 'session-child'])
  assert.equal(entries[0]!['via'], undefined)
  assert.deepEqual(entries[1]!['via'], { id: 'session-parent', title: '父会话' })
  assert.equal(entries[1]!['origin'], 'subagent')
  assert.match(String(payload(captured)['summary']), /其中 1 条是子智能体会话/)
})

test('POST /delete：状态不允许（会话不在库里）时把完整计划带回来', async () => {
  const sandbox = makeSandbox('web-delete-guard')
  const handlers = createApiHandlers(deps(sandbox))

  const { res, captured } = fakeRes()
  await handlers['POST /delete']!(
    fakeReq('POST', `${API_PREFIX}/delete`, Buffer.from(JSON.stringify({ sessionIds: ['session-ghost'], mode: 'apply' }))),
    res,
  )
  // 与 /migrate 同一套：落地那条路是事件流，状态码发在结果之前，所以"计划不 ok"落在正文里。
  assert.equal(captured.status, 200)
  const body = payload(captured)
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
  // 一条被宿主拒了：整体 `ok:false`，但成功的那条与失败的原因都在正文里（逐条报进度的那条流
  // 以 `result` 收尾，部分失败同样是"结果"而不是传输层的错）。
  assert.equal(done.status, 200)
  const body = payload(done)
  assert.equal(body['ok'], false)
  assert.deepEqual(body['archived'], ['session-a'])
  assert.deepEqual(body['failed'], [
    { id: 'session-busy', error: 'cannot archive session: the session is active (turn)' },
  ])
  assert.equal(body['takesEffect'], 'immediate')
  // 逐条报进度：分母是这次点名的条数，`done` 是"已经做完的条数"。
  assert.deepEqual(progressOf(done), [
    { phase: 'archive', total: 2, done: 0, id: 'session-a' },
    { phase: 'archive', total: 2, done: 1, id: 'session-busy' },
  ])

  const undone = await post({ sessionIds: ['session-a'], archived: false })
  assert.equal(undone.status, 200)
  assert.equal(payload(undone)['ok'], true)
  assert.deepEqual(calls[calls.length - 1], { op: 'unarchive', id: 'session-a' })
})

test('POST /archive：单独归档一条子智能体被拒，点名父会话时子智能体跟着一起归档', async () => {
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

  // 子智能体跟着父会话走：单独点它一律拒，并指名该点谁（宿主的归档服务一次都不该被调到）
  const lone = await post({ sessionIds: ['session-child'], archived: true })
  assert.equal(lone.status, 400)
  assert.match(
    String(payload(lone)['error']),
    /session-child 是子智能体会话（它跟着父会话走）：请改点名它的父会话 父会话（session-parent）/,
  )
  assert.deepEqual(calls, [], '被拒的请求一条都不该动')

  // 点名父会话：子智能体跟着一起归档（族是一个单位）
  const family = await post({ sessionIds: ['session-parent'], archived: true })
  assert.equal(family.status, 200)
  assert.deepEqual(calls, [
    { op: 'archive', id: 'session-parent' },
    { op: 'archive', id: 'session-child' },
  ])
  assert.deepEqual(payload(family)['archived'], ['session-parent', 'session-child'])
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
  assert.match(String(payload(captured)['error']), /workspaceRegistry/)
})

test('POST /retitle：逐条请宿主的名称服务重算，跳过与失败分开报，子智能体不惊动宿主', async () => {
  const sandbox = makeSandbox('web-retitle')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '兜底名称' })
  writeSession(sandbox.sessionsRoot, 'session-pinned', CWD_A, 2000, { title: '我自己改的名字' })
  writeSession(sandbox.sessionsRoot, 'session-broken', CWD_A, 3000, { title: '会失败的那条' })
  writeSession(sandbox.sessionsRoot, 'session-child', CWD_A, 4000, {
    origin: 'subagent',
    parentSession: 'session-a',
    title: '子会话',
  })
  /** 宿主那一侧被真正问到的 id：子智能体与不在库里的都不该出现在这里。 */
  const asked: string[] = []
  /** 每次请宿主重算时带的选项：`includePinned` 是接口显式传进来的（默认 false）。 */
  const options: Array<{ includePinned?: boolean } | undefined> = []
  const handlers = createApiHandlers(
    deps(sandbox, {
      titleRefresh: () => ({
        refresh: async (id: string, given?: { includePinned?: boolean }) => {
          asked.push(id)
          options.push(given)
          if (id === 'session-pinned') return { status: 'skipped', reason: 'pinned' }
          if (id === 'session-broken') throw new Error('session-title-llm: 模型调用超时')
          return { status: 'retitled', title: `新标题：${id}` }
        },
      }),
    }),
  )
  const post = async (body: unknown): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /retitle']!(fakeReq('POST', `${API_PREFIX}/retitle`, Buffer.from(JSON.stringify(body))), res)
    return captured
  }

  const done = await post({
    sessionIds: ['session-a', 'session-child', 'session-pinned', 'session-broken', 'session-gone'],
  })
  assert.equal(done.status, 200)
  const body = payload(done)
  // 有失败项时整体 ok 为 false，但成功的与跳过的都照原样在正文里（部分失败同样是"结果"）。
  assert.equal(body['ok'], false)
  assert.deepEqual(body['retitled'], [{ id: 'session-a', title: '新标题：session-a' }])
  assert.deepEqual(body['unchanged'], [])
  assert.deepEqual(body['skipped'], [
    { id: 'session-child', reason: 'subagent' },
    { id: 'session-pinned', reason: 'pinned' },
    { id: 'session-gone', reason: 'not-found' },
  ])
  assert.deepEqual(body['failed'], [{ id: 'session-broken', error: 'session-title-llm: 模型调用超时' }])
  assert.deepEqual(asked, ['session-a', 'session-pinned', 'session-broken'], '子智能体与不在库里的不该惊动宿主')
  // 逐条报进度：分母是这次点名的条数，`done` 是"已经做完的条数"。
  assert.deepEqual(progressOf(done), [
    { phase: 'retitle', total: 5, done: 0, id: 'session-a', label: '兜底名称' },
    { phase: 'retitle', total: 5, done: 1, id: 'session-child', label: '子会话' },
    { phase: 'retitle', total: 5, done: 2, id: 'session-pinned', label: '我自己改的名字' },
    { phase: 'retitle', total: 5, done: 3, id: 'session-broken', label: '会失败的那条' },
    { phase: 'retitle', total: 5, done: 4, id: 'session-gone' },
  ])
  assert.deepEqual(
    options,
    [{ includePinned: false }, { includePinned: false }, { includePinned: false }],
    '界面那条路（不带 includePinned）永远是明确的 false',
  )

  // 一次性清理走的那条路：正文里显式写 `includePinned: true`，逐条原样转给宿主。
  const forced = await post({ sessionIds: ['session-pinned'], includePinned: true })
  assert.equal(forced.status, 200)
  assert.deepEqual(payload(forced)['skipped'], [{ id: 'session-pinned', reason: 'pinned' }])
  assert.deepEqual(options[options.length - 1], { includePinned: true })
  // 只有显式 `true` 才算：字符串 'true'、1 这类都不该被当成打开。
  await post({ sessionIds: ['session-pinned'], includePinned: 'true' })
  assert.deepEqual(options[options.length - 1], { includePinned: false })
})

test('POST /retitle：空清单回 400，正文不是 JSON 回 400，宿主没有名称服务回 409', async () => {
  const sandbox = makeSandbox('web-retitle-refusals')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)

  const bare = createApiHandlers(deps(sandbox))
  const call = async (handler: ReturnType<typeof createApiHandlers>, raw: string): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handler['POST /retitle']!(fakeReq('POST', `${API_PREFIX}/retitle`, Buffer.from(raw)), res)
    return captured
  }

  const empty = await call(bare, JSON.stringify({ sessionIds: [] }))
  assert.equal(empty.status, 400)
  assert.match(String(payload(empty)['error']), /至少一个会话/)

  const broken = await call(bare, '{ 这不是 JSON')
  assert.equal(broken.status, 400)
  assert.match(String(payload(broken)['error']), /不是合法 JSON/)

  // 端口**在**但说这个宿主没有那套服务（`src/index.ts` 的探测就是这样答"没有"的）：如实拒绝，
  // 而不是逐条去试、把"这个宿主没有这个能力"说成五条失败。
  const withoutService = createApiHandlers(deps(sandbox, { titleRefresh: () => undefined }))
  const refused = await call(withoutService, JSON.stringify({ sessionIds: ['session-a'] }))
  assert.equal(refused.status, 409)
  assert.match(String(payload(refused)['error']), /没有会话名称服务/)
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
  const backupDir = payload(created.captured)['backupDir'] as string

  // 备份列表要能看出这份是"删除"留下的（界面据此把按钮写成「恢复」）
  const listed = fakeRes()
  await handlers['GET /backups']!(fakeReq('GET', `${API_PREFIX}/backups`), listed.res)
  const backups = payload(listed.captured)['backups'] as Array<Record<string, unknown>>
  assert.equal(backups.find((backup) => backup['dir'] === backupDir)!['kind'], 'delete')

  const rolled = fakeRes()
  await handlers['POST /rollback']!(
    fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir }))),
    rolled.res,
  )
  assert.equal(rolled.captured.status, 200)
  const outcome = payload(rolled.captured)
  assert.equal(outcome['registryRestored'], false)
  assert.equal(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-a')), true)
})

// ---- WebDAV 同步 ----

test('GET /state：带上同步配置的非敏感字段；没配时是 null', async () => {
  const sandbox = makeSandbox('web-sync-state')
  const plain = fakeRes()
  await createApiHandlers(deps(sandbox))['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), plain.res)
  assert.equal(payload(plain.captured)['sync'], null, '没配置同步就是 null（界面据此不画那个区块）')

  const configured = fakeRes()
  await createApiHandlers(
    deps(sandbox, {
      syncInfo: () => ({ url: 'https://dav.example.com/dsh', machineId: 'robot-a', mappings: 2 }),
    }),
  )['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), configured.res)
  assert.deepEqual(payload(configured.captured)['sync'], {
    url: 'https://dav.example.com/dsh',
    machineId: 'robot-a',
    mappings: 2,
  })
})

test('GET /state：目录带项目身份，只问界面上真会出现的那些目录', async () => {
  const sandbox = makeSandbox('web-state-repos')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_B, 2000)
  const asked: string[][] = []
  const handlers = createApiHandlers(
    deps(sandbox, {
      repos: async (dirs) => {
        asked.push([...dirs])
        return new Map([[CWD_A, 'github.com/he0119/demo']])
      },
    }),
  )
  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)
  assert.deepEqual(payload(captured)['repos'], { [CWD_A]: 'github.com/he0119/demo' })
  // 问的是"会话的 cwd + 注册表里的工作区路径"（这里 CWD_A 两处都有，只问一次），不是库里的每个目录
  assert.equal(asked.length, 1)
  assert.deepEqual(asked[0]!.slice().sort(), [CWD_A, CWD_B].sort())

  // 没注入这个入口（旧宿主、没装 git 的机器）：空表，界面退回显示路径
  const plain = fakeRes()
  await createApiHandlers(deps(sandbox))['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), plain.res)
  assert.deepEqual(payload(plain.captured)['repos'], {})
})

test('GET|POST /sync：这个宿主没配置同步时 409，且没有一个字节被写', async () => {
  const sandbox = makeSandbox('web-sync-off')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))
  for (const method of ['GET', 'POST']) {
    const { res, captured } = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq(method, `${API_PREFIX}/sync`), res)
    assert.equal(captured.status, 409)
    assert.match(String(payload(captured)['error']), /没有配置 WebDAV 同步/)
  }
  // 「测试连接」走同一个 409：没有 url 就没有可探的远端（这句比"PROPFIND 失败"有用得多）。
  const probe = fakeRes()
  await handlers['GET|POST /sync']!(fakeReq('GET', `${API_PREFIX}/sync?mode=test`), probe.res)
  assert.equal(probe.captured.status, 409)
  assert.match(String(payload(probe.captured)['error']), /没有配置 WebDAV 同步/)
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
    const denied = payload(wrong.captured)
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
    const first = payload(ok.captured)
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
    assert.deepEqual(payload(listed.captured)['machines'], ['robot-a'])
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

test('POST /sync?mode=apply：预演不落地，apply 走事件流拉取远端那条并登记进本机工作区', async () => {
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
    assert.equal(
      preview.captured.headers['content-type'],
      'text/event-stream; charset=utf-8',
      '预演也走事件流：它要扫本机、读远端、逐条比对，冷的时候几秒，界面得说出做到哪儿了',
    )
    const previewStream = events(preview.captured)
    assert.deepEqual(
      previewStream.map((event) => event['type']),
      ['progress', 'progress', 'result'],
      '预演报的是算计划的三段：扫本机的 1 条、读远端索引 1 条，再收尾',
    )
    assert.deepEqual(
      previewStream.filter((event) => event['type'] === 'progress').map((event) => event['progress']),
      [
        { phase: 'scan', total: 1, done: 0 },
        { phase: 'remote', total: 0, done: 0 },
      ],
      '读远端索引那一段没有分母（total: 0）：界面只说"正在读取远端索引…"。预演没有 pull/push——那两段要真写盘；本机与远端没有同 id 的会话，比对那段一个文件都不用读',
    )
    const plan = previewStream.find((event) => event['type'] === 'result')?.['result'] as Record<string, unknown>
    assert.equal(plan['mode'], 'plan')
    assert.equal(plan['applied'], false)
    assert.deepEqual(plan['plan'] && (plan['plan'] as Record<string, unknown>)['pullIds'], ['session-remote'])
    assert.equal(
      existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-remote')),
      false,
      '预演一个字节都不落地',
    )
    // 预演也要回答"这次落地之后要不要重启"：判据是宿主端口的探测（这个宿主没有那套动作），而不是
    // "这次什么都没干"。界面的确认弹窗就靠它在按下确认之前先把这句话说出来。
    assert.equal(plan['takesEffect'], 'restart-required', '预演就把"落地后要重启"说清楚')

    const applied = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq('POST', `${API_PREFIX}/sync?mode=apply`), applied.res)
    assert.equal(applied.captured.status, 200)
    assert.equal(
      applied.captured.headers['content-type'],
      'text/event-stream; charset=utf-8',
      '落地那一次是事件流（界面靠它显示"正在推送 12 / 84"）',
    )
    const stream = events(applied.captured)
    assert.deepEqual(
      stream.map((event) => event['type']),
      ['progress', 'progress', 'progress', 'progress', 'result'],
      '先报算计划的三段（扫本机、读远端索引），再报拉取与推送各一条，最后收尾',
    )
    assert.deepEqual(
      stream.filter((event) => event['type'] === 'progress').map((event) => event['progress']),
      [
        { phase: 'scan', total: 1, done: 0 },
        { phase: 'remote', total: 0, done: 0 },
        { phase: 'pull', total: 1, done: 0, id: 'session-remote', label: '远端那条' },
        { phase: 'push', total: 1, done: 0, id: 'session-a', label: 'session-a' },
      ],
      '算计划的三段在前（按下确认后到第一条拉取完成之间那段空档就靠它），每条开始处理前一条事件：先拉取后推送，done 从 0 数起，label 标题优先',
    )
    const outcome = stream.find((event) => event['type'] === 'result')?.['result'] as Record<string, unknown>
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

    // 落地完再预演一次：本机已经有这条、内容一致，没有会话要落到本机，此时不该再说"需要重启"——
    // 纯推送（或没事可做）不改本机任何东西，那时候说重启是一句假警告。
    const after = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq('GET', `${API_PREFIX}/sync`), after.res)
    const afterResult = events(after.captured).find((event) => event['type'] === 'result')?.['result'] as Record<
      string,
      unknown
    >
    assert.deepEqual((afterResult['plan'] as Record<string, unknown>)['pullIds'], [], '这条已经在本机了')
    assert.equal(afterResult['takesEffect'], 'immediate', '没有会话要落地就不谈"生效"')
  } finally {
    await fixture.close()
    rmSync(sandbox.base, { recursive: true, force: true })
  }
})

test('POST /sync：裁决随预演与落地一起走，keep-remote 落选的那份落成新会话', async () => {
  const sandbox = makeSandbox('web-sync-decisions')
  writeSession(sandbox.sessionsRoot, 'session-split', CWD_A, 1000, {
    eventLines: ['{"type":"user/message","seq":1,"data":{"text":"A-tail"}}'],
  })
  const fixture = await startDavFixture({ root: join(sandbox.base, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const foreign = join(sandbox.base, 'foreign')
  mkdirSync(foreign, { recursive: true })
  const foreignRoot = join(sandbox.base, 'foreign-sessions')
  try {
    writeSession(foreignRoot, 'session-split', foreign, 1500, {
      eventLines: ['{"type":"user/message","seq":1,"data":{"text":"B-tail"}}'],
    })
    await putRemoteSession(dav, 'robot-b', {
      id: 'session-split',
      cwd: foreign,
      createdAt: 1500,
      logPath: join(sessionDir(foreignRoot, foreign, 'session-split'), 'session.v4.jsonl.zstd'),
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

    const plain = fakeRes()
    await handlers['GET|POST /sync']!(fakeReq('GET', `${API_PREFIX}/sync`), plain.res)
    const plainPlan = payload(plain.captured)['plan'] as Record<string, unknown>
    assert.equal((plainPlan['push'] as Array<Record<string, unknown>>)[0]?.['code'], 'diverged')

    const decisions = { 'session-split': 'keep-remote' }
    const preview = fakeRes()
    await handlers['GET|POST /sync']!(
      fakeReq('POST', `${API_PREFIX}/sync`, Buffer.from(JSON.stringify({ decisions }))),
      preview.res,
    )
    const planned = payload(preview.captured)
    const plan = planned['plan'] as Record<string, unknown>
    assert.deepEqual(plan['pullIds'], ['session-split'], '裁决把这一对从"不动"改成了会拉取')
    assert.equal((plan['pull'] as Array<Record<string, unknown>>)[0]?.['code'], 'keep-remote')
    assert.equal(typeof planned['planId'], 'string')

    const applied = fakeRes()
    await handlers['GET|POST /sync']!(
      fakeReq(
        'POST',
        `${API_PREFIX}/sync?mode=apply`,
        Buffer.from(JSON.stringify({ planId: planned['planId'], decisions })),
      ),
      applied.res,
    )
    const outcome = payload(applied.captured)
    assert.deepEqual(outcome['planSource'], { kind: 'reused' }, '同一组裁决能复用预演那份')
    assert.deepEqual(outcome['replaced'], ['session-split'])
    const pulled = outcome['pulled'] as string[]
    assert.equal(pulled.length, 2, '落选的本机那份 + 拉回来的正本')
    const branchId = pulled.find((id) => id !== 'session-split')
    assert.ok(branchId !== undefined && branchId.startsWith('session-'))
    const textOf = (id: string): string =>
      decodeAll(readFileSync(join(sessionDir(sandbox.sessionsRoot, CWD_A, id), 'session.v4.jsonl.zstd')))
    assert.match(textOf('session-split'), /B-tail/)
    assert.match(textOf(branchId), /A-tail/, '本机那份没有丢')
    assert.doesNotMatch(textOf(branchId), /B-tail/)
  } finally {
    await fixture.close()
    rmSync(sandbox.base, { recursive: true, force: true })
  }
})

test('POST /sync?mode=apply：带着预演给的 planId 就照着那份计划落地（一份预演只够落地一次）', async () => {
  const sandbox = makeSandbox('web-sync-preview')
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
    const planned = payload(preview.captured)
    assert.equal(typeof planned['planId'], 'string', '预演回一个号码：确认那次带着它回来')

    const applied = fakeRes()
    await handlers['GET|POST /sync']!(
      fakeReq('POST', `${API_PREFIX}/sync?mode=apply`, Buffer.from(JSON.stringify({ planId: planned['planId'] }))),
      applied.res,
    )
    assert.deepEqual(
      progressOf(applied.captured).map((progress) => progress['phase']),
      ['remote', 'pull', 'push'],
      '照预演那份走：只重读一次远端索引（验数据有没有变），扫本机 / 问 git / 比对内容那几段不再走',
    )
    const outcome = payload(applied.captured)
    assert.deepEqual(outcome['planSource'], { kind: 'reused' })
    assert.deepEqual(outcome['pulled'], ['session-remote'])
    assert.deepEqual((outcome['plan'] as Record<string, unknown>)['pullIds'], ['session-remote'])
    assert.ok(existsSync(sessionDir(sandbox.sessionsRoot, CWD_A, 'session-remote')), '该落的还是落了')

    // 一份预演只够落地一次：拿着同一个号码再来一次，宿主手里已经没有那份数据了，退回从零重算。
    const again = fakeRes()
    await handlers['GET|POST /sync']!(
      fakeReq('POST', `${API_PREFIX}/sync?mode=apply`, Buffer.from(JSON.stringify({ planId: planned['planId'] }))),
      again.res,
    )
    const second = payload(again.captured)
    const source = second['planSource'] as Record<string, unknown>
    assert.equal(source['kind'], 'recomputed')
    assert.match(String(source['reason']), /不在宿主手里/)
    assert.ok(
      progressOf(again.captured).some((progress) => progress['phase'] === 'scan'),
      '重算那次照旧报算计划那几段',
    )
  } finally {
    await fixture.close()
    rmSync(sandbox.base, { recursive: true, force: true })
  }
})

// ---- 长动作的进度（事件流） ----
//
// 这一组钉的不是"某个动作能跑完"（上面那些用例已经钉了结论），而是"**干活的每一段都报了**"：
// 分母是什么、`done` 从 0 数起、顺序与真实步骤一致。界面那条进度条读的就是这些事件，少报一段的表现
// 就是进度条停在原地或者走不满——只有这里能当场发现。

test('GET /state：整库扫描逐条报进度，收尾仍是那一份清单', async () => {
  const sandbox = makeSandbox('web-state-progress')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '会话甲' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000, { title: '会话乙' })
  const handlers = createApiHandlers(deps(sandbox))

  const { res, captured } = fakeRes()
  await handlers['GET /state']!(fakeReq('GET', `${API_PREFIX}/state`), res)
  assert.equal(captured.status, 200)
  assert.equal(
    captured.headers['content-type'],
    'text/event-stream; charset=utf-8',
    '整库要逐条读 header、折标题，这一段走事件流（页头那句「读取中…」原来什么都不知道）',
  )
  assert.deepEqual(
    progressOf(captured),
    [
      { phase: 'scan', total: 2, done: 0 },
      { phase: 'scan', total: 2, done: 1 },
    ],
    '每开始扫一条报一次：done 是**已经扫完**的条数，界面按 done + 1 说"正在扫第几条"',
  )
  const body = payload(captured)
  assert.equal((body['sessions'] as unknown[]).length, 2, '收尾那条 result 里仍是原来那份清单')
  assert.equal(body['sessionsRoot'], sandbox.sessionsRoot)
})

test('POST /migrate：落地时把 备份 / 改写 / 搬目录 / 注册表 / 复核 / 补齐 逐段报出来', async () => {
  const sandbox = makeSandbox('web-migrate-progress')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '会话甲' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)
  const warmed: string[] = []
  const handlers = createApiHandlers(
    deps(sandbox, {
      hostCheckpoints: () => ({
        warm: async (id: string): Promise<void> => {
          warmed.push(id)
        },
      }),
      // 宿主没有那套注册表动作时这一步要回"重启最稳妥"，与进度无关，这里只是把探测固定住。
      hostRegistry: () => undefined,
    }),
  )

  const { res, captured } = fakeRes()
  await handlers['POST /migrate']!(
    fakeReq('POST', `${API_PREFIX}/migrate`, Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'], to: CWD_B, mode: 'apply' }))),
    res,
  )
  assert.equal(captured.status, 200)
  assert.deepEqual(
    progressOf(captured).map((item) => [item['phase'], item['total'], item['done']]),
    [
      ['scan', 2, 0],
      ['scan', 2, 1],
      // 备份是"整份会话目录按字节复制"：分母是会话数
      ['backup', 2, 0],
      ['backup', 2, 1],
      // 改写是逐文件的活：这条会话只有一代日志，所以分母与上面同数（有几代日志时分母就更大）
      ['rewrite', 2, 0],
      ['rewrite', 2, 1],
      ['move', 2, 0],
      ['move', 2, 1],
      // 注册表是一次落盘，没有"第几条"：分母 0，界面只说在做什么、不画条
      ['registry', 0, 0],
      ['verify', 2, 0],
      ['verify', 2, 1],
      // 落地之后请宿主把列表元数据折出来（不然侧边栏是"未命名"）
      ['warm', 2, 0],
      ['warm', 2, 1],
    ],
    '段名与真实步骤一一对应、顺序一致；每段开始处理下一条之前先报一条',
  )
  // 会话按"最新在前"排（与侧边栏同一口径）：session-b 是后建的，所以它排在前面。
  assert.deepEqual(warmed, ['session-b', 'session-a'], '补齐那一段真的是逐条走宿主')
  assert.equal(payload(captured)['verified'], true, '收尾仍是原来那份结论')
  // 报进度不许碰数据：本条会话的名字只出现在 id / label 上，备份目录里那份快照才是字节真相。
  const labels = progressOf(captured)
    .filter((item) => item['phase'] === 'backup')
    .map((item) => item['label'])
  assert.deepEqual(labels, ['session-b', '会话甲'], 'label 优先用标题，没有标题的那条退回 id')
})

test('POST /delete：先备整个会话目录再删，逐条报进度（预演只报扫描那一段）', async () => {
  const sandbox = makeSandbox('web-delete-progress')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '会话甲' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)
  const handlers = createApiHandlers(deps(sandbox))
  const body = (mode: string): Buffer =>
    Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'], mode }))

  // 预演：只有"重算计划"那一段要花时间（扫整个库）
  const planned = fakeRes()
  await handlers['POST /delete']!(fakeReq('POST', `${API_PREFIX}/delete`, body('plan')), planned.res)
  assert.deepEqual(
    progressOf(planned.captured).map((item) => item['phase']),
    ['scan', 'scan'],
    '预演不写盘：不该出现 backup / remove / verify 那几段',
  )

  const applied = fakeRes()
  await handlers['POST /delete']!(fakeReq('POST', `${API_PREFIX}/delete`, body('apply')), applied.res)
  assert.deepEqual(
    progressOf(applied.captured).map((item) => [item['phase'], item['total'], item['done']]),
    [
      ['scan', 2, 0],
      ['scan', 2, 1],
      ['backup', 2, 0],
      ['backup', 2, 1],
      ['remove', 2, 0],
      ['remove', 2, 1],
      ['verify', 2, 0],
      ['verify', 2, 1],
    ],
    '备份在前、删除在后、最后逐条复核"真的不在了、备份里真的在"',
  )
  assert.equal(payload(applied.captured)['verified'], true)
})

test('POST /rollback：预演与落地都逐条报"正在还原"，迁移备份还多一段注册表', async () => {
  const sandbox = makeSandbox('web-rollback-progress')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '会话甲' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000)
  const handlers = createApiHandlers(deps(sandbox))
  const migrate = (mode: string): Buffer =>
    Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'], to: CWD_B, mode }))

  await handlers['POST /migrate']!(fakeReq('POST', `${API_PREFIX}/migrate`, migrate('apply')), fakeRes().res)
  const { res: listRes, captured: listed } = fakeRes()
  await handlers['GET /backups']!(fakeReq('GET', `${API_PREFIX}/backups`), listRes)
  const backupDir = (payload(listed)['backups'] as Array<Record<string, unknown>>)[0]!['dir'] as string

  const call = async (dryRun: boolean): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['POST /rollback']!(
      fakeReq('POST', `${API_PREFIX}/rollback`, Buffer.from(JSON.stringify({ backupDir, dryRun }))),
      res,
    )
    return captured
  }

  const dry = await call(true)
  assert.deepEqual(
    progressOf(dry).map((item) => [item['phase'], item['total'], item['done'], item['label']]),
    [
      ['restore', 2, 0, 'session-b'],
      ['restore', 2, 1, 'session-a'],
      ['registry', 0, 0, undefined],
    ],
    '预演也要逐条走一遍清单（不写盘而已）：分母是会话数，注册表那一段没有分母',
  )
  assert.equal(payload(dry)['dryRun'], true)

  const done = await call(false)
  assert.deepEqual(
    progressOf(done).map((item) => item['phase']),
    ['restore', 'restore', 'registry'],
    '落地报的是同一套段名（界面一条进度块跑完预演与落地两条路）',
  )
  assert.equal(payload(done)['registryRestored'], true)
  assert.deepEqual(
    progressOf(done).filter((item) => item['phase'] === 'restore').map((item) => item['label']),
    ['session-b', 'session-a'],
    '还原按会话报，label 用 id（备份清单里没有标题这一项）',
  )
})

test('POST /import：预演按包里的条数读、落地只按"会创建"的那些写', async () => {
  const source = makeSandbox('web-import-progress-src')
  writeSession(source.sessionsRoot, 'session-a', CWD_A, 1000, { title: '会话甲' })
  writeSession(source.sessionsRoot, 'session-b', CWD_A, 2000)
  const sourceHandlers = createApiHandlers(deps(source))
  const exported = fakeRes()
  await sourceHandlers['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'] }))),
    exported.res,
  )
  assert.equal(
    exported.captured.headers['content-type'],
    'application/octet-stream',
    '导出**不**吃事件流：它的响应体就是产物本身（见 web.ts 里那条说明）',
  )
  const bundle = exported.captured.body

  // 落地到一个只有其中一条的库：那一条会被跳过（分母只算"会创建"的那些，进度条才走得满）
  const target = makeSandbox('web-import-progress-dst')
  writeSession(target.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(
    deps(target, { hostCheckpoints: () => ({ warm: async (): Promise<void> => {} }) }),
  )
  const url = `${API_PREFIX}/import?targetCwd=${encodeURIComponent(CWD_A)}`

  const planned = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', url, bundle), planned.res)
  assert.deepEqual(
    progressOf(planned.captured).map((item) => [item['phase'], item['total'], item['done']]),
    [
      // 库那一遍扫描没有"第几条"可讲（目录项的条数与包里的条数不是一回事）
      ['scan', 0, 0],
      ['read', 2, 0],
      ['read', 2, 1],
    ],
    '预演逐条读包里的日志折标题，分母是包里的条数',
  )
  assert.equal(payload(planned.captured)['ok'], true)

  const applied = fakeRes()
  await handlers['POST /import']!(fakeReq('POST', `${url}&mode=apply`, bundle), applied.res)
  assert.deepEqual(
    progressOf(applied.captured).map((item) => [item['phase'], item['total'], item['done']]),
    [
      ['scan', 0, 0],
      ['read', 2, 0],
      ['read', 2, 1],
      // session-a 已在库里 → 一条都不写；分母是 1（会创建的那些），所以恰好走满
      ['write', 1, 0],
      ['registry', 0, 0],
      ['warm', 1, 0],
    ],
    '落地沿用同一份计划（不再读一遍包），只按会创建的那些逐条写盘',
  )
  const body = payload(applied.captured)
  assert.deepEqual(body['written'], ['session-b'])
  assert.equal(existsSync(sessionDir(target.sessionsRoot, CWD_A, 'session-b')), true)
})

test('事件流：每写完一条就把 socket 推给内核（同步循环里也攒不到最后）', async () => {
  const sandbox = makeSandbox('web-sse-flush')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, { title: '会话甲' })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000, { title: '会话乙' })
  writeSession(sandbox.sessionsRoot, 'session-c', CWD_A, 3000, { title: '会话丙' })
  const handlers = createApiHandlers(deps(sandbox))

  /*
   * 这一条钉的是"进度条到底会不会动"的那一半，测试里其它断言都钉不住它：
   *
   * `res.write()` 每次都会把 socket cork 住（`writableCorked` 1、事件就躺在 `writableLength` 里），
   * Node 要等下一次事件循环才推给内核。而报进度的这些循环是**同步**的（读日志、改首帧、搬目录中间
   * 一次 await 都没有），所以不主动 `uncork()` 的话，整段干完之前一个字节都发不出去——跨进程实测
   * （本机、五条事件）：不 uncork 全在 1537ms 到达，uncork 之后是 33/330/630/930/1230ms。
   *
   * 这里量的是 `uncork()` 之后 socket 里还剩多少字节：每条事件都推干净了（0），事件条数也对得上。
   */
  const afterFlush: number[] = []
  const server = createServer((req, res) => {
    const real = res.socket
    if (real === null) throw new Error('这个夹具需要一个真实 socket')
    const socket = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'uncork') {
          return () => {
            target.uncork()
            // 推完之后 socket 里不该再留着这条事件的字节。
            afterFlush.push(target.writableLength)
          }
        }
        const value = Reflect.get(target, prop, receiver) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    /*
     * 只把 `sendEvent()` 用到的那几样转发给真正的响应：`Object.create(res)` 那种代理不行——
     * `end()` 内部的 `this.finished = true` 会写在代理自己身上，真响应永远结束不了（用例当场挂住）。
     */
    const shim = {
      get writableEnded(): boolean {
        return res.writableEnded
      },
      write: (chunk: string | Buffer): boolean => res.write(chunk),
      end: (chunk?: string | Buffer): void => {
        res.end(chunk)
      },
      writeHead: (status: number, headers?: Record<string, string>): unknown => res.writeHead(status, headers),
      socket,
    } as unknown as ServerResponse
    void handlers['GET /state']!(req, shim)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const client = request({ port, path: `${API_PREFIX}/state` }, (upstream) => {
        let text = ''
        upstream.setEncoding('utf8')
        upstream.on('data', (chunk: string) => {
          text += chunk
        })
        upstream.on('end', () => resolve(text))
      })
      client.on('error', reject)
      client.end()
    })
    const eventCount = (body.match(/^data:/gm) ?? []).length
    assert.equal(eventCount, 4, '3 条会话 → 3 条 scan 进度 + 1 条收尾')
    assert.equal(afterFlush.length, eventCount, '每写完一条事件必须推一次：攒着就是整段结束才发')
    assert.deepEqual([...new Set(afterFlush)], [0], '推完之后 socket 里不留缓冲——字节已经在路上了')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
test('GET /transcript：把一条会话的日志折成完整时间线（会话事实、分页、坏行、拒绝都在一次响应里）', async () => {
  const sandbox = makeSandbox('web-transcript')
  writeSession(sandbox.sessionsRoot, 'session-plain', CWD_A, 1000, { title: '兜底名称' })
  writeRawSession(sandbox.sessionsRoot, 'session-rich', CWD_A, 2000, [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: { content: [{ type: 'text', text: '看看这个日志' }], source: { kind: 'user' } },
    },
    {
      type: 'tool/call',
      seq: 2,
      time: 3,
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    },
    {
      type: 'tool/result',
      seq: 3,
      time: 4,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'a.txt\nb.txt' }],
          isError: false,
        },
      },
    },
    '{"type":"turn/end","seq":4,"time":5,"data":{ 这行坏了 }}',
    { type: 'session/title', seq: 5, time: 6, data: { title: '看看日志', source: { kind: 'user' } } },
  ])

  const handlers = createApiHandlers(deps(sandbox))
  const call = async (query: string): Promise<Captured> => {
    const { res, captured } = fakeRes()
    await handlers['GET /transcript']!(fakeReq('GET', `${API_PREFIX}/transcript${query}`), res)
    return captured
  }
  const itemsOf = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    body['items'] as Array<Record<string, unknown>>

  const whole = await call('?id=session-rich')
  assert.equal(whole.status, 200, String(payload(whole)['error'] ?? ''))
  const body = payload(whole)
  const facts = body['session'] as Record<string, unknown>
  assert.equal(facts['id'], 'session-rich')
  assert.equal(facts['file'], 'session.v4.jsonl.zstd')
  assert.equal(facts['generation'], 4)
  assert.equal(facts['generations'], 1, '"这就是全部内容"的说法要跟目录里的代次数一致')
  assert.equal(facts['createdAt'], 2000)
  assert.equal(body['totalEvents'], 6)
  assert.equal(body['problemCount'], 1, '坏行如实记数，不当成"读不出来"整份拒掉')
  assert.deepEqual(
    itemsOf(body).map((item) => item['kind']),
    ['event', 'user', 'tool-call', 'tool-result', 'event'],
    '坏行不占条目，其余事件一条不少',
  )
  assert.deepEqual(
    itemsOf(body).map((item) => item['index']),
    [0, 1, 2, 3, 5],
    '条目带的是它自己在日志里的位置（看原文要用它）',
  )
  assert.equal(itemsOf(body)[3]!['name'], 'bash', '工具名从调用那条补过来')
  assert.equal(itemsOf(body)[3]!['text'], 'a.txt\nb.txt')
  assert.equal(itemsOf(body)[0]!['text'], '第 1 轮开始')
  assert.equal(itemsOf(body)[4]!['text'], '标题（人（改名））：看看日志')
  assert.deepEqual(body['counts'], {
    events: 6,
    byType: { 'turn/start': 1, 'user/message': 1, 'tool/call': 1, 'tool/result': 1, 'turn/end': 1, 'session/title': 1 },
    human: 1,
    synthetic: 0,
    assistant: 0,
    toolCalls: 1,
    toolResults: 1,
    system: 0,
  })

  // 分页：第二页从第 2 条事件开始（游标是"事件位"，不是 seq）
  const firstPage = await call('?id=session-rich&limit=2')
  assert.equal(payload(firstPage)['nextCursor'], 2)
  assert.deepEqual(itemsOf(payload(firstPage)).map((item) => item['index']), [0, 1])
  const secondPage = await call('?id=session-rich&from=2&limit=10')
  assert.deepEqual(itemsOf(payload(secondPage)).map((item) => item['index']), [2, 3, 5])
  assert.equal(payload(secondPage)['nextCursor'], undefined, '读完了就不给下一次游标')

  // 参数糊涂时当"没提要求"（用缺省值），不当 0：`?from=abc` 不该被理解成"从头再来一遍"以外的意思
  const sloppy = await call('?id=session-rich&from=abc&limit=')
  assert.equal(sloppy.status, 200)
  assert.equal(payload(sloppy)['cursor'], 0)

  // 三处拒绝：没给 id、库里没这条
  const missing = await call('')
  assert.equal(missing.status, 400)
  assert.match(String(payload(missing)['error']), /缺少会话 id/)
  const absent = await call('?id=session-nope')
  assert.equal(absent.status, 404)
  assert.match(String(payload(absent)['error']), /会话库里没有/)

  // 只有 header + 一条用户消息 + 一条标题的普通会话照样读得出来
  const plain = await call('?id=session-plain')
  assert.equal(plain.status, 200)
  assert.equal(payload(plain)['totalEvents'], 2)
  assert.equal((payload(plain)['session'] as Record<string, unknown>)['title'], '兜底名称')
})

// ── 自动推送端点（只推不拉，点一次就是真跑）────────────────────────────────────

/** 一个假的节拍器：记下被怎么调用，并回一个给定的结论。 */
function fakeTimer(outcome: Record<string, unknown>): {
  timer: NonNullable<Awaited<ReturnType<NonNullable<Parameters<typeof createApiHandlers>[0]['autoPush']>>>>
  calls: Array<{ force?: boolean; onProgress?: unknown }>
} {
  const calls: Array<{ force?: boolean; onProgress?: unknown }> = []
  const timer = {
    enabled: () => true,
    intervalMs: () => 300_000,
    async tick(options?: { force?: boolean; onProgress?: (event: ProgressEvent) => void }) {
      calls.push(options ?? {})
      options?.onProgress?.({ phase: 'push', done: 0, total: 1, id: 'session-a', label: 'a' })
      return outcome as never
    },
    last: () => ({ enabled: true, intervalMs: 300_000 }),
    note: () => undefined,
    touched: () => undefined,
    stop: () => undefined,
  }
  return { timer, calls }
}

test('GET /auto-push：这个宿主没有节拍器时 409，且没有一个字节被写', async () => {
  const sandbox = makeSandbox('web-auto-push-off')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const handlers = createApiHandlers(deps(sandbox))
  const { res, captured } = fakeRes()
  await handlers['GET /auto-push']!(fakeReq('GET', `${API_PREFIX}/auto-push`), res)
  assert.equal(captured.status, 409)
  assert.match(String(payload(captured)['error']), /自动推送的节拍器/)
  // 没配置同步时没有任何东西该被写。
  assert.deepEqual(readRegistry(sandbox.registryPath).tables.workspaces['ws-a']?.sessionIds, ['session-a'])
})

test('GET /auto-push：当场跑一轮，force 绕开速度闸，结果摊平着回来', async () => {
  const sandbox = makeSandbox('web-auto-push-run')
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000)
  const { timer, calls } = fakeTimer({
    ran: true,
    failures: 0,
    outcome: {
      plan: { ok: true, problems: [], pull: [], push: [], pullIds: [], pushIds: ['session-a'], blank: [], bytesIn: 0, bytesOut: 10, localCount: 1, remoteCount: 0, machines: [] },
      applied: true,
      pulled: [],
      replaced: [],
      pushed: [{ id: 'session-a', action: 'upload' }],
      bytesIn: 0,
      bytesOut: 10,
      registryWritten: false,
      indexWritten: true,
      problems: [],
    },
  })
  const handlers = createApiHandlers(
    deps(sandbox, {
      autoPush: async () => timer,
      syncInfo: () => ({ url: 'https://dav.example/', machineId: 'robot-a', mappings: 0, autoPush: { intervalMs: 300_000 } }),
    }),
  )
  const { res, captured } = fakeRes()
  await handlers['GET /auto-push']!(fakeReq('GET', `${API_PREFIX}/auto-push`), res)

  const result = payload(captured)
  assert.equal(result['mode'], 'auto-push')
  assert.deepEqual(result['remote'], { url: 'https://dav.example/', machineId: 'robot-a' })
  assert.equal(result['ran'], true)
  assert.equal(result['failures'], 0)
  // 那份 SyncOutcome 是**摊平**进来的：界面因此能复用 /sync 那一套解析。
  assert.deepEqual(result['pushed'], [{ id: 'session-a', action: 'upload' }])
  assert.deepEqual(result['pulled'], [], '只推这条路上拉取永远是空的')
  assert.equal(result['bytesIn'], 0)
  assert.equal(result['bytesOut'], 10)
  assert.equal(result['planSource'], undefined, '自动推送没有"预演那份"，所以没有 planSource')
  // 只推不改本机 → 永远 immediate（不能走 effectOf 探出一句假警告）。
  assert.equal(result['takesEffect'], 'immediate')
  assert.ok(result['plan'] !== undefined, '计划一起带回来（界面按需显示）')

  // 用户手点的那一次必须 force：它不该被"距上次才过了 20 秒"挡住。
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.force, true)
  assert.equal(typeof calls[0]?.onProgress, 'function', '进度要接上（画在页面横幅上）')

  /*
   * `what` 那一项由宿主侧的 `runAutoPush()` 盖（它知道自己在报哪条流），端点这一层只是把节拍器交出来
   * 的事件原样转成 SSE——所以这里核"转过去了"，`what` 的值由 test/auto-push.test.ts 钉。
   */
  const progress = progressOf(captured)
  assert.ok(progress.length > 0, '节拍器报的进度要转成事件')
  assert.equal(progress[0]?.['phase'], 'push')
  assert.equal(progress[0]?.['id'], 'session-a')
})

test('GET /auto-push：没跑（skip）时不带计划也不带结果，只回一句话的码', async () => {
  const sandbox = makeSandbox('web-auto-push-skip')
  const { timer } = fakeTimer({ ran: false, skip: 'interval', failures: 0 })
  const handlers = createApiHandlers(
    deps(sandbox, {
      autoPush: async () => timer,
      syncInfo: () => ({ url: 'https://dav.example/', machineId: 'robot-a', mappings: 0 }),
    }),
  )
  const { res, captured } = fakeRes()
  await handlers['GET /auto-push']!(fakeReq('GET', `${API_PREFIX}/auto-push`), res)

  const result = payload(captured)
  assert.equal(result['mode'], 'auto-push')
  assert.equal(result['ran'], false)
  assert.equal(result['skip'], 'interval', '跳过原因是机器可读的码（句子在浏览器半侧）')
  assert.equal(result['plan'], undefined, '没跑就没有计划可给')
  assert.equal(result['pushed'], undefined, '也没结果——给一份空的只会让界面去猜哪个字段是真的')
  assert.equal(result['takesEffect'], undefined)
})

test('GET /auto-push：节拍器抛错时靠事件说，HTTP 状态早就是 200', async () => {
  const sandbox = makeSandbox('web-auto-push-fail')
  const timer = {
    enabled: () => true,
    intervalMs: () => 300_000,
    tick: async () => {
      throw new Error('远端不认这套凭据')
    },
    last: () => ({ enabled: true, intervalMs: 300_000, minIntervalMs: 60_000 }),
    note: () => undefined,
    stop: () => undefined,
  }
  const handlers = createApiHandlers(deps(sandbox, { autoPush: async () => timer as never }))
  const { res, captured } = fakeRes()
  await handlers['GET /auto-push']!(fakeReq('GET', `${API_PREFIX}/auto-push`), res)
  // 流一旦开始，状态就已经发出去了；错误只能靠一条 error 事件说。
  assert.equal(captured.status, 200)
  const error = events(captured).find((event) => event['type'] === 'error')
  assert.ok(error !== undefined, '要以一条 error 收尾')
  assert.match(String(error['error']), /远端不认这套凭据/)
})

test('GET /auto-push：方法检查在路由那一层（POST 回 405）', async () => {
  // 方法白名单由 `registerWebRoutes()` 把关，不在 handler 表里——所以这条要真注册一次路由。
  const sandbox = makeSandbox('web-auto-push-405')
  const { timer } = fakeTimer({ ran: false, skip: 'idle', failures: 0 })
  const routes: WebRouteLike[] = []
  registerWebRoutes(
    { register: (route) => { routes.push(route); return () => {} } },
    deps(sandbox, { autoPush: async () => timer }),
  )
  const route = routes.find((item) => item.path.endsWith('/auto-push'))!
  const { res, captured } = fakeRes()
  await route.handler(fakeReq('POST', `${API_PREFIX}/auto-push`), res)
  assert.equal(captured.status, 405)
  // GET 是它认的那一个（上面几条已经验过行为，这里只核方法位）。
  const ok = fakeRes()
  await route.handler(fakeReq('GET', `${API_PREFIX}/auto-push`), ok.res)
  assert.notEqual(ok.captured.status, 405)
})

// ── 附件对象（导出把对象收进包、导入把它落进本机库） ──────────────────────────

test('POST /export：附件对象跟着包走，条数/字节/本机缺的那几个都报在响应头里', async () => {
  const sandbox = makeSandbox('web-export-attachments')
  const store = makeAttachmentStore(sandbox.base)
  const present = Buffer.from('本机附件库里有的那张图')
  const absent = Buffer.from('只被日志引用、库里已经没有的那张图')
  const presentRef: AttachmentRef = { id: attachmentIdOf(present), kind: 'image' }
  const absentRef: AttachmentRef = { id: attachmentIdOf(absent), kind: 'image' }
  store.put(presentRef, present)
  writeSession(sandbox.sessionsRoot, 'session-a', CWD_A, 1000, {
    attachment: { ref: presentRef, bytes: present.length },
  })
  writeSession(sandbox.sessionsRoot, 'session-b', CWD_A, 2000, {
    attachment: { ref: absentRef, bytes: absent.length },
  })

  const handlers = createApiHandlers(deps(sandbox, { attachments: () => store.port }))
  const { res, captured } = fakeRes()
  await handlers['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a', 'session-b'] }))),
    res,
  )
  assert.equal(captured.status, 200)
  assert.equal(captured.headers['x-dsh-attachment-count'], '1', '库里有的那个进包')
  assert.equal(captured.headers['x-dsh-attachment-bytes'], String(present.length))
  assert.equal(captured.headers['x-dsh-attachment-missing'], '1', '库里没有的那个要如实报，界面据此提醒')

  const { readBundle, attachmentBytes } = await import('../src/transfer.ts')
  const bundle = readBundle(captured.body)
  assert.deepEqual(
    bundle.attachments.map((entry) => entry.id),
    [presentRef.id],
  )
  assert.deepEqual(attachmentBytes(bundle, bundle.attachments[0]!), present)
})

test('POST /import：日志已在库里、只缺附件对象时照样落地（写会话 0 条、补对象 1 个）', async () => {
  const source = makeSandbox('web-import-attachments-source')
  const store = makeAttachmentStore(source.base)
  const image = Buffer.from('要补进另一个库的图片字节')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  store.put(ref, image)
  writeSession(source.sessionsRoot, 'session-a', CWD_A, 1000, { attachment: { ref, bytes: image.length } })

  const exporter = createApiHandlers(deps(source, { attachments: () => store.port }))
  const exported = fakeRes()
  await exporter['POST /export']!(
    fakeReq('POST', `${API_PREFIX}/export`, Buffer.from(JSON.stringify({ sessionIds: ['session-a'] }))),
    exported.res,
  )
  assert.equal(exported.captured.status, 200)

  // 目标库：会话日志照原样摆进去（"早就导过、图是挂的"），附件库是空的。
  const target = makeSandbox('web-import-attachments-target')
  writeSession(target.sessionsRoot, 'session-a', CWD_A, 1000, { attachment: { ref, bytes: image.length } })
  const targetStore = makeAttachmentStore(target.base)
  assert.equal(existsSync(targetStore.port.pathOf(ref)!), false, '目标库这会儿确实没有这个对象')

  const importer = createApiHandlers(deps(target, { attachments: () => targetStore.port }))
  const url = `${API_PREFIX}/import?targetCwd=${encodeURIComponent(CWD_A)}&mode=apply`
  const applied = fakeRes()
  await importer['POST /import']!(fakeReq('POST', url, exported.captured.body), applied.res)

  const result = payload(applied.captured)
  assert.equal(result['ok'], true, '只有附件要补时落地也是成功（界面据此收掉弹窗并刷新）')
  assert.deepEqual(result['written'], [], '一条会话都没写（库里已经有它）')
  assert.equal(result['attachmentWritten'], 1)
  assert.equal(result['attachmentPresent'], 0)
  assert.deepEqual(result['attachmentProblems'], [])
  assert.deepEqual(readFileSync(targetStore.port.pathOf(ref)!), image)
})

// ── 差异端点：同一个 id 两边各自写过时，"哪儿不一样"的只读出口 ────────────────────────────────

/** 手写一份日志：header 由用例给，事件行一条条给（这样两边只差我想差的那几条）。 */
function writeLog(root: string, id: string, cwd: string, events: readonly string[]): string {
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1500,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const dir = sessionDir(root, cwd, id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  // header 记得先序列化：直接塞字符串模板会写成 `[object Object]`，那份日志的 header 就废了
  // （整条会话会被扫描跳过，端点回 404"会话库里没有它"）。
  writeFileSync(
    path,
    Buffer.concat([JSON.stringify(header), ...events].map((line) => encodeRawFrame(`${line}\n`))),
  )
  return path
}

/** 一条用户消息（差异预览的摘要是它的正文）。 */
const message = (seq: number, text: string): string =>
  JSON.stringify({
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
  })

test('GET /sync-diff：两边事件一致、只有 header 的 cwd 不同，且一个字节都不写', async () => {
  const sandbox = makeSandbox('sync-diff-same')
  const fixture = await startDavFixture({ root: join(sandbox.base, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const foreignRoot = join(sandbox.base, 'foreign-sessions')
  try {
    const localPath = writeLog(sandbox.sessionsRoot, 'session-shared', CWD_A, [message(0, '同一个起头')])
    const foreignPath = writeLog(foreignRoot, 'session-shared', CWD_B, [message(0, '同一个起头')])
    await putRemoteSession(dav, 'robot-b', {
      id: 'session-shared',
      cwd: CWD_B,
      createdAt: 1500,
      logPath: foreignPath,
      logName: 'session.v4.jsonl.zstd',
      logVersion: 4,
    })
    const before = readFileSync(localPath)
    // 夹具记的是这台服务器**收到过的全部**请求，里面已经有搭场景时那两次 PUT——只看端点这一段。
    const requestsBefore = fixture.requests.length
    const handlers = createApiHandlers(
      deps(sandbox, {
        sync: async () => ({ settings: { url: fixture.url, machineId: 'robot-a', mapping: {} }, dav }),
      }),
    )
    const called = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared`), called.res)
    assert.equal(called.captured.status, 200)
    const body = payload(called.captured)
    assert.equal(body['machine'], 'robot-b', '远端那一份是哪台机器的')
    assert.equal(body['localFile'], 'session.v4.jsonl.zstd')
    assert.ok(Number(body['bundleBytes']) > 0, '下这个包花了多少字节要报出来')
    const diff = body['diff'] as Record<string, unknown>
    assert.equal(diff['relation'], 'same', '事件逐条一致')
    assert.equal(diff['common'], 1)
    assert.deepEqual(diff['header'], [{ field: 'cwd', local: CWD_A, remote: CWD_B }], '差别只在 header 的 cwd')
    assert.deepEqual(readFileSync(localPath), before, '只读：本机那份没被动过')
    assert.deepEqual(
      fixture.requests
        .slice(requestsBefore)
        .filter((item) => item.startsWith('PUT') || item.startsWith('DELETE')),
      [],
      '只读：这条路一个字节都没往远端写',
    )
  } finally {
    await fixture.close()
  }
})

test('GET /sync-diff：远端接着写的那些条列出来（续写，不是分叉）', async () => {
  const sandbox = makeSandbox('sync-diff-extends')
  const fixture = await startDavFixture({ root: join(sandbox.base, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const foreignRoot = join(sandbox.base, 'foreign-sessions')
  try {
    writeLog(sandbox.sessionsRoot, 'session-shared', CWD_A, [message(0, '同一个起头')])
    const foreignPath = writeLog(foreignRoot, 'session-shared', CWD_B, [
      message(0, '同一个起头'),
      message(1, '远端又写了一句'),
    ])
    await putRemoteSession(dav, 'robot-b', {
      id: 'session-shared',
      cwd: CWD_B,
      createdAt: 1500,
      logPath: foreignPath,
      logName: 'session.v4.jsonl.zstd',
      logVersion: 4,
    })
    const handlers = createApiHandlers(
      deps(sandbox, {
        sync: async () => ({ settings: { url: fixture.url, machineId: 'robot-a', mapping: {} }, dav }),
      }),
    )
    const called = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared`), called.res)
    assert.equal(called.captured.status, 200)
    const diff = payload(called.captured)['diff'] as Record<string, unknown>
    assert.equal(diff['relation'], 'remote-extends', '远端那份是本机这部分的前缀')
    assert.equal(diff['common'], 1)
    const tail = diff['remoteTail'] as { count: number; preview: Array<Record<string, unknown>>; hidden: number }
    assert.equal(tail.count, 1)
    assert.equal(tail.hidden, 0)
    assert.deepEqual(
      tail.preview.map((item) => [item['index'], item['kind'], item['brief']]),
      [[1, 'user', '远端又写了一句']],
      '预览给的是摘要，位置是整份日志里的位置',
    )
    assert.equal((diff['localTail'] as { count: number }).count, 0)
  } finally {
    await fixture.close()
  }
})

test('GET /sync-diff：各条拒绝面都说清是哪一步、哪一边', async () => {
  const sandbox = makeSandbox('sync-diff-refuse')
  const fixture = await startDavFixture({ root: join(sandbox.base, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const foreignRoot = join(sandbox.base, 'foreign-sessions')
  try {
    writeLog(sandbox.sessionsRoot, 'session-shared', CWD_A, [message(0, '同一个起头')])
    const foreignPath = writeLog(foreignRoot, 'session-other', CWD_B, [message(0, '别的会话')])
    await putRemoteSession(dav, 'robot-b', {
      id: 'session-other',
      cwd: CWD_B,
      createdAt: 1600,
      logPath: foreignPath,
      logName: 'session.v4.jsonl.zstd',
      logVersion: 4,
    })
    const handlers = createApiHandlers(
      deps(sandbox, {
        sync: async () => ({ settings: { url: fixture.url, machineId: 'robot-a', mapping: {} }, dav }),
      }),
    )
    const noId = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff`), noId.res)
    assert.equal(noId.captured.status, 400)
    assert.match(String(payload(noId.captured)['error']), /缺少会话 id/)

    const noLocal = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-nothing`), noLocal.res)
    assert.equal(noLocal.captured.status, 404)
    assert.match(String(payload(noLocal.captured)['error']), /会话库里没有/)

    // 远端索引里只有 `session-other`，本机这条在远端没有对应：这是"没配映射 / 远端没有"那一类，
    // 不是一个可以比的对象。
    const noRemote = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared`), noRemote.res)
    assert.equal(noRemote.captured.status, 404)
    assert.match(String(payload(noRemote.captured)['error']), /远端索引里没有/)

    const noRuntime = createApiHandlers(deps(sandbox))
    const notConfigured = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared`), notConfigured.res)
    assert.equal(notConfigured.captured.status, 404, '没有远端那一份时先报"远端没有"，与没配同步是两句')
    assert.ok(noRuntime !== undefined)
  } finally {
    await fixture.close()
  }
})

test('GET /sync-diff：没配同步时明确说没配（不是"远端没有这条"）', async () => {
  const sandbox = makeSandbox('sync-diff-unconfigured')
  try {
    writeLog(sandbox.sessionsRoot, 'session-shared', CWD_A, [message(0, '同一个起头')])
    const handlers = createApiHandlers(deps(sandbox))
    const called = fakeRes()
    await handlers['GET /sync-diff']!(fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared`), called.res)
    assert.equal(called.captured.status, 409)
    assert.match(String(payload(called.captured)['error']), /没有配置 WebDAV 同步/)
  } finally {
    rmSync(join(sandbox.base), { recursive: true, force: true })
  }
})

test('GET /sync-diff：指名的那台机器与远端索引记的不是同一台时拒绝', async () => {
  const sandbox = makeSandbox('sync-diff-machine')
  const fixture = await startDavFixture({ root: join(sandbox.base, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const foreignRoot = join(sandbox.base, 'foreign-sessions')
  try {
    writeLog(sandbox.sessionsRoot, 'session-shared', CWD_A, [message(0, '同一个起头')])
    const foreignPath = writeLog(foreignRoot, 'session-shared', CWD_B, [message(0, '同一个起头')])
    await putRemoteSession(dav, 'robot-b', {
      id: 'session-shared',
      cwd: CWD_B,
      createdAt: 1500,
      logPath: foreignPath,
      logName: 'session.v4.jsonl.zstd',
      logVersion: 4,
    })
    const handlers = createApiHandlers(
      deps(sandbox, {
        sync: async () => ({ settings: { url: fixture.url, machineId: 'robot-a', mapping: {} }, dav }),
      }),
    )
    const wrong = fakeRes()
    await handlers['GET /sync-diff']!(
      fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared&machine=robot-c`),
      wrong.res,
    )
    assert.equal(wrong.captured.status, 409)
    assert.match(String(payload(wrong.captured)['error']), /是 robot-b 的，不是 robot-c 的/)

    const right = fakeRes()
    await handlers['GET /sync-diff']!(
      fakeReq('GET', `${API_PREFIX}/sync-diff?id=session-shared&machine=robot-b`),
      right.res,
    )
    assert.equal(right.captured.status, 200, '指名对得上就照常比')
  } finally {
    await fixture.close()
  }
})
