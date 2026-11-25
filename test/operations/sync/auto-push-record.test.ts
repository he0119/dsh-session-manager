// 自动那一轮写「上次同步」记录：哪一轮写、写成什么。
//
// 反事实（改回去必须变红的那些）：
//   - 把 `autoPushRunRecord()` 里「没跑（`skip` 有值）就什么都不留」那句去掉 → "空跑不写"红；
//   - 把失败那一条分支去掉（`ran: false` 也不写）→ "没跑成也留一条"红；
//   - 把只推那档写死的 `immediate` 换成透传 → "只推那档永不说要重启"红；
//   - 把 `source` 写死成 `manual` → 三处来源断言一起红；
//   - 把 `at` 用 `now` 顶掉 `finishedAt` → "记录的是这一轮结束的时刻"红。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { autoPushRunRecord, type AutoPushOutcome } from '../../../src/operations/sync/auto-push.ts'
import { resolveAutoPushRuntime } from '../../../src/operations/sync/runtime.ts'
import type { SyncOutcome } from '../../../src/operations/sync/sync.ts'
import type { SyncRunRecord } from '../../../src/operations/sync/sync-state.ts'
import { sessionDir } from '../../../src/shared/paths.ts'
import { writeRegistryAtomic } from '../../../src/shared/registry.ts'
import { encodeRawFrame } from '../../../src/shared/log/zstd-frame.ts'
import type { SessionHeader } from '../../../src/shared/types.ts'
import { startDavFixture } from '../../fixtures/dav-fixture.ts'
import { sandboxDir } from '../../fixtures/sandbox.ts'

/** 造一份"这一轮真跑了"的应用结果：只摆 `autoPushRunRecord()` 读的那几项。 */
function applied(overrides: Record<string, unknown> = {}): SyncOutcome {
  return {
    plan: { pull: [], push: [], problems: [] },
    pulled: [],
    replaced: [],
    pushed: [],
    problems: [],
    ...overrides,
  } as unknown as SyncOutcome
}

/** 造一轮结论：默认是"真跑了、搬了东西"。 */
function round(overrides: Partial<AutoPushOutcome> = {}): AutoPushOutcome {
  return {
    ran: true,
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_060_000,
    failures: 0,
    outcome: applied(),
    ...overrides,
  }
}

test('只推那档：记下推送条数，来源是 auto-push，且永远不说要重启', () => {
  const record = autoPushRunRecord(round({ outcome: applied({ pushed: [{ id: 'a' }] }) }), {
    mode: 'push',
    // 宿主其实接不住注册表改动，但只推这一档一个字节都不动本机：这个结论对它不成立。
    takesEffect: 'restart-required',
    now: 1_800_000_999_000,
  })
  assert.deepEqual(record, {
    at: new Date(1_800_000_060_000).toISOString(),
    ok: true,
    pulled: 0,
    pushed: 1,
    leftovers: [],
    takesEffect: 'immediate',
    source: 'auto-push',
  })
})

test('双向那档：拉推两条账都记，来源是 auto-sync，要不要重启按宿主的探测', () => {
  const withEffect = autoPushRunRecord(
    round({ outcome: applied({ pulled: [{ id: 'a' }, { id: 'b' }], pushed: [{ id: 'c' }], effect: { kind: 'applied' } }) }),
    { mode: 'sync', takesEffect: 'restart-required', now: 1_800_000_999_000 },
  )
  assert.equal(withEffect?.source, 'auto-sync')
  assert.equal(withEffect?.pulled, 2)
  assert.equal(withEffect?.pushed, 1)
  assert.equal(withEffect?.takesEffect, 'immediate', '宿主当场认下了注册表改动，就不该说要重启')

  const withoutPort = autoPushRunRecord(round({ outcome: applied({ pulled: [{ id: 'a' }] }) }), {
    mode: 'sync',
    takesEffect: 'restart-required',
    now: 1_800_000_999_000,
  })
  assert.equal(withoutPort?.takesEffect, 'restart-required', '这个宿主没有注册表动作，那趟的改动要重启才生效')
})

test('这一轮有几条没做到：ok 仍是 true，那几条进 problems 与 leftovers（与手动那趟同一套读法）', () => {
  const record = autoPushRunRecord(
    round({
      outcome: applied({
        problems: ['乙（session-2）：会话正开着，这一轮不动'],
        plan: {
          pull: [],
          problems: [],
          push: [
            {
              id: 'session-2',
              title: '乙',
              action: 'skip',
              code: 'live',
              blockedBy: 'live',
              reason: '会话正开着，这一轮不动',
            },
          ],
        },
      }),
    }),
    { mode: 'sync', takesEffect: 'immediate', now: 1_800_000_999_000 },
  )
  assert.equal(record?.ok, true, '这一趟本身跑完了：没做到的那几条走 problems，不走 error')
  assert.deepEqual(record?.problems, ['乙（session-2）：会话正开着，这一轮不动'])
  assert.equal(record?.leftovers?.length, 1)
  assert.equal(record?.leftovers?.[0]?.sessionId, 'session-2')
})

test('空跑那轮不写：没有搬东西，时间戳留给上一趟真搬了的', () => {
  assert.equal(
    autoPushRunRecord(round({ skip: 'idle', outcome: undefined }), { mode: 'push', takesEffect: 'immediate', now: 1 }),
    undefined,
  )
  assert.equal(
    autoPushRunRecord(round({ skip: 'idle', outcome: undefined }), { mode: 'sync', takesEffect: 'immediate', now: 1 }),
    undefined,
  )
})

test('没跑的（没开自动 / 上一轮还在跑）什么都不留', () => {
  for (const skip of ['disabled', 'busy'] as const) {
    assert.equal(
      autoPushRunRecord({ ran: false, skip, failures: 0 }, { mode: 'push', takesEffect: 'immediate', now: 1 }),
      undefined,
    )
  }
})

test('没跑成也留一条：ok 为 false、带原因、记的是这一轮结束的时刻', () => {
  const record = autoPushRunRecord(
    { ran: false, failures: 3, problem: '读远端索引失败：401 Unauthorized' },
    { mode: 'sync', takesEffect: 'restart-required', now: 1_800_000_123_000 },
  )
  assert.deepEqual(record, {
    at: new Date(1_800_000_123_000).toISOString(),
    ok: false,
    pulled: 0,
    pushed: 0,
    error: '读远端索引失败：401 Unauthorized',
    source: 'auto-sync',
  })
})

test('失败连原因都没留下时也有一句话，界面上不会出现空白的原因', () => {
  const record = autoPushRunRecord({ ran: false, failures: 1 }, { mode: 'push', takesEffect: 'immediate', now: 0 })
  assert.equal(record?.ok, false)
  assert.equal(typeof record?.error, 'string')
  assert.notEqual(record?.error, '')
})
/** 一台假机器：一个会话库、一份空注册表、一个项目目录。 */
function makeMachine(name: string): { base: string; cwd: string; sessionsRoot: string; registryPath: string } {
  const base = sandboxDir('auto-push-record')
  rmSync(base, { recursive: true, force: true })
  const root = join(base, name)
  const cwd = join(root, 'proj')
  mkdirSync(cwd, { recursive: true })
  const sessionsRoot = join(root, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  const registryPath = join(root, 'workspace.json')
  writeRegistryAtomic(registryPath, {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  })
  return { base: root, cwd, sessionsRoot, registryPath }
}

/** 在本机写一份会话日志（宿主写完一轮就是这个形状）。 */
function writeSession(sessionsRoot: string, cwd: string, id: string): void {
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1000,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const lines = [JSON.stringify(header), JSON.stringify({ type: 'user/message', seq: 0, data: {} })]
  const dir = sessionDir(sessionsRoot, cwd, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 
    'session.v4.jsonl.zstd'),
    Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))),
  )
}

test('接上调度器之后：真跑一轮就记一笔，空跑那一轮不记', async () => {
  /*
   * 这条盯的是**接线**：`resolveAutoPushRuntime()` 那一圈把 `recordRun` 交给入口之后，一轮真的跑完要
   * 写进「上次同步」。上面那些用例只验「结论怎么变成记录」，验不到「谁来调它」。
   *
   * 两轮连跑还有第二个用处：第一轮把会话推上去，第二轮扫下来一条都不用搬（`idle`），它不该再写
   * 一遍——否则页头那行会被空跑刷成「刚刚 · 拉取 0 条、推送 0 条」，把真搬了东西的时刻盖掉。
   */
  const machine = makeMachine('robot-a')
  writeSession(machine.sessionsRoot, machine.cwd, 'session-1')
  const dav = await startDavFixture({ root: join(machine.base, 'dav') })
  try {
    const records: SyncRunRecord[] = []
    const resolved = await resolveAutoPushRuntime(
      // 这个假宿主没有任何可选服务：没有注册表动作、没有活的会话表；密码走环境变量（这台假 DAV 不要密码）。
      {},
      { sync: { url: dav.url, machineId: 'robot-a', autoSync: true } },
      { sessionsRoot: machine.sessionsRoot, registryPath: machine.registryPath, backupRoot: join(machine.base, 'backups') },
      { recordRun: (run) => records.push(run) },
    )
    assert.ok(resolved !== undefined, '配了 sync.url 就该有调度器')
    assert.equal(resolved.timer.enabled(), true, 'autoSync: true 就是开着')

    const first = await resolved.timer.tick()
    assert.equal(first.ran, true)
    assert.equal(records.length, 1, '真跑了一轮就记一笔')
    const record = records[0]!
    assert.equal(record.source, 'auto-sync', '这一档是双向')
    assert.equal(record.ok, true)
    assert.equal(record.pushed, 1, '本机那一条被推上去了')
    assert.equal(record.pulled, 0, '远端本来就是空的')
    assert.deepEqual(record.problems ?? [], [])
    // 这个假宿主没有注册表动作：双向那档的结论按「要重启才生效」记（界面按它点黄）。
    assert.equal(record.takesEffect, 'restart-required')

    const second = await resolved.timer.tick()
    assert.equal(second.ran, true)
    assert.equal(second.skip, 'idle', '第二轮一条都不用搬')
    assert.equal(records.length, 1, '空跑那一轮不写：时间戳留给上一趟真搬了东西的')
  } finally {
    await dav.close()
    rmSync(sandboxDir('auto-push-record'), { recursive: true, force: true })
  }
})
