import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readRegistry, reHome, validateRegistry, verifyRegistryChange } from '../src/registry.ts'
import type { WorkspaceRegistryState } from '../src/types.ts'

/** 一份满足全部启动不变式的最小注册表。 */
function makeRegistry(): WorkspaceRegistryState {
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-downloads', 'ws-temp'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'ws-downloads': {
          path: 'C:\\Users\\me\\Downloads',
          title: 'Downloads',
          sessionIds: ['session-a', 'session-b'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'ws-temp': {
          path: 'C:\\Users\\me\\Work\\temp',
          title: 'temp',
          sessionIds: ['session-live'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
}

const NOW = '2026-09-27T00:00:00.000Z'

test('validateRegistry：合法注册表通过', () => {
  const r = validateRegistry(makeRegistry())
  assert.equal(r.ok, true, r.problems.join('; '))
})

test('validateRegistry：能逐类抓出启动会报错的问题', () => {
  const dupPath = makeRegistry()
  dupPath.tables.workspaces['ws-temp']!.path = 'C:\\Users\\me\\Downloads'
  assert.match(validateRegistry(dupPath).problems.join(';'), /duplicate workspace path/)

  const dupSession = makeRegistry()
  dupSession.tables.workspaces['ws-temp']!.sessionIds.push('session-a')
  assert.match(validateRegistry(dupSession).problems.join(';'), /accounted by both/)

  const drift = makeRegistry()
  drift.global.workspaceIds = ['ws-downloads'] // 少了 ws-temp
  assert.match(validateRegistry(drift).problems.join(';'), /order drift/)

  const phantom = makeRegistry()
  phantom.global.workspaceIds.push('ws-ghost')
  assert.match(validateRegistry(phantom).problems.join(';'), /absent record/)

  const dupOrder = makeRegistry()
  dupOrder.global.workspaceIds.push('ws-temp')
  assert.match(validateRegistry(dupOrder).problems.join(';'), /duplicate id/)
})

test('reHome：复用已存在的目标工作区并摘除原注册表', () => {
  const { registry, change } = reHome(makeRegistry(), {
    sessionIds: ['session-a', 'session-b'],
    toPath: 'C:\\Users\\me\\Work\\temp',
    now: NOW,
  })
  assert.equal(change.createdTarget, false)
  assert.equal(change.targetId, 'ws-temp')
  assert.deepEqual(change.added, ['session-a', 'session-b'])
  assert.deepEqual(
    change.movedFrom.map((m) => m.workspaceId),
    ['ws-downloads'],
  )
  // 原注册表清空后默认删除记录与顺序项
  assert.deepEqual(
    change.removedSources.map((m) => m.workspaceId),
    ['ws-downloads'],
  )
  assert.deepEqual(registry.global.workspaceIds, ['ws-temp'])
  assert.deepEqual(registry.tables.workspaces['ws-temp']?.sessionIds, ['session-live', 'session-a', 'session-b'])
  assert.equal(registry.tables.workspaces['ws-downloads'], undefined)
  assert.equal(validateRegistry(registry).ok, true)
})

test('reHome：目标目录无工作区时新建并前插（与宿主 create 语义一致）', () => {
  const { registry, change } = reHome(makeRegistry(), {
    sessionIds: ['session-a'],
    toPath: 'C:\\Users\\me\\Work\\dsh-temp',
    now: NOW,
    newId: 'ws-new',
  })
  assert.equal(change.createdTarget, true)
  assert.equal(registry.global.workspaceIds[0], 'ws-new', '新工作区应前插')
  assert.equal(registry.tables.workspaces['ws-new']?.title, 'dsh-temp')
  assert.deepEqual(registry.tables.workspaces['ws-new']?.sessionIds, ['session-a'])
  assert.equal(registry.tables.workspaces['ws-downloads']?.sessionIds.length, 1, '原注册表只被摘走 session-a')
  assert.equal(validateRegistry(registry).ok, true)
})

test('reHome：removeEmptySources=false 时保留空注册表', () => {
  const { registry } = reHome(makeRegistry(), {
    sessionIds: ['session-a', 'session-b'],
    toPath: 'C:\\Users\\me\\Work\\temp',
    now: NOW,
    removeEmptySources: false,
  })
  assert.deepEqual(registry.tables.workspaces['ws-downloads']?.sessionIds, [])
  assert.ok(registry.global.workspaceIds.includes('ws-downloads'))
  assert.equal(validateRegistry(registry).ok, true)
})

test('reHome：幂等——重复调用不再改动', () => {
  const first = reHome(makeRegistry(), { sessionIds: ['session-a'], toPath: 'C:\\Users\\me\\Work\\temp', now: NOW })
  const second = reHome(first.registry, { sessionIds: ['session-a'], toPath: 'C:\\Users\\me\\Work\\temp', now: NOW })
  assert.deepEqual(second.registry.tables.workspaces['ws-temp']?.sessionIds, ['session-live', 'session-a'])
  assert.equal(second.change.added.length, 0)
  assert.equal(second.change.movedFrom.length, 0)
})

test('reHome：不修改传入对象（纯函数）', () => {
  const input = makeRegistry()
  const snapshot = structuredClone(input)
  reHome(input, { sessionIds: ['session-a'], toPath: 'C:\\Users\\me\\Work\\temp', now: NOW })
  assert.deepEqual(input, snapshot)
})

test('reHome：拒绝在已损坏的注册表上操作', () => {
  const broken = makeRegistry()
  broken.global.workspaceIds = ['ws-downloads']
  assert.throws(() => reHome(broken, { sessionIds: ['session-a'], toPath: 'X:\\y' }), /invalid registry/)
})

test('reHome：结果永不违反不变式（含未知会话 id）', () => {
  const { registry } = reHome(makeRegistry(), {
    sessionIds: ['session-unknown', 'session-a'],
    toPath: 'C:\\Users\\me\\Work\\temp',
    now: NOW,
  })
  assert.equal(validateRegistry(registry).ok, true)
})

test('reHome：宿主不认的悬空登记不算成员，源工作区照样删得掉', () => {
  const before = makeRegistry()
  // session-ghost 只登记在册、盘上早就没有它了（插件删除会话时刻意不清理注册表）。
  before.tables.workspaces['ws-downloads']!.sessionIds = ['session-a', 'session-b', 'session-ghost']
  const { registry, change } = reHome(before, {
    sessionIds: ['session-a', 'session-b'],
    toPath: 'C:\\Users\\me\\Work\\temp',
    now: NOW,
    staleSessionIds: new Set(['session-ghost']),
  })

  assert.deepEqual(
    change.removedSources.map((entry) => entry.workspaceId),
    ['ws-downloads'],
    '真实会话全搬走、只剩悬空登记时，这块工作区必须被删掉',
  )
  assert.deepEqual(change.droppedStale, [
    { workspaceId: 'ws-downloads', path: 'C:\\Users\\me\\Downloads', sessionIds: ['session-ghost'] },
  ])
  assert.equal(registry.tables.workspaces['ws-downloads'], undefined)
  assert.deepEqual(registry.global.workspaceIds, ['ws-temp'])
  // 复核要放行这次点名摘掉的悬空登记（否则每次落地都会误报"会话 id 少了"）
  assert.deepEqual(verifyRegistryChange(before, registry, change).problems, [])
  assert.equal(validateRegistry(registry).ok, true)

  // 篡改：同一份结果、但计划里不报这条摘除——复核必须把它抓出来，说明上面那条断言不是白过的。
  const silent = { ...change, droppedStale: [] }
  assert.match(verifyRegistryChange(before, registry, silent).problems.join(';'), /session-ghost 在落盘结果里没了/)
})

test('reHome：留下真成员的工作区还在，但它的悬空登记被顺手摘掉', () => {
  const before = makeRegistry()
  before.tables.workspaces['ws-downloads']!.sessionIds = ['session-a', 'session-b', 'session-ghost']
  const { registry, change } = reHome(before, {
    sessionIds: ['session-a'],
    toPath: 'C:\\Users\\me\\Work\\temp',
    now: NOW,
    staleSessionIds: new Set(['session-ghost']),
  })

  assert.deepEqual(change.removedSources, [], '还剩 session-b，不许删这块工作区')
  assert.deepEqual(registry.tables.workspaces['ws-downloads']?.sessionIds, ['session-b'], '悬空登记不该再挂在账上')
  assert.deepEqual(change.droppedStale.map((entry) => entry.sessionIds), [['session-ghost']])
  assert.deepEqual(verifyRegistryChange(before, registry, change).problems, [])
})

test('reHome：这次没碰的工作区不动它的悬空登记', () => {
  const before = makeRegistry()
  before.tables.workspaces['ws-temp']!.sessionIds = ['session-live', 'session-ghost']
  const { registry, change } = reHome(before, {
    sessionIds: ['session-a'],
    // 目标是一块**新建**的工作区：ws-temp 这一次完全没被碰过，它的悬空登记不该被动。
    toPath: 'C:\\Users\\me\\Work\\elsewhere',
    newId: 'ws-new',
    now: NOW,
    staleSessionIds: new Set(['session-ghost']),
  })

  // 迁移只该动"这次真搬出过会话"的那些记录：别的记录里的悬空登记不是这次的事。
  assert.deepEqual(registry.tables.workspaces['ws-temp']?.sessionIds, ['session-live', 'session-ghost'])
  assert.deepEqual(change.droppedStale, [])
})

// 真实数据：只读校验本机真实注册表，必须满足启动不变式。
const REAL = process.env['DSM_WORKSPACE_JSON'] ?? join(homedir(), '.dsh', 'storages', 'workspace.json')
test(
  '真实注册表：满足启动不变式',
  { skip: !existsSync(REAL) && `no registry at ${REAL}` },
  () => {
    const reg = readRegistry(REAL)
    const { ok, problems } = validateRegistry(reg)
    assert.equal(ok, true, problems.join('; '))
    const n = Object.keys(reg.tables.workspaces).length
    assert.ok(n > 0)
    console.log(`      真实注册表：${n} 个工作区、${reg.global.workspaceIds.length} 个顺序项，不变式通过`)
  },
)
