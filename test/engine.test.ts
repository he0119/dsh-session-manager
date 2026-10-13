// 端到端：在隔离沙箱里造出"多帧日志 + 注册表"，跑 plan → apply → verify → rollback，
// 并逐字节断言回滚后与原始状态完全一致。
//
// 关键：cwd 用**沙箱里的真实目录**，而不是编造的字符串——因为计划层会用
// existsSync(to) 校验目标目录真实存在，用假路径测不出真行为。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { applyPlan, verifyAppliedPlan } from '../src/execute.ts'
import { readManifest, rollback } from '../src/journal.ts'
import { buildRelocationPlan, describePlan } from '../src/plan.ts'
import { projectKey } from '../src/project-key.ts'
import { readRegistry } from '../src/registry.ts'
import type { DecodeAll, WorkspaceRegistryState } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

let clock = 0
function makeLog(id: string, cwd: string, nEvents: number): Buffer {
  const createdAt = ++clock
  const frames = [
    encodeRawFrame(
      JSON.stringify({ type: 'session', version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0 }) + '\n',
    ),
  ]
  for (let i = 0; i < nEvents; i++) {
    const type = i === 0 ? 'turn/start' : i === nEvents - 1 ? 'turn/end' : 'user/message'
    frames.push(
      encodeRawFrame(
        JSON.stringify({ type, seq: i, time: createdAt + i, data: { turn: 1, content: [{ type: 'text', text: `在 ${cwd} 下做事 #${i}` }] } }) +
          '\n',
      ),
    )
  }
  return Buffer.concat(frames)
}

interface Sandbox {
  base: string
  root: string
  registryPath: string
  registry: WorkspaceRegistryState
  logs: Record<string, Buffer>
  /** 默认点名的那几条（"全选"等价于列出来的都勾上：session-c 只有造了它才在里面）。 */
  ids: string[]
  fromDir: string
  toDir: string
  sourceProjectDirName: string
  targetProjectDir: string
  backupRoot: string
}

/** 造一个完整隔离沙箱（cwd 为真实目录）。 */
function makeSandbox(name: string, options: { unowned?: boolean } = {}): Sandbox {
  const base = join(import.meta.dirname, '.sandbox', name)
  rmSync(base, { recursive: true, force: true })

  const fromDir = join(base, 'downloads')
  const toDir = join(base, 'work', 'temp')
  mkdirSync(fromDir, { recursive: true })
  mkdirSync(toDir, { recursive: true })

  const root = join(base, 'dsh', 'sessions')
  const sourceProjectDirName = projectKey(fromDir)
  const targetProjectDir = projectKey(toDir)
  mkdirSync(join(root, sourceProjectDirName, 'session-a'), { recursive: true })
  mkdirSync(join(root, sourceProjectDirName, 'session-b'), { recursive: true })
  mkdirSync(join(root, targetProjectDir), { recursive: true })

  const logs: Record<string, Buffer> = { a: makeLog('session-a', fromDir, 40), b: makeLog('session-b', fromDir, 12) }
  writeFileSync(join(root, sourceProjectDirName, 'session-a', 'session.v4.jsonl.zstd'), logs['a']!)
  writeFileSync(join(root, sourceProjectDirName, 'session-b', 'session.v4.jsonl.zstd'), logs['b']!)
  if (options.unowned) {
    mkdirSync(join(root, sourceProjectDirName, 'session-c'), { recursive: true })
    logs['c'] = makeLog('session-c', fromDir, 3)
    writeFileSync(join(root, sourceProjectDirName, 'session-c', 'session.v4.jsonl.zstd'), logs['c']!)
  }

  const registryPath = join(base, 'dsh', 'storages', 'workspace.json')
  mkdirSync(join(base, 'dsh', 'storages'), { recursive: true })
  const registry: WorkspaceRegistryState = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-downloads', 'ws-temp'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        'ws-downloads': {
          path: fromDir,
          title: 'downloads',
          sessionIds: ['session-a', 'session-b'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'ws-temp': {
          path: toDir,
          title: 'temp',
          sessionIds: ['session-live'],
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
    logs,
    ids: options.unowned ? ['session-a', 'session-b', 'session-c'] : ['session-a', 'session-b'],
    fromDir,
    toDir,
    sourceProjectDirName,
    targetProjectDir,
    backupRoot: join(base, 'backups'),
  }
}

// 源由 `sessionIds` 决定（没有"源目录"这个参数了）：默认点名夹具里那几条，个别用例自己覆盖。
const opts = (sb: Sandbox, extra: Record<string, unknown> = {}) => ({
  root: sb.root,
  registry: sb.registry,
  sessionIds: sb.ids,
  to: sb.toDir,
  decodeAll,
  ...extra,
})

test('端到端：plan → apply → verify → rollback 全链路', () => {
  const sb = makeSandbox('e2e')
  const srcA = join(sb.root, sb.sourceProjectDirName, 'session-a', 'session.v4.jsonl.zstd')

  // ---- plan（dry-run：不得写任何字节） ----
  const plan = buildRelocationPlan(opts(sb))
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.sessions.length, 2)
  assert.equal(plan.registryChange?.added.length, 2)
  assert.equal(plan.registryChange?.createdTarget, false)
  assert.match(describePlan(plan), /迁移 2 个会话/)
  assert.equal(existsSync(join(sb.root, sb.targetProjectDir, 'session-a')), false, 'dry-run 不得移动目录')
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, 'dry-run 不得改注册表')
  assert.deepEqual(readFileSync(srcA), sb.logs['a'], 'dry-run 不得改日志')

  // ---- apply ----
  const applied = applyPlan(plan, {
    registryPath: sb.registryPath,
    decodeAll,
    backupRoot: sb.backupRoot,
    now: new Date('2026-09-27T00:00:00Z'),
  })
  assert.equal(applied.rewritten, 2)
  assert.equal(applied.moved, 2)
  assert.ok(existsSync(join(applied.backupDir, 'manifest.json')))
  assert.ok(existsSync(join(applied.backupDir, 'execution.log')))
  assert.equal(existsSync(join(sb.root, sb.sourceProjectDirName)), false, '空源项目目录应被清理')

  // ---- verify（等价于宿主的 corrupt 判据） ----
  const verified = verifyAppliedPlan(plan, { decodeAll })
  assert.equal(verified.ok, true, verified.problems.join('; '))
  assert.equal(verified.checked, 2)

  // 日志：header 换新 cwd，正文逐行不变，旧路径作为历史保留
  const after = decodeAll(readFileSync(join(sb.root, sb.targetProjectDir, 'session-a', 'session.v4.jsonl.zstd')))
  const before = decodeAll(sb.logs['a']!)
  const aLines = after.split('\n')
  const bLines = before.split('\n')
  assert.equal(aLines.length, bLines.length)
  assert.equal((JSON.parse(aLines[0] ?? '{}') as { cwd?: string }).cwd, sb.toDir)
  for (let i = 1; i < bLines.length; i++) assert.equal(aLines[i], bLines[i], `正文第 ${i} 行不得改动`)
  assert.ok(after.includes(JSON.stringify(sb.fromDir).slice(1, -1)), '正文里的旧路径是历史事实，必须保留')

  // 注册表：注册表转移、空工作区被删、顺序与表键一致
  const reg = readRegistry(sb.registryPath)
  // 注册表按"新→旧"排列（session-b 的 createdAt 更大），追加在既有会话之后
  assert.deepEqual(reg.tables.workspaces['ws-temp']?.sessionIds, ['session-live', 'session-b', 'session-a'])
  assert.equal(reg.tables.workspaces['ws-downloads'], undefined)
  assert.deepEqual(reg.global.workspaceIds, ['ws-temp'])

  // ---- rollback ----
  const { manifest } = readManifest(applied.backupDir)
  const rolled = rollback(manifest, { backupDir: applied.backupDir })
  assert.ok(rolled.restoredFiles >= 2)
  assert.equal(rolled.registryRestored, true)

  // 逐字节回到原状
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, '注册表必须完全还原')
  assert.deepEqual(readFileSync(srcA), sb.logs['a'], '日志必须逐字节还原')
  assert.deepEqual(readFileSync(join(sb.root, sb.sourceProjectDirName, 'session-b', 'session.v4.jsonl.zstd')), sb.logs['b'])
  assert.equal(existsSync(join(sb.root, sb.targetProjectDir, 'session-a')), false, '目标侧应被清空')

  rmSync(sb.base, { recursive: true, force: true })
})

// 没有"未分组来源"这种来源：没人认领的那条会话就在这个目录里，勾上它（默认点名清单里就有）就一起迁。
// 不勾它则这次不搬它，也不会有人替它做主——这才是"未分组只是一枚标签"。
test('未分组的会话：勾上就一起迁（它本来没登记在任何工作区），不勾就不动它', () => {
  const sb = makeSandbox('unowned', { unowned: true })
  const all = buildRelocationPlan(opts(sb))
  assert.equal(all.ok, true, all.problems.join('; '))
  assert.equal(all.sessions.length, 3)
  assert.equal(all.sessions.find((s) => s.id === 'session-c')?.registered, false)
  assert.deepEqual(all.sessionIds, ['session-a', 'session-b', 'session-c'])

  const two = buildRelocationPlan(opts(sb, { sessionIds: ['session-a', 'session-b'] }))
  assert.equal(two.ok, true, two.problems.join('; '))
  assert.deepEqual(two.sessions.map((s) => s.id).sort(), ['session-a', 'session-b'])
  assert.equal(two.sessions.some((s) => s.id === 'session-c'), false)

  rmSync(sb.base, { recursive: true, force: true })
})

// 用户那条路：清理文件夹时把项目文件夹删掉，会话就落到外壳侧边栏的「未分组」里（那是标签，不是来源）。
// 把项目重建到别处之后，勾上那几条照旧能迁：来源取自每条会话 header 里的 cwd（**不要求那个目录还在
// 盘上**），真正必须存在的是来源项目目录（会话日志那一层）。
test('来源目录已经不在盘上（项目文件夹删了）：勾上那几条照旧迁到重建后的目录', () => {
  const sb = makeSandbox('deleted-source')
  rmSync(sb.fromDir, { recursive: true, force: true })

  const plan = buildRelocationPlan(opts(sb))
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.deepEqual(plan.sessions.map((s) => s.id).sort(), ['session-a', 'session-b'])
  assert.deepEqual(plan.sessionIds, ['session-a', 'session-b'])
  assert.deepEqual(plan.sourceProjectDirs, [join(sb.root, sb.sourceProjectDirName)])
  // 宿主那边这两条已经不算 ws-downloads 的成员（目录解析不出来 → 侧边栏「未分组」），
  // 而它们在注册表里还登记着：计划照旧按"从那条记录摘走"处理，源记录摘空后删掉。
  assert.deepEqual(plan.sessions.map((s) => s.registered), [false, false])
  assert.deepEqual(plan.registryChange?.movedFrom.map((source) => source.workspaceId), ['ws-downloads'])
  assert.deepEqual(plan.registryChange?.removedSources.map((source) => source.workspaceId), ['ws-downloads'])
  assert.deepEqual(plan.registryChange?.added.sort(), ['session-a', 'session-b'])

  const result = applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot })
  assert.equal(result.moved, 2)
  assert.equal(result.rewritten, 2)
  const verified = verifyAppliedPlan(plan, { decodeAll })
  assert.equal(verified.ok, true, verified.problems.join('; '))

  // 落位：两条都进了目标项目目录，header 的 cwd 改成目标目录；源项目目录被搬空后删掉
  for (const [name, id] of [['a', 'session-a'], ['b', 'session-b']] as const) {
    const dir = join(sb.root, sb.targetProjectDir, id)
    assert.equal(existsSync(dir), true, `${id} 该落在目标项目目录里`)
    const header = JSON.parse(decodeAll(readFileSync(join(dir, 'session.v4.jsonl.zstd'))).split('\n')[0]!) as {
      cwd?: string
    }
    assert.equal(header.cwd, sb.toDir)
    assert.notDeepEqual(readFileSync(join(dir, 'session.v4.jsonl.zstd')), sb.logs[name], '首帧必须真的被改写')
  }
  assert.equal(existsSync(join(sb.root, sb.sourceProjectDirName)), false, '搬空的项目目录要删掉')

  // 备份清单里的 from 就是那个（已经不在盘上的）源路径：回滚只认清单，不看目录在不在
  const { manifest } = readManifest(result.backupDir)
  assert.equal(manifest.from, sb.fromDir)
  const rolled = rollback(manifest, { backupDir: result.backupDir })
  assert.equal(rolled.restoredFiles, 2)
  for (const [name, id] of [['a', 'session-a'], ['b', 'session-b']] as const) {
    assert.deepEqual(readFileSync(join(sb.root, sb.sourceProjectDirName, id, 'session.v4.jsonl.zstd')), sb.logs[name])
  }
  assert.equal(
    existsSync(join(sb.root, sb.targetProjectDir)),
    false,
    '目标项目目录里没有别的会话：回滚把它当"空掉的目标项目目录"顺手删掉（与 apply 对称）',
  )
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry, '注册表必须完全还原')

  rmSync(sb.base, { recursive: true, force: true })
})

test('宿主持着的会话不搬：留在原目录、源工作区不被摘空，并如实列出来', () => {
  const sb = makeSandbox('live-hold')

  // 宿主内存里攥着 session-b：它既挂不上新工作区（宿主拿内存里那份 header 校验 cwd），日志也不能搬走。
  const plan = buildRelocationPlan(opts(sb, { live: new Set(['session-b']) }))
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.deepEqual(plan.sessions.map((s) => s.id), ['session-a'], '只搬没被宿主攥着的那条')
  assert.deepEqual(plan.liveSkipped.map((s) => s.id), ['session-b'], '没搬的必须列出来')
  assert.equal(plan.liveSkipped[0]?.cwd, sb.fromDir, '留在原处：cwd 还是源的')
  assert.deepEqual(plan.registryChange?.added, ['session-a'], '注册表只登记真搬走的那条')
  assert.deepEqual(plan.registryChange?.removedSources, [], '源工作区还认着 session-b，不许删')
  assert.equal(plan.registryChange?.targetPath, sb.toDir)
  assert.match(describePlan(plan), /另有 1 条会话宿主持在内存里（还活着），这次不搬：session-b/)
  assert.match(describePlan(plan), /重启 DSH 之后再迁一次/)

  /*
   * 只点名那条活着的：这次没有东西可搬，说清是"宿主攥着"（重启后再迁）而不是"没选中会话"。
   * 它不是拦下整份计划的错误——勾选集里混着一条活会话时，其余几条照搬（上一段就是）。
   */
  const named = buildRelocationPlan(opts(sb, { live: new Set(['session-b']), sessionIds: ['session-b'] }))
  assert.equal(named.ok, false)
  assert.deepEqual(named.sessions, [])
  assert.deepEqual(named.liveSkipped.map((s) => s.id), ['session-b'])
  assert.match(named.problems.join('; '), /every ticked session is live in the host \(1\) — restart DSH/)

  // 整个来源都在宿主手里：说清原因，别让用户拿"没选中会话"去查勾选。
  const allLive = buildRelocationPlan(opts(sb, { live: new Set(['session-a', 'session-b']) }))
  assert.equal(allLive.ok, false)
  assert.match(allLive.problems.join('; '), /every ticked session is live in the host \(2\)/)

  // 一个字节都没写：这一层只读（活会话的日志尤其不能动——宿主手里还有写句柄）。
  assert.deepEqual(readRegistry(sb.registryPath), sb.registry)
  assert.deepEqual(readFileSync(join(sb.root, sb.sourceProjectDirName, 'session-b', 'session.v4.jsonl.zstd')), sb.logs['b'])
  assert.equal(existsSync(join(sb.root, sb.targetProjectDir, 'session-b')), false)
  assert.equal(existsSync(join(sb.root, sb.sourceProjectDirName, 'session-b')), true)

  rmSync(sb.base, { recursive: true, force: true })
})

test('计划层拒绝：目标不存在 / 目标就是来源自己（没东西可搬）/ 有损项目目录名碰撞', () => {
  const sb = makeSandbox('reject')

  const missing = buildRelocationPlan(opts(sb, { to: join(sb.base, 'nope', 'missing') }))
  assert.equal(missing.ok, false)
  assert.match(missing.problems.join(';'), /target directory does not exist/)

  // 目标就是这几条会话现在住的那个目录：目录不用搬、header 也不用改，报"没东西可搬"而不是走一遍空流程。
  const same = buildRelocationPlan(opts(sb, { to: sb.fromDir }))
  assert.equal(same.ok, false)
  assert.match(same.problems.join(';'), /nothing to migrate/)

  // projectKey 把分隔符折叠成 '-'，因此 '…\collide\downloads' 与 '…\collide-downloads' 同名
  const collideDir = sb.base + '-downloads'
  mkdirSync(collideDir, { recursive: true })
  assert.equal(projectKey(collideDir), projectKey(sb.fromDir), '前置条件：两者确实同名')
  const collide = buildRelocationPlan(opts(sb, { to: collideDir }))
  assert.equal(collide.ok, false)
  assert.match(collide.problems.join(';'), /projectKey collision/)

  rmSync(sb.base, { recursive: true, force: true })
  rmSync(collideDir, { recursive: true, force: true })
})

test('applyPlan 拒绝执行有问题的计划；搬完之后再拿同一批 id 计划会如实说"已经在目标里了"', () => {
  const sb = makeSandbox('refuse')
  const bad = buildRelocationPlan(opts(sb, { to: sb.fromDir }))
  assert.equal(bad.ok, false)
  assert.throws(
    () => applyPlan(bad, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot }),
    /refusing to apply/,
  )

  const plan = buildRelocationPlan(opts(sb))
  applyPlan(plan, { registryPath: sb.registryPath, decodeAll, backupRoot: sb.backupRoot, now: new Date('2026-09-27T00:00:00Z') })
  // 同一批 id 再计划一次：它们已经被扫到目标项目目录里了（cwd 就是目标），这一次没东西可搬。
  const again = buildRelocationPlan(opts(sb))
  assert.equal(again.ok, false)
  assert.match(again.problems.join(';'), /nothing to migrate/)

  rmSync(sb.base, { recursive: true, force: true })
})

test('多帧回归：一条事件一帧，单帧解码器会截断', () => {
  const sb = makeSandbox('frames')
  const buf = readFileSync(join(sb.root, sb.sourceProjectDirName, 'session-a', 'session.v4.jsonl.zstd'))
  let magic = 0
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) magic++
  }
  assert.ok(magic >= 41, `应探测到多帧（实际 ${magic} 个候选）`)
  // 1 行 header + 40 条事件 = 41 行
  assert.equal(decodeAll(buf).split('\n').filter(Boolean).length, 41)
  rmSync(sb.base, { recursive: true, force: true })
})
