// test/sync-state.test.ts — 上一次手动同步那条记录：位置、读写、以及"读不懂就当没有"。
//
// 为什么值得单独钉：页头那枚状态说"多久以前、成没成"，全靠这一份。它写坏了不会报错——界面只会退回
// "配没配"那一句，看着像"从来没同步过"。所以坏 JSON、缺字段、时间解不出来这三条都在这里摆出来。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readSyncRun, syncStatePath, writeSyncRun } from '../src/sync-state.ts'

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
