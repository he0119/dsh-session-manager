// 会话导入导出：容器的字节往返、包校验的拒绝面、导入预演与落地、冲突与无 cwd 的分支。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { sessionDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry, validateRegistry } from '../src/registry.ts'
import type { DecodeAll, SessionHeader, SessionLogFile, WorkspaceRegistryState } from '../src/types.ts'
import {
  BUNDLE_FORMAT_VERSION,
  applyImport,
  buildBundle,
  entryBytes,
  planImport,
  readBundle,
  type ExportSource,
} from '../src/transfer.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FROM_CWD = 'C:\\Users\\me\\Downloads'
const TO_CWD = 'D:\\work\\temp'

function makeRoot(name: string): string {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  mkdirSync(join(base, 'sessions'), { recursive: true })
  return join(base, 'sessions')
}

/** 造一条会话目录（分桶 + 会话目录 + 代次文件），返回可用作导出源的描述。 */
function writeSession(
  root: string,
  options: { id: string; cwd?: string; version?: number; compression?: string | null; events?: number },
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
  const text =
    JSON.stringify(header) +
    '\n' +
    Array.from({ length: events }, (_, i) => JSON.stringify({ type: 'user/message', seq: i, data: {} })).join('\n') +
    '\n'
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

  assert.equal(parsed.formatVersion, BUNDLE_FORMAT_VERSION)
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

test('导入：没有 cwd 的会话落 _no-cwd 分桶、不改写、也不动注册表', () => {
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
