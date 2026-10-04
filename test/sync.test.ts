// WebDAV 同步：计划是纯计算，落地打一个真的 WebDAV 夹具（两台假机器各一个库）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { createDavClient, type DavPort } from '../src/dav.ts'
import { scanAll, type DiscoveredSession } from '../src/discovery.ts'
import { sessionDir } from '../src/paths.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry, writeRegistryAtomic } from '../src/registry.ts'
import {
  SYNC_INDEX_FILE,
  contentFingerprint,
  SYNC_NAMESPACE_DIR,
  fileFingerprint,
  normalizeMapping,
  parseIndex,
  planSync,
  readRemoteLibrary,
  relation,
  remoteBundlePath,
  remoteIndexPath,
  runSync,
  testSyncConnection,
  type FileFingerprint,
  type RemoteLibrary,
  type RemoteSessionEntry,
  type SyncProgress,
  type SyncSettings,
} from '../src/sync.ts'
import type { GitRunner } from '../src/repo.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'
import { startDavFixture } from './dav-fixture.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')
const SANDBOX = join(import.meta.dirname, '.sandbox', 'sync')

// ── 假机器 ────────────────────────────────────────────────────────────────

interface Machine {
  base: string
  cwd: string
  sessionsRoot: string
  registryPath: string
}

/** 造一台机器：一个真实存在的工作区目录、一个空的会话库、一份登记了它的注册表。 */
function makeMachine(name: string): Machine {
  const base = join(SANDBOX, name)
  rmSync(base, { recursive: true, force: true })
  const cwd = join(base, 'proj')
  mkdirSync(cwd, { recursive: true })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const registryPath = join(base, 'workspace.json')
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }
  writeRegistryAtomic(registryPath, registry)
  return { base, cwd, sessionsRoot, registryPath }
}

/** 往一台机器的库里写一条会话（格式与宿主写的一致：多帧 zstd 的 raw block）。 */
function writeSession(machine: Machine, id: string, createdAt: number, options: { title?: string; cwd?: string } = {}): void {
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt,
    cwd: options.cwd ?? machine.cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const lines = [JSON.stringify(header), JSON.stringify({ type: 'user/message', seq: 0, data: {} })]
  if (options.title !== undefined) {
    lines.push(JSON.stringify({ type: 'session/title', seq: 1, data: { title: options.title, source: { kind: 'fallback' } } }))
  }
  const dir = sessionDir(machine.sessionsRoot, header.cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))))
}

/** 给一条已有会话再加一代日志（宿主续写会话就是这个形状：同一个目录里多一个 `session.vN`）。 */
function addGeneration(machine: Machine, id: string, version: number): void {
  const dir = sessionDir(machine.sessionsRoot, machine.cwd, id)
  const header: SessionHeader = {
    type: 'session',
    version,
    id,
    createdAt: 1000,
    cwd: machine.cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  writeFileSync(
    join(dir, `session.v${version}.jsonl.zstd`),
    Buffer.concat([JSON.stringify(header), '\n'].map((line) => encodeRawFrame(line))),
  )
}

/** 这台机器的同步设置。 */
function settings(machine: Machine, overrides: Partial<SyncSettings> = {}): SyncSettings {
  return { url: '', machineId: 'robot-a', mapping: {}, ...overrides }
}

/** 用一台机器的库跑一次同步。 */
async function syncMachine(
  machine: Machine,
  dav: ReturnType<typeof createDavClient>,
  config: SyncSettings,
  options: {
    apply: boolean
    titles?: Record<string, string>
    git?: GitRunner
    onProgress?: (event: SyncProgress) => void
  },
): Promise<Awaited<ReturnType<typeof runSync>>> {
  return runSync(
    {
      dav,
      settings: config,
      sessionsRoot: machine.sessionsRoot,
      registryPath: machine.registryPath,
      decodeAll,
      ...(options.titles === undefined ? {} : { resolveTitle: ({ id }: { id: string }) => options.titles?.[id] }),
      ...(options.git === undefined ? {} : { git: options.git }),
      pluginVersion: '0.0.1-test',
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    },
    { apply: options.apply, ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }) },
  )
}

/**
 * 只留**写盘**那两段的进度（拉 / 推）。
 *
 * 算计划的三段（扫本机 / 读远端索引 / 比对内容）每次都报，`planPhases()` 单看它们——两者混在
 * 一起比，任何一处改动都会让另一处的失败信息看不出说的是谁。
 */
function writePhases(events: readonly SyncProgress[]): string[] {
  return events
    .filter((event) => event.phase === 'pull' || event.phase === 'push')
    .map((event) => `${event.phase} ${event.done}/${event.total}`)
}

/** 只留算计划那三段的进度。 */
function planPhases(events: readonly SyncProgress[]): string[] {
  return events
    .filter(
      (event) =>
        event.phase === 'scan' || event.phase === 'remote' || event.phase === 'repo' || event.phase === 'compare',
    )
    .map((event) => `${event.phase} ${event.done}/${event.total}`)
}

test('scanAll：进度分母是"这次要尝试的条目数"，跨项目目录也是同一个分母', () => {
  // 分母数少了（比如只数真会话）进度条会停在 33%；数多了又永远走不到头；而**按项目目录分别报**
  // 会让进度条每换一个目录就跳回 0。这里的库跨两个项目目录：A 里两条会话 + 一个只有临时文件的
  // 目录 + 一个普通文件（4 个条目），B 里一条会话（1 个条目）——分母是 5，一条条数到 4。
  const machine = makeMachine('scan-progress')
  try {
    writeSession(machine, 'one', 1000)
    writeSession(machine, 'two', 2000)
    const elsewhere = join(machine.base, 'other')
    mkdirSync(elsewhere, { recursive: true })
    writeSession(machine, 'three', 3000, { cwd: elsewhere })
    const projectDir = dirname(sessionDir(machine.sessionsRoot, machine.cwd, 'one'))
    mkdirSync(join(projectDir, 'half-written'), { recursive: true })
    writeFileSync(join(projectDir, 'stray.txt'), 'not a session')

    const seen: string[] = []
    const sessions = scanAll(machine.sessionsRoot, decodeAll, {
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    })
    // 目录遍历顺序由文件系统给，所以只钉形状：每条报一次、分母不变、done 从 0 数到 total - 1。
    assert.deepEqual(
      seen.map((entry) => entry.split('/')[1]),
      ['5', '5', '5', '5', '5'],
      '分母是整库要尝试的条目数（跨项目目录累加，含那两个不成会话的条目）',
    )
    assert.deepEqual(
      seen.map((entry) => Number(entry.split('/')[0])),
      [0, 1, 2, 3, 4],
      'done 从 0 数起：事件发在开始处理那一条之前（与同步那两段同一个口径）',
    )
    assert.equal(sessions.length, 3, '不成会话的条目只是让进度走一格，不进结果')
  } finally {
    rmSync(machine.base, { recursive: true, force: true })
  }
})

/** 读一条日志的首帧（header）。 */
function readHeader(machine: Machine, cwd: string, id: string): SessionHeader {
  const buf = readFileSync(join(sessionDir(machine.sessionsRoot, cwd, id), 'session.v4.jsonl.zstd'))
  const [first] = decodeAll(buf).split('\n')
  return JSON.parse(first ?? '{}') as SessionHeader
}

/** 把一条路径登记成工作区（"我在这台机器上打开过这个项目"）。 */
function registerWorkspace(machine: Machine, path: string): void {
  const registry = readRegistry(machine.registryPath)
  const id = 'ws-1'
  registry.tables.workspaces[id] = {
    path,
    title: 'proj',
    sessionIds: [],
    createdAt: new Date(1000).toISOString(),
    updatedAt: new Date(1000).toISOString(),
  }
  registry.global.workspaceIds = [id]
  writeRegistryAtomic(machine.registryPath, registry)
}

/** 假的 git：按目录回答"这里的仓库是什么"，省得测试真去建仓库。 */
function fakeGit(answers: Record<string, { root: string; url: string }>): GitRunner {
  return async (args, cwd) => {
    const answer = answers[cwd]
    if (answer === undefined) throw new Error(`不是仓库：${cwd}`)
    if (args[0] === 'rev-parse') return `${answer.root}\n`
    if (args[0] === 'remote') return 'origin\n'
    if (args[0] === 'config') return `${answer.url}\n`
    throw new Error(`unexpected ${args.join(' ')}`)
  }
}

// ── 计划（纯计算） ────────────────────────────────────────────────────────

function fp(version: number, sha: string, bytes = 10): FileFingerprint {
  return { version, bytes, sha256: sha }
}

/**
 * 造一条发现出来的会话（只填计划用得上的那几个字段）。
 * @param entries `[sha, 代次]`，配合假哈希用。
 */
function fakeSession(id: string, entries: Array<[string, number]>, title?: string): DiscoveredSession {
  const createdAt = 1000
  return {
    dirName: `~${id}`,
    dir: `/sessions/${id}`,
    id,
    cwd: '/opt/work/proj',
    createdAt,
    header: { type: 'session', version: 4, id, createdAt, cwd: '/opt/work/proj', isSeeded: false, delegationDepth: 0 },
    files: entries.map(([sha, version]) => ({
      name: `session.v${version}.jsonl.zstd`,
      path: `${sha}@${version}`,
      version,
      compression: 'zstd',
      bytes: 1,
    })),
    ...(title === undefined ? {} : { title }),
  }
}

function remoteOf(
  entries: Array<{
    machine: string
    id: string
    cwd?: string
    title?: string
    createdAt?: number
    files: FileFingerprint[]
    repo?: string
    repoPath?: string
  }>,
): RemoteLibrary {
  const map = new Map<string, RemoteSessionEntry>()
  const indexes = new Map<string, { machineId: string; entries: Array<Omit<RemoteSessionEntry, 'machine'>> }>()
  for (const entry of entries) {
    const { machine, createdAt, ...rest } = entry
    const full = { ...rest, createdAt: createdAt ?? 0 }
    map.set(entry.id, { ...full, machine })
    const index = indexes.get(machine) ?? { machineId: machine, entries: [] }
    index.entries.push(full)
    indexes.set(machine, index)
  }
  return { machines: [...indexes.keys()].sort(), entries: map, indexes, problems: [] }
}

test('sync：远端路径的第一层是插件命名空间，机器格在它下面', () => {
  assert.equal(remoteIndexPath('robot-a'), 'dsh-session-manager/robot-a/index.json')
  assert.equal(remoteBundlePath('robot-a', 'session-a'), 'dsh-session-manager/robot-a/session-a.dshsess')
  // 机器名不是安全路径段时按 encodeSegment 编码（与宿主目录名的口径一致）
  assert.equal(remoteIndexPath('robot/a'), 'dsh-session-manager/robot~002Fa/index.json')
})

test('sync：映射归一化去掉结尾斜杠，空值与重名如实报', () => {
  const { mapping, problems } = normalizeMapping({
    '/home/a/dev/proj/': '/opt/work/proj/',
    '  /srv/x  ': '  /srv/y  ',
    '': '/nowhere',
    '/empty': '   ',
    '/dup/': '/one',
    '/dup': '/two',
  })
  assert.deepEqual(
    [...mapping.entries()],
    [
      ['/home/a/dev/proj', '/opt/work/proj'],
      ['/srv/x', '/srv/y'],
      ['/dup', '/one'],
    ],
  )
  assert.equal(problems.length, 3)
  assert.match(problems.join('\n'), /空的来源路径/)
  assert.match(problems.join('\n'), /目标是空路径/)
  assert.match(problems.join('\n'), /出现了两次/)
})

test('sync：relation 区分一致 / 本机领先 / 远端领先 / 分叉', () => {
  const v0 = fp(0, 'a')
  const v1 = fp(1, 'b')
  const v1other = fp(1, 'c')
  assert.equal(relation([v0, v1], [v0, v1]), 'identical')
  assert.equal(relation([v0, v1], [v0]), 'local-ahead')
  assert.equal(relation([v0], [v0, v1]), 'remote-ahead')
  assert.equal(relation([v0, v1], [v0, v1other]), 'diverged')
  assert.equal(relation([v0, v1], [v0, fp(2, 'd')]), 'diverged')
})

test('sync：计划——远端独有要拉取，没有映射 / 目标不存在都跳过并说明', () => {
  const dirs = new Set(['/opt/work/proj'])
  const plan = planSync({
    local: [],
    remote: remoteOf([
      { machine: 'robot-a', id: 's1', cwd: '/home/a/dev/proj', files: [fp(0, 'a')] },
      { machine: 'robot-a', id: 's2', cwd: '/home/other/proj', files: [fp(0, 'b')] },
      { machine: 'robot-a', id: 's3', files: [fp(0, 'c')] },
      { machine: 'robot-a', id: 's4', cwd: '/gone/proj', files: [fp(0, 'd')] },
    ]),
    mapping: new Map([
      ['/home/a/dev/proj', '/opt/work/proj'],
      ['/gone/proj', '/opt/gone'],
    ]),
    isDirectory: (path) => dirs.has(path),
  })
  assert.deepEqual(plan.pullIds, ['s1', 's3'])
  assert.deepEqual(
    plan.pull.map((entry) => `${entry.id}:${entry.action}`),
    ['s1:create', 's2:skip', 's3:create', 's4:skip'],
  )
  assert.equal(plan.pull[0]?.toCwd, '/opt/work/proj')
  assert.match(plan.pull[1]?.reason ?? '', /没有 \/home\/other\/proj → 本机的同步映射/)
  assert.match(plan.pull[3]?.reason ?? '', /目标目录不存在/)
  assert.equal(plan.ok, false, '映射指到不存在的目录是阻塞问题')
  assert.match(plan.problems.join('\n'), /但那不是一个存在的目录/)
  assert.equal(plan.bytesIn, 20, 's1 与 s3 各 10 字节')
})

test('sync：计划——本机独有要推送，本机领先重新推送，远端领先与分叉都不动', () => {
  // 计划阶段只为"两边都有"的会话算指纹，所以这里的假哈希把 sha 编进文件路径里：
  // `path` 是 `sha@version`，`fakeHash` 再把它拆回来。
  const fakeHash = (path: string, version: number): FileFingerprint => ({
    version,
    bytes: 1,
    sha256: path.split('@')[0] ?? '',
  })
  const plan = planSync({
    local: [
      fakeSession('only-local', [['x', 0]], '本机独有'),
      fakeSession('behind', [['a', 0], ['b', 1]]),
      fakeSession('same', [['a', 0]]),
      fakeSession('ahead', [['a', 0]]),
      fakeSession('fork', [['a', 0], ['zzz', 1]]),
    ],
    remote: remoteOf([
      { machine: 'robot-b', id: 'behind', cwd: '/home/b/proj', files: [fp(0, 'a')] },
      { machine: 'robot-b', id: 'same', cwd: '/home/b/proj', files: [fp(0, 'a')] },
      { machine: 'robot-b', id: 'ahead', cwd: '/home/b/proj', files: [fp(0, 'a'), fp(1, 'b')] },
      { machine: 'robot-b', id: 'fork', cwd: '/home/b/proj', files: [fp(0, 'a'), fp(1, 'b')] },
    ]),
    mapping: new Map(),
    hashFile: fakeHash,
  })
  assert.deepEqual(plan.pushIds.sort(), ['behind', 'only-local'])
  const byId = new Map(plan.push.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('only-local')?.action, 'upload')
  assert.equal(byId.get('only-local')?.title, '本机独有')
  assert.equal(byId.get('behind')?.action, 'update', '本机严格领先 → 重新推送刷新')
  assert.equal(byId.get('same')?.action, 'skip')
  assert.equal(byId.get('ahead')?.action, 'skip')
  assert.match(byId.get('ahead')?.reason ?? '', /robot-b 那份更新/)
  assert.equal(byId.get('fork')?.action, 'skip')
  assert.match(byId.get('fork')?.reason ?? '', /两边各自写过/)
  assert.deepEqual(plan.pullIds, [], '两边都有的会话一条都不拉取')
})

test('sync：索引解析宽容——坏 JSON / 缺 id / 没有代次都不炸整次同步', () => {
  const problems: string[] = []
  assert.equal(parseIndex('{不是 JSON', 'robot-a', problems), undefined)
  assert.match(problems.join('\n'), /不是合法 JSON/)

  const index = parseIndex(
    JSON.stringify({
      entries: [
        { files: [{ version: 0, bytes: 1, sha256: 'a' }] },
        { id: 'no-files', files: [] },
        { id: 'ok', cwd: '/home/a/proj', title: '标题', createdAt: 5, files: [{ version: 0, bytes: 3, sha256: 'b' }] },
      ],
    }),
    'robot-a',
    problems,
  )
  assert.deepEqual(
    index?.entries.map((entry) => entry.id),
    ['ok'],
  )
  assert.match(problems.join('\n'), /没有 id/)
  assert.match(problems.join('\n'), /没有任何代次记录/)
})

// ── 落地（真服务） ────────────────────────────────────────────────────────

test('sync：端到端——A 推送、B 拉取，cwd 改写成 B 的路径且注册表跟着登记', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  try {
    writeSession(a, 's1', 1000, { title: '第一条' })
    writeSession(a, 's2', 2000)
    writeSession(a, 's3', 3000, { cwd: join(a.base, 'elsewhere') }) // B 没有它的映射

    const pushed = await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), {
      apply: true,
      titles: { s1: '第一条' },
    })
    assert.deepEqual(pushed.pushed.map((entry) => entry.id).sort(), ['s1', 's2', 's3'])
    assert.equal(pushed.indexWritten, true)
    assert.equal(pushed.registryWritten, false, '推送的那一侧不碰注册表')

    // 远端索引里带着标题与代次指纹
    const remote = await readRemoteLibrary(dav, settings(a, { machineId: 'robot-a' }))
    assert.deepEqual(remote.machines, ['robot-a'])
    assert.equal(remote.entries.get('s1')?.title, '第一条')
    assert.equal(remote.entries.get('s2')?.files.length, 1)

    const bConfig = settings(b, { machineId: 'robot-b', mapping: { [a.cwd]: b.cwd } })
    const preview = await syncMachine(b, dav, bConfig, { apply: false })
    assert.deepEqual([...preview.plan.pullIds].sort(), ['s1', 's2'])
    assert.deepEqual(preview.plan.pushIds, [])
    assert.match(
      preview.plan.pull.find((entry) => entry.id === 's3')?.reason ?? '',
      /没有 .*elsewhere → 本机的同步映射/,
    )

    const pulled = await syncMachine(b, dav, bConfig, { apply: true })
    assert.deepEqual(pulled.pulled.sort(), ['s1', 's2'])
    assert.equal(pulled.registryWritten, true)
    assert.equal(pulled.indexWritten, true, '拉取完也要写自己那一格（把所有自己的会话列出来）')

    // 落地位置与 cwd：按 B 的路径重新算项目目录
    for (const id of ['s1', 's2']) {
      assert.ok(existsSync(join(sessionDir(b.sessionsRoot, b.cwd, id), 'session.v4.jsonl.zstd')))
      assert.equal(readHeader(b, b.cwd, id).cwd, b.cwd)
    }
    assert.equal(existsSync(join(b.sessionsRoot, projectKey(a.cwd))), false, 'A 的项目目录不该在 B 上出现')

    // 注册表：B 上新建了指向本机路径的工作区，拉取来的会话登记在里面
    const registry = readRegistry(b.registryPath)
    const record = Object.values(registry.tables.workspaces).find((item) => item.path === b.cwd)
    assert.ok(record, 'B 上应当登记了目标工作区')
    assert.deepEqual([...record.sessionIds].sort(), ['s1', 's2'])
    assert.equal(registry.global.workspaceIds.length, 1)

    // 第二次同步：两边都不动
    const again = await syncMachine(b, dav, bConfig, { apply: true })
    assert.deepEqual(again.pulled, [])
    assert.deepEqual(again.pushed, [])
    const aPlan = await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), { apply: false })
    assert.deepEqual(aPlan.plan.pullIds, [])
    assert.deepEqual(aPlan.plan.pushIds, [])
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：端到端——两边各推送各的互不覆盖；本机领先时重新推送刷新', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  try {
    writeSession(a, 'a1', 1000)
    writeSession(b, 'b1', 1500)
    const aConfig = settings(a, { machineId: 'robot-a', mapping: { [b.cwd]: a.cwd } })
    const bConfig = settings(b, { machineId: 'robot-b', mapping: { [a.cwd]: b.cwd } })

    await syncMachine(a, dav, aConfig, { apply: true })
    await syncMachine(b, dav, bConfig, { apply: true })
    // 各自推了自己的那条、也拉了对方那条
    const remote = await readRemoteLibrary(dav, settings(a, { machineId: 'robot-a' }))
    assert.deepEqual([...remote.entries.keys()].sort(), ['a1', 'b1'])
    assert.deepEqual(remote.machines, ['robot-a', 'robot-b'])
    // 两台机器的格子各写各的：A 的索引里不该有 b1
    assert.deepEqual(
      remote.indexes.get('robot-a')?.entries.map((entry) => entry.id),
      ['a1'],
    )
    assert.deepEqual(
      remote.indexes.get('robot-b')?.entries.map((entry) => entry.id),
      ['b1'],
    )

    // A 上 a1 多出一代（本机严格领先）→ 下一次同步重新推送，而不是跳过
    addGeneration(a, 'a1', 5)
    const grown = await syncMachine(a, dav, aConfig, { apply: false })
    assert.deepEqual(grown.plan.pushIds, ['a1'])
    assert.equal(grown.plan.push.find((entry) => entry.id === 'a1')?.action, 'update')
    assert.match(grown.plan.push.find((entry) => entry.id === 'a1')?.reason ?? '', /远端停在 v4，本机到 v4–v5/)

    const applied = await syncMachine(a, dav, aConfig, { apply: true })
    assert.deepEqual(applied.pushed, [{ id: 'a1', action: 'update' }])
    const refreshed = await readRemoteLibrary(dav, settings(a, { machineId: 'robot-a' }))
    assert.equal(refreshed.entries.get('a1')?.files.length, 2, '重新推送后远端记录到两代')

    // B 那边已经有 a1 了（同 id）→ 第二次同步不拉取它，也不覆盖本机
    const bAgain = await syncMachine(b, dav, bConfig, { apply: false })
    assert.deepEqual(bAgain.plan.pullIds, [])
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：端到端——坏包只记问题，不挡住同一批里其它会话', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  try {
    writeSession(a, 'good', 1000)
    writeSession(a, 'bad', 2000)
    await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), { apply: true })

    // 把远端那份 bad 的包砸坏（模拟传输损坏 / 别的工具写脏）
    const badPath = join(fixture.root, SYNC_NAMESPACE_DIR, 'robot-a', 'bad.dshsess')
    writeFileSync(badPath, Buffer.from('这不是一个 gzip 包'))

    const outcome = await syncMachine(b, dav, settings(b, { machineId: 'robot-b', mapping: { [a.cwd]: b.cwd } }), {
      apply: true,
    })
    assert.deepEqual(outcome.pulled, ['good'])
    assert.equal(outcome.problems.length, 1)
    assert.match(outcome.problems[0] ?? '', /拉取 bad 失败/)
    assert.ok(existsSync(join(sessionDir(b.sessionsRoot, b.cwd, 'good'), 'session.v4.jsonl.zstd')))
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：端到端——远端索引点名的包不在时只记问题', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  try {
    writeSession(a, 'gone', 1000)
    await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), { apply: true })
    rmSync(join(fixture.root, SYNC_NAMESPACE_DIR, 'robot-a', 'gone.dshsess'))

    const outcome = await syncMachine(b, dav, settings(b, { machineId: 'robot-b', mapping: { [a.cwd]: b.cwd } }), {
      apply: true,
    })
    assert.deepEqual(outcome.pulled, [])
    assert.match(outcome.problems.join('\n'), /拉取 gone 失败/)
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：端到端——扫描出来的会话与指纹能被远端读回认出（同源校验）', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  try {
    writeSession(a, 's1', 1000)
    await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), { apply: true })
    const local = scanAll(a.sessionsRoot, decodeAll)
    const remote = await readRemoteLibrary(dav, settings(a, { machineId: 'robot-a' }))
    const mine =
      local[0]?.files.map((file) => contentFingerprint(file.path, file.version, file.compression, decodeAll)) ?? []
    assert.equal(relation(mine, remote.entries.get('s1')?.files ?? []), 'identical')
    assert.ok(existsSync(join(fixture.root, remoteIndexPath('robot-a'))))
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('contentFingerprint：cwd 不同、内容相同的两份会话哈希相同，且等于冻结值', () => {
  // 冻结值来自"解整篇 + 自校验"的旧实现：换实现不许改哈希口径，否则远端索引里已发布的
  // 指纹会被判成"两边各自写过"。同一份夹具用两个 cwd 各算一次，钉住"cwd 无关"。
  const FROZEN = 'f22b7f75e4cc10d9b3dd31fabfe99c168c27756dbdc89fceebe1a51792422d3a'
  const dir = join(SANDBOX, 'fingerprint')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const make = (cwd: string): string => {
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id: 'session-abc',
      createdAt: 1,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
    }
    const path = join(dir, `${cwd.replaceAll('/', '_')}.zstd`)
    writeFileSync(
      path,
      Buffer.concat([
        encodeRawFrame(JSON.stringify(header) + '\n'),
        encodeRawFrame('{"type":"turn/start","seq":0}\n'),
        encodeRawFrame('{"type":"turn/end","seq":1}\n'),
      ]),
    )
    return path
  }
  const mine = contentFingerprint(make('/home/u/dev/one'), 1, 'zstd', decodeAll)
  const theirs = contentFingerprint(make('/home/u/dev/two'), 1, 'zstd', decodeAll)
  assert.equal(mine.sha256, FROZEN)
  assert.equal(theirs.sha256, FROZEN, 'cwd 不同不该改哈希')
  assert.equal(mine.bytes, 210, 'bytes 仍是文件的真实长度')
  rmSync(dir, { recursive: true, force: true })
})

test('sync：项目身份——一条映射都不配也能落地（两台机器共用同一份配置）', () => {
  const remote = remoteOf([
    {
      machine: 'robot-a',
      id: 's1',
      cwd: '/home/alice/dev/proj/packages/web',
      createdAt: 1,
      files: [fp(1, 'aa')],
      repo: 'github.com/o/r',
      repoPath: 'packages/web',
    },
  ])
  const plan = planSync({
    local: [],
    remote,
    mapping: new Map(),
    repos: new Map([['github.com/o/r', '/work/proj']]),
    isDirectory: () => true,
  })
  assert.equal(plan.pull[0]?.toCwd, '/work/proj/packages/web', '仓库根 + 仓库内相对路径')
  assert.deepEqual(plan.pullIds, ['s1'])
  assert.equal(plan.pull[0]?.action, 'create')

  // 仓库根自己（repoPath 是 `.`）：落回根，不拼出多余的一层
  const rootOnly = planSync({
    local: [],
    remote: remoteOf([
      { machine: 'robot-a', id: 's2', cwd: '/home/alice/dev/proj', createdAt: 1, files: [fp(1, 'bb')], repo: 'github.com/o/r', repoPath: '.' },
    ]),
    mapping: new Map(),
    repos: new Map([['github.com/o/r', '/work/proj']]),
    isDirectory: () => true,
  })
  assert.equal(rootOnly.pull[0]?.toCwd, '/work/proj')
})

test('sync：项目身份——显式映射优先；本机认不出这个项目就跳过并指名仓库', () => {
  const remote = remoteOf([
    {
      machine: 'robot-a',
      id: 's1',
      cwd: '/home/alice/dev/proj/packages/web',
      createdAt: 1,
      files: [fp(1, 'aa')],
      repo: 'github.com/o/r',
      repoPath: 'packages/web',
    },
  ])
  // 用户配了映射：按他说的落，不会因为"本机恰好也有这个仓库"而改道
  const explicit = planSync({
    local: [],
    remote,
    mapping: new Map([['/home/alice/dev/proj/packages/web', '/somewhere/else']]),
    repos: new Map([['github.com/o/r', '/work/proj']]),
    isDirectory: () => true,
  })
  assert.equal(explicit.pull[0]?.toCwd, '/somewhere/else')

  // 本机没有这个项目：跳过，理由里点名仓库（用户据此知道该在本机打开哪个项目）
  const unknown = planSync({ local: [], remote, mapping: new Map(), repos: new Map(), isDirectory: () => true })
  assert.equal(unknown.pull[0]?.action, 'skip')
  assert.equal(unknown.pull[0]?.code, 'no-mapping')
  assert.match(unknown.pull[0]?.reason ?? '', /github\.com\/o\/r/)

  // 老索引（没有身份那两项）+ 空映射：照旧跳过，不因为新机制出现就改变老行为
  const legacy = planSync({
    local: [],
    remote: remoteOf([{ machine: 'robot-a', id: 's1', cwd: '/home/alice/dev/proj', createdAt: 1, files: [fp(1, 'aa')] }]),
    mapping: new Map(),
    repos: new Map([['github.com/o/r', '/work/proj']]),
    isDirectory: () => true,
  })
  assert.equal(legacy.pull[0]?.action, 'skip')
  assert.equal(legacy.pull[0]?.code, 'no-mapping')
  assert.doesNotMatch(legacy.pull[0]?.reason ?? '', /也没在本机找到仓库/)
})

test('sync：端到端——两个不同路径的克隆靠 git remote 认成同一个项目', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  // 两台机器上同一个仓库：A 在 robot-a/proj，B 在 robot-b/proj——路径不同，remote 相同
  const aSub = join(a.cwd, 'packages', 'web')
  const bSub = join(b.cwd, 'packages', 'web')
  for (const dir of [aSub, bSub]) mkdirSync(dir, { recursive: true })
  registerWorkspace(a, a.cwd)
  registerWorkspace(b, b.cwd)
  const url = 'git@github.com:he0119/demo-proj.git'
  const gitA = fakeGit({ [aSub]: { root: a.cwd, url } })
  const gitB = fakeGit({ [b.cwd]: { root: b.cwd, url } })
  // 两边都是同一份配置：同样的 url、同样的空映射（machineId 缺省时连它也一样）
  const config: SyncSettings = { url: '', machineId: 'robot-a', mapping: {} }
  try {
    writeSession(a, 's1', 1000, { cwd: aSub })
    await syncMachine(a, dav, { ...config, machineId: 'robot-a' }, { apply: true, git: gitA })
    const remote = await readRemoteLibrary(dav, { ...config, machineId: 'robot-b' })
    assert.equal(remote.entries.get('s1')?.repo, 'github.com/he0119/demo-proj', '推送的索引带着项目身份')
    assert.equal(remote.entries.get('s1')?.repoPath, 'packages/web', '以及仓库内相对路径')

    const probing: SyncProgress[] = []
    const outcome = await syncMachine(b, dav, { ...config, machineId: 'robot-b' }, {
      apply: true,
      git: gitB,
      onProgress: (event) => probing.push(event),
    })
    assert.deepEqual(outcome.pulled, ['s1'])
    // 认仓库身份那一段（真机上它比前两段加起来还长：每个候选目录一个 git 进程）也要报进度。
    assert.deepEqual(
      planPhases(probing),
      ['remote 0/0', 'repo 0/1'],
      '本机还没有会话、注册表里有一个工作区：扫本机没有条目可数，候选目录就那一个',
    )
    const local = scanAll(b.sessionsRoot, decodeAll)
    assert.equal(local.length, 1)
    assert.equal(local[0]?.cwd, bSub, 'cwd 改写成这台机器的克隆路径（中间那条映射一个字都没配）')
    assert.equal(readHeader(b, bSub, 's1').cwd, bSub, '落地那条会话的 header 也是新路径')
    assert.notEqual(bSub, aSub)
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：项目身份——索引里不写 remote 原文（凭据不进远端）', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  try {
    writeSession(a, 's1', 1000)
    const git = fakeGit({ [a.cwd]: { root: a.cwd, url: 'https://alice:ghp_secrettoken@github.com/o/r.git' } })
    await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), { apply: true, git })
    const index = readFileSync(join(fixture.root, remoteIndexPath('robot-a')), 'utf8')
    assert.match(index, /github\.com\/o\/r/, '身份写进了索引')
    assert.doesNotMatch(index, /ghp_secrettoken/, '令牌不进索引')
    assert.doesNotMatch(index, /alice@/, '用户名也不进索引')
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：拉取之后继续写，还能推送回远端（判据不看 cwd，只看内容）', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  // A 那边的会话在 `/home/alice/dev/proj`，B 落地时会被改写成 b.cwd —— 两份的**字节不同**
  const remoteCwd = '/home/alice/dev/proj'
  const gitNone: GitRunner = async () => {
    throw new Error('没有身份可用')
  }
  try {
    writeSession(a, 's1', 1000, { cwd: remoteCwd })
    await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), { apply: true, git: gitNone })
    const pulled = await syncMachine(
      b,
      dav,
      settings(b, { machineId: 'robot-b', mapping: { [remoteCwd]: b.cwd } }),
      { apply: true, git: gitNone },
    )
    assert.deepEqual(pulled.pulled, ['s1'])
    const file = scanAll(b.sessionsRoot, decodeAll)[0]?.files[0]
    assert.ok(file !== undefined)
    assert.notEqual(
      createHash('sha256').update(readFileSync(file.path)).digest('hex'),
      readFileSync(join(fixture.root, remoteIndexPath('robot-a')), 'utf8').match(/"sha256": "([^"]+)"/)?.[1],
      '两边的字节确实不同（cwd 被改写过），判据得绕开它',
    )

    // 再预演一次：拉取的这份就是远端那份，判"内容一致"，而不是"两边各自写过"
    const again = await syncMachine(b, dav, settings(b, { machineId: 'robot-b', mapping: {} }), { apply: false, git: gitNone })
    assert.equal(again.plan.push.length, 1)
    assert.equal(again.plan.push[0]?.code, 'identical')

    // 在这台机器上继续写：多一个 v5（宿主就是往同一批文件上追加一帧）
    const appended = Buffer.concat([readFileSync(file.path), encodeRawFrame('{"type":"event","seq":5}\n')])
    writeFileSync(join(dirname(file.path), 'session.v5.jsonl.zstd'), appended)
    const pushed = await syncMachine(b, dav, settings(b, { machineId: 'robot-b', mapping: {} }), { apply: true, git: gitNone })
    assert.deepEqual(pushed.pushed, [{ id: 's1', action: 'update' }], '本机领先就该重推，而不是因为 cwd 不同判成 diverged')
    const bIndex = await readRemoteLibrary(dav, settings(b, { machineId: 'robot-b' }))
    assert.equal(bIndex.indexes.get('robot-b')?.entries[0]?.files.length, 2, 'B 的格子里是它自己的两个代次')
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：同一个 id 有多台贡献时，联集取领先的那份（不是格子名排前面的）', async () => {
  // robot-a 只有 v4，robot-b 有 v4+v5 且共有代次一致 → 拉回来的应该是 robot-b 那份
  const shared = fp(4, 'aaaa')
  const longer = fp(5, 'bbbb')
  const remote = remoteOf([
    { machine: 'robot-a', id: 's1', cwd: '/x', createdAt: 1, files: [shared] },
    { machine: 'robot-b', id: 's1', cwd: '/x', createdAt: 1, files: [shared, longer] },
  ])
  // remoteOf 直接建联集时是"后来的覆盖"？不是——它按传入顺序 set，这里显式核对 readRemoteLibrary 的
  // 判据用的是同一套：直接调 relation 层面的等价断言。
  assert.equal(remote.entries.get('s1')?.files.length, 2, '测试脚手架本身按传入顺序覆盖，真判据在 readRemoteLibrary')

  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  try {
    const shortIndex = { unit: 'dsh-session-manager/sync', version: 1, machineId: 'robot-a', entries: [{ id: 's1', cwd: '/x', createdAt: 1, files: [shared] }] }
    const longIndex = {
      unit: 'dsh-session-manager/sync',
      version: 1,
      machineId: 'robot-b',
      entries: [{ id: 's1', cwd: '/x', createdAt: 1, files: [shared, longer] }],
    }
    for (const [machine, payload] of [
      ['robot-a', shortIndex],
      ['robot-b', longIndex],
    ] as const) {
      mkdirSync(join(fixture.root, SYNC_NAMESPACE_DIR, machine), { recursive: true })
      writeFileSync(
        join(fixture.root, `${SYNC_NAMESPACE_DIR}/${machine}/${SYNC_INDEX_FILE}`),
        JSON.stringify(payload),
      )
    }
    const library = await readRemoteLibrary(dav, settings(makeMachine('robot-c'), { machineId: 'robot-c' }))
    assert.equal(library.entries.get('s1')?.machine, 'robot-b', '领先的那份（v5 在这台机器上）')
    assert.equal(library.entries.get('s1')?.files.length, 2)
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

test('sync：端到端——真 git 认身份，两台机器仓库路径不同、映射为空', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  // 两台机器上各一个**真的**仓库：路径不同、remote 相同（不注入 git，走 createGitRunner）
  const url = 'git@github.com:he0119/demo-proj.git'
  const aSub = join(a.cwd, 'packages', 'web')
  const bSub = join(b.cwd, 'packages', 'web')
  mkdirSync(aSub, { recursive: true })
  mkdirSync(bSub, { recursive: true })
  for (const dir of [a.cwd, b.cwd]) {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir })
  }
  // B 上这个项目只以"登记过的工作区"出现（库里还没有会话）——候选目录的另一半来源
  registerWorkspace(b, b.cwd)
  // 除了 machineId（同一台宿主上跑两个实例，主机名会撞），两边是同一份配置：url 相同、映射为空
  const config: SyncSettings = { url: '', machineId: 'robot-a', mapping: {} }
  try {
    writeSession(a, 's1', 1000, { cwd: aSub })
    await syncMachine(a, dav, config, { apply: true })
    const remote = await readRemoteLibrary(dav, { ...config, machineId: 'robot-b' })
    assert.equal(remote.entries.get('s1')?.repo, 'github.com/he0119/demo-proj', '真 git 读出来的身份')
    assert.equal(remote.entries.get('s1')?.repoPath, 'packages/web', '仓库内相对路径')

    const outcome = await syncMachine(b, dav, { ...config, machineId: 'robot-b' }, { apply: true })
    assert.deepEqual(outcome.pulled, ['s1'], '一条映射都没配，靠身份落地')
    assert.equal(scanAll(b.sessionsRoot, decodeAll)[0]?.cwd, bSub)
    assert.equal(readHeader(b, bSub, 's1').cwd, bSub, '落地那条会话的 header 也是本机克隆里的路径')
    assert.notEqual(aSub, bSub)
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

// ── 测试连接（只读探一次） ────────────────────────────────────────────────

/** 拿一组"探到的东西"造一个远端面：分类是纯判定，不必每次都起真服务。 */
function probeStub(probe: {
  rootStatus: number
  rootOk: boolean
  collectionStatus: number
  collectionExists: boolean
  entries?: Array<{ name: string; kind: 'collection' | 'file' }>
  detail?: string
}): DavPort {
  return {
    baseUrl: 'https://dav.example.com/dsh',
    list: async () => [],
    get: async () => Buffer.alloc(0),
    put: async () => {},
    ensure: async () => {},
    probe: async () => ({ entries: [], ...probe }),
  }
}

test('sync：测试连接把每种失败分开（码 + 判定依据的状态码，不抛）', async () => {
  const unauthorizedProbe = { rootStatus: 401, rootOk: false, collectionStatus: 0, collectionExists: false, detail: 'PROPFIND … 返回 401 Unauthorized' }
  const cases: Array<[string, Parameters<typeof probeStub>[0], number]> = [
    ['401 认证失败', unauthorizedProbe, 401],
    ['403 没权限', { rootStatus: 403, rootOk: false, collectionStatus: 0, collectionExists: false }, 403],
    ['404 地址不对', { rootStatus: 404, rootOk: false, collectionStatus: 0, collectionExists: false }, 404],
    ['405 不支持 PROPFIND', { rootStatus: 405, rootOk: false, collectionStatus: 0, collectionExists: false }, 405],
    ['501 没实现', { rootStatus: 501, rootOk: false, collectionStatus: 0, collectionExists: false }, 501],
    ['503 服务器出错', { rootStatus: 503, rootOk: false, collectionStatus: 0, collectionExists: false }, 503],
    ['418 认不出来也照实报', { rootStatus: 418, rootOk: false, collectionStatus: 0, collectionExists: false }, 418],
    ['连不上（状态码 0）', { rootStatus: 0, rootOk: false, collectionStatus: 0, collectionExists: false, detail: 'fetch failed' }, 0],
  ]
  const codes = {
    401: 'unauthenticated',
    403: 'forbidden',
    404: 'notFound',
    405: 'unsupported',
    501: 'unsupported',
    503: 'serverError',
    418: 'other',
    0: 'unreachable',
  } as const
  for (const [name, probe, status] of cases) {
    const result = await testSyncConnection(probeStub(probe))
    assert.equal(result.code, codes[status as keyof typeof codes], name)
    assert.equal(result.status, status, name)
    assert.deepEqual(result.machines, [], name)
    assert.equal(result.namespaceExists, false, name)
  }
  // 原始原因原样带出去（界面要把它显示出来），认不出来的码也一样。
  const unauthorized = await testSyncConnection(probeStub(unauthorizedProbe))
  assert.match(String(unauthorized.detail), /401/)
})

test('sync：测试连接把"命名空间还没建"当成功，并列出已有的机器格', async () => {
  // 资源根过了、这一层还没有：成功，且说得清"还没有"。
  const first = await testSyncConnection(
    probeStub({ rootStatus: 207, rootOk: true, collectionStatus: 404, collectionExists: false }),
  )
  assert.deepEqual(first, { code: 'ok', status: 207, namespaceExists: false, machines: [], entries: 0 })

  // 资源根过了、这一层也在：把里面的机器格按名字报出来（文件不算机器格）。
  const existing = await testSyncConnection(
    probeStub({
      rootStatus: 207,
      rootOk: true,
      collectionStatus: 207,
      collectionExists: true,
      entries: [
        { name: 'robot-b', kind: 'collection' },
        { name: 'robot-a', kind: 'collection' },
        { name: 'stray.txt', kind: 'file' },
      ],
    }),
  )
  assert.deepEqual(existing, {
    code: 'ok',
    status: 207,
    namespaceExists: true,
    machines: ['robot-a', 'robot-b'],
    entries: 3,
  })

  // 命名空间那一次不是 404 也不是 207（例如 403）：那才是失败，码取自它。
  const denied = await testSyncConnection(
    probeStub({ rootStatus: 207, rootOk: true, collectionStatus: 403, collectionExists: false }),
  )
  assert.equal(denied.code, 'forbidden')
  assert.equal(denied.status, 403)
})

test('sync：测试连接打真服务——空远端、已有机器格、凭据不对三种情形', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const root = join(SANDBOX, 'probe-dav')
  const fixture = await startDavFixture({ root, auth: { username: 'webdav', password: 's3cret' } })
  try {
    const good = createDavClient({ baseUrl: fixture.url, username: 'webdav', password: 's3cret' })
    const empty = await testSyncConnection(good)
    assert.deepEqual(empty, { code: 'ok', status: 207, namespaceExists: false, machines: [], entries: 0 })

    // 远端已经有这台机器的格子：报出来（这是"地址对不对"最直接的证据）。
    await good.ensure(`${SYNC_NAMESPACE_DIR}/robot-a`)

    const before = fixture.requests.length
    const withMachine = await testSyncConnection(good)
    assert.deepEqual(withMachine.machines, ['robot-a'])
    assert.equal(withMachine.namespaceExists, true)
    // 只读：两次 PROPFIND，没有 MKCOL / PUT / GET。
    assert.deepEqual(
      fixture.requests.slice(before).map((line) => line.split(' ')[0]),
      ['PROPFIND', 'PROPFIND'],
    )

    const wrong = createDavClient({ baseUrl: fixture.url, username: 'webdav', password: 'nope' })
    const denied = await testSyncConnection(wrong)
    assert.equal(denied.code, 'unauthenticated')
    assert.equal(denied.status, 401)
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})

// 同步是这个插件里唯一"按条走网络"的长动作：本机几百条会话时，一次整库同步就是几百次往返。进度事件
// 是界面在那几十秒里唯一能看的东西，所以这里钉住它的形状与顺序——**发在开始处理一条之前**（`done`
// 是已经做完的条数），跳过的那些不进分母（否则进度条永远走不满）。

test('sync：每开始处理一条报一次进度，拉取与推送各自一段', async () => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  const fixture = await startDavFixture({ root: join(SANDBOX, 'dav') })
  const dav = createDavClient({ baseUrl: fixture.url })
  const a = makeMachine('robot-a')
  const b = makeMachine('robot-b')
  // 这一条只关心"按条报进度"，不要 git 身份那一路掺进来：沙箱本身就在一个仓库里，认得出身份的话
  // `far` 会靠"同一个仓库 + 相对路径"落到本机，它就从"落不下来"变成"能拉"了。
  const gitNone: GitRunner = async () => {
    throw new Error('没有身份可用')
  }
  try {
    writeSession(a, 'one', 1000)
    writeSession(a, 'two', 2000)
    // 第三条在另一个目录里：b 没有它的映射，于是它在计划里是一条 `skip`（落不下来）。进度分母必须
    // 把它排掉——否则界面上会出现"拉到 3 / 3 完成"但库里只多了两条。
    const far = join(SANDBOX, 'far-project')
    mkdirSync(far, { recursive: true })
    writeSession(a, 'far', 3000, { cwd: far })

    const pushing: SyncProgress[] = []
    await syncMachine(a, dav, settings(a, { machineId: 'robot-a' }), {
      apply: true,
      titles: { one: '第一条' },
      git: gitNone,
      onProgress: (event) => pushing.push(event),
    })
    assert.deepEqual(
      writePhases(pushing),
      ['push 0/3', 'push 1/3', 'push 2/3'],
      '推那一段：三条各报一次，done 从 0 数起（事件发在开始处理那条之前）',
    )
    assert.deepEqual(
      [...new Set(pushing.filter((event) => event.phase === 'push').map((event) => event.id))].sort(),
      ['far', 'one', 'two'],
    )
    assert.equal(pushing.find((event) => event.id === 'one')?.label, '第一条', 'label 用读到的标题')
    assert.equal(pushing.find((event) => event.id === 'two')?.label, 'two', '读不到标题就退回 id')
    assert.deepEqual(
      planPhases(pushing),
      ['scan 0/3', 'scan 1/3', 'scan 2/3', 'remote 0/0'],
      '落地前先算计划：本机三条会话各报一次、远端索引前后各一条——按下确认后到第一条推送之间不空等',
    )

    const pulling: SyncProgress[] = []
    const outcome = await syncMachine(b, dav, settings(b, { machineId: 'robot-b', mapping: { [a.cwd]: b.cwd } }), {
      apply: true,
      git: gitNone,
      onProgress: (event) => pulling.push(event),
    })
    assert.deepEqual([...outcome.pulled].sort(), ['one', 'two'])
    assert.deepEqual(
      planPhases(pulling),
      ['remote 0/0'],
      '本机库是空的：扫本机一段一条都数不到，就不报（分母 0 的进度条闪一下只是噪声）',
    )
    assert.deepEqual(
      writePhases(pulling),
      ['pull 0/2', 'pull 1/2'],
      '拉那一段同样逐条报，分母排掉落不下来的那条（`far`：没配映射），也不掺进推送那一段',
    )
    assert.deepEqual(
      [...new Set(pulling.filter((event) => event.phase === 'pull').map((event) => event.id))].sort(),
      ['one', 'two'],
      'skip 的那条不报进度',
    )
    assert.equal(pulling.find((event) => event.id === 'one')?.label, '第一条', '远端记的标题跟着包一起过来')

    // 再同步一次：库里有同 id、远端那份也一样，全是 skip。
    const again: SyncProgress[] = []
    await syncMachine(b, dav, settings(b, { machineId: 'robot-b', mapping: { [a.cwd]: b.cwd } }), {
      apply: true,
      git: gitNone,
      onProgress: (event) => again.push(event),
    })
    assert.deepEqual(writePhases(again), [], '跳过的那些不进分母，也不报进度——报了进度条就永远走不满')
    assert.deepEqual(
      planPhases(again),
      ['scan 0/2', 'scan 1/2', 'remote 0/0', 'compare 0/2', 'compare 1/2'],
      '全都跳过时也要报算计划那三段：时间照花（读本机、读远端、逐条比对内容），只是没有写盘那两段',
    )
  } finally {
    await fixture.close()
    rmSync(SANDBOX, { recursive: true, force: true })
  }
})
