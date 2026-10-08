// 迁移编排（src/migrate.ts）的单元面：预演只读、dry-run 不写、回滚只认自己的备份根。
//
// 工具层那条路径由 test/tools.test.ts 端到端覆盖（plan → migrate → verify → rollback），
// 这里补的是**界面也会用到的**那些边界：备份目录的越界拒绝、备份清单的列举、dry-run 的零写入。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import {
  assertBackupDir,
  listBackups,
  previewMigration,
  readBackup,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
} from '../src/migrate.ts'
import { scanAll } from '../src/discovery.ts'
import { createBackup } from '../src/journal.ts'
import { sessionDir } from '../src/paths.ts'
import { writeRegistryAtomic, readRegistry } from '../src/registry.ts'
import type { DecodeAll, HostRegistryPort, SessionHeader, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FROM = join(import.meta.dirname, '.sandbox', 'migrate-from')
const TO = join(import.meta.dirname, '.sandbox', 'migrate-to')

interface Sandbox {
  base: string
  deps: MigrateDeps
  sessionId: string
}

/** 造一个最小但完整的沙箱：源工作区里若干条会话 + 指向它们的注册表 + 已存在的目标目录。 */
function makeSandbox(name: string, ids: readonly string[] = ['session-migrate-1']): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })
  const sessionsRoot = join(base, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  mkdirSync(FROM, { recursive: true })
  mkdirSync(TO, { recursive: true })

  ids.forEach((id, index) => {
    const header: SessionHeader = {
      type: 'session',
      version: 4,
      id,
      createdAt: 1000 + index,
      cwd: FROM,
      isSeeded: false,
      delegationDepth: 0,
    }
    const dir = sessionDir(sessionsRoot, FROM, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), encodeRawFrame(`${JSON.stringify(header)}\n`))
  })

  const registryPath = join(base, 'workspace.json')
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-from'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-from': {
          path: FROM,
          title: 'from',
          sessionIds: [...ids],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeRegistryAtomic(registryPath, registry)

  return {
    base,
    sessionId: ids[0]!,
    deps: { sessionsRoot, registryPath, backupRoot: join(base, 'backups'), decodeAll },
  }
}

test('预演：把源项目目录的会话与注册表变更算出来，一个字节都不写', () => {
  const sb = makeSandbox('migrate-preview')
  const before = readFileSync(join(sb.deps.registryPath), 'utf8')

  const preview = previewMigration(sb.deps, { from: FROM, to: TO })
  assert.equal(preview.ok, true, `预演应当可用：${preview.problems.join('; ')}`)
  assert.equal(preview.sessions.length, 1)
  assert.equal(preview.sessions[0]?.registered, true)
  assert.equal(preview.files, 1)
  assert.ok(preview.bytes > 0, '应当报出日志字节数')
  assert.equal(preview.registryChange?.targetPath, TO)
  assert.match(preview.summary, /迁移/)

  // 只读的证据：注册表没变、会话还在源项目目录、目标项目目录没被建出来
  assert.equal(readFileSync(sb.deps.registryPath, 'utf8'), before)
  const dirName = basename(sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId))
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)), true, '会话应当还在源项目目录')
  assert.equal(existsSync(join(sb.deps.sessionsRoot, preview.targetProjectDir, dirName)), false, '预演不该建目标会话目录')
  rmSync(sb.base, { recursive: true, force: true })
})

test('预演：目标的另一种拼写先归一（同一个目录不会凭写法多出一条工作区记录）', () => {
  const sb = makeSandbox('migrate-canonical-to')
  // 结尾分隔符是"另一种拼写"里最朴素的一种；Windows 上还有 git 给的正斜杠（见 canonical-path.test.ts）
  const preview = previewMigration(sb.deps, { from: FROM, to: `${TO}${sep}` })

  assert.equal(preview.ok, true, `另一种拼写应当照常可用：${preview.problems.join('; ')}`)
  assert.equal(preview.to, TO, '落地用的是归一之后的那个字符串')
  assert.equal(preview.registryChange?.targetPath, TO, '注册表里那条记录的 path 也是它')
  rmSync(sb.base, { recursive: true, force: true })
})

test('预演：同一个目录的两种拼写不算一次迁移', () => {
  const sb = makeSandbox('migrate-same-directory')
  const preview = previewMigration(sb.deps, { from: FROM, to: `${FROM}${sep}` })

  assert.equal(preview.ok, false)
  assert.ok(
    preview.problems.some((problem) => /identical/.test(problem)),
    `应当报"源与目标同一个目录"：${preview.problems.join('; ')}`,
  )
  rmSync(sb.base, { recursive: true, force: true })
})

test('dry-run：runMigration(apply:false) 与预演同形，且不写盘', async () => {
  const sb = makeSandbox('migrate-dryrun')
  const run = await runMigration(sb.deps, { from: FROM, to: TO }, { apply: false })

  assert.equal(run.applied, false)
  assert.equal(run.backupDir, undefined, 'dry-run 不该有备份目录')
  assert.equal(run.preview.ok, true)
  assert.equal(existsSync(sb.deps.backupRoot), false, 'dry-run 不该建备份根')
  rmSync(sb.base, { recursive: true, force: true })
})

test('执行：改写 header.cwd、搬目录、登记目标工作区，并留下可回滚的备份', async () => {
  const sb = makeSandbox('migrate-apply')
  const run = await runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.verified, true, `复核应当通过：${run.problems.join('; ')}`)
  assert.equal(run.rewritten, 1)
  assert.equal(run.moved, 1)
  assert.ok(run.backupDir, '执行必须留下备份目录')

  // 备份清单带上了源/目标，界面据此列出"这次搬了什么"
  const { manifest } = readBackup(sb.deps, run.backupDir)
  assert.equal(manifest.from, FROM)
  assert.equal(manifest.to, TO)
  assert.equal(manifest.sessions.length, 1)
  assert.equal(manifest.sessions[0]?.sourceDir, sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId))

  // 目标项目目录里能看到这条会话，且 header.cwd 已改写
  const dir = sessionDir(sb.deps.sessionsRoot, TO, sb.sessionId)
  assert.equal(existsSync(dir), true, '会话应当已在目标项目目录里')
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)), false, '源项目目录里那份应当已经搬走')
  const header = JSON.parse(decodeAll(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as { cwd: string }
  assert.equal(header.cwd, TO)

  // 列举：这份备份应当出现在列表里，且带源/目标
  const listed = listBackups(sb.deps)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.sessions, 1)
  assert.equal(listed[0]?.from, FROM)
  assert.equal(listed[0]?.to, TO)

  rmSync(sb.base, { recursive: true, force: true })
})

test('子集：只搬点名的会话，源工作区没被搬空就留在注册表里', async () => {
  const sb = makeSandbox('migrate-subset', ['session-keep', 'session-go'])
  const run = await runMigration(sb.deps, { from: FROM, to: TO, sessionIds: ['session-go'] }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.verified, true, `复核应当通过：${run.problems.join('; ')}`)
  // 预演与落地看到的是同一份子集
  assert.deepEqual(run.preview.sessions.map((s) => s.id), ['session-go'])
  assert.equal(run.moved, 1)
  // 没被点名的那条必须原地不动
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, FROM, 'session-keep')), true, '未点名的会话不该被搬走')
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, FROM, 'session-go')), false)
  assert.equal(existsSync(sessionDir(sb.deps.sessionsRoot, TO, 'session-go')), true)

  // 注册表：只摘走 session-go；源工作区还剩一条，所以必须留着
  const change = run.preview.registryChange
  assert.equal(change?.removedSources.length, 0, '源工作区没被搬空，不该从注册表上删掉')
  assert.deepEqual(change?.movedFrom.map((entry) => entry.sessionIds), [['session-go']])
  assert.deepEqual(readRegistry(sb.deps.registryPath).tables.workspaces['ws-from']?.sessionIds, ['session-keep'])

  rmSync(sb.base, { recursive: true, force: true })
})

test('子集：点名的会话不在源项目目录里 → 预演就报问题，而不是静默少搬', () => {
  const sb = makeSandbox('migrate-subset-unknown', ['session-a'])
  const preview = previewMigration(sb.deps, { from: FROM, to: TO, sessionIds: ['session-a', 'session-ghost'] })

  assert.equal(preview.ok, false)
  assert.match(preview.problems.join('; '), /session-ghost not found/)
  rmSync(sb.base, { recursive: true, force: true })
})

test('回滚：dryRun 只回动作清单，真跑则目录与字节都回到原位', async () => {
  const sb = makeSandbox('migrate-rollback')
  const run = await runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })
  const backupDir = run.backupDir!
  const afterMigrate = sessionDir(sb.deps.sessionsRoot, TO, sb.sessionId)
  assert.equal(existsSync(afterMigrate), true)

  // dry-run：给动作但不写
  const plan = await rollbackMigration(sb.deps, { backupDir, dryRun: true })
  assert.equal(plan.dryRun, true)
  assert.ok(plan.actions.length > 0, '应当列出将要做的动作')
  assert.equal(existsSync(afterMigrate), true, 'dry-run 不该动目录')

  // 真回滚：目录回源项目目录、header.cwd 复原、注册表还原
  const done = await rollbackMigration(sb.deps, { backupDir })
  assert.equal(done.dryRun, false)
  assert.equal(done.restoredFiles, 1)
  assert.equal(done.registryRestored, true)
  assert.equal(existsSync(afterMigrate), false, '目标位必须已经搬走')
  const back = sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)
  assert.equal(existsSync(back), true, '会话目录必须搬回源项目目录')
  const header = JSON.parse(decodeAll(readFileSync(join(back, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as { cwd: string }
  assert.equal(header.cwd, FROM, 'header.cwd 必须逐字节还原成源路径')
  // 对称性：apply 会删掉空源项目目录，回滚也该删掉空目标项目目录（否则会话根下留一个空目录）
  assert.equal(existsSync(dirname(afterMigrate)), false, '空掉的目标项目目录应当被删掉')

  rmSync(sb.base, { recursive: true, force: true })
})

test('覆盖前那份备份：目录像删除那样搬回，注册表像迁移那样一起还原', async () => {
  // 同步"覆盖本机那份"走的是同一条备份路（`kind: 'replace'`），但语义与删除那份**不一样**：
  // 覆盖会把会话搬到一个新目录（远端那份的 cwd 可能不同）并 reHome 它在注册表里的登记，所以回滚必须
  // 连注册表一起还原——只搬目录会让登记停在被覆盖之后的那份路径上。
  const sb = makeSandbox('migrate-replace')
  const dir = sessionDir(sb.deps.sessionsRoot, FROM, sb.sessionId)
  const session = scanAll(sb.deps.sessionsRoot, decodeAll).find((item) => item.id === sb.sessionId)!
  const backup = createBackup({
    backupRoot: sb.deps.backupRoot,
    registryPath: sb.deps.registryPath,
    kind: 'replace',
    now: new Date('2026-10-05T08:00:00.000Z'),
    sessions: [{ id: sb.sessionId, sourceDir: dir, files: session.files }],
  })
  const manifest = JSON.parse(readFileSync(backup.manifestPath, 'utf8')) as { kind: string; sessions: Array<{ targetDir: string }> }
  assert.equal(manifest.kind, 'replace')
  assert.match(manifest.sessions[0]?.targetDir ?? '', /backups/, '目标目录是备份里那份副本（同删除），不是原位')

  // 模拟覆盖：本机那份被换掉（目录没了），注册表被 reHome 到另一个目录。
  rmSync(dir, { recursive: true, force: true })
  const registry = readRegistry(sb.deps.registryPath)
  registry.tables.workspaces['ws-from'] = {
    ...registry.tables.workspaces['ws-from']!,
    sessionIds: [],
  }
  writeRegistryAtomic(sb.deps.registryPath, registry)

  const listed = listBackups(sb.deps).find((item) => item.dir === backup.dir)
  assert.equal(listed?.kind, 'replace', '清单里如实报"覆盖前"那一类')

  const done = await rollbackMigration(sb.deps, { backupDir: backup.dir })
  assert.equal(done.registryRestored, true, '覆盖那条要连注册表一起还原')
  assert.equal(existsSync(dir), true, '被换掉的那份要搬回原位')
  assert.deepEqual(readRegistry(sb.deps.registryPath).tables.workspaces['ws-from']?.sessionIds, [sb.sessionId])

  rmSync(sb.base, { recursive: true, force: true })
})

test('备份目录越界：只认本插件备份根下的目录，其余一律拒', async () => {
  const sb = makeSandbox('migrate-guard')
  const run = await runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })
  const good = run.backupDir!

  assert.equal(assertBackupDir(sb.deps, good), good)
  // 空值、根目录本身、根之外、根下但没有 manifest 的目录
  assert.throws(() => assertBackupDir(sb.deps, ''), /缺少备份目录/)
  assert.throws(() => assertBackupDir(sb.deps, sb.deps.backupRoot), /不在本插件的备份根下/)
  assert.throws(() => assertBackupDir(sb.deps, join(sb.base, 'elsewhere')), /不在本插件的备份根下/)
  const empty = join(sb.deps.backupRoot, 'not-a-backup')
  mkdirSync(empty, { recursive: true })
  assert.throws(() => assertBackupDir(sb.deps, empty), /没有 manifest\.json/)

  rmSync(sb.base, { recursive: true, force: true })
})

test('列举备份：坏目录跳过而不是让整张列表打不开', async () => {
  const sb = makeSandbox('migrate-list')
  await runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })
  mkdirSync(join(sb.deps.backupRoot, 'garbage'), { recursive: true })
  writeFileSync(join(sb.deps.backupRoot, 'garbage', 'manifest.json'), '{not json')

  const listed = listBackups(sb.deps)
  assert.equal(listed.length, 1, '只有那一条真备份应当出现')
  assert.equal(listBackups({ ...sb.deps, backupRoot: join(sb.base, 'nope') }).length, 0, '备份根不存在时回空列表')
  rmSync(sb.base, { recursive: true, force: true })
})

test('执行后请宿主补检查点：搬动的会话各补一次，补不上也不影响迁移结论', async () => {
  const sb = makeSandbox('migrate-warm', ['session-warm-1', 'session-warm-2'])
  const warmed: string[] = []
  const run = await runMigration(
    {
      ...sb.deps,
      // 一条成功、一条失败：计数要分开，失败的只进结论、不进 problems（迁移本身没错）。
      hostCheckpoints: () => ({
        warm: async (sessionId: string) => {
          warmed.push(sessionId)
          if (sessionId === 'session-warm-2') throw new Error('日志读不动')
        },
      }),
    },
    { from: FROM, to: TO, title: 'to' },
    { apply: true },
  )

  assert.deepEqual([...warmed].sort(), ['session-warm-1', 'session-warm-2'])
  assert.equal(run.warm?.warmed, 1)
  assert.equal(run.warm?.failed, 1)
  assert.equal(run.verified, true, `复核应当照旧通过：${run.problems.join('; ')}`)
  assert.deepEqual(run.problems, [], '补齐列表元数据失败不该出现在迁移的问题清单里')
  assert.match(run.summary, /已请宿主折好这 1 条会话的列表元数据/)
  assert.match(run.summary, /1 条没补上/)

  rmSync(sb.base, { recursive: true, force: true })
})

test('宿主没有补检查点那套服务时：如实说"要等第一次点开"，迁移照旧算成功', async () => {
  const sb = makeSandbox('migrate-warm-unavailable')
  const run = await runMigration(sb.deps, { from: FROM, to: TO, title: 'to' }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.verified, true)
  assert.equal(run.warm?.unavailable, true)
  assert.match(run.summary, /第一次点开才有标题/)
  rmSync(sb.base, { recursive: true, force: true })
})

test('执行：宿主持着的那条不搬（日志也不动），注册表里它仍归源工作区', async () => {
  const sb = makeSandbox('migrate-live', ['session-hold', 'session-go'])
  const run = await runMigration(
    { ...sb.deps, liveSessionIds: () => new Set(['session-hold']) },
    { from: FROM, to: TO, title: 'to' },
    { apply: true },
  )

  assert.equal(run.applied, true)
  assert.deepEqual(run.preview.sessions.map((s) => s.id), ['session-go'], '只搬没被宿主持着的那条')
  assert.deepEqual(run.preview.liveSkipped.map((s) => s.id), ['session-hold'])
  assert.match(run.summary, /另有 1 条会话宿主持在内存里（还活着），这次没搬：session-hold/)
  // 少搬的那条必须还在原处、还在源工作区那条记录里：源工作区因此不会被摘空、更不会被删。
  assert.equal(
    existsSync(sessionDir(sb.deps.sessionsRoot, FROM, 'session-hold')),
    true,
    '活会话的日志不许搬走',
  )
  const registry = readRegistry(sb.deps.registryPath)
  assert.deepEqual(registry.tables.workspaces['ws-from']?.sessionIds, ['session-hold'])
  assert.deepEqual(run.preview.registryChange?.removedSources, [])
  rmSync(sb.base, { recursive: true, force: true })
})

test('宿主没接住时把这次算好的注册表写回文件（它自己那一步已经用内存副本盖过一次）', async () => {
  const sb = makeSandbox('migrate-effect-clobber')
  const before = readRegistry(sb.deps.registryPath)
  let clobbered = 0
  const deps: MigrateDeps = {
    ...sb.deps,
    hostRegistry: () => ({
      refreshIndex: async () => {},
      ensureWorkspace: async () => {
        // 宿主的真实行为：新建工作区那一步它按内存里那份整份落盘（单单元契约），插件写好的文件当场被盖。
        writeRegistryAtomic(sb.deps.registryPath, before)
        clobbered += 1
        return 'ws-host-1'
      },
      attachSession: async () => {
        throw new Error('夹具：宿主拒绝挂靠')
      },
      detachSession: async () => {},
      members: async () => [],
      removeWorkspace: async () => {},
    }),
  }
  const run = await runMigration(deps, { from: FROM, to: TO, title: 'to' }, { apply: true })

  assert.equal(clobbered, 1, '夹具要真的盖过一次，否则这条测试什么也没测')
  assert.equal(run.applied, true, '宿主没接住不该把迁移说成失败')
  assert.equal(run.effect?.kind, 'failed')
  assert.equal(run.effect?.registryRestored, true, '宿主动过手，就必须把这次的结果写回去')
  assert.match(run.summary, /注册表已按这次的结果重新写回磁盘/)
  // 磁盘上留下的必须是这次的结果：目标工作区认下了那条会话，源工作区那条记录没了。
  const after = readRegistry(sb.deps.registryPath)
  const target = Object.values(after.tables.workspaces).find((record) => record.path === TO)
  assert.deepEqual(target?.sessionIds, [sb.sessionId])
  assert.equal(
    Object.values(after.tables.workspaces).some((record) => record.path === FROM),
    false,
    '源工作区被摘空后应删掉',
  )
  // 复核是拿"改动前的备份"与"现在磁盘上那份"比的：写回来了它就该通过——不写回来正是用户撞上的那次 500。
  assert.equal(run.verified, true, run.problems.join('; '))
  assert.deepEqual(run.problems, [])
  rmSync(sb.base, { recursive: true, force: true })
})

/**
 * 一个"像真宿主"的端口：它按**内存里那份**整份落盘（`dsh-storage-json` 的单单元契约），并且只认
 * `known` 里的会话（盘上早就没有的那些它认不出来，`attachSession()` 会回绝——真实宿主拿 header 缓存
 * 校验 cwd，同样回绝）。
 */
function memoryHost(options: {
  registryPath: string
  memory: WorkspaceRegistryState
  known: ReadonlySet<string>
}): { port: HostRegistryPort; attached: Array<{ workspaceId: string; sessionId: string }>; refreshes: () => number } {
  const attached: Array<{ workspaceId: string; sessionId: string }> = []
  let refreshes = 0
  const persist = (): void => writeRegistryAtomic(options.registryPath, options.memory)
  const stamp = '2026-01-01T00:00:00.000Z'
  return {
    attached,
    refreshes: () => refreshes,
    port: {
      refreshIndex: async () => {
        refreshes += 1
      },
      ensureWorkspace: async (path, title) => {
        const found = Object.entries(options.memory.tables.workspaces).find(([, record]) => record.path === path)
        if (found !== undefined) return found[0]
        const id = `ws-host-${Object.keys(options.memory.tables.workspaces).length}`
        options.memory.tables.workspaces[id] = {
          path,
          title: title ?? path,
          sessionIds: [],
          createdAt: stamp,
          updatedAt: stamp,
        }
        options.memory.global.workspaceIds.push(id)
        // 真实宿主：新建工作区那一步它按内存里那份整份落盘，插件写好的文件当场被盖。
        persist()
        return id
      },
      attachSession: async (workspaceId, sessionId) => {
        if (!options.known.has(sessionId)) throw new Error(`夹具：宿主不认这条会话 ${sessionId}`)
        const record = options.memory.tables.workspaces[workspaceId]
        if (record === undefined) throw new Error(`夹具：没有这条工作区 ${workspaceId}`)
        if (!record.sessionIds.includes(sessionId)) record.sessionIds.push(sessionId)
        attached.push({ workspaceId, sessionId })
        persist()
      },
      detachSession: async (workspaceId, sessionId) => {
        const record = options.memory.tables.workspaces[workspaceId]
        if (record !== undefined) record.sessionIds = record.sessionIds.filter((id) => id !== sessionId)
        persist()
      },
      members: async (workspaceId) => [...(options.memory.tables.workspaces[workspaceId]?.sessionIds ?? [])],
      removeWorkspace: async (workspaceId) => {
        delete options.memory.tables.workspaces[workspaceId]
        options.memory.global.workspaceIds = options.memory.global.workspaceIds.filter((id) => id !== workspaceId)
        persist()
      },
    },
  }
}

/** 往注册表里加一个别的目录的工作区，它有一条归属——宿主的旧内存里未必有这条。 */
function addStranger(sb: Sandbox, workspaceId: string, path: string, sessionId: string): WorkspaceRegistryState {
  mkdirSync(path, { recursive: true })
  const registry = readRegistry(sb.deps.registryPath)
  registry.global.workspaceIds.push(workspaceId)
  registry.tables.workspaces[workspaceId] = {
    path,
    title: 'other',
    sessionIds: [sessionId],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  writeRegistryAtomic(sb.deps.registryPath, registry)
  return registry
}

test('宿主全盘接受、却拿内存里那份抹掉了别人的归属：复核出来并让它重新挂一遍', async () => {
  const sb = makeSandbox('migrate-effect-memory-clobber')
  const otherDir = join(sb.base, 'other-dir')
  const stranger = 'session-stranger-1'
  const registry = addStranger(sb, 'ws-other', otherDir, stranger)
  // 宿主那次启动读到的是更早的一份：这条归属在它内存里根本没有。
  const memory = structuredClone(registry)
  memory.tables.workspaces['ws-other']!.sessionIds = []
  const host = memoryHost({ registryPath: sb.deps.registryPath, memory, known: new Set([sb.sessionId, stranger]) })
  const deps: MigrateDeps = { ...sb.deps, hostRegistry: () => host.port }

  const run = await runMigration(deps, { from: FROM, to: TO, title: 'to' }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.effect?.kind, 'applied')
  assert.deepEqual(run.effect?.membershipsRestored, [stranger], '被抹掉的归属要让它重新认下')
  assert.equal(run.effect?.membershipsUnrecognized, undefined)
  // 走的是宿主那条路（不是插件自己写文件）：它被要求重新挂过这一条，且挂之前先按磁盘重看了一遍。
  assert.deepEqual(
    host.attached.filter((entry) => entry.sessionId === stranger),
    [{ workspaceId: 'ws-other', sessionId: stranger }],
  )
  assert.ok(host.refreshes() >= 2, '要回来之前得让它按磁盘重看一遍，否则它拿旧缓存回绝')
  // 磁盘上那条归属回来了，复核因此通过。
  const after = readRegistry(sb.deps.registryPath)
  assert.deepEqual(after.tables.workspaces['ws-other']?.sessionIds, [stranger])
  assert.equal(run.verified, true, run.problems.join('; '))
  assert.match(run.summary, /顺手抹掉了 1 条别的归属/)
  rmSync(sb.base, { recursive: true, force: true })
})

test('宿主不认的悬空登记只报出来，不写回文件', async () => {
  const sb = makeSandbox('migrate-effect-unknown-membership')
  const otherDir = join(sb.base, 'other-dir')
  const ghost = 'session-ghost-1'
  const registry = addStranger(sb, 'ws-other', otherDir, ghost)
  // 宿主不认这条（盘上早就没有这条会话）：内存里没有它，`attachSession()` 也回绝。
  const memory = structuredClone(registry)
  memory.tables.workspaces['ws-other']!.sessionIds = []
  const host = memoryHost({ registryPath: sb.deps.registryPath, memory, known: new Set([sb.sessionId]) })
  const deps: MigrateDeps = { ...sb.deps, hostRegistry: () => host.port }

  const run = await runMigration(deps, { from: FROM, to: TO, title: 'to' }, { apply: true })

  assert.equal(run.applied, true)
  assert.equal(run.effect?.membershipsRestored, undefined, '要不回来的不能算要回来了')
  assert.deepEqual(run.effect?.membershipsUnrecognized, [ghost])
  assert.match(run.summary, /另有 1 条归属宿主不认/)
  // 关键：不硬写回文件（写回去只会让它下次落盘再抹一次）。
  const after = readRegistry(sb.deps.registryPath)
  assert.deepEqual(after.tables.workspaces['ws-other']?.sessionIds, [])
  // 复核照旧点名这一条没了（悬空登记的清理是另一条路的事）。
  assert.equal(run.verified, false)
  assert.ok(
    run.problems.some((problem) => problem.includes(ghost)),
    `复核应当点名这条：${run.problems.join('; ')}`,
  )
  rmSync(sb.base, { recursive: true, force: true })
})
