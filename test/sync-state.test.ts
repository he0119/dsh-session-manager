// test/sync-state.test.ts — 上一次手动同步那条记录：位置、读写、以及"读不懂就当没有"。
//
// 为什么值得单独钉：页头那枚状态说"多久以前、成没成"，全靠这一份。它写坏了不会报错——界面只会退回
// "配没配"那一句，看着像"从来没同步过"。所以坏 JSON、缺字段、时间解不出来这三条都在这里摆出来。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { lastRunView, readSyncRun, syncStatePath, writeSyncRun } from '../src/sync-state.ts'

/**
 * 在一座临时 `$DSH_HOME` 下跑一段，跑完删干净。
 * @param fn 拿临时家目录当参数。
 */
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'dsm-sync-state-'))
  try {
    fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('记录写在插件自己那一层目录里', () => {
  withHome((home) => {
    assert.equal(syncStatePath(home), join(home, 'dsh-session-manager', 'state.json'))
  })
})

test('写进去再读回来是同一份', () => {
  withHome((home) => {
    const run = { at: '2026-11-12T12:00:00.000Z', ok: true, pulled: 3, pushed: 2 }
    writeSyncRun(home, run)
    assert.deepEqual(readSyncRun(home), run)
    // 文件里是 `{ sync: … }`：以后要往这个文件里加别的记录时不必换格式。
    const raw = JSON.parse(readFileSync(syncStatePath(home), 'utf8')) as { sync?: unknown }
    assert.deepEqual(raw.sync, run)
  })
})

test('失败那趟带着原因，也读得回来', () => {
  withHome((home) => {
    const run = { at: '2026-11-12T12:00:00.000Z', ok: false, pulled: 0, pushed: 0, error: '401 Unauthorized' }
    writeSyncRun(home, run)
    assert.deepEqual(readSyncRun(home), run)
  })
})

test('没写过 / JSON 坏了 / 字段缺了，都当没有', () => {
  withHome((home) => {
    assert.equal(readSyncRun(home), undefined, '文件不在')
    mkdirSync(join(home, 'dsh-session-manager'), { recursive: true })
    writeFileSync(syncStatePath(home), '{ not json')
    assert.equal(readSyncRun(home), undefined, '坏 JSON')
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { at: '2026-11-12T12:00:00.000Z', ok: true } }))
    assert.equal(readSyncRun(home), undefined, '少了条数字段')
    writeFileSync(
      syncStatePath(home),
      JSON.stringify({ sync: { at: 'not-a-date', ok: true, pulled: 0, pushed: 0 } }),
    )
    assert.equal(readSyncRun(home), undefined, '时间解不出来：界面要拿它算"多久以前"')
  })
})

test('写不进去不抛：同步本身不该因为记不下一句话而失败', () => {
  withHome((home) => {
    // 同名的文件挡在目录位置上：mkdir 会失败。
    writeFileSync(join(home, 'dsh-session-manager'), 'x')
    assert.doesNotThrow(() => writeSyncRun(home, { at: new Date().toISOString(), ok: true, pulled: 0, pushed: 0 }))
  })
})

test('跑完了但有几条没做到、以及要重启，这两项也要活过重启', () => {
  withHome((home) => {
    const run = {
      at: '2026-11-12T12:00:00.000Z',
      ok: true,
      pulled: 1,
      pushed: 0,
      problems: ['缺映射：/home/u/dev/x', '目标目录不存在：/home/u/dev/y'],
      takesEffect: 'restart-required' as const,
    }
    writeSyncRun(home, run)
    assert.deepEqual(readSyncRun(home), run, '两项都读得回来')
  })
})

test('这两项写坏了也当没有（旧的记录里本来就没有它们）', () => {
  withHome((home) => {
    mkdirSync(join(home, 'dsh-session-manager'), { recursive: true })
    const base = { at: '2026-11-12T12:00:00.000Z', ok: true, pulled: 0, pushed: 0 }
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, problems: 'not-an-array' } }))
    assert.equal(readSyncRun(home), undefined, 'problems 形状不对')
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, problems: [1, 2] } }))
    assert.equal(readSyncRun(home), undefined, 'problems 里不是字符串')
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, takesEffect: 'later' } }))
    assert.equal(readSyncRun(home), undefined, 'takesEffect 不在那两个值里')
    // 旧版本写的记录（没有这两项）照旧能读。
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: base }))
    assert.deepEqual(readSyncRun(home), base, '旧记录不因为缺字段而失效')
  })
})

test('「还要不要重启」按进程启动时刻算，不落盘', () => {
  const at = '2026-11-12T12:00:00.000Z'
  const run = { at, ok: true, pulled: 1, pushed: 0, takesEffect: 'restart-required' as const }
  const ranAt = Date.parse(at)
  // 那趟就在这个进程里跑的（进程起得更早）：重启还没发生。
  assert.equal(lastRunView(run, ranAt - 60_000).pendingRestart, true)
  // 记录比进程还早 = 中间已经重启过，那一趟早就生效了。
  assert.equal(lastRunView(run, ranAt + 60_000).pendingRestart, false)
  // 不需要重启的那趟，任何时候都不算"等重启"。
  assert.equal(lastRunView({ ...run, takesEffect: 'immediate' }, ranAt - 60_000).pendingRestart, false)
  // 旧记录没有这一项：按"不用重启"。
  assert.equal(lastRunView({ at, ok: true, pulled: 0, pushed: 0 }, ranAt - 60_000).pendingRestart, false)
  // 失败的记录同理（它连 takesEffect 都没有）。
  assert.equal(lastRunView({ at, ok: false, pulled: 0, pushed: 0, error: 'x' }, ranAt - 60_000).pendingRestart, false)
})

test('「没做到的条目」原样落盘、也读得回来（点名版要跨重启还认得出是哪条会话）', () => {
  withHome((home) => {
    const run = {
      at: '2026-11-13T09:00:00.000Z',
      ok: true,
      pulled: 0,
      pushed: 1,
      problems: ['同步映射把 /home/u/dev/x 指到了 /nope，但那不是一个存在的目录'],
      leftovers: [
        { message: '甲（session-1）：目标目录不存在：/nope', sessionId: 'session-1' },
        { message: '同步映射把 /home/u/dev/x 指到了 /nope，但那不是一个存在的目录' },
      ],
      takesEffect: 'immediate' as const,
    }
    writeSyncRun(home, run)
    assert.deepEqual(readSyncRun(home), run, '带 id 的与不带 id 的都读得回来')
  })
})

test('「没做到的条目」形状不对也当没有（宁可只少一张清单，不让页面读库失败）', () => {
  withHome((home) => {
    mkdirSync(join(home, 'dsh-session-manager'), { recursive: true })
    const base = { at: '2026-11-13T09:00:00.000Z', ok: true, pulled: 0, pushed: 0 }
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, leftovers: 'nope' } }))
    assert.equal(readSyncRun(home), undefined, '不是数组')
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, leftovers: [{ sessionId: 'x' }] } }))
    assert.equal(readSyncRun(home), undefined, '缺 message')
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, leftovers: [{ message: 'x', sessionId: 7 }] } }))
    assert.equal(readSyncRun(home), undefined, 'sessionId 不是字符串')
    // 不带 id 的那种是合法条目（映射、远端索引那几步没有会话可指）。
    writeFileSync(syncStatePath(home), JSON.stringify({ sync: { ...base, leftovers: [{ message: 'x' }] } }))
    assert.deepEqual(readSyncRun(home), { ...base, leftovers: [{ message: 'x' }] }, '只有 message 也行')
  })
})
