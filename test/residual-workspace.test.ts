// 端到端：一次「整来源全部迁移」之后，源工作区在侧边栏里还会不会留着。
//
// 为什么单开一个文件：这一条测的不是某一步，而是**三样东西的合取**——候选只收侧边栏显示的会话
// （visibility.ts）、注册表判"搬空了吗"要按宿主认的成员算（registry.ts / plan.ts）、以及搬完剩下的
// 那几条必须报出来（describeStranded()）。三者各自都有单测，但"全量迁移之后工作区还在不在"只有把它们
// 串起来才看得见，而它正是用户看见的那个现象（一个画出来却一条都不显示的工作区）。
//
// 宿主那一侧用夹具端口"像真宿主"：成员按 header 的 cwd 归一之后是否等于记录的 path 过滤（宿主
// `WorkspaceEntity.sessionIds` 就是这个判据），挂靠按同一条校验、不合格就回绝。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { canonicalDirIfExists } from '../src/canonical-path.ts'
import { scanAll } from '../src/discovery.ts'
import { runMigration, type MigrateDeps } from '../src/migrate.ts'
import { encodeSegment, projectionCacheDir, sessionDir } from '../src/paths.ts'
import { readRegistry, writeRegistryAtomic } from '../src/registry.ts'
import type { DecodeAll, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

interface Fixture {
  base: string
  root: string
  registryPath: string
  from: string
  to: string
  deps: MigrateDeps
  /** 夹具宿主实际收到的动作（断言"宿主自己有没有把那块工作区删掉"）。 */
  calls: string[]
  /** 夹具宿主现在认这块工作区的哪些成员（与宿主同一条过滤：cwd 归一 == 记录的 path）。 */
  hostMembers: (workspaceId: string) => string[]
}

/**
 * 造一个隔离沙箱：源目录里有若干会话（可见 / 空白 / 已归档），注册表里还有一条**盘上没有**的登记。
 *
 * `createdAt` 递增，所以注册表的顺序与传入顺序一致（宿主注册表是"新→旧"）。
 */
function makeFixture(
  name: string,
  options: { sessions?: Array<'visible' | 'visible-2' | 'blank' | 'archived'>; dangling?: boolean } = {},
): Fixture {
  const kinds = options.sessions ?? ['visible', 'blank', 'archived']
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const from = join(base, 'source-workspace')
  const to = join(base, 'target-workspace')
  mkdirSync(from, { recursive: true })
  mkdirSync(to, { recursive: true })
  const root = join(base, 'sessions')
  const registryPath = join(base, 'storages', 'workspace.json')
  mkdirSync(join(base, 'storages'), { recursive: true })
  const cacheDir = projectionCacheDir(registryPath)
  mkdirSync(cacheDir, { recursive: true })

  let clock = 1000
  const registered: string[] = []
  let archivedId: string | undefined
  for (const kind of kinds) {
    const id = `session-${kind}`
    const createdAt = ++clock
    const blank = kind === 'blank'
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id,
      createdAt,
      cwd: from,
      isSeeded: false,
      delegationDepth: 0,
    }
    const frames = [encodeRawFrame(`${JSON.stringify(header)}\n`)]
    // 空白会话只有 seed 事件（宿主按投影缓存里的 `blank` 判它，见 visibility.ts）。
    if (!blank) frames.push(encodeRawFrame(`${JSON.stringify({ type: 'turn/start', seq: 0, data: {} })}\n`))
    const dir = sessionDir(root, from, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
    if (blank) {
      writeFileSync(
        join(cacheDir, `${encodeSegment(id)}.json`),
        JSON.stringify({
          record: { identity: { createdAt, cwd: from }, rows: { sessionListMetadata: { val: { blank: true } } } },
        }),
      )
    }
    if (kind === 'archived') archivedId = id
    registered.push(id)
  }
  // 登记着、但盘上从来没有过这条会话：插件删除会话时刻意不清理注册表（见 journal/delete 那篇笔记）。
  if (options.dangling !== false) registered.push('session-ghost')

  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-from', 'ws-to'],
      archivedSessionIds: archivedId === undefined ? [] : [archivedId],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'ws-from': {
          path: from,
          title: 'source-workspace',
          sessionIds: [...registered],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'ws-to': {
          path: to,
          title: 'target-workspace',
          sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeRegistryAtomic(registryPath, registry)

  /*
   * 夹具宿主：内存里一份记录 + 一张"这条会话现在住在哪"的索引。
   *
   * 索引在 `refreshIndex()` 时按磁盘重建（真宿主启动时做的两步之一），`sessionPath()` 查不到就返回
   * undefined——**悬空登记因此在宿主那边根本不算成员**，与真宿主一致。
   */
  const records = new Map<string, { id: string; path: string; sessionIds: string[] }>()
  for (const [id, record] of Object.entries(registry.tables.workspaces)) {
    records.set(id, { id, path: record.path, sessionIds: [...record.sessionIds] })
  }
  let index = new Map<string, string | undefined>()
  const sessionPath = (sessionId: string): string | undefined => index.get(sessionId)
  const calls: string[] = []

  const deps: MigrateDeps = {
    sessionsRoot: root,
    registryPath,
    backupRoot: join(base, 'backups'),
    decodeAll,
    hostRegistry: () => ({
      refreshIndex: async () => {
        index = new Map(
          scanAll(root, decodeAll).map((session) => [
            session.id,
            session.cwd === undefined ? undefined : canonicalDirIfExists(session.cwd),
          ]),
        )
      },
      ensureWorkspace: async (path) => {
        calls.push(`ensure ${path}`)
        for (const record of records.values()) if (record.path === path) return record.id
        const id = `ws-host-${records.size}`
        records.set(id, { id, path, sessionIds: [] })
        return id
      },
      attachSession: async (workspaceId, sessionId) => {
        calls.push(`attach ${sessionId}`)
        const record = records.get(workspaceId)
        if (record === undefined) throw new Error(`夹具：工作区 ${workspaceId} 不在`)
        const cwd = sessionPath(sessionId)
        // 真宿主就是拿索引里那份 header 校验的：对不上就一口回绝（活会话正是栽在这一步）。
        if (cwd !== record.path) throw new Error(`attach refused: its cwd resolves to '${String(cwd)}'`)
        if (!record.sessionIds.includes(sessionId)) record.sessionIds = [sessionId, ...record.sessionIds]
      },
      detachSession: async (workspaceId, sessionId) => {
        calls.push(`detach ${sessionId}`)
        const record = records.get(workspaceId)
        if (record !== undefined) record.sessionIds = record.sessionIds.filter((id) => id !== sessionId)
      },
      members: async (workspaceId) =>
        (records.get(workspaceId)?.sessionIds ?? []).filter((id) => sessionPath(id) === records.get(workspaceId)?.path),
      removeWorkspace: async (workspaceId) => {
        calls.push(`remove ${workspaceId}`)
        records.delete(workspaceId)
      },
    }),
  }

  return {
    base,
    root,
    registryPath,
    from,
    to,
    deps,
    calls,
    hostMembers: (workspaceId) =>
      (records.get(workspaceId)?.sessionIds ?? []).filter((id) => sessionPath(id) === records.get(workspaceId)?.path),
  }
}

test('E2E：只剩悬空登记的源工作区，全量迁移后必须被删掉', async () => {
  const fx = makeFixture('residual-stale-only', { sessions: ['visible'], dangling: true })

  const run = await runMigration(fx.deps, { from: fx.from, to: fx.to }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.verified, true, run.problems.join('; '))
  // 预演就得说清楚：这块工作区会被删，顺带摘掉那条盘上已经没有的登记。
  assert.deepEqual(
    run.preview.registryChange?.removedSources.map((entry) => entry.workspaceId),
    ['ws-from'],
  )
  assert.deepEqual(run.preview.registryChange?.droppedStale.map((entry) => entry.sessionIds), [['session-ghost']])
  assert.match(run.preview.summary, /顺带清掉 1 条宿主不认的悬空登记/)

  // 落盘结果：源工作区没了、目标工作区认下了那条会话
  const after = readRegistry(fx.registryPath)
  assert.equal(after.tables.workspaces['ws-from'], undefined, '源工作区必须被删掉（这正是"残留工作区"那一条）')
  assert.deepEqual(after.tables.workspaces['ws-to']?.sessionIds, ['session-visible'])
  assert.deepEqual(after.global.workspaceIds, ['ws-to'])

  // 宿主那一步：悬空登记要跟着摘掉，它才肯把这块工作区删掉（它本来就不认这条登记）
  assert.ok(fx.calls.includes('detach session-ghost'), '悬空登记也要从宿主那份里摘掉')
  assert.ok(fx.calls.includes('remove ws-from'), '宿主自己把那块空工作区删了')
  assert.deepEqual(fx.hostMembers('ws-from'), [])

  rmSync(fx.base, { recursive: true, force: true })
})

test('E2E：只剩侧边栏不显示的会话时，源工作区留着，但必须点名说清楚', async () => {
  const fx = makeFixture('residual-hidden', { sessions: ['visible', 'blank', 'archived'], dangling: true })

  const run = await runMigration(fx.deps, { from: fx.from, to: fx.to }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.verified, true, run.problems.join('; '))
  // 空白与已归档不进候选、这次不搬，因此源工作区留着——两块事实都得报出来。
  assert.deepEqual(run.preview.sessions.map((session) => session.id), ['session-visible'])
  assert.deepEqual(
    run.preview.strandedSources.map((source) => ({
      workspaceId: source.workspaceId,
      members: source.members.map((member) => `${member.id}:${member.reason}`),
    })),
    [{ workspaceId: 'ws-from', members: ['session-blank:blank', 'session-archived:archived'] }],
  )
  assert.match(run.summary, /另有 2 条会话侧边栏不显示（空白 1、已归档 1），这次不搬：session-blank、session-archived/)
  assert.match(run.summary, /那几块工作区因此不会被删/)
  assert.match(run.preview.summary, /另有 2 条会话侧边栏不显示（空白 1、已归档 1），这次不搬：session-blank、session-archived/)
  // 悬空登记照旧顺手摘掉，但它不是这块工作区留下来的原因
  assert.deepEqual(run.preview.registryChange?.droppedStale.map((entry) => entry.sessionIds), [['session-ghost']])

  const after = readRegistry(fx.registryPath)
  assert.deepEqual(after.tables.workspaces['ws-from']?.sessionIds, ['session-blank', 'session-archived'])
  assert.deepEqual(after.global.workspaceIds, ['ws-from', 'ws-to'])
  // 没搬的那两条还在源项目目录里、归属不变；搬走的那条在目标里
  assert.equal(existsSync(sessionDir(fx.root, fx.from, 'session-blank')), true)
  assert.equal(existsSync(sessionDir(fx.root, fx.from, 'session-archived')), true)
  assert.equal(existsSync(sessionDir(fx.root, fx.to, 'session-visible')), true)

  rmSync(fx.base, { recursive: true, force: true })
})

test('E2E：只是用户自己挑了子集时，不报"侧边栏不显示"那一句', async () => {
  const fx = makeFixture('residual-subset', { sessions: ['visible', 'visible-2'], dangling: false })

  const run = await runMigration(fx.deps, { from: fx.from, to: fx.to, sessionIds: ['session-visible'] }, { apply: true })

  assert.equal(run.applied, true)
  assert.deepEqual(run.preview.strandedSources, [], '没被点名的可见会话不是"搬不走的"，别混进这一句')
  assert.doesNotMatch(run.summary, /侧边栏不显示/)
  assert.deepEqual(readRegistry(fx.registryPath).tables.workspaces['ws-from']?.sessionIds, ['session-visible-2'])

  rmSync(fx.base, { recursive: true, force: true })
})
