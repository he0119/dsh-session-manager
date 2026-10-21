// 自动推送：**只推不拉**那条路。
//
// 这一份与 sync.test.ts 分开，是因为它钉的是一组**方向性**的断言——"这一轮永远不会动本机"不是靠读
// 代码看出来的，而是靠"跑完之后本机每一个字节都没变"验出来的。计划那一层（planSync 的 pushOnly 过滤）
// 是纯计算，所以前半段可以直接喂给它；后半段走真的 WebDAV 夹具，验落地那一条。
//
// 反事实（改回去必须变红的那些）：
//   - 把 `planSync` 里那句 `if (input.pushOnly === true) narrowToPushOnly(...)` 去掉 → "拉取表空"
//     与"本机不变"两组断言一起红；
//   - 把 `narrowToPushOnly()` 里 `code === 'identical'` 那个例外去掉 → "内容一致那几条留着"红；
//   - 把 `runAutoPush()` 里的 `pushOnly` 传参去掉 → "不落任何本机会话"红；
//   - 把 `runAutoPush()` 里那个速度闸去掉 → "没到间隔就不跑"红；
//   - 把 `runAutoPush()` 里 `idle` 那条早退去掉 → "没有可推的就不写索引"红。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { DEFAULT_AUTO_PUSH_INTERVAL_MS, MIN_AUTO_PUSH_INTERVAL_MS, autoPushSection } from '../src/config.ts'
import { createDavClient } from '../src/dav.ts'
import { scanAll, type DiscoveredSession } from '../src/discovery.ts'
import { sessionDir } from '../src/paths.ts'
import { readRegistry, writeRegistryAtomic } from '../src/registry.ts'
import {
  SYNC_INDEX_FILE,
  SYNC_NAMESPACE_DIR,
  AUTO_PUSH_SETTLE_MS,
  createAutoPushTimer,
  planSync,
  readRemoteLibrary,
  remoteBundlePath,
  remoteIndexPath,
  runAutoPush,
  runSync,
  syncPrepared,
  prepareSync,
  type FileFingerprint,
  type RemoteLibrary,
  type RemoteSessionEntry,
  type SyncDeps,
  type SyncSettings,
} from '../src/sync.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'
import { startDavFixture } from './dav-fixture.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')
const SANDBOX = join(import.meta.dirname, '.sandbox', 'auto-push')

// ── 假机器（与 sync.test.ts 同一套形状，这里只留用得到的） ──────────────────────

interface Machine {
  base: string
  cwd: string
  sessionsRoot: string
  registryPath: string
}

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

/** 这条会话在盘上的全部字节（验"本机一个字节都没变"用）。 */
function sessionBytes(machine: Machine, id: string): string {
  const dir = sessionDir(machine.sessionsRoot, machine.cwd, id)
  return readFileSync(join(dir, 'session.v4.jsonl.zstd')).toString('base64')
}

/** 这条会话目录在不在。 */
function sessionThere(machine: Machine, id: string): boolean {
  try {
    return statSync(sessionDir(machine.sessionsRoot, machine.cwd, id)).isDirectory()
  } catch {
    return false
  }
}

function writeSession(
  machine: Machine,
  id: string,
  createdAt: number,
  options: { title?: string; cwd?: string; event?: string } = {},
): void {
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
  if (options.event !== undefined) lines.push(options.event)
  if (options.title !== undefined) {
    lines.push(JSON.stringify({ type: 'session/title', seq: 1, data: { title: options.title, source: { kind: 'fallback' } } }))
  }
  const dir = sessionDir(machine.sessionsRoot, header.cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))))
}

/**
 * 给一条已有会话再加一代日志（宿主续写会话就是这个形状：同一个目录里多一个 `session.vN`）。
 *
 * 帧的写法与 `sync.test.ts` 的 `addGeneration()` 逐字节一致（header 与换行是**两帧**，不是拼在一起
 * 的一帧）——拼成一帧的话新代次读不出 header，整条会话在扫描阶段就被丢掉，于是"远端领先"那种关系根本
 * 造不出来。这一条踩过：现象是"别人推上去的会话在本机看不见"，看起来像同步的问题。
 */
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
    Buffer.concat([encodeRawFrame(JSON.stringify(header)), encodeRawFrame('\n')]),
  )
}

/** 这台机器的同步设置；`autoPush` 按参数给。 */
function settings(machine: Machine, overrides: Partial<SyncSettings> = {}): SyncSettings {
  return { url: '', machineId: 'robot-a', mapping: {}, ...overrides }
}

interface DepsOptions {
  sessionMeta?: SyncDeps['sessionMeta']
  liveSessionIds?: SyncDeps['liveSessionIds']
  hostRegistry?: SyncDeps['hostRegistry']
  hostCheckpoints?: SyncDeps['hostCheckpoints']
  progressWhat?: string
  onProgress?: SyncDeps['progressWhat'] extends never ? never : (event: { phase: string; what?: string }) => void
}

function depsOf(
  machine: Machine,
  dav: ReturnType<typeof createDavClient>,
  config: SyncSettings,
  options: DepsOptions = {},
): SyncDeps {
  return {
    dav,
    settings: config,
    sessionsRoot: machine.sessionsRoot,
    registryPath: machine.registryPath,
    backupRoot: join(machine.base, 'backups'),
    decodeAll,
    ...(options.sessionMeta === undefined ? {} : { sessionMeta: options.sessionMeta }),
    ...(options.liveSessionIds === undefined ? {} : { liveSessionIds: options.liveSessionIds }),
    ...(options.hostRegistry === undefined ? {} : { hostRegistry: options.hostRegistry }),
    ...(options.hostCheckpoints === undefined ? {} : { hostCheckpoints: options.hostCheckpoints }),
    ...(options.progressWhat === undefined ? {} : { progressWhat: options.progressWhat }),
    pluginVersion: '0.0.1-test',
    now: () => new Date('2026-10-01T00:00:00.000Z'),
  }
}

/** 一份假指纹（计划那一层的纯计算用得上）。 */
function fingerprint(version: number, sha: string): FileFingerprint {
  return { version, bytes: 100, sha256: sha }
}

/** 一条假的远端记录。 */
function remoteEntry(id: string, files: FileFingerprint[], extra: Partial<RemoteSessionEntry> = {}): RemoteSessionEntry {
  return { id, createdAt: 1000, files, machine: 'robot-b', ...extra }
}

function libraryOf(entries: RemoteSessionEntry[]): RemoteLibrary {
  return {
    machines: ['robot-b'],
    entries: new Map(entries.map((entry) => [entry.id, entry])),
    indexes: new Map(),
    problems: [],
  }
}

/** 真会话对象的最小面（`planSync` 只读这几个字段）。 */
function sessionOf(id: string, files: { version: number; bytes: number }[], cwd = '/tmp/proj'): DiscoveredSession {
  return {
    id,
    cwd,
    createdAt: 1000,
    dir: `/tmp/sessions/${id}`,
    files: files.map((file) => ({
      name: `session.v${file.version}.jsonl.zstd`,
      path: `/tmp/sessions/${id}/session.v${file.version}.jsonl.zstd`,
      version: file.version,
      bytes: file.bytes,
      compression: 'zstd',
      mtimeMs: 1,
    })),
  } as unknown as DiscoveredSession
}

// ── 计划这一层：pushOnly 到底摘掉了什么 ───────────────────────────────────────

test('planSync(pushOnly)：拉取整表摘掉，且不因为"目标目录不存在"而报错', () => {
  // 远端有一条本机没有的（今天会拉取），而映射把它指到一个**不存在**的目录（今天会记 problem）。
  // 只推这条路上那两件事都不该发生：它不改本机，落地目录自然也不关它的事。
  const mine = sessionOf('mine', [{ version: 4, bytes: 10 }])
  const plan = planSync({
    local: [mine],
    remote: libraryOf([remoteEntry('theirs', [fingerprint(4, 'aaa')], { cwd: '/remote/only' })]),
    mapping: new Map([['/remote/only', '/nowhere/at/all']]),
    pushOnly: true,
    isDirectory: () => false,
    hashFile: () => fingerprint(4, 'bbb'),
  })
  assert.deepEqual(plan.pull, [], '只推这条路上一张拉取表都不该有')
  assert.deepEqual(plan.pullIds, [], '拉取 id 一并清空（进度分母读它）')
  assert.equal(plan.bytesIn, 0, '不落地就没有入流量')
  assert.ok(
    !plan.problems.some((problem) => problem.includes('不是一个存在的目录')),
    `只推的路上不该因为落地目录报错，实际 problems：${plan.problems.join(' | ')}`,
  )
  assert.ok(
    plan.problems.every((problem) => !problem.includes('不是一个存在的目录')),
    '改写之后那句"会吓人"的话不该再出现',
  )
})

test('planSync(pushOnly)：本地独有的与本机领先的照推，一致的原样留着', () => {
  const plan = planSync({
    local: [
      sessionOf('only-local', [{ version: 4, bytes: 10 }]),
      sessionOf('ahead', [{ version: 4, bytes: 10 }, { version: 5, bytes: 20 }]),
      sessionOf('same', [{ version: 4, bytes: 10 }]),
    ],
    remote: libraryOf([
      remoteEntry('ahead', [fingerprint(4, 'shared')]),
      remoteEntry('same', [fingerprint(4, 'shared')]),
    ]),
    mapping: new Map(),
    pushOnly: true,
    hashFile: (path) => {
      // 两个版本给两枚不同的指纹；`ahead` 的 v4 与远端共有、必须一致才算"领先"。
      const version = Number(/session\.v(\d+)\./.exec(path)?.[1] ?? '4')
      return fingerprint(version, 'shared')
    },
  })
  const byId = new Map(plan.push.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('only-local')?.action, 'upload', '远端没有的就推')
  assert.equal(byId.get('ahead')?.action, 'update', '本机领先的重新推送刷新远端')
  assert.equal(byId.get('ahead')?.code, 'local-ahead')
  assert.equal(byId.get('same')?.action, 'skip', '内容一致的留着（它是"这次不用动"的唯一说明）')
  assert.equal(byId.get('same')?.code, 'identical')
  assert.deepEqual([...plan.pushIds].sort(), ['ahead', 'only-local'], '要推的就是那两条')
})

test('planSync(pushOnly)：远端领先的、两边各自写过的、判不出来的——一条都不推', () => {
  /*
   * 三条会话分别造出三种方向，判据都是**结构性**的（代次集合 + 共有代次的内容）：
   *   - `remote-ahead`：本机的 v4 是远端 v4+v5 的前缀（今天走"覆盖本机那份"）；
   *   - `diverged-local-newer`：本机 v5、远端 v4，**共有代次的内容不同**——两边各自写过，而本机更晚；
   *   - `diverged-noise`：同样是分叉，但两边的活动时间一样 → 判不出谁更新。
   *
   * 第二条是这一条用例的重点：它是唯一"分叉但仍然要推"的情形（本机这份更晚 → 把自己那格刷成最新，
   * 不碰本机）。把 `local-newer` 一起摘掉就会让它在这条路上永远推不上去。
   */
  const plan = planSync({
    local: [
      sessionOf('remote-ahead', [{ version: 4, bytes: 10 }]),
      sessionOf('diverged-local-newer', [{ version: 5, bytes: 30 }]),
      sessionOf('diverged-noise', [{ version: 5, bytes: 60 }]),
    ],
    remote: libraryOf([
      remoteEntry('remote-ahead', [fingerprint(4, 'shared'), fingerprint(5, 'newer')], { lastActiveAt: 5000 }),
      remoteEntry('diverged-local-newer', [fingerprint(4, 'mine-was-different')], { lastActiveAt: 1000 }),
      remoteEntry('diverged-noise', [fingerprint(4, 'mine-was-different')], { lastActiveAt: 2000 }),
    ]),
    mapping: new Map(),
    pushOnly: true,
    // 前两条本机更晚（6000 > 1000）；第三条两边一样（2000 = 2000）→ 判不出来。
    // 用的是 `SessionMeta` 的真字段名（`activeAt()` 读的是这两枚钟里晚的那枚）。
    sessionMeta: (session) => ({ lastPromptAt: session.id === 'diverged-noise' ? 2000 : 6000 }),
    hashFile: (path) => {
      const version = Number(/session\.v(\d+)\./.exec(path)?.[1] ?? '4')
      // 本机这边 v4 的内容与远端不同（'mine-here' ≠ 'mine-was-different'）→ 分叉；
      // `remote-ahead` 的 v4 则与远端**一致**，它才是"本机是远端前缀"那条结构关系。
      const same = path.includes('remote-ahead')
      return fingerprint(version, same ? 'shared' : version === 4 ? 'mine-here' : `mine-v${version}`)
    },
  })
  const byId = new Map(plan.push.map((entry) => [entry.id, entry]))
  assert.equal(byId.get('remote-ahead'), undefined, '远端领先的那条（今天会覆盖本机）在只推里整条摘掉')
  assert.equal(byId.get('diverged-local-newer')?.action, 'update', '两边各自写过而本机更晚：照推（不碰本机）')
  assert.equal(byId.get('diverged-local-newer')?.code, 'local-newer')
  assert.equal(byId.get('diverged-noise'), undefined, '判不出谁更新的那条也摘掉（它今天就不推）')
  assert.deepEqual(plan.pushIds, ['diverged-local-newer'])
})

test('planSync(pushOnly)：空白会话照旧不推，也不因为"只推"而混进别的名单', () => {
  const plan = planSync({
    local: [sessionOf('blank-one', [{ version: 4, bytes: 10 }])],
    remote: libraryOf([]),
    mapping: new Map(),
    pushOnly: true,
    sessionMeta: () => ({ blank: true }),
    hashFile: () => fingerprint(4, 'x'),
  })
  assert.deepEqual(plan.pushIds, [], '空白会话没有内容可传')
  assert.deepEqual(plan.blank, ['blank-one'], '空白名单只装空白会话，不装"因为只推所以不推"的那些')
})

test('planSync(pushOnly)：远端有内容而本机是空白的那条，不再走"覆盖本机"', () => {
  // 今天这条路会把它排进 `pull`（`blank-local`）——先备份再拿远端那份顶掉本机。只推时整条消失：
  // 既没有拉取，也不该出现在任何一张表里。
  const plan = planSync({
    local: [sessionOf('blank-local', [{ version: 4, bytes: 10 }])],
    remote: libraryOf([remoteEntry('blank-local', [fingerprint(4, 'theirs'), fingerprint(5, 'theirs-2')])]),
    mapping: new Map(),
    pushOnly: true,
    sessionMeta: () => ({ blank: true }),
    hashFile: () => fingerprint(4, 'mine'),
  })
  assert.deepEqual(plan.pull, [], '只推这条路上没有"覆盖本机"')
  assert.deepEqual(plan.pushIds, [])
  assert.ok(
    !plan.push.some((entry) => entry.id === 'blank-local'),
    '它既不该被推，也不该在推送表里留一条"这次不动"（那会让人以为做过判断）',
  )
})

test('planSync(不带 pushOnly)：两个方向照旧，一个字节都没变', () => {
  // 反事实：同一个输入，只有 pushOnly 不同。这一条是"过滤没有顺手改坏手动那条路"的防线。
  const input = {
    local: [sessionOf('mine', [{ version: 4, bytes: 10 }])],
    remote: libraryOf([remoteEntry('theirs', [fingerprint(4, 'aaa')], { cwd: '/remote/only' })]),
    mapping: new Map([['/remote/only', '/nowhere']]),
    isDirectory: () => false,
    hashFile: () => fingerprint(4, 'bbb'),
  }
  const plan = planSync(input)
  assert.equal(plan.pull.length, 1, '手动那条路上拉取照旧')
  assert.equal(plan.pull[0]?.action, 'skip', '目标目录不存在 → skip')
  assert.ok(
    plan.problems.some((problem) => problem.includes('不是一个存在的目录')),
    '手动那条路上那句原话照旧（只推时才改写）',
  )
})

// ── 编排这一层：跑一轮到底做了什么 ───────────────────────────────────────────

/** 一份"这一轮该怎么算"。`enabled` 缺省 true。 */
function autoSettings(machine: Machine, overrides: Partial<SyncSettings['autoPush']> = {}): SyncSettings {
  return settings(machine, { autoPush: { enabled: true, intervalMs: 300_000, ...overrides } })
}

test('runAutoPush：没开自动推送就什么都不做', async () => {
  const machine = makeMachine('disabled')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only-local', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    const outcome = await runAutoPush(depsOf(machine, dav, settings(machine, { autoPush: { enabled: false, intervalMs: 300_000 } })))
    assert.equal(outcome.ran, false)
    assert.equal(outcome.skip, 'disabled')
    assert.equal(outcome.failures, 0)
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：没到间隔就不跑（force 能绕过去）', async () => {
  const machine = makeMachine('interval')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only-local', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    const now = 1_000_000
    const deps = depsOf(machine, dav, autoSettings(machine))

    const early = await runAutoPush(deps, { lastRunAt: now - 10_000, now: () => now })
    assert.equal(early.ran, false)
    assert.equal(early.skip, 'interval', '距上次真跑才 10 秒，远不到 5 分钟')

    const forced = await runAutoPush(deps, { lastRunAt: now - 10_000, now: () => now, force: true })
    assert.equal(forced.ran, true, 'force = 用户手点的那一次，不该被间隔挡住')
    assert.deepEqual(
      forced.outcome?.pushed.map((entry) => entry.id),
      ['only-local'],
    )
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：只推不拉——远端独有的那条不被拉进来，本机一个字节都不变', async () => {
  const machine = makeMachine('push-only')
  const other = makeMachine('push-only-other')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'mine', 1000, { title: '本机的' })
    writeSession(other, 'theirs', 2000, { title: '别人的' })

    // 先把"别人那条"推上去（借别的机器的身份走一次正常同步），再让这台机器跑自动推送。
    const theirsDeps = depsOf(other, createDavClient({ baseUrl: fixture.url }), settings(other, { machineId: 'robot-b' }))
    const theirsOutcome = await runSync(theirsDeps, { apply: true })
    assert.deepEqual(theirsOutcome.pulled, [], '先确认那条是推上去的，不是拉下来的')

    const mineBytesBefore = sessionBytes(machine, 'mine')
    const mineDirExistedBefore = sessionThere(machine, 'theirs')

    const deps = depsOf(machine, createDavClient({ baseUrl: fixture.url }), autoSettings(machine))
    const outcome = await runAutoPush(deps, { force: true })
    assert.equal(outcome.ran, true)
    assert.deepEqual(
      outcome.outcome?.pulled,
      [],
      '自动推送永远不拉：远端那条不该落到本机',
    )
    assert.deepEqual(
      outcome.outcome?.pushed.map((entry) => entry.id),
      ['mine'],
      '本机独有的照推',
    )
    assert.equal(outcome.outcome?.bytesIn, 0, '没有入流量')
    assert.equal(sessionThere(machine, 'theirs'), mineDirExistedBefore, '远端独有那条不该出现在本机库里')
    assert.equal(sessionBytes(machine, 'mine'), mineBytesBefore, '本机这条的字节一个都没变')
    assert.deepEqual(outcome.outcome?.replaced, [], '覆盖本机那份这件事在只推里根本不存在')
    assert.equal(outcome.outcome?.registryWritten, false, '只推不改注册表')
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
    rmSync(other.base, { recursive: true, force: true })
  }
})

test('runAutoPush：远端更新、本机落后的那条——本机内容原地不动，也不进备份', async () => {
  const machine = makeMachine('never-overwrite')
  const other = makeMachine('never-overwrite-other')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'shared', 1000)
    writeSession(other, 'shared', 1000)
    // 别人继续写：同一个目录里多一代日志（宿主续写会话就是这个形状），远端那份因此**领先**
    // ——这是结构性判据（本机 v4 是远端 v4+v5 的前缀），不看时间。
    addGeneration(other, 'shared', 5)
    const pushedByOther = await runSync(
      depsOf(other, createDavClient({ baseUrl: fixture.url }), settings(other, { machineId: 'robot-b' })),
      { apply: true },
    )
    assert.deepEqual(
      pushedByOther.pushed.map((entry) => entry.id),
      ['shared'],
      '先把远端那份推上去（它的代次 v4+v5 才是"领先"那一份）',
    )

    const before = sessionBytes(machine, 'shared')
    const backupRoot = join(machine.base, 'backups')
    const dav = createDavClient({ baseUrl: fixture.url })

    const outcome = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })

    assert.equal(outcome.ran, true)
    assert.equal(sessionBytes(machine, 'shared'), before, '远端领先也不能动本机那份：只推这条路不覆盖')
    // 备份是"覆盖本机那份"唯一的前置步骤；没有覆盖就不该留下备份目录。
    assert.throws(() => statSync(backupRoot), '没有覆盖就不该建备份')
    /*
     * 本机这份是远端的**前缀**（v4 对 v4+v5）：推上去等于拿旧内容刷新远端，所以一条都不推。远端那边
     * 那一格的索引也不该动（没有可推的、也没有要撤下的），这一轮因此是 `idle`。
     */
    assert.equal(outcome.skip, 'idle', '本机落后 → 这一轮没有可推的')
    assert.equal(outcome.outcome, undefined, 'idle 那一轮连落地都不走（没有 SyncOutcome 可报）')

    // 再从远端读一遍：本机那一格的索引里没有 shared（这一轮没推过），远端那份照旧是 v4+v5。
    const library = await readRemoteLibrary(dav, settings(machine))
    const own = library.indexes.get('robot-a')
    assert.equal(own, undefined, '本机从来没推过东西，它那一格不该凭空出现')
    const remote = [...library.entries.values()].find((entry) => entry.id === 'shared')
    assert.deepEqual(
      remote?.files.map((file) => file.version).sort(),
      [4, 5],
      '远端那份照旧是 v4+v5：自动推送没有拿本机的旧内容去刷新它',
    )
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
    rmSync(other.base, { recursive: true, force: true })
  }
})

test('runAutoPush：本机删掉的会话从自己那格索引里撤下来（即"没得推也要收尾"）', async () => {
  const machine = makeMachine('reindex')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'kept', 1000)
    writeSession(machine, 'deleted', 2000)
    const dav = createDavClient({ baseUrl: fixture.url })

    // 第一次：两条都推上去。
    const first = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })
    assert.equal(first.ran, true)
    assert.deepEqual([...(first.outcome?.pushed ?? [])].map((entry) => entry.id).sort(), ['deleted', 'kept'])

    const indexOf = async (): Promise<{ id: string }[]> => {
      const library = await readRemoteLibrary(dav, settings(machine))
      return library.indexes.get('robot-a')?.entries.map((entry) => ({ id: entry.id })) ?? []
    }
    assert.deepEqual((await indexOf()).map((entry) => entry.id).sort(), ['deleted', 'kept'])

    // 本机删掉一条，再跑一轮：这一轮"一条都不推"，但索引必须跟着收窄。
    rmSync(sessionDir(machine.sessionsRoot, machine.cwd, 'deleted'), { recursive: true, force: true })
    const second = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })
    assert.equal(second.ran, true)
    assert.equal(
      second.skip,
      undefined,
      '索引里有本机已经没有的会话 → 不是 idle，这一轮要走落地把索引刷新',
    )
    assert.deepEqual(second.outcome?.pushed, [], '没有可推的（被删的那条不在本机了，剩下的那条远端已有）')
    assert.deepEqual(
      (await indexOf()).map((entry) => entry.id),
      ['kept'],
      '删掉的那条要从自己那格索引里消失（否则别的机器会去取一个不存在的包）',
    )
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：本机删掉的会话也要收走索引记录，即使这一轮一条都不推', async () => {
  // 与上一条同一件事，但把它单独钉一遍：这是 `idle` 早退最容易漏掉的那一格——"推送表空"不等于
  // "索引不用动"。反事实：把 `indexNeedsSettling()` 从 `idle` 判据里去掉，这一条就红。
  const machine = makeMachine('reindex-extra')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'a', 1000)
    writeSession(machine, 'b', 2000)
    const dav = createDavClient({ baseUrl: fixture.url })
    await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })

    rmSync(sessionDir(machine.sessionsRoot, machine.cwd, 'b'), { recursive: true, force: true })
    const second = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })
    assert.equal(second.ran, true)
    assert.equal(second.skip, undefined, '本机少了一条 → 索引要收尾，不能算 idle')
    assert.equal(second.outcome?.indexWritten, true, '索引这一次必须真的写上去')
    const library = await readRemoteLibrary(dav, settings(machine))
    assert.deepEqual(
      (library.indexes.get('robot-a')?.entries ?? []).map((entry) => entry.id),
      ['a'],
    )
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：真的没得推时连索引都不写（idle）', async () => {
  const machine = makeMachine('idle')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })

    // 把远端那份索引的 mtime 记下来，再跑一轮"什么都没变"的。
    const indexUrl = `${fixture.url}/${SYNC_NAMESPACE_DIR}/robot-a/${SYNC_INDEX_FILE}`
    const before = await (await fetch(indexUrl)).text()
    const second = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })
    const after = await (await fetch(indexUrl)).text()

    assert.equal(second.ran, true)
    assert.equal(second.skip, 'idle', '没有可推的、也没有要撤下的 → 空跑')
    assert.equal(second.outcome, undefined, 'idle 那一轮连落地都不走（也就没有 indexWritten 可看）')
    assert.ok(before.includes('"only"') && after.includes('"only"'), '索引内容照旧')
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：连不上远端时记一笔失败，不把错抛出来', async () => {
  const machine = makeMachine('failure')
  try {
    writeSession(machine, 'only', 1000)
    /*
     * 一个连不上的远端（端口 9 上没有服务）。`readRemoteLibrary()` 把"列远端失败"记进 `problems`
     * 而不是抛出来（那是有意的：一个格子读不到不该拦住整次同步），所以这一轮会**照常跑**，只是
     * `plan.problems` 里有那条错——这就是它算"失败"（`failures + 1`）的地方。
     * 要紧的是 `runAutoPush()` 自己不许抛：后台任务抛出去没人接。
     */
    const dav = createDavClient({ baseUrl: 'http://127.0.0.1:9/nowhere', timeoutMs: 500 })
    const outcome = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), { force: true })
    assert.equal(outcome.ran, true)
    assert.equal(outcome.failures, 1, '有 problems → 连续失败计数 +1')
    assert.ok(outcome.problem !== undefined && outcome.problem !== '', '要把原因留下一句')
  } finally {
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：跑成功一次就把连续失败清零', async () => {
  const machine = makeMachine('failure-reset')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    const outcome = await runAutoPush(depsOf(machine, dav, autoSettings(machine)), {
      force: true,
      failures: 4,
    })
    assert.equal(outcome.ran, true)
    assert.deepEqual(outcome.outcome?.problems, [])
    assert.equal(outcome.failures, 0, '这一轮没问题 → 计数清零')
    assert.equal(outcome.problem, undefined, '清零时不该还留着上一次的原因')
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('runAutoPush：进度事件盖着 auto-push 的名（后台那条流认得出）', async () => {
  const machine = makeMachine('what')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only-local', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    const seen: string[] = []
    const deps = depsOf(machine, dav, autoSettings(machine))
    await runAutoPush(deps, { force: true, onProgress: (event) => seen.push(`${event.phase}:${String(event.what)}`) })
    assert.ok(seen.length > 0, '算计划那几段总该报点什么')
    assert.ok(
      seen.every((entry) => entry.endsWith(':auto-push')),
      `自动推送报的每一条都要带 what=auto-push，实际：${seen.join(' ')}`,
    )
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

test('手动同步那条路的事件不带 what（形状与以前逐字节相同）', async () => {
  const machine = makeMachine('manual-what')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only-local', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    const seen: Array<Record<string, unknown>> = []
    const prepared = await prepareSync(depsOf(machine, dav, settings(machine)), {
      onProgress: (event) => seen.push({ ...event }),
    })
    await syncPrepared(depsOf(machine, dav, settings(machine)), prepared, {
      onProgress: (event) => seen.push({ ...event }),
    })
    assert.ok(seen.length > 0)
    assert.ok(
      seen.every((event) => !('what' in event)),
      `手动那条路上不该有 what（那是给"同一时刻有两条流"用的），实际：${JSON.stringify(seen.slice(0, 3))}`,
    )
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

// ── 节拍器 ───────────────────────────────────────────────────────────────

test('createAutoPushTimer：到点自己跑一轮，到点之前不跑', async () => {
  let timerHandle: (() => void) | undefined
  let scheduled: number | undefined
  const runs: number[] = []
  let enabled = true
  const timer = createAutoPushTimer({
    clock: { enabled: () => enabled, intervalMs: () => 120_000 },
    run: async () => {
      runs.push(1)
      return { ran: true, failures: 0 }
    },
    setTimer: (handler, ms) => {
      timerHandle = handler
      scheduled = ms
      return 1
    },
    clearTimer: () => {
      timerHandle = undefined
    },
  })
  assert.equal(scheduled, 60_000, '醒来的节奏被 60 秒那个上界封着（间隔 2 分钟也不能两分钟才醒）')
  assert.equal(runs.length, 0, '挂上之后不立刻跑')
  timerHandle?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, '到点了就跑一轮')
  timer.stop()
  assert.equal(timerHandle, undefined, 'stop() 之后没有挂着的定时器')
})

test('createAutoPushTimer：关掉之后不再挂定时器，也不跑', async () => {
  let scheduled = 0
  let enabled = false
  const runs: number[] = []
  createAutoPushTimer({
    clock: { enabled: () => enabled, intervalMs: () => 60_000 },
    run: async () => {
      runs.push(1)
      return { ran: true, failures: 0 }
    },
    setTimer: () => {
      scheduled += 1
      return 1
    },
    clearTimer: () => undefined,
  })
  assert.equal(scheduled, 0, '关着的时候连定时器都不挂（省一个空转的）')
  // 打开之后下一次 tick 就该挂上（配置是活引用，改完不必重启）。
  enabled = true
  const timer = createAutoPushTimer({
    clock: { enabled: () => enabled, intervalMs: () => 60_000 },
    run: async () => {
      runs.push(1)
      return { ran: true, failures: 0 }
    },
    setTimer: () => {
      scheduled += 1
      return 1
    },
    clearTimer: () => undefined,
  })
  assert.equal(scheduled, 1, '开着就挂')
  timer.stop()
})

test('createAutoPushTimer：上一轮还在跑时这一轮让开（busy），不排队', async () => {
  let release: (() => void) | undefined
  const started: number[] = []
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    run: async () => {
      started.push(1)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { ran: true, failures: 0 }
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
  })
  const first = timer.tick()
  const second = await timer.tick()
  assert.equal(started.length, 1, '第二次不该再起一轮')
  assert.equal(second.ran, false)
  assert.equal(second.skip, 'busy')
  release?.()
  await first
  timer.stop()
})

test('createAutoPushTimer：status() 从"没在跑"到"跑到第几条"再到"上一轮结论"', async () => {
  let release: (() => void) | undefined
  let report: ((event: { phase: 'push'; done: number; total: number; id: string }) => void) | undefined
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    now: () => 1_000,
    run: async (options) => {
      report = options?.onProgress as typeof report
      report?.({ phase: 'push', done: 0, total: 2, id: 'session-a' })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { ran: true, failures: 0 }
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
  })
  assert.deepEqual(timer.status(), { running: null, last: undefined }, '还没跑：什么都没在跑')

  const seen: string[] = []
  const pending = timer.tick({ force: true, onProgress: (event) => seen.push(event.phase) })
  // 让出一次，让 run() 里的第一条进度落到状态上。
  await new Promise((resolve) => setImmediate(resolve))
  const during = timer.status()
  assert.equal(during.running?.startedAt, 1_000, '开始时刻来自节拍器的时钟')
  assert.deepEqual(during.running?.progress, { phase: 'push', done: 0, total: 2, id: 'session-a' })
  assert.deepEqual(seen, ['push'], '发起那一侧自己给的回调照旧收到（记状态与报进度是两件事）')

  const second = await timer.tick()
  assert.equal(second.skip, 'busy', '正跑着的时候再点一次只报 busy——界面靠 status() 看进度，不靠再点一次')

  report?.({ phase: 'push', done: 2, total: 2, id: 'session-b' })
  assert.equal(timer.status().running?.progress?.done, 2, '进度跟着走到最后一条')
  release?.()
  await pending
  const after = timer.status()
  assert.equal(after.running, null, '跑完就不再是"正在跑"')
  assert.equal(after.last?.ran, true, '上一轮结论留在 status 里')
  timer.stop()
})

test('createAutoPushTimer：subscribe() 一条条收到进度，跑完收到结论，退订之后不再推', async () => {
  let release: (() => void) | undefined
  let report: ((event: { phase: 'push'; done: number; total: number; id: string }) => void) | undefined
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    now: () => 1_000,
    run: async (options) => {
      report = options?.onProgress as typeof report
      report?.({ phase: 'push', done: 0, total: 2, id: 'session-a' })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { ran: true, failures: 0, outcome: { pushed: [], bytesOut: 0, problems: [] } as never }
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
  })

  const events: string[] = []
  const unsubscribe = timer.subscribe((event) => {
    events.push(event.type === 'progress' ? `progress:${event.progress.done}` : 'done')
  })

  const pending = timer.tick({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['progress:0'], '订阅之后第一条进度就推过来了')

  report?.({ phase: 'push', done: 1, total: 2, id: 'session-b' })
  assert.deepEqual(events, ['progress:0', 'progress:1'], '每一条都推，不用等跑完')

  // 退订：这一轮剩下的都不该再推给它（界面关掉同步页就是这条路）。
  unsubscribe()
  report?.({ phase: 'push', done: 2, total: 2, id: 'session-c' })
  release?.()
  await pending
  assert.deepEqual(events, ['progress:0', 'progress:1'], '退订之后进度与结论都收不到')

  // 第二个订阅者进来：只推之后发生的（这一轮已经在跑，开头不会补发之前那几条）。
  const late: string[] = []
  const unsubscribeLate = timer.subscribe((event) => late.push(event.type))
  const second = timer.tick({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(late, ['progress'], '刚订上时不会补发之前那几条，只收之后产生的')
  release?.()
  await second
  assert.deepEqual(late, ['progress', 'done'], '跑完推一条结论')
  unsubscribeLate()
  timer.stop()
})

test('createAutoPushTimer：关着的时候 tick 回 disabled（手动那一次 force 例外）', async () => {
  const runs: number[] = []
  const timer = createAutoPushTimer({
    clock: { enabled: () => false, intervalMs: () => 60_000 },
    run: async () => {
      runs.push(1)
      return { ran: true, failures: 0 }
    },
    setTimer: () => 1,
    clearTimer: () => undefined,
  })
  const skipped = await timer.tick()
  assert.equal(skipped.skip, 'disabled')
  assert.equal(runs.length, 0)
  const forced = await timer.tick({ force: true })
  assert.equal(forced.ran, true, 'force 只管速度闸与开关：用户手点的那一次要能跑')
  assert.equal(runs.length, 1)
  timer.stop()
})

test('createAutoPushTimer：last() 报出当前设置与最近一次结论', async () => {
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 123_000 },
    run: async () => ({ ran: true, failures: 0 }),
    setTimer: () => 1,
    clearTimer: () => undefined,
  })
  const before = timer.last()
  assert.deepEqual(
    { enabled: before.enabled, intervalMs: before.intervalMs },
    { enabled: true, intervalMs: 123_000 },
  )
  assert.equal(before.outcome, undefined, '还没跑过就没有结论')
  await timer.tick()
  assert.equal(timer.last().outcome?.ran, true)
  timer.stop()
})


test('autoPushSection：间隔缺席取缺省、小于下限抬到下限、坏值退缺省', () => {
  /*
   * 这一条钉的是**"多久一次"只有一个来源**：用户填进配置的那个数在读的时候就被归一了，节拍器与
   * `runAutoPush()` 的速度闸读的都是归一之后的值。所以这里核的是"填 60000 就是 60000（不是 300000）"，
   * 以及"填 1 会被抬到 60000"——后者是那个下限唯一真正生效的地方。
   */
  const at = (autoPushIntervalMs: number | undefined): number =>
    autoPushSection({ url: 'https://dav.example/', ...(autoPushIntervalMs === undefined ? {} : { autoPushIntervalMs }) })
      ?.intervalMs ?? -1
  assert.equal(at(undefined), DEFAULT_AUTO_PUSH_INTERVAL_MS, '缺席 = 缺省 300000')
  assert.equal(at(120_000), 120_000, '填了就用填的那个')
  assert.equal(at(60_000), 60_000, '正好等于下限：原样（不是被抬成缺省！）')
  assert.equal(at(MIN_AUTO_PUSH_INTERVAL_MS), MIN_AUTO_PUSH_INTERVAL_MS, '下限本身照收')
  assert.equal(at(1), MIN_AUTO_PUSH_INTERVAL_MS, '比下限小的抬到下限，不退缺省')
  assert.equal(at(0), DEFAULT_AUTO_PUSH_INTERVAL_MS, '0 当坏值（schema 的 min(1) 会先挡，这里兜住手改配置）')
  assert.equal(at(Number.NaN), DEFAULT_AUTO_PUSH_INTERVAL_MS, 'NaN 退缺省')
  assert.equal(at(59_999.6), MIN_AUTO_PUSH_INTERVAL_MS, '整数化之后再判下限')
  // 开关只认 true：false 与缺席都是"没开"，不是"用默认值开"。
  assert.equal(autoPushSection({ url: 'x', autoPush: false })?.enabled, false)
  assert.equal(autoPushSection({ url: 'x' })?.enabled, false)
  assert.equal(autoPushSection({ url: 'x', autoPush: true })?.enabled, true)
  assert.equal(autoPushSection(undefined), undefined, '连同步都没配就没有这一节')
})

test('runAutoPush：填 60000 就按 60000 放行，别拿缺省那个 300000 当闸', async () => {
  /*
   * 回归：`autoPushIntervalMs` 填 60000 时，过了 61 秒**必须**放行。这条曾经有过一次"文档写 60000、
   * 实际要等 300000"的疑点——真正的原因是节拍器上挂了一个没人读的 `minIntervalMs`，看起来像第二道
   * 闸。现在闸门只比 `settings.autoPush.intervalMs`（读配置时就已归一），所以这条把"填多少就是多少"
   * 钉死：改回"拿缺省值当闸"，61 秒这一档立刻变红。
   */
  const machine = makeMachine('interval-floor')
  const fixture = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    writeSession(machine, 'only-local', 1000)
    const dav = createDavClient({ baseUrl: fixture.url })
    const deps = depsOf(machine, dav, settings(machine, { autoPush: { enabled: true, intervalMs: 60_000 } }))
    const t0 = 1_000_000
    const first = await runAutoPush(deps, { force: true, now: () => t0 })
    assert.equal(first.ran, true)

    // 61 秒之后：按 60000 的间隔该放行。
    const after = await runAutoPush(deps, { lastRunAt: first.finishedAt, now: () => t0 + 61_000 })
    assert.notEqual(after.skip, 'interval', '填了 60000 却在 61 秒时仍被挡住 = 闸用错了值')
    // 30 秒之后：该挡住。
    const early = await runAutoPush(deps, { lastRunAt: first.finishedAt, now: () => t0 + 30_000 })
    assert.equal(early.ran, false)
    assert.equal(early.skip, 'interval', '没到填的那个间隔就该挡住')
  } finally {
    await fixture.close()
    rmSync(machine.base, { recursive: true, force: true })
  }
})

// ── 事件层：写完一轮就推 ────────────────────────────────────────────────────────
//
// 这一组测的是"会话事件攒一轮"那一层（`touched()`）。它有两个并存的计时器——兜底的轮询与静默窗口——
// 所以假定时器要能同时记住两个句柄，按"谁被排了第几次"分辨（先排的是兜底那个）。

/** 一个能同时管住两个计时器的假表：返回句柄表，测试按顺序挑一个触发。 */
function fakeTimers(): {
  handles: Array<{ handler: () => void; ms: number }>
  setTimer: (handler: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** 触发第 index 个还挂着的计时器（按挂上的先后）。 */
  fire: (index: number) => void
  /** 还挂着几个。 */
  live: () => number
  /** 每个被排过的（ms 记录用）。 */
  scheduled: number[]
} {
  const handles: Array<{ handler: () => void; ms: number } | undefined> = []
  const scheduled: number[] = []
  const liveIndices = (): number[] => handles.map((h, i) => (h === undefined ? -1 : i)).filter((i) => i >= 0)
  return {
    handles: handles as Array<{ handler: () => void; ms: number }>,
    scheduled,
    setTimer: (handler, ms) => {
      scheduled.push(ms)
      handles.push({ handler, ms })
      return handles.length - 1
    },
    clearTimer: (handle) => {
      handles[handle as number] = undefined
    },
    fire: (index) => {
      const target = liveIndices()[index]
      assert.ok(target !== undefined, `没有第 ${index} 个还挂着的计时器（共 ${liveIndices().length} 个）`)
      const entry = handles[target]
      handles[target] = undefined
      entry?.handler()
    },
    live: () => liveIndices().length,
  }
}

test('touched()：静默窗口到了才推一轮，窗口是 AUTO_PUSH_SETTLE_MS', async () => {
  /*
   * 事件层的核心：收到 `turn/end` 不是立刻推，而是起一个静默窗口——一轮对话里 `turn/end` 会连发
   * （goal 续轮、子智能体、compaction），不等一等就是整包 PUT × N。
   */
  const timers = fakeTimers()
  const runs: Array<{ force?: boolean } | undefined> = []
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    run: async (options) => {
      runs.push(options as { force?: boolean } | undefined)
      return { ran: true, failures: 0 }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  // 挂上之后先排的是兜底那一轮（60 秒）。
  assert.equal(timers.handles[0]?.ms, 60_000, '兜底那一轮先挂上')

  timer.touched()
  assert.equal(timers.live(), 2, '兜底 + 静默窗口，两个各算各的')
  assert.equal(timers.handles[1]?.ms, AUTO_PUSH_SETTLE_MS, `静默窗口是 ${AUTO_PUSH_SETTLE_MS} 毫秒`)
  assert.equal(runs.length, 0, '窗口没到之前不推')

  timers.fire(1) // 静默窗口那个
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, '窗口到了就推一轮')
  assert.equal(runs[0]?.force, true, '用户刚写完一轮：绕开速度闸（那是给兜底那条路留的）')
  timer.stop()
})

test('touched()：窗口里再来事件就重置计时（连发的 turn/end 只推一次）', async () => {
  const timers = fakeTimers()
  const runs: number[] = []
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    run: async () => {
      runs.push(1)
      return { ran: true, failures: 0 }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  timer.touched()
  const firstWindow = timers.handles[1]
  assert.equal(timers.live(), 2, '兜底 + 一个窗口')
  timer.touched() // 又写完一条
  timer.touched() // 再来一条

  assert.equal(timers.handles[1], undefined, '前一个窗口被清掉了（这就是"重置"）')
  assert.equal(timers.live(), 2, '重置之后仍然只有"兜底 + 一个窗口"，不会越攒越多')

  // 只有最后那个窗口能触发，且只推一次——被重置掉的那个已经不在表里了。
  const lastWindow = timers.handles[timers.handles.length - 1]
  assert.notEqual(lastWindow, firstWindow, '是重排出来的新句柄，不是原来那个')
  timers.fire(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, '连发三次也只推一次')
  timer.stop()
})

test('touched()：关着的时候什么都不做（不排队、不欠账）', async () => {
  const timers = fakeTimers()
  const runs: number[] = []
  let enabled = false
  const timer = createAutoPushTimer({
    clock: { enabled: () => enabled, intervalMs: () => 60_000 },
    run: async () => {
      runs.push(1)
      return { ran: true, failures: 0 }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  assert.equal(timers.live(), 0, '关着时连兜底都不挂')

  timer.touched()
  assert.equal(timers.live(), 0, '关着时事件不排任何东西')
  assert.equal(runs.length, 0)

  // 打开之后，之前那次 touched() 不该"补跑"一次——没有欠账这回事。
  enabled = true
  timer.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, '只有显式 tick 的那一次')
  timer.stop()
})

test('touched()：上一轮还在跑时记下"补一次"，跑完立刻补推', async () => {
  /*
   * 正在跑的那一轮读的是它**开始之前**的快照，里面没有刚写完的这一笔。直接丢掉会让用户觉得
   * "我写完了它没推"，所以欠着的那一次要在跑完之后补上。
   */
  const timers = fakeTimers()
  let release: (() => void) | undefined
  const runs: Array<{ force?: boolean } | undefined> = []
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    run: async (options) => {
      runs.push(options as { force?: boolean } | undefined)
      if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve })
      return { ran: true, failures: 0 }
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  const first = timer.tick({ force: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 1, '第一轮在跑')

  timer.touched()
  assert.equal(timers.live(), 1, '跑着的时候不排窗口（只记账，见下）')

  release?.()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.live(), 2, '跑完补起一个窗口（兜底 + 它）')

  timers.fire(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runs.length, 2, '欠着的那一次补推了')
  assert.equal(runs[1]?.force, true, '补的那次也绕开速度闸')
  timer.stop()
})

test('touched()：stop() 之后不再排窗口', async () => {
  const timers = fakeTimers()
  const timer = createAutoPushTimer({
    clock: { enabled: () => true, intervalMs: () => 60_000 },
    run: async () => ({ ran: true, failures: 0 }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  timer.touched()
  assert.equal(timers.live(), 2)
  timer.stop()
  assert.equal(timers.live(), 0, 'stop() 把兜底与窗口都清掉')
  timer.touched()
  assert.equal(timers.live(), 0, '停掉之后事件不再排窗口')
})
