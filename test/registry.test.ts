import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { missingMemberships, readRegistry, reHome, validateRegistry } from '../src/registry.ts'
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

// 缺归属：宿主拿内存里那份整份落盘之后，别人那几条就是这么没的（见 registry.ts 的 missingMemberships）。
test('缺归属：计划里有、盘上整份都没有的才算', () => {
  const expected = makeRegistry()
  const actual = structuredClone(expected)
  actual.tables.workspaces['ws-downloads']!.sessionIds = ['session-a', 'session-extra']
  actual.tables.workspaces['ws-temp']!.sessionIds = []
  assert.deepEqual(missingMemberships(expected, actual), [
    { path: 'C:\\Users\\me\\Downloads', title: 'Downloads', sessionId: 'session-b' },
    { path: 'C:\\Users\\me\\Work\\temp', title: 'temp', sessionId: 'session-live' },
  ])
})

test('缺归属：挪到别的工作区下不算缺（那是复核该报出来的问题，不该在这里悄悄改挂）', () => {
  const expected = makeRegistry()
  const actual = structuredClone(expected)
  actual.tables.workspaces['ws-downloads']!.sessionIds = ['session-a']
  actual.tables.workspaces['ws-temp']!.sessionIds = ['session-live', 'session-b']
  assert.deepEqual(missingMemberships(expected, actual), [])
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
