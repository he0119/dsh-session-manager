// test/operations/sync/sync-state.test.ts — 上一次手动同步那条记录：形状、宽容读、旧文件迁移。
//
// 为什么值得单独钉：页头那枚状态说"多久以前、成没成"，全靠这一份。它读坏了不会报错——界面只会退回
// "配没配"那一句，看着像"从来没同步过"。所以坏记录、缺字段、时间解不出来这三条都在这里摆出来，外加
// 老 state.json 的一次性迁移（搬一条、改个名、别重复搬）。
//
// 记录现在存在官方领域存储里（见 src/operations/sync/sync-domain.ts），这一份只测"形状怎么判"与
// "旧文件怎么搬"；领域的打开在 sync-domain.test.ts 里用假模块测。表格的口子（`SyncRunTable`）在这里
// 用内存假实现，不碰真实 storageDomain，也不起宿主。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  lastRunView,
  migrateLegacySyncRun,
  migratedSyncStatePath,
  NO_SYNC_RUN_STORE,
  parseSyncRun,
  readLegacySyncRunFile,
  SYNC_RUN_KEY,
  syncStatePath,
  type StoredSyncRun,
  type SyncRunRecord,
  type SyncRunTable,
} from '../../../src/operations/sync/sync-state.ts'

/**
 * 在一座临时 `$DSH_HOME` 下跑一段，跑完删干净。
 * @param fn 拿临时家目录当参数。
 */
function withHome(fn: (home: string) => void | Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsm-sync-state-'))
  return Promise.resolve(fn(home)).finally(() => {
    rmSync(home, { recursive: true, force: true })
  })
}

/** 内存里的那张表：迁移与读写口都需要它，测试不碰真实领域。 */
class MemoryTable implements SyncRunTable {
  readonly records = new Map<string, StoredSyncRun>()
  /** 下一次 `put` 抛什么（模拟后端写不进去）。 */
  failNextPut?: Error

  get(key: typeof SYNC_RUN_KEY): StoredSyncRun {
    return this.records.get(key)
  }

  async put(key: typeof SYNC_RUN_KEY, value: StoredSyncRun): Promise<void> {
    if (this.failNextPut !== undefined) {
      const error = this.failNextPut
      this.failNextPut = undefined
      throw error
    }
    this.records.set(key, value)
  }
}

/** 旧版 `state.json` 的内容。 */
function writeLegacy(home: string, content: unknown): void {
  mkdirSync(join(home, 'dsh-session-manager'), { recursive: true })
  writeFileSync(syncStatePath(home), JSON.stringify(content))
}

const sample: SyncRunRecord = { at: '2026-11-12T12:00:00.000Z', ok: true, pulled: 3, pushed: 2 }

test('旧文件在插件自己那一层目录里，迁移后是同目录的 .migrated', () => {
  withHome((home) => {
    assert.equal(syncStatePath(home), join(home, 'dsh-session-manager', 'state.json'))
    assert.equal(migratedSyncStatePath(home), join(home, 'dsh-session-manager', 'state.json.migrated'))
  })
})

test('读得懂的一份就是原样那一条', () => {
  assert.deepEqual(parseSyncRun(sample), sample)
  assert.deepEqual(
    parseSyncRun({ ...sample, error: '401 Unauthorized' }),
    { ...sample, error: '401 Unauthorized' },
  )
})

test('旧记录缺 leftovers / takesEffect 照旧算一条记录', () => {
  assert.deepEqual(parseSyncRun(sample), sample, '这两个字段本来就是后加的')
})

test('来源记在 source 里：三个值照读，缺了按旧记录读，认不出的也不丢整条', () => {
  for (const source of ['manual', 'auto-push', 'auto-sync'] as const) {
    assert.deepEqual(parseSyncRun({ ...sample, source }), { ...sample, source })
  }
  assert.deepEqual(parseSyncRun(sample), sample, '旧记录没有这一项：那时只有手动那趟会写')
  assert.deepEqual(
    parseSyncRun({ ...sample, source: '以后才会有的一条' }),
    { ...sample, source: '以后才会有的一条' },
    '以后多一条写入口时这一版读得回来（界面按手动那趟画），不是整条记录当没有',
  )
})

test('读不懂的都当没有：少字段、类型不对、时间解不出来、根本不是对象', () => {
  assert.equal(parseSyncRun(undefined), undefined)
  assert.equal(parseSyncRun(null), undefined)
  assert.equal(parseSyncRun('nope'), undefined)
  assert.equal(parseSyncRun([]), undefined)
  assert.equal(parseSyncRun({ at: '2026-11-12T12:00:00.000Z', ok: true }), undefined, '少了条数字段')
  assert.equal(parseSyncRun({ ...sample, ok: 'yes' }), undefined, 'ok 不是布尔')
  assert.equal(parseSyncRun({ ...sample, pulled: '3' }), undefined, 'pulled 不是数字')
  assert.equal(parseSyncRun({ ...sample, at: 'not-a-date' }), undefined, '时间解不出来')
  assert.equal(parseSyncRun({ ...sample, problems: 'not-an-array' }), undefined, 'problems 形状不对')
  assert.equal(parseSyncRun({ ...sample, problems: [1, 2] }), undefined, 'problems 里不是字符串')
  assert.equal(parseSyncRun({ ...sample, takesEffect: 'later' }), undefined, 'takesEffect 不在那两个值里')
})

test('「没做到的条目」原样读回来，不认识的 kind 也读回来', () => {
  const run = {
    ...sample,
    problems: ['同步映射把 /home/u/dev/x 指到了 /nope，但那不是一个存在的目录'],
    leftovers: [
      {
        message: '甲（session-1）：目标目录不存在：/nope',
        sessionId: 'session-1',
        title: '甲',
        kind: 'path' as const,
        detail: '目标目录不存在：/nope',
      },
      { message: '同步映射把 /home/u/dev/x 指到了 /nope，但那不是一个存在的目录', kind: 'other' as const },
      // 以后宿主多一种分类时，这一版不该整条记录当没有；界面把它归到「其它问题」。
      { message: '以后才会有的一条', kind: 'later-kind' },
    ],
    takesEffect: 'restart-required' as const,
  }
  assert.deepEqual(parseSyncRun(run), run)
})

test('「没做到的条目」形状不对当没有：缺 message、id / 名字不是字符串', () => {
  assert.equal(parseSyncRun({ ...sample, leftovers: 'nope' }), undefined, '不是数组')
  assert.equal(parseSyncRun({ ...sample, leftovers: [{ sessionId: 'x' }] }), undefined, '缺 message')
  assert.equal(parseSyncRun({ ...sample, leftovers: [{ message: 'x', sessionId: 7 }] }), undefined)
  assert.equal(parseSyncRun({ ...sample, leftovers: [{ message: 'x', title: 7 }] }), undefined)
  assert.equal(parseSyncRun({ ...sample, leftovers: [{ message: 'x', detail: 7 }] }), undefined)
  assert.equal(parseSyncRun({ ...sample, leftovers: [{ message: 'x', kind: 7 }] }), undefined)
  assert.deepEqual(
    parseSyncRun({ ...sample, leftovers: [{ message: 'x' }] }),
    { ...sample, leftovers: [{ message: 'x' }] },
    '只有 message 也行（映射、远端索引那几步没有会话可指）',
  )
})

test('旧文件读得懂就读出来，不在 / 坏了 / 形状不对都是 undefined', async () => {
  await withHome((home) => {
    assert.equal(readLegacySyncRunFile(home), undefined, '文件不在')
    mkdirSync(join(home, 'dsh-session-manager'), { recursive: true })
    writeFileSync(syncStatePath(home), '{ not json')
    assert.equal(readLegacySyncRunFile(home), undefined, '坏 JSON')
    writeLegacy(home, { sync: { at: sample.at, ok: true } })
    assert.equal(readLegacySyncRunFile(home), undefined, '旧文件里那条少了条数字段')
    writeLegacy(home, { sync: sample })
    assert.deepEqual(readLegacySyncRunFile(home), sample)
  })
})

test('迁移：旧文件里那条搬进领域，旧文件改名成 .migrated', async () => {
  await withHome(async (home) => {
    writeLegacy(home, { sync: sample })
    const table = new MemoryTable()
    const notes: string[] = []

    const result = await migrateLegacySyncRun(home, table, (message) => notes.push(message))

    assert.deepEqual(result, { imported: true, renamed: true })
    assert.deepEqual(table.get(SYNC_RUN_KEY), sample, '领域里有那条记录了')
    assert.equal(existsSync(syncStatePath(home)), false, '旧文件不在原位了')
    assert.deepEqual(JSON.parse(readFileSync(migratedSyncStatePath(home), 'utf8')), { sync: sample }, '内容原样留着')
    assert.equal(notes.length, 0, '正常迁移不必说话')

    // 幂等：再跑一次什么都不做。
    const again = await migrateLegacySyncRun(home, table, (message) => notes.push(message))
    assert.deepEqual(again, { imported: false, renamed: false })
    assert.deepEqual(notes, [])
  })
})

test('迁移：领域里已经有记录就不导入（旧文件也不动）', async () => {
  await withHome(async (home) => {
    writeLegacy(home, { sync: sample })
    const table = new MemoryTable()
    const newer: SyncRunRecord = { at: '2026-11-13T09:00:00.000Z', ok: true, pulled: 0, pushed: 1 }
    table.records.set(SYNC_RUN_KEY, newer)

    const result = await migrateLegacySyncRun(home, table, () => {})

    assert.deepEqual(result, { imported: false, renamed: false })
    assert.deepEqual(table.get(SYNC_RUN_KEY), newer, '领域里那条没被旧文件盖掉')
    assert.equal(existsSync(syncStatePath(home)), true, '旧文件留着（没有可导入的东西，也没理由动它）')
  })
})

test('迁移：旧文件读不懂就不导入、不改名（用户目录里的东西不悄悄搬走）', async () => {
  await withHome(async (home) => {
    writeLegacy(home, { sync: { at: 'not-a-date' } })
    const table = new MemoryTable()
    const notes: string[] = []

    const result = await migrateLegacySyncRun(home, table, (message) => notes.push(message))

    assert.deepEqual(result, { imported: false, renamed: false })
    assert.equal(table.get(SYNC_RUN_KEY), undefined)
    assert.equal(existsSync(syncStatePath(home)), true)
    assert.deepEqual(notes, [])
  })
})

test('迁移：领域写不进去时只提示一句，不抛、也不改名', async () => {
  await withHome(async (home) => {
    writeLegacy(home, { sync: sample })
    const table = new MemoryTable()
    table.failNextPut = new Error('backend is down')
    const notes: string[] = []

    const result = await migrateLegacySyncRun(home, table, (message) => notes.push(message))

    assert.deepEqual(result, { imported: false, renamed: false })
    assert.equal(existsSync(syncStatePath(home)), true, '没搬成就不改名，下次再试')
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /backend is down/)
  })
})

test('迁移：搬完了但改名失败，只提示一句（领域里已经有记录，下次不会再导入）', async () => {
  await withHome(async (home) => {
    writeLegacy(home, { sync: sample })
    const table = new MemoryTable()
    // 在旧文件旁边放一个同名目录，rename 会失败（ENOTDIR / EISDIR）。
    mkdirSync(migratedSyncStatePath(home))
    writeFileSync(join(migratedSyncStatePath(home), 'occupied'), 'x')
    const notes: string[] = []

    const result = await migrateLegacySyncRun(home, table, (message) => notes.push(message))

    assert.equal(result.imported, true)
    assert.equal(result.renamed, false)
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /migrated/)
    assert.deepEqual(table.get(SYNC_RUN_KEY), sample)
  })
})

test('没有存储可用时：读永远没有、写丢掉（与原来读不到记录时一致）', () => {
  assert.equal(NO_SYNC_RUN_STORE.read(), undefined)
  assert.doesNotThrow(() => NO_SYNC_RUN_STORE.write(sample))
  assert.equal(NO_SYNC_RUN_STORE.read(), undefined, '写进去也不会有')
})

test('「还要不要重启」按进程启动时刻算，不写入磁盘', () => {
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
