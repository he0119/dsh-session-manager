// 「未分组」来源：源不是一个目录，而是"注册表没认领、且有 cwd"的那批会话（可以横跨多个项目目录）。
//
// 这一支与单目录来源的差别全在**源的定义**上：计划层要对着一整库去圈候选、每条会话的源目录各不
// 相同、执行阶段要按每条会话自己的项目目录清理空目录。所以这里用一个"三个目录 + 一个无 cwd 的老会话"
// 的沙箱把这些点逐个钉住，并跑到 apply → verify → rollback（回滚只认清单，跨目录对它是透明的）。
//
// cwd 用沙箱里的**真实目录**：计划层会用 existsSync(to) 校验目标目录存在。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { applyPlan, verifyAppliedPlan } from '../src/execute.ts'
import { readManifest, rollback } from '../src/journal.ts'
import { previewMigration } from '../src/migrate.ts'
import { buildRelocationPlan } from '../src/plan.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import type { DecodeAll, SessionMove, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

let clock = 0
function makeLog(id: string, cwd: string | undefined, nEvents: number): Buffer {
  const createdAt = ++clock
  const header: Record<string, unknown> = { type: 'session', version: 4, id, createdAt, isSeeded: false, delegationDepth: 0 }
  if (cwd !== undefined) header['cwd'] = cwd
  const frames = [encodeRawFrame(JSON.stringify(header) + '\n')]
  for (let i = 0; i < nEvents; i++) {
    const type = i === 0 ? 'turn/start' : i === nEvents - 1 ? 'turn/end' : 'user/message'
    frames.push(
      encodeRawFrame(
        JSON.stringify({ type, seq: i, time: createdAt + i, data: { turn: 1, content: [{ type: 'text', text: `#${i}` }] } }) +
          '\n',
      ),
    )
  }
  return Buffer.concat(frames)
}

/** 会话目录名（宿主按 id 编码；这里直接用 id 当目录名，扫描阶段不校验这两者的关系）。 */
const dirNameOf = (id: string): string => id

interface Sandbox {
  base: string
  root: string
  registryPath: string
  registry: WorkspaceRegistryState
  backupRoot: string
  dirA: string
  dirB: string
  dirC: string
  dirTarget: string
  logs: Record<string, Buffer>
  sessionDir: (id: string) => string
}

/**
 * 沙箱布局：
 *   dirA —— 已登记工作区 ws-a（只认领 session-owned），项目目录里还混着一条没人认领的 session-orphan-a；
 *   dirB / dirC —— 没有工作区记录，各住着一条没人认领的会话；
 *   `_no-cwd` 项目目录 —— 一条没有 cwd 的未登记会话（不该进「未分组」来源：header 里没有 cwd 可改写）；
 *   dirTarget —— 目标目录，**不在**注册表里（于是这次迁移要新建一条工作区记录），
 *               项目目录里已经住着一条没人认领的 session-orphan-at（cwd 就是它）。
 */
function makeSandbox(name: string): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })

  const dirA = join(base, 'dir-a')
  const dirB = join(base, 'dir-b')
  const dirC = join(base, 'dir-c')
  const dirTarget = join(base, 'target')
  for (const dir of [dirA, dirB, dirC, dirTarget]) mkdirSync(dir, { recursive: true })

  const root = join(base, 'dsh', 'sessions')
  const logs: Record<string, Buffer> = {
    'session-owned': makeLog('session-owned', dirA, 20),
    'session-orphan-a': makeLog('session-orphan-a', dirA, 6),
    'session-orphan-b': makeLog('session-orphan-b', dirB, 4),
    'session-orphan-c': makeLog('session-orphan-c', dirC, 3),
    // 这条的 cwd 已经**是**目标目录：没人认领，但它本来就住在那儿（真实库里的常态）。
    // 收编它只需要补一条注册表记录——不搬目录、不改 cwd，回滚时也不能去搬自己的目录。
    'session-orphan-at': makeLog('session-orphan-at', dirTarget, 5),
    'session-nocwd': makeLog('session-nocwd', undefined, 2),
  }
  const place = (projectDirName: string, id: string): void => {
    const dir = join(root, projectDirName, dirNameOf(id))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), logs[id]!)
  }
  place(projectKey(dirA), 'session-owned')
  place(projectKey(dirA), 'session-orphan-a')
  place(projectKey(dirB), 'session-orphan-b')
  place(projectKey(dirC), 'session-orphan-c')
  place(projectKey(dirTarget), 'session-orphan-at')
  place('_no-cwd', 'session-nocwd')

  const registryPath = join(base, 'dsh', 'storages', 'workspace.json')
  mkdirSync(join(base, 'dsh', 'storages'), { recursive: true })
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-a'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-a': {
          path: dirA,
          title: 'a',
          sessionIds: ['session-owned'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n')

  return {
    base,
    root,
    registryPath,
    registry,
    backupRoot: join(base, 'backups'),
    dirA,
    dirB,
    dirC,
    dirTarget,
    logs,
    sessionDir: (id: string) => {
      for (const projectDirName of [projectKey(dirA), projectKey(dirB), projectKey(dirC), '_no-cwd', projectKey(dirTarget)]) {
        const dir = join(root, projectDirName, dirNameOf(id))
        if (existsSync(dir)) return dir
      }
      throw new Error(`session ${id} not found in the sandbox`)
    },
  }
}

const opts = (sb: Sandbox, extra: Record<string, unknown> = {}) => ({
  root: sb.root,
  registry: sb.registry,
  to: sb.dirTarget,
  decodeAll,
  unowned: true,
  ...extra,
})

test('未分组来源：候选 = 注册表没认领且有 cwd 的那些，横跨多个项目目录', () => {
  const sb = makeSandbox('unowned-plan')
  const plan = buildRelocationPlan(opts(sb))

  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.unowned, true)
  // 源不是一个目录：这两个字段必须是空串，而不是随便挑一个目录当"代表"
  assert.equal(plan.from, '')
  assert.equal(plan.sourceProjectDir, '')
  assert.deepEqual(
    plan.sessions.map((s: SessionMove) => s.id).sort(),
    ['session-orphan-a', 'session-orphan-at', 'session-orphan-b', 'session-orphan-c'],
    '在册的 session-owned 与没有 cwd 的 session-nocwd 都不该进这个来源',
  )
  // 每条会话各自的源目录：这就是"跨目录"在计划里的样子（执行阶段全靠它）
  const fromById = new Map(plan.sessions.map((s: SessionMove) => [s.id, s.from]))
  assert.equal(fromById.get('session-orphan-a'), sb.dirA)
  assert.equal(fromById.get('session-orphan-b'), sb.dirB)
  assert.equal(fromById.get('session-orphan-c'), sb.dirC)
  assert.equal(fromById.get('session-orphan-at'), sb.dirTarget)
  // cwd already at the target: no move, no rewrite — the one that only needs a registry entry
  const atTarget = plan.sessions.find((s: SessionMove) => s.id === 'session-orphan-at')!
  assert.equal(atTarget.alreadyAtTarget, true)
  assert.equal(atTarget.sourceDir, atTarget.targetDir, '目标目录就是它自己，这不是"目标被占用"')
  for (const s of plan.sessions) {
    assert.equal(s.to, sb.dirTarget)
    assert.equal(s.registered, false)
    assert.equal(s.targetDir, join(sb.root, projectKey(sb.dirTarget), dirNameOf(s.id)))
  }
  // 注册表：目标记录要新建，三条都是"从未分组收编"，没有从任何工作区摘除
  assert.equal(plan.registryChange?.createdTarget, true)
  assert.equal(plan.registryChange?.adoptedFromUnowned.length, 4)
  assert.deepEqual(plan.registryChange?.movedFrom, [])
  assert.deepEqual(plan.registryChange?.removedSources, [])
  // 在册那条会话的归属不能被动到
  assert.deepEqual(plan.nextRegistry?.tables.workspaces['ws-a']?.sessionIds, ['session-owned'])
})

test('未分组来源：预演把"横跨几个源项目目录"报出来，且一个字节都不写', () => {
  const sb = makeSandbox('unowned-preview')
  const before = readFileSync(join(sb.sessionDir('session-orphan-b'), 'session.v4.jsonl.zstd'))
  const preview = previewMigration(
    { sessionsRoot: sb.root, registryPath: sb.registryPath, backupRoot: sb.backupRoot, decodeAll },
    { to: sb.dirTarget, unowned: true },
  )

  assert.equal(preview.ok, true, preview.problems.join('; '))
  assert.equal(preview.unowned, true)
  // 源不是一个目录：from / sourceProjectDir 是空串，界面据此换一句"横跨 N 个源项目目录"的说明
  assert.equal(preview.from, '')
  assert.equal(preview.sourceProjectDir, '')
  assert.deepEqual(preview.sourceProjectDirs, [
    join(sb.root, projectKey(sb.dirA)),
    join(sb.root, projectKey(sb.dirB)),
    join(sb.root, projectKey(sb.dirC)),
    join(sb.root, projectKey(sb.dirTarget)),
  ])
  assert.equal(preview.sessions.length, 4)
  assert.equal(preview.registryChange?.createdTarget, true)

  assert.equal(existsSync(join(sb.root, projectKey(sb.dirTarget), dirNameOf('session-orphan-b'))), false)
  assert.deepEqual(readFileSync(join(sb.sessionDir('session-orphan-b'), 'session.v4.jsonl.zstd')), before)
})

test('未分组来源：apply 把会话收进目标工作区，并只清掉自己搬空的项目目录', () => {
  const sb = makeSandbox('unowned-apply')
  const plan = buildRelocationPlan(opts(sb, { title: '收编' }))
  assert.equal(plan.ok, true, plan.problems.join('; '))

  const result = applyPlan(plan, {
    registryPath: sb.registryPath,
    decodeAll,
    backupRoot: sb.backupRoot,
  })
  const verified = verifyAppliedPlan(plan, { decodeAll })
  assert.equal(verified.ok, true, verified.problems.join('; '))
  // 四条里只有三条真的换了位置：cwd 已经等于目标的那条留在原地（`alreadyAtTarget`），
  // 改写的日志也只有三条（它的 header 本来就不用改）。
  assert.equal(result.moved, 3)
  assert.equal(result.rewritten, 3)

  // 落位：三条会话都进了目标项目目录，header 里的 cwd 都是目标目录
  for (const id of ['session-orphan-a', 'session-orphan-b', 'session-orphan-c', 'session-orphan-at']) {
    const dir = join(sb.root, projectKey(sb.dirTarget), dirNameOf(id))
    assert.equal(existsSync(dir), true, `${id} 应该落在目标项目目录里`)
    const header = JSON.parse(decodeAll(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as {
      cwd?: string
      id?: string
    }
    assert.equal(header.cwd, sb.dirTarget)
    assert.equal(header.id, id)
  }

  // 没被点到的两条会话原地不动（一个字节都不该变）；cwd 已在目标上的那条也不该被改写
  assert.deepEqual(readFileSync(join(sb.sessionDir('session-owned'), 'session.v4.jsonl.zstd')), sb.logs['session-owned'])
  assert.deepEqual(readFileSync(join(sb.sessionDir('session-nocwd'), 'session.v4.jsonl.zstd')), sb.logs['session-nocwd'])
  assert.deepEqual(
    readFileSync(join(sb.root, projectKey(sb.dirTarget), dirNameOf('session-orphan-at'), 'session.v4.jsonl.zstd')),
    sb.logs['session-orphan-at'],
  )

  // 空项目目录：dirB / dirC 的各只剩空目录，被删；dirA 还留着在册的那条会话，必须保住
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirB))), false, '搬空的项目目录要删掉')
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirC))), false, '搬空的项目目录要删掉')
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirA))), true, '还有别的会话的项目目录不能删')
  assert.equal(existsSync(sb.sessionDir('session-owned')), true)

  // 注册表：新建的目标记录收下三条，ws-a 原样
  const registry = readRegistry(sb.registryPath)
  const targetId = plan.registryChange!.targetId
  assert.equal(registry.tables.workspaces[targetId]?.path, sb.dirTarget)
  assert.equal(registry.tables.workspaces[targetId]?.title, '收编')
  assert.deepEqual(registry.tables.workspaces[targetId]?.sessionIds.slice().sort(), [
    'session-orphan-a',
    'session-orphan-at',
    'session-orphan-b',
    'session-orphan-c',
  ])
  assert.deepEqual(registry.tables.workspaces['ws-a']?.sessionIds, ['session-owned'])

  // 备份清单：源不是一个目录，所以 from 缺席（界面显示成「—」）；每条会话的原始位置在记录里
  const { manifest } = readManifest(result.backupDir)
  assert.equal(manifest.from, undefined)
  assert.equal(manifest.to, sb.dirTarget)
  assert.equal(manifest.sessions.length, 4)
  assert.deepEqual(
    manifest.sessions.map((s) => basename(dirname(s.sourceDir))).sort(),
    [projectKey(sb.dirA), projectKey(sb.dirB), projectKey(sb.dirC), projectKey(sb.dirTarget)].sort(),
  )
})

test('未分组来源：回滚把三条会话按清单搬回原项目目录、字节还原、注册表还原', () => {
  const sb = makeSandbox('unowned-rollback')
  const plan = buildRelocationPlan(opts(sb, { title: '收编' }))
  assert.equal(plan.ok, true, plan.problems.join('; '))
  const result = applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot })
  const { manifest } = readManifest(result.backupDir)

  const rolled = rollback(manifest, { backupDir: result.backupDir })
  assert.equal(rolled.restoredFiles, 4)

  for (const id of ['session-orphan-a', 'session-orphan-b', 'session-orphan-c', 'session-orphan-at']) {
    const dir = sb.sessionDir(id)
    assert.deepEqual(readFileSync(join(dir, 'session.v4.jsonl.zstd')), sb.logs[id], `${id} 的字节要一模一样`)
  }
  // 已经住在目标目录里的那条：回滚**不能**去搬它自己的目录（源==目标，先删后改名会丢目录）
  assert.equal(
    existsSync(join(sb.root, projectKey(sb.dirTarget), dirNameOf('session-orphan-at'))),
    true,
    'cwd 已在目标上的那条会话，回滚后必须还在原地',
  )
  const moveBacks = rolled.actions.filter((action: string) => action.startsWith('move back:'))
  assert.equal(moveBacks.length, 3, '只有真的挪过位置的那三条才有"搬回去"的动作')
  assert.equal(
    moveBacks.some((action: string) => action.includes(dirNameOf('session-orphan-at'))),
    false,
    '原地不动的那条不该被搬（源与目标是同一个目录，搬它等于先删掉自己）',
  )
  // 回滚后再看一次：在册的那条、无 cwd 的那条始终没被动过
  assert.deepEqual(readFileSync(join(sb.sessionDir('session-owned'), 'session.v4.jsonl.zstd')), sb.logs['session-owned'])
  assert.deepEqual(readFileSync(join(sb.sessionDir('session-nocwd'), 'session.v4.jsonl.zstd')), sb.logs['session-nocwd'])
  // 目标项目目录里还有那条原地不动的会话，所以**不能**被删（"只删确认为空的"）
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirTarget))), true)
  const registry = readRegistry(sb.registryPath)
  assert.deepEqual(Object.keys(registry.tables.workspaces), ['ws-a'])
  assert.deepEqual(registry.tables.workspaces['ws-a']?.sessionIds, ['session-owned'])
})

test('未分组来源：只搬点名的几条（子集走同一个来源）', () => {
  const sb = makeSandbox('unowned-subset')
  const plan = buildRelocationPlan(opts(sb, { sessionIds: ['session-orphan-b'] }))
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.deepEqual(plan.sessions.map((s) => s.id), ['session-orphan-b'])
  assert.equal(plan.registryChange?.added.length, 1)
  assert.deepEqual(plan.registryChange?.adoptedFromUnowned, ['session-orphan-b'])

  const result = applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot })
  assert.equal(result.moved, 1)
  // 没被点名的那两条留在原处；只被搬空的那个项目目录（dirB）被删
  assert.equal(existsSync(sb.sessionDir('session-orphan-a')), true)
  assert.equal(existsSync(sb.sessionDir('session-orphan-c')), true)
  assert.equal(existsSync(join(sb.root, projectKey(sb.dirB))), false)
})

test('未分组来源：参数说不清、点名点错、要搬产物时都如实报 problem', () => {
  const sb = makeSandbox('unowned-problems')

  // 两种源同时给：谁也说不清该用哪个
  const both = buildRelocationPlan(opts(sb, { from: sb.dirA }))
  assert.equal(both.ok, false)
  assert.ok(both.problems.some((p) => p.includes('ambiguous')), both.problems.join('; '))

  // 只给 to、既没有 from 也没有 unowned
  const none = buildRelocationPlan({ root: sb.root, registry: sb.registry, to: sb.dirTarget, decodeAll })
  assert.equal(none.ok, false)
  assert.ok(none.problems.some((p) => p.includes('from is required')), none.problems.join('; '))

  // 点名了在册的会话：它不属于这个来源，不许静默少搬
  const owned = buildRelocationPlan(opts(sb, { sessionIds: ['session-orphan-b', 'session-owned'] }))
  assert.equal(owned.ok, false)
  assert.ok(owned.problems.some((p) => p.includes('session-owned') && p.includes('not an unowned session')))

  // 点名了没有 cwd 的那条：这个来源覆盖不到它（header 里没有 cwd 可改写）
  const nocwd = buildRelocationPlan(opts(sb, { sessionIds: ['session-nocwd'] }))
  assert.equal(nocwd.ok, false)
  assert.ok(nocwd.problems.some((p) => p.includes('session-nocwd') && p.includes('not an unowned session')))

  // 产物搬迁要一个"源目录"当基准，跨目录的源给不出来：明说，而不是悄悄不搬
  const artifacts = buildRelocationPlan(opts(sb, { includeArtifacts: true }))
  assert.equal(artifacts.ok, false)
  assert.ok(artifacts.problems.some((p) => p.includes('artifacts')), artifacts.problems.join('; '))
})

test('未分组来源：登记过、但 cwd 与那条记录的 path 对不上的照旧算未分组（宿主也这么滤）', () => {
  const sb = makeSandbox('unowned-stale-record')
  // 把三条候选都登记进 ws-a（它的 path 是 dirA），而它们各自的 cwd 是 dirB / dirC / 目标目录：
  // 宿主建成员索引时按 header 的 cwd 归一后与记录的 path 逐字比，对不上的**不算成员**——外壳侧边栏
  // 因此把这三条放进「未分组」（目录改名、搬走之后真实库里的样子）。只有 session-orphan-a 的 cwd
  // 就是 dirA，它是 ws-a 的真成员，不该进这个来源。
  const registry = structuredClone(sb.registry) as WorkspaceRegistryState
  registry.tables.workspaces['ws-a']!.sessionIds = [
    'session-owned',
    'session-orphan-a',
    'session-orphan-b',
    'session-orphan-c',
    'session-orphan-at',
  ]
  const plan = buildRelocationPlan({ root: sb.root, registry, to: sb.dirTarget, decodeAll, unowned: true })
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.deepEqual(plan.sessions.map((s) => s.id).sort(), [
    'session-orphan-at',
    'session-orphan-b',
    'session-orphan-c',
  ])
  assert.equal(plan.sessions.every((s) => s.registered === false), true, '它们在外壳那边就是没人认领的')
})

test('未分组来源：库里一条这样的会话都没有时，计划结果是"没得搬"而不是崩溃', () => {
  const sb = makeSandbox('unowned-empty')
  // 每条会话都由**它自己那个目录**的工作区认领（登记 + cwd 归一到同一个 path 才是认领，见 accounting.ts）：
  // 于是这个来源一条候选都不剩。
  const registry = structuredClone(sb.registry) as WorkspaceRegistryState
  registry.tables.workspaces['ws-a']!.sessionIds = ['session-owned', 'session-orphan-a']
  const claim = (id: string, path: string, sessionId: string): void => {
    registry.tables.workspaces[id] = {
      path,
      title: id,
      sessionIds: [sessionId],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    registry.global.workspaceIds.push(id)
  }
  claim('ws-b', sb.dirB, 'session-orphan-b')
  claim('ws-c', sb.dirC, 'session-orphan-c')
  claim('ws-target', sb.dirTarget, 'session-orphan-at')
  const plan = buildRelocationPlan({ root: sb.root, registry, to: sb.dirTarget, decodeAll, unowned: true })
  assert.equal(plan.ok, false)
  assert.deepEqual(plan.problems, ['no sessions selected for migration'])
})
