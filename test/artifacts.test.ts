// 会话产物：提取（证据分层）、收窄（存在性 + 嵌套剪枝）、搬迁与回滚。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { applyArtifactMoves, extractArtifactsFromLog, isInside, planArtifactMoves, resolveArtifactPath } from '../src/artifacts.ts'
import { applyPlan, verifyAppliedPlan } from '../src/execute.ts'
import { readManifest, rollback } from '../src/journal.ts'
import { buildRelocationPlan } from '../src/plan.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import type { ArtifactMove, DecodeAll, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const CWD = 'C:\\Users\\me\\Downloads'

/** 直接构造 JSONL 正文（纯提取测试不需要 zstd 外壳）。 */
function logText(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n'
}
const writeCall = (p: string) => ({
  type: 'tool/call',
  seq: 1,
  time: 1,
  data: { name: 'write', arguments: JSON.stringify({ file_path: p }) },
})
const editCall = (p: string) => ({
  type: 'tool/call',
  seq: 2,
  time: 2,
  data: { name: 'edit', arguments: JSON.stringify({ file_path: p }) },
})
const shellCall = (cmd: string) => ({
  type: 'tool/call',
  seq: 3,
  time: 3,
  data: { name: 'pwsh', arguments: JSON.stringify({ command: cmd }) },
})
const delivered = (...paths: string[]) => ({
  type: 'deliverables/presented',
  seq: 4,
  time: 4,
  data: { turn: 1, files: paths.map((p) => ({ path: p, description: 'x' })) },
})

test('提取：write=创建、edit=修改、deliverables=交付、shell=启发式', () => {
  const text = logText([
    writeCall(CWD + '\\a.mjs'),
    editCall(CWD + '\\a.mjs'),
    writeCall(CWD + '\\dir\\b.txt'),
    delivered(CWD + '\\dir\\b.txt'),
    shellCall(`New-Item -ItemType Directory -Force -Path '${CWD}\\cache'`),
  ])
  const { candidates } = extractArtifactsFromLog(text, { cwd: CWD })
  const byPath = new Map(candidates.map((c) => [c.path, c]))

  // 同一路径上 write 比 edit 强
  assert.equal(byPath.get(CWD + '\\a.mjs')?.kind, 'created')
  assert.deepEqual(byPath.get(CWD + '\\a.mjs')?.via, ['write', 'edit'])
  // write 比 delivered 强
  assert.equal(byPath.get(CWD + '\\dir\\b.txt')?.kind, 'created')
  // shell 命令里的造物路径
  assert.equal(byPath.get(CWD + '\\cache')?.kind, 'shell')
})

test('提取：相对路径按 cwd 解析；工作区外的路径也会被提取（由规划层收窄）', () => {
  const text = logText([writeCall('sub\\rel.txt'), writeCall('D:\\elsewhere\\x.txt')])
  const { candidates } = extractArtifactsFromLog(text, { cwd: CWD })
  const paths = candidates.map((c) => c.path).sort()
  // 期望值用 win32 那套算：被测行为是「按路径自己的方言解析」，与当前宿主无关——
  // 宿主的 join 在 Linux 上会给出 `C:\Users\me\Downloads/sub/rel.txt` 这种混着来的串。
  assert.deepEqual(paths, [win32.join(CWD, 'sub', 'rel.txt'), 'D:\\elsewhere\\x.txt'])
  assert.equal(isInside(win32.join(CWD, 'sub', 'rel.txt'), CWD), true)
  assert.equal(isInside('D:\\elsewhere\\x.txt', CWD), false)
})

test('提取：无造物动词的 shell 命令不产生候选', () => {
  const text = logText([shellCall(`Get-ChildItem '${CWD}\\a.mjs'`)])
  assert.equal(extractArtifactsFromLog(text, { cwd: CWD }).candidates.length, 0)
})

test('规划：与磁盘存在性求交 + 工作区外剔除', () => {
  const text = logText([
    writeCall(CWD + '\\exists.txt'),
    writeCall(CWD + '\\gone.txt'),
    writeCall(CWD + '\\sub\\in.txt'),
    writeCall('D:\\out\\x.txt'),
  ])
  const present = new Set([CWD + '\\exists.txt', CWD + '\\sub\\in.txt'])
  const plan = planArtifactMoves({
    sessions: [{ id: 's1', text }],
    fromDir: CWD,
    toDir: 'C:\\Users\\me\\Work\\temp',
    exists: (p) => present.has(p),
    isDirectory: () => false,
  })
  assert.deepEqual(plan.moves.map((m) => m.relative).sort(), ['exists.txt', 'sub\\in.txt'])
  const reasons = plan.skipped.map((s) => s.reason).sort()
  assert.deepEqual(reasons, ['no longer on disk', 'outside the source workspace'])
  assert.equal(plan.problems.length, 0)
})

test('规划：嵌套剪枝——目录整体搬走时不再单独搬它内部的文件', () => {
  const dir = CWD + '\\proj'
  const inside = dir + '\\lib\\x.mjs'
  const text = logText([writeCall(dir), writeCall(inside), writeCall(CWD + '\\loose.mjs')])
  const present = new Set([dir, inside, CWD + '\\loose.mjs'])
  const plan = planArtifactMoves({
    sessions: [{ id: 's1', text }],
    fromDir: CWD,
    toDir: 'C:\\Users\\me\\Work\\temp',
    exists: (p) => present.has(p),
    isDirectory: (p) => p === dir,
  })
  assert.deepEqual(plan.moves.map((m) => m.relative).sort(), ['loose.mjs', 'proj'])
})

test('规划：目标位已存在时报问题（拒绝覆盖）', () => {
  const text = logText([writeCall(CWD + '\\x.txt')])
  const plan = planArtifactMoves({
    sessions: [{ id: 's1', text }],
    fromDir: CWD,
    toDir: 'C:\\to',
    exists: () => true,
    isDirectory: () => false,
  })
  assert.match(plan.problems.join(';'), /already exists/)
})

test('规划：includeKinds 可排除被修改的文件', () => {
  const text = logText([writeCall(CWD + '\\new.txt'), editCall(CWD + '\\old.txt')])
  const exists = () => true
  const all = planArtifactMoves({ sessions: [{ id: 's1', text }], fromDir: CWD, toDir: 'C:\\to', exists, isDirectory: () => false })
  assert.deepEqual(all.moves.map((m) => m.relative).sort(), ['new.txt', 'old.txt'])
  const createdOnly = planArtifactMoves({
    sessions: [{ id: 's1', text }],
    fromDir: CWD,
    toDir: 'C:\\to',
    exists,
    isDirectory: () => false,
    includeKinds: ['created'],
  })
  assert.deepEqual(createdOnly.moves.map((m) => m.relative), ['new.txt'])
  assert.match(createdOnly.skipped.map((s) => s.reason).join(';'), /excluded/)
})

test('resolveArtifactPath：绝对保留、相对按 cwd 解析、空值返回 null', () => {
  assert.equal(resolveArtifactPath('D:\\a\\b', CWD), 'D:\\a\\b')
  // 同上：cwd 是 Windows 方言，相对路径就按 win32 解析，与宿主平台无关。
  assert.equal(resolveArtifactPath('a\\b', CWD), win32.join(CWD, 'a', 'b'))
  assert.equal(resolveArtifactPath('', CWD), null)
  assert.equal(resolveArtifactPath(null, CWD), null)
})

// ---- 与迁移引擎的端到端集成 ----

interface Sandbox {
  base: string
  root: string
  registryPath: string
  registry: WorkspaceRegistryState
  fromDir: string
  toDir: string
  bucket: string
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
  mkdirSync(join(root, projectKey(toDir)), { recursive: true })

  // 会话产物：一个目录（含内部文件）、一个独立文件、一个已被删除的文件
  mkdirSync(join(fromDir, 'proj', 'lib'), { recursive: true })
  writeFileSync(join(fromDir, 'proj', 'lib', 'x.mjs'), 'inside\n')
  writeFileSync(join(fromDir, 'loose.md'), 'loose\n')

  const header = { type: 'session', version: 4, id: 'session-a', createdAt: 1, cwd: fromDir, isSeeded: false, delegationDepth: 0 }
  const events = [
    { type: 'tool/call', seq: 0, time: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: join(fromDir, 'proj', 'lib', 'x.mjs') }) } },
    { type: 'tool/call', seq: 1, time: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: join(fromDir, 'proj') }) } },
    { type: 'tool/call', seq: 2, time: 3, data: { name: 'write', arguments: JSON.stringify({ file_path: join(fromDir, 'loose.md') }) } },
    { type: 'tool/call', seq: 3, time: 4, data: { name: 'write', arguments: JSON.stringify({ file_path: join(fromDir, 'gone.txt') }) } },
    { type: 'deliverables/presented', seq: 4, time: 5, data: { turn: 1, files: [{ path: join(fromDir, 'loose.md'), description: 'd' }] } },
  ]
  const frames = [encodeRawFrame(JSON.stringify(header) + '\n'), ...events.map((e) => encodeRawFrame(JSON.stringify(e) + '\n'))]
  writeFileSync(join(root, bucket, 'session-a', 'session.v4.jsonl.zstd'), Buffer.concat(frames))

  const registryPath = join(base, 'dsh', 'storages', 'workspace.json')
  mkdirSync(join(base, 'dsh', 'storages'), { recursive: true })
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-dl', 'ws-temp'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-dl': { path: fromDir, title: 'downloads', sessionIds: ['session-a'], createdAt: 'x', updatedAt: 'x' },
        'ws-temp': { path: toDir, title: 'temp', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
      },
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')
  return { base, root, registryPath, registry, fromDir, toDir, bucket, backupRoot: join(base, 'backups') }
}

test('集成：includeArtifacts 时产物随会话一起搬，并可字节级回滚', () => {
  const sb = makeSandbox('artifacts')
  const plan = buildRelocationPlan({
    root: sb.root,
    registry: sb.registry,
    from: sb.fromDir,
    to: sb.toDir,
    decodeAll,
    includeArtifacts: true,
  })
  assert.equal(plan.ok, true, plan.problems.join('; '))
  // proj 目录整体搬 → 其中的 x.mjs 被剪掉；gone.txt 不在磁盘上被跳过
  assert.deepEqual(plan.artifacts?.moves.map((m) => m.relative).sort(), ['loose.md', 'proj'])
  assert.match(plan.artifacts?.skipped.map((s) => s.reason).join(';') ?? '', /no longer on disk/)

  const applied = applyPlan(plan, {
    registryPath: sb.registryPath,
    decodeAll,
    backupRoot: sb.backupRoot,
    now: new Date('2026-09-27T00:00:00Z'),
  })
  assert.equal(applied.artifactsMoved, 2)
  assert.ok(existsSync(join(sb.toDir, 'proj', 'lib', 'x.mjs')), '目录内的文件应随之到达')
  assert.ok(existsSync(join(sb.toDir, 'loose.md')))
  assert.equal(existsSync(join(sb.fromDir, 'proj')), false)
  assert.equal(existsSync(join(sb.fromDir, 'loose.md')), false)

  const v = verifyAppliedPlan(plan, { decodeAll })
  assert.equal(v.ok, true, v.problems.join('; '))

  // 回滚：产物也要回到原位
  const { manifest } = readManifest(applied.backupDir)
  assert.equal(manifest.artifacts.length, 2)
  const rb = rollback(manifest, { backupDir: applied.backupDir })
  assert.equal(rb.restoredArtifacts, 2)
  assert.ok(existsSync(join(sb.fromDir, 'proj', 'lib', 'x.mjs')))
  assert.equal(readFileSync(join(sb.fromDir, 'loose.md'), 'utf8'), 'loose\n')
  assert.equal(existsSync(join(sb.toDir, 'proj')), false)
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry)

  rmSync(sb.base, { recursive: true, force: true })
})

test('集成：不传 includeArtifacts 时不动任何产物', () => {
  const sb = makeSandbox('no-artifacts')
  const plan = buildRelocationPlan({ root: sb.root, registry: sb.registry, from: sb.fromDir, to: sb.toDir, decodeAll })
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.artifacts, null)
  applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot, now: new Date('2026-09-27T00:00:00Z') })
  assert.ok(existsSync(join(sb.fromDir, 'proj', 'lib', 'x.mjs')), '未要求时产物必须原地不动')
  assert.ok(existsSync(join(sb.fromDir, 'loose.md')))
  rmSync(sb.base, { recursive: true, force: true })
})

test('applyArtifactMoves：真实文件系统上搬运并建目录', () => {
  const base = join(import.meta.dirname, '.sandbox', 'moves')
  rmSync(base, { recursive: true, force: true })
  const src = join(base, 'src')
  const dst = join(base, 'dst')
  mkdirSync(join(src, 'a', 'b'), { recursive: true })
  writeFileSync(join(src, 'a', 'b', 'f.txt'), 'hi\n')
  const moves: ArtifactMove[] = [
    {
      sourcePath: join(src, 'a'),
      targetPath: join(dst, 'a'),
      isDir: true,
      kind: 'created',
      sessionIds: ['s'],
      relative: 'a',
    },
  ]
  const r = applyArtifactMoves(moves)
  assert.equal(r.moved, 1)
  assert.equal(readFileSync(join(dst, 'a', 'b', 'f.txt'), 'utf8'), 'hi\n')
  assert.equal(existsSync(join(src, 'a')), false)
  rmSync(base, { recursive: true, force: true })
})
