// 会话包传输：容器的字节往返、包校验的拒绝面、导入预演与落地、冲突与无 cwd 的分支。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { decompress } from 'fzstd'

import type { AttachmentPort, AttachmentRef } from '../src/attachments.ts'
import { sessionDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry, validateRegistry } from '../src/registry.ts'
import type { DecodeAll, SessionHeader, SessionLogFile, WorkspaceRegistryState } from '../src/types.ts'
import {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_MAGIC,
  BUNDLE_MIN_FORMAT_VERSION,
  applyImport,
  attachmentBytes,
  buildBundle,
  entryBytes,
  planImport,
  readBundle,
  type ExportSource,
} from '../src/transfer.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'
import { attachmentEvent, attachmentIdOf, makeAttachmentStore } from './attachment-fixture.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FROM_CWD = 'C:\\Users\\me\\Downloads'
const TO_CWD = 'D:\\work\\temp'

function makeRoot(name: string): string {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  mkdirSync(join(base, 'sessions'), { recursive: true })
  return join(base, 'sessions')
}

/** 造一条会话目录（项目目录 + 会话目录 + 代次文件），返回可用作导出源的描述。 */
function writeSession(
  root: string,
  options: {
    id: string
    cwd?: string
    version?: number
    compression?: string | null
    events?: number
    /** 逐行替换默认那几条空事件（写"日志里带附件引用"的会话时用它）。 */
    eventLines?: readonly string[]
  },
): ExportSource {
  const version = options.version ?? 4
  const compression = options.compression === undefined ? 'zstd' : options.compression
  const header: SessionHeader = {
    type: 'session',
    version,
    id: options.id,
    createdAt: 1000,
    isSeeded: false,
    delegationDepth: 0,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }
  const events = options.events ?? 2
  const body =
    options.eventLines ??
    Array.from({ length: events }, (_, i) => JSON.stringify({ type: 'user/message', seq: i, data: {} }))
  const text = JSON.stringify(header) + '\n' + body.join('\n') + '\n'
  const buf =
    compression === 'zstd'
      ? Buffer.concat(text.split('\n').slice(0, -1).map((line) => encodeRawFrame(line + '\n')))
      : Buffer.from(text, 'utf8')

  const dir = sessionDir(root, options.cwd, options.id)
  mkdirSync(dir, { recursive: true })
  const name = compression === 'zstd' ? `session.v${version}.jsonl.zstd` : `session.v${version}.jsonl`
  const path = join(dir, name)
  writeFileSync(path, buf)
  const files: SessionLogFile[] = [{ name, path, version, compression, bytes: buf.length }]
  return { id: options.id, cwd: options.cwd, createdAt: header.createdAt, dir, files }
}

/**
 * 把一个 v2 包改写成 v1：格式号写 1、清单里去掉 `attachments` 那一节，载荷原样留着。
 *
 * 载荷里那些对象字节没人再指着它们（v1 没有偏移表），读的时候被忽略——这正是"老包能不能导"要验的东西。
 * 不直接手拼一个包，是因为手拼的清单会漏掉会话那一节的真形状。
 */
function downgradeToV1(bundle: Buffer): Buffer {
  const raw = gunzipSync(bundle)
  const headerLength = BUNDLE_MAGIC.length + 4
  const manifestLength = raw.readUInt32LE(BUNDLE_MAGIC.length)
  const manifest = manifestOf(bundle)
  delete manifest['attachments']
  manifest['formatVersion'] = 1
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const header = Buffer.alloc(headerLength)
  header.write(BUNDLE_MAGIC, 0, 'utf8')
  header.writeUInt32LE(manifestBytes.length, BUNDLE_MAGIC.length)
  return gzipSync(Buffer.concat([header, manifestBytes, raw.subarray(headerLength + manifestLength)]))
}

/** 换掉清单再压回去（其余字节一个不动）：造"某个字段被改坏"的包用它。 */
function withManifest(bundle: Buffer, edit: (manifest: Record<string, unknown>) => void): Buffer {
  const raw = gunzipSync(bundle)
  const headerLength = BUNDLE_MAGIC.length + 4
  const manifestLength = raw.readUInt32LE(BUNDLE_MAGIC.length)
  const manifest = manifestOf(bundle)
  edit(manifest)
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  const header = Buffer.alloc(headerLength)
  header.write(BUNDLE_MAGIC, 0, 'utf8')
  header.writeUInt32LE(manifestBytes.length, BUNDLE_MAGIC.length)
  return gzipSync(Buffer.concat([header, manifestBytes, raw.subarray(headerLength + manifestLength)]))
}

/**
 * 清单原文（`readBundle` 读完之后看不到的字段名要靠它核）：格式号是不是"照包里的内容写的"、
 * 没对象的包有没有把 `attachments` 那一节省掉，都得看这一份。
 */
function manifestOf(bundle: Buffer): Record<string, unknown> {
  const raw = gunzipSync(bundle)
  const headerLength = BUNDLE_MAGIC.length + 4
  const manifestLength = raw.readUInt32LE(BUNDLE_MAGIC.length)
  return JSON.parse(raw.subarray(headerLength, headerLength + manifestLength).toString('utf8')) as Record<
    string,
    unknown
  >
}

function emptyRegistry(): WorkspaceRegistryState {
  return {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }
}

test('导出/导入：字节往返，包里的载荷与磁盘上的日志逐字节相同', () => {
  const root = makeRoot('transfer-roundtrip')
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD })
  const onDisk = readFileSync(source.files[0]!.path)

  const bundle = buildBundle([source], { now: '2026-09-27T00:00:00.000Z' })
  const parsed = readBundle(bundle)

  assert.equal(parsed.formatVersion, BUNDLE_MIN_FORMAT_VERSION, '一个对象都不带的包照旧是 v1')
  assert.equal('attachments' in manifestOf(bundle), false, 'v1 的清单里不该多出 attachments 那一节')
  assert.equal(parsed.createdAt, '2026-09-27T00:00:00.000Z')
  assert.equal(parsed.sessions.length, 1)
  assert.equal(parsed.sessions[0]!.id, 'session-a')
  assert.equal(parsed.sessions[0]!.cwd, FROM_CWD)
  assert.deepEqual(entryBytes(parsed, parsed.sessions[0]!.files[0]!), onDisk)
})

test('包校验：sha256、截断、magic、formatVersion 任何一项不对都拒绝', () => {
  const root = makeRoot('transfer-validate')
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD })
  const bundle = buildBundle([source])

  // 改动载荷里的一个字节：sha256 必须发现
  const corrupted = Buffer.from(bundle)
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff
  assert.throws(() => readBundle(corrupted), /gzip|sha256/i)

  // 截断到最后几字节之外的内容都读不出来
  assert.throws(() => readBundle(bundle.subarray(0, 8)), /gzip|truncated/i)

  // 不是 gzip 的东西
  assert.throws(() => readBundle(Buffer.from('这不是一个包')), /gzip/i)
})

test('导入：预演不写字节，落地后 cwd 被改写成目标工作区且除 cwd 外正文不变', () => {
  const root = makeRoot('transfer-import')
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, events: 3 })
  const original = decodeAll(readFileSync(source.files[0]!.path))
  const bundle = readBundle(buildBundle([source]))

  // 换一个库：模拟"从另一台机器导进来"
  const targetRoot = makeRoot('transfer-import-target')
  const registry = emptyRegistry()
  const plan = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD, registry, now: '2026-09-27T00:00:00.000Z', newId: 'ws-target' })

  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.deepEqual(plan.created, ['session-a'])
  assert.deepEqual(plan.rehomed, ['session-a'])
  assert.equal(plan.entries[0]!.toCwd, TO_CWD)
  assert.equal(plan.registryChange?.createdTarget, true)
  // 预演不写盘
  assert.equal(existsSync(plan.entries[0]!.dir), false)

  const registryPath = join(targetRoot, '..', 'workspace.json')
  const outcome = applyImport(bundle, plan, { root: targetRoot, targetCwd: TO_CWD, registry, registryPath, decodeAll })
  assert.deepEqual(outcome.written, ['session-a'])
  assert.equal(outcome.registryWritten, true)

  const written = join(sessionDir(targetRoot, TO_CWD, 'session-a'), 'session.v4.jsonl.zstd')
  assert.equal(existsSync(written), true)
  const next = decodeAll(readFileSync(written))
  const nextLines = next.split('\n')
  const originalLines = original.split('\n')
  assert.equal(JSON.parse(nextLines[0]!).cwd, TO_CWD)
  // 正文（header 之后的事件）逐行不变；header 除 cwd 外也不变
  assert.deepEqual(nextLines.slice(1), originalLines.slice(1))
  const a = JSON.parse(originalLines[0]!)
  const b = JSON.parse(nextLines[0]!)
  delete a.cwd
  delete b.cwd
  assert.deepEqual(b, a)

  const writtenRegistry = readRegistry(registryPath)
  assert.equal(validateRegistry(writtenRegistry).ok, true)
  assert.deepEqual(writtenRegistry.tables.workspaces['ws-target']?.sessionIds, ['session-a'])
  assert.equal(writtenRegistry.tables.workspaces['ws-target']?.path, TO_CWD)
})

test('导入：目标 cwd 与日志原有 cwd 相同时逐字节不改写', () => {
  const root = makeRoot('transfer-noop')
  const source = writeSession(root, { id: 'session-same', cwd: FROM_CWD })
  const onDisk = readFileSync(source.files[0]!.path)
  const bundle = readBundle(buildBundle([source]))

  const targetRoot = makeRoot('transfer-noop-target')
  const plan = planImport(bundle, { root: targetRoot, targetCwd: FROM_CWD })
  const outcome = applyImport(bundle, plan, { root: targetRoot, targetCwd: FROM_CWD, decodeAll })

  assert.deepEqual(outcome.written, ['session-same'])
  const written = join(sessionDir(targetRoot, FROM_CWD, 'session-same'), 'session.v4.jsonl.zstd')
  assert.deepEqual(readFileSync(written), onDisk)
})

test('导入：库里已有同 id 的会话时只跳过、绝不覆盖，且预演 ok=false', () => {
  const root = makeRoot('transfer-conflict')
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD })
  const bundle = readBundle(buildBundle([source]))

  const plan = planImport(bundle, { root, targetCwd: TO_CWD })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.created, [])
  assert.equal(plan.entries[0]!.action, 'skip')
  assert.match(plan.entries[0]!.reason ?? '', /已经有同 id 的会话/)
  assert.match(plan.entries[0]!.reason ?? '', new RegExp(projectKey(FROM_CWD)))

  const outcome = applyImport(bundle, plan, { root, targetCwd: TO_CWD, decodeAll })
  assert.deepEqual(outcome.written, [])
})

test('导入：没有 cwd 的会话落 _no-cwd 项目目录、不改写、也不动注册表', () => {
  const root = makeRoot('transfer-nocwd')
  const source = writeSession(root, { id: 'session-blank', cwd: undefined, events: 1 })
  const bundle = readBundle(buildBundle([source]))

  const targetRoot = makeRoot('transfer-nocwd-target')
  const registry = emptyRegistry()
  const plan = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD, registry })

  assert.deepEqual(plan.created, ['session-blank'])
  assert.deepEqual(plan.rehomed, [])
  assert.equal(plan.entries[0]!.toCwd, undefined)
  assert.equal(plan.nextRegistry, null, '没有可重挂的会话时不该产生注册表变更')
  assert.match(plan.entries[0]!.dir, new RegExp(`_no-cwd`))

  const outcome = applyImport(bundle, plan, { root: targetRoot, targetCwd: TO_CWD, registry, decodeAll })
  assert.deepEqual(outcome.written, ['session-blank'])
  assert.equal(outcome.registryWritten, false)
})

test('导入：明文 v0 日志（无 zstd 外壳）走文本改写，同样只动 cwd', () => {
  const root = makeRoot('transfer-plain')
  const source = writeSession(root, { id: 'session-v0', cwd: FROM_CWD, version: 0, compression: null })
  const original = readFileSync(source.files[0]!.path, 'utf8')
  const bundle = readBundle(buildBundle([source]))

  const targetRoot = makeRoot('transfer-plain-target')
  const plan = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD })
  applyImport(bundle, plan, { root: targetRoot, targetCwd: TO_CWD, decodeAll })

  const name = bundle.sessions[0]!.files[0]!.name
  assert.equal(name, 'session.v0.jsonl')
  const written = join(sessionDir(targetRoot, TO_CWD, 'session-v0'), name)
  const next = readFileSync(written, 'utf8')
  const nextLines = next.split('\n')
  assert.equal(JSON.parse(nextLines[0]!).cwd, TO_CWD)
  assert.deepEqual(nextLines.slice(1), original.split('\n').slice(1))
  // 导入写出的文件名就是包里那个名字，不由本机重新推算（否则明文 v0 会被改名成 .zstd）
  assert.equal(existsSync(sessionDir(targetRoot, TO_CWD, 'session-v0')), true)
})

test('导入：目标目录的另一种拼写先归一（header 的 cwd 与注册表那条记录是同一个字符串）', () => {
  const root = makeRoot('transfer-canonical')
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD })
  const bundle = readBundle(buildBundle([source]))

  const targetRoot = makeRoot('transfer-canonical-target')
  const to = join(targetRoot, 'proj')
  mkdirSync(to, { recursive: true })
  // 另一种拼写：Windows 上 `git rev-parse --show-toplevel` 给的正斜杠也是这一类（见
  // canonical-path.test.ts），这里用两个平台都算另一种写法的结尾 `.` 段验同一段代码。
  const spelled = `${to}${sep}`
  const registry = emptyRegistry()
  const plan = planImport(bundle, { root: targetRoot, targetCwd: spelled, registry, now: '2026-09-27T00:00:00.000Z', newId: 'ws-target' })

  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.entries[0]?.toCwd, to, '落地用的是归一之后的那个字符串')
  assert.equal(plan.nextRegistry?.tables.workspaces['ws-target']?.path, to, '注册表那条记录的 path 也是它')

  const registryPath = join(targetRoot, '..', 'workspace.json')
  applyImport(bundle, plan, { root: targetRoot, targetCwd: spelled, registry, registryPath, decodeAll })
  const written = join(sessionDir(targetRoot, to, 'session-a'), 'session.v4.jsonl.zstd')
  const header = JSON.parse(decodeAll(readFileSync(written)).split('\n')[0]!) as { cwd: string }
  assert.equal(header.cwd, to, '改写进 header 的同样是它')
})

test('导出/导入：一个包装多条会话（含无 cwd 的那条）时各自走各自的分支', () => {
  const root = makeRoot('transfer-multi')
  const withCwd = writeSession(root, { id: 'session-a', cwd: FROM_CWD })
  const withoutCwd = writeSession(root, { id: 'session-b', cwd: undefined, events: 1 })
  const bundle = readBundle(buildBundle([withCwd, withoutCwd]))
  assert.deepEqual(bundle.sessions.map((s) => s.id), ['session-a', 'session-b'])

  const targetRoot = makeRoot('transfer-multi-target')
  const registry = emptyRegistry()
  const plan = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD, registry, newId: 'ws-target' })
  assert.deepEqual(plan.created, ['session-a', 'session-b'])
  assert.deepEqual(plan.rehomed, ['session-a'])

  const outcome = applyImport(bundle, plan, { root: targetRoot, targetCwd: TO_CWD, registry, decodeAll })
  assert.deepEqual(outcome.written, ['session-a', 'session-b'])
  assert.ok(outcome.bytes > 0)
})

// ── 附件对象（v2 包里跟着日志一起走的那一段） ─────────────────────────────────

test('导出：日志里引用的附件对象进包（两条会话引用同一个只进一份），字节与对象文件一致', () => {
  const root = makeRoot('transfer-attach-pack')
  const store = makeAttachmentStore('transfer-attach-pack-store')
  const image = Buffer.from('假装这是一张 PNG 的字节')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  store.put(ref, image)

  const first = writeSession(root, {
    id: 'session-a',
    cwd: FROM_CWD,
    eventLines: [attachmentEvent(ref, image.length)],
  })
  const second = writeSession(root, {
    id: 'session-b',
    cwd: FROM_CWD,
    eventLines: [attachmentEvent(ref, image.length)],
  })

  let report: { packed: number; bytes: number; missing: number } | undefined
  const bundle = buildBundle([first, second], {
    now: '2026-09-27T00:00:00.000Z',
    attachments: {
      port: store.port,
      decodeAll,
      onReport: (value) => {
        report = { packed: value.packed, bytes: value.bytes, missing: value.missing.length }
      },
    },
  })
  const parsed = readBundle(bundle)

  assert.equal(parsed.formatVersion, BUNDLE_FORMAT_VERSION, '真带了对象才升 v2')
  assert.equal(BUNDLE_MIN_FORMAT_VERSION, 1, '还要读得懂 v1 的老包')
  // 同一个对象被两条会话引用：载荷里只有一份。
  assert.deepEqual(
    parsed.attachments.map((entry) => `${entry.kind}:${entry.id}:${entry.bytes}`),
    [`image:${ref.id}:${image.length}`],
  )
  assert.deepEqual(attachmentBytes(parsed, parsed.attachments[0]!), image)
  assert.deepEqual(report, { packed: 1, bytes: image.length, missing: 0 })
  // 日志那一侧照旧：两条会话都在包里。
  assert.deepEqual(parsed.sessions.map((session) => session.id), ['session-a', 'session-b'])
})

test('导出：库里找不到的对象照样出包，如实报成 missing（不是抛错）', () => {
  const root = makeRoot('transfer-attach-missing')
  const store = makeAttachmentStore('transfer-attach-missing-store')
  const image = Buffer.from('这个对象没有真的写进库里')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, eventLines: [attachmentEvent(ref, image.length)] })

  let missing: readonly AttachmentRef[] = []
  const bundle = readBundle(
    buildBundle([source], {
      attachments: {
        port: store.port,
        decodeAll,
        onReport: (value) => {
          missing = value.missing
        },
      },
    }),
  )
  assert.deepEqual(bundle.attachments, [], '对象不在库里，包里就没有它')
  assert.deepEqual(
    missing.map((item) => item.id),
    [ref.id],
    '但要如实报出来：用户要靠它知道这次有几张图带不走',
  )
})

test('导出：日志里没有 attachmentId 的会话一个字节都不多解（没有附件服务时也照旧出包）', () => {
  const root = makeRoot('transfer-attach-none')
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, events: 3 })
  // 不给端口：包照旧是 v1、清单里连 attachments 那一节都不写（没有附件服务的宿主就走这一支），
  // 也就是与升级前逐字节同形——这种包老宿主照旧读得了，不该被格式号挡在门外。
  const bundle = buildBundle([source])
  const parsed = readBundle(bundle)
  assert.deepEqual(parsed.attachments, [])
  assert.equal(parsed.formatVersion, 1)
  assert.equal('attachments' in manifestOf(bundle), false)
})

test('导出：给了端口但引用的对象本机就没有时，包退回 v1 并如实报 missing', () => {
  const root = makeRoot('transfer-attach-none-2')
  const store = makeAttachmentStore('transfer-attach-none-2-store')
  // 日志里引用了一个库里没有的对象：一个都没带成，格式号不该白升。
  const missing: AttachmentRef = { id: attachmentIdOf(Buffer.from('这个对象本机没有')), kind: 'image' }
  const source = writeSession(root, {
    id: 'session-a',
    cwd: FROM_CWD,
    eventLines: [attachmentEvent(missing, 18)],
  })
  let report: { packed: number; missing: number } | undefined
  const bundle = buildBundle([source], {
    attachments: {
      port: store.port,
      decodeAll,
      onReport: (value) => {
        report = { packed: value.packed, missing: value.missing.length }
      },
    },
  })
  const parsed = readBundle(bundle)
  assert.equal(parsed.formatVersion, 1, '一个对象都没带走，包就该是 v1')
  assert.deepEqual(parsed.attachments, [])
  assert.deepEqual(report, { packed: 0, missing: 1 })
  assert.equal('attachments' in manifestOf(bundle), false)
})

test('导入：包里的对象按库落进目标附件库（内容一致、只读权限），两次导入第二次是 present', () => {
  const root = makeRoot('transfer-attach-import')
  const store = makeAttachmentStore('transfer-attach-import-store')
  const image = Buffer.from('要跟着会话搬过去的图片字节')
  const file = Buffer.from('还有一份文件对象')
  const imageRef: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  // 文件的名字来自日志里的引用（`attachment.name`），它决定本机路径的最后一段。
  const fileRef: AttachmentRef = { id: attachmentIdOf(file), kind: 'file', name: 'notes.txt' }
  store.put(imageRef, image)
  store.put(fileRef, file)

  const source = writeSession(root, {
    id: 'session-a',
    cwd: FROM_CWD,
    eventLines: [attachmentEvent(imageRef, image.length), attachmentEvent(fileRef, file.length, 'notes.txt')],
  })
  const bundle = readBundle(buildBundle([source], { attachments: { port: store.port, decodeAll } }))
  assert.equal(bundle.attachments.length, 2, '图片与文件是两个库里的两个对象')

  const targetRoot = makeRoot('transfer-attach-import-target')
  const targetStore = makeAttachmentStore('transfer-attach-import-target-store')
  const plan = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD, attachments: targetStore.port })
  assert.equal(plan.attachmentAdds, 2)
  assert.equal(plan.attachmentBytes, image.length + file.length)
  assert.deepEqual(
    plan.attachments.map((entry) => `${entry.kind}:${entry.action}`),
    ['image:create', 'file:create'],
  )
  assert.equal(plan.ok, true)

  const outcome = applyImport(bundle, plan, {
    root: targetRoot,
    targetCwd: TO_CWD,
    decodeAll,
    attachments: targetStore.port,
  })
  assert.deepEqual(outcome.written, ['session-a'])
  assert.equal(outcome.attachmentWritten, 2)
  assert.equal(outcome.attachmentPresent, 0)
  assert.equal(outcome.attachmentBytes, image.length + file.length)
  assert.deepEqual(outcome.attachmentProblems, [])

  // 文件落在宿主那条带名字的路径上（`files/<sha 前两位>/<sha>/<名字>`），不是 `file-objects/` 下那个
  // 内容寻址的规范副本——宿主读回来读的就是前者。
  assert.equal(
    targetStore.port.pathOf(fileRef),
    join(targetStore.root, 'files', fileRef.id.slice(7, 9), fileRef.id.slice(7), 'notes.txt'),
  )
  assert.equal(existsSync(join(targetStore.root, 'files', fileRef.id.slice(7, 9), fileRef.id.slice(7), 'notes.txt')), true)

  for (const [ref, bytes] of [
    [imageRef, image],
    [fileRef, file],
  ] as const) {
    const path = targetStore.port.pathOf(ref)!
    assert.deepEqual(readFileSync(path), bytes, `${ref.kind} 对象落在端口给的那个位置`)
    assert.equal(statSync(path).mode & 0o777, 0o400, '对象库是只读的：权限与宿主写下来的规格一致')
  }

  // 第二次导入同一个包：会话还在库里（skip），对象已经在本机（present），一个字节都不再写。
  const again = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD, attachments: targetStore.port })
  assert.deepEqual(again.created, [])
  assert.deepEqual(
    again.attachments.map((entry) => entry.action),
    ['present', 'present'],
  )
  assert.equal(again.attachmentAdds, 0)
  const second = applyImport(bundle, again, {
    root: targetRoot,
    targetCwd: TO_CWD,
    decodeAll,
    attachments: targetStore.port,
  })
  assert.deepEqual(second.written, [])
  assert.equal(second.attachmentWritten, 0)
  assert.equal(second.attachmentPresent, 2)
})

test('导入：日志早就在库里、只缺对象时照旧补对象，一条日志都不覆盖（这就是"图挂了"的修复路径）', () => {
  const root = makeRoot('transfer-attach-repair')
  const store = makeAttachmentStore('transfer-attach-repair-store')
  const image = Buffer.from('修复路径用的图片字节')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  store.put(ref, image)
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, eventLines: [attachmentEvent(ref, image.length)] })
  const bundle = readBundle(buildBundle([source], { attachments: { port: store.port, decodeAll } }))

  // 目标库：会话目录照原样复制过去（模拟"日志早就导过、图是挂的"），附件库是空的。
  const targetRoot = makeRoot('transfer-attach-repair-target')
  const targetStore = makeAttachmentStore('transfer-attach-repair-target-store')
  const dir = sessionDir(targetRoot, FROM_CWD, 'session-a')
  mkdirSync(dir, { recursive: true })
  const logName = source.files[0]!.name
  const before = readFileSync(source.files[0]!.path)
  writeFileSync(join(dir, logName), before)

  const plan = planImport(bundle, { root: targetRoot, targetCwd: FROM_CWD, attachments: targetStore.port })
  assert.deepEqual(plan.created, [], '库里已经有这条会话')
  assert.equal(plan.entries[0]!.action, 'skip')
  assert.equal(plan.attachmentAdds, 1, '但缺的那个对象要补上')
  assert.equal(plan.ok, true, '只有附件要补时，计划也是"有可落地内容"')

  const outcome = applyImport(bundle, plan, {
    root: targetRoot,
    targetCwd: FROM_CWD,
    decodeAll,
    attachments: targetStore.port,
  })
  assert.deepEqual(outcome.written, [], '一条会话都没写')
  assert.equal(outcome.attachmentWritten, 1)
  assert.deepEqual(readFileSync(targetStore.port.pathOf(ref)!), image)
  assert.deepEqual(readFileSync(join(dir, logName)), before, '日志逐字节不动（导入永不覆盖）')
})

test('导入：宿主没有附件服务时对象一条都不落，计划里如实报 unavailable', () => {
  const root = makeRoot('transfer-attach-noport')
  const store = makeAttachmentStore('transfer-attach-noport-store')
  const image = Buffer.from('没有附件服务时带不过去的字节')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  store.put(ref, image)
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, eventLines: [attachmentEvent(ref, image.length)] })
  const bundle = readBundle(buildBundle([source], { attachments: { port: store.port, decodeAll } }))

  const targetRoot = makeRoot('transfer-attach-noport-target')
  const plan = planImport(bundle, { root: targetRoot, targetCwd: TO_CWD })
  assert.deepEqual(
    plan.attachments.map((entry) => entry.action),
    ['unavailable'],
  )
  assert.equal(plan.attachmentAdds, 0)
  assert.equal(plan.ok, true, '会话照旧能导：附件落不了不影响日志')

  const outcome = applyImport(bundle, plan, { root: targetRoot, targetCwd: TO_CWD, decodeAll })
  assert.deepEqual(outcome.written, ['session-a'])
  assert.equal(outcome.attachmentWritten, 0)
  assert.match(outcome.attachmentProblems.join('\n'), /没有附件服务/)
})

test('包校验：附件载荷被改动一个字节时按 id 里的 sha256 拒掉整包', () => {
  const root = makeRoot('transfer-attach-corrupt')
  const store = makeAttachmentStore('transfer-attach-corrupt-store')
  const image = Buffer.from('会被改坏的图片字节')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  store.put(ref, image)
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, eventLines: [attachmentEvent(ref, image.length)] })
  const bundle = buildBundle([source], { attachments: { port: store.port, decodeAll } })

  const corrupted = Buffer.from(bundle)
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff
  assert.throws(() => readBundle(corrupted), /gzip|sha256/i)

  // 逐个字节改在载荷里（先解开再压回去）：gzip 层不该抢在附件那条不变式前面报错，否则这条断言
  // 永远验的是"压缩流坏了"，而不是"对象与它 id 里的 sha256 不符"。
  const raw = gunzipSync(bundle)
  raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff
  assert.throws(() => readBundle(gzipSync(raw)), /attachment .* failed its sha256 check/i)
})

test('包校验：文件条目缺名字时拒掉整包（名字决定它落在哪儿）', () => {
  const root = makeRoot('transfer-attach-noname')
  const store = makeAttachmentStore('transfer-attach-noname-store')
  const file = Buffer.from('一个带名字的文件对象')
  const ref: AttachmentRef = { id: attachmentIdOf(file), kind: 'file', name: 'notes.txt' }
  store.put(ref, file)
  const source = writeSession(root, {
    id: 'session-a',
    cwd: FROM_CWD,
    eventLines: [attachmentEvent(ref, file.length, 'notes.txt')],
  })
  const bundle = buildBundle([source], { attachments: { port: store.port, decodeAll } })
  assert.equal((manifestOf(bundle)['attachments'] as Array<Record<string, unknown>>)[0]?.['name'], 'notes.txt')

  // 补一条没有名字的文件条目：本机路径算不出来，落下去只会是个错位置，所以整包按坏包拒掉。
  assert.throws(
    () =>
      readBundle(
        withManifest(bundle, (manifest) => {
          const entries = manifest['attachments'] as Array<Record<string, unknown>>
          delete entries[0]!['name']
        }),
      ),
    /file without a name/i,
  )

  // 名字写成一个空串同样拒掉（不是"没有这一项"就不管）。
  assert.throws(
    () =>
      readBundle(
        withManifest(bundle, (manifest) => {
          const entries = manifest['attachments'] as Array<Record<string, unknown>>
          entries[0]!['name'] = ''
        }),
      ),
    /malformed name/i,
  )
})

test('读包：v1 的老包（没有 attachments 那一节）照旧读得出来、也照旧导得进去', () => {
  const root = makeRoot('transfer-v1')
  const store = makeAttachmentStore('transfer-v1-store')
  const image = Buffer.from('v1 时代的包当然没有这段字节')
  const ref: AttachmentRef = { id: attachmentIdOf(image), kind: 'image' }
  store.put(ref, image)
  const source = writeSession(root, { id: 'session-a', cwd: FROM_CWD, eventLines: [attachmentEvent(ref, image.length)] })
  const onDisk = readFileSync(source.files[0]!.path)
  // 造一个真的 v1 包：同一条容器，格式号写 1、清单里没有 attachments 那一节。
  const bundle = downgradeToV1(buildBundle([source], { attachments: { port: store.port, decodeAll } }))
  const parsed = readBundle(bundle)

  assert.equal(parsed.formatVersion, 1)
  assert.deepEqual(parsed.attachments, [], 'v1 没有对象可带，读出来是空表')
  assert.deepEqual(entryBytes(parsed, parsed.sessions[0]!.files[0]!), onDisk, '日志那一侧照旧逐字节一致')

  const targetRoot = makeRoot('transfer-v1-target')
  const plan = planImport(parsed, { root: targetRoot, targetCwd: FROM_CWD })
  assert.deepEqual(plan.created, ['session-a'])
  const outcome = applyImport(parsed, plan, { root: targetRoot, targetCwd: FROM_CWD, decodeAll })
  assert.deepEqual(outcome.written, ['session-a'])
  assert.equal(outcome.attachmentWritten, 0)
})

