/**
 * 差异视图"两边 / 计数"的判据：零条那半块也要摆出来、三格计数一格不少。
 *
 * 界面那层只能靠真实 GUI 量；但"哪几块要摆、每格拿哪个数"是判据——判据要能在这一层钉住：把零条那块
 * 过滤掉、把某一格换成别的数，这里就得变红。
 *
 * @module dsh-session-manager/test/diff-stats
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { sideBlocks, STAT_KEY, statCells, tailEmptyKey } from '../src/client/logic/diffStats.ts'
import { diffSessionLogs } from '../src/session-diff.ts'

const header = JSON.stringify({
  type: 'log',
  version: 1,
  id: 'session-x',
  createdAt: '2026-01-01T00:00:00.000Z',
  cwd: '/home/a/p',
})
const ev = (n: number): string =>
  JSON.stringify({
    type: 'event',
    seq: n,
    time: `2026-01-01T00:00:0${n}.000Z`,
    data: { type: 'user/message', content: [{ type: 'text', text: `第 ${n} 条` }] },
  })
const diffOf = (local: string[], remote: string[]) =>
  diffSessionLogs(local, remote, { localBytes: 1, remoteBytes: 1 }, {})

test('差异视图：两块尾巴都在，0 条那块也摆出来', () => {
  // 远端是本机的前缀（同一条延续），远端这块 0 条——0 条也是结论，不能整块吃掉。
  const diff = diffOf([header, ev(1), ev(2), ev(3)], [header, ev(1), ev(2)])
  const blocks = sideBlocks(diff)
  assert.deepEqual(blocks.map((b) => b.side), ['local', 'remote'], '两块都在，本机在前')
  assert.deepEqual(blocks.map((b) => b.tail.count), [1, 0], '远端这块是 0 条——0 条也要摆')
})

test('差异视图：三格计数一格不少，共同 / 本机独有 / 远端独有各拿各的数', () => {
  // 真分叉：共同前缀 2 条，之后本机又写了 2 条、远端又写了 1 条。
  const diff = diffOf([header, ev(1), ev(2), ev(3), ev(4)], [header, ev(1), ev(2), ev(5)])
  const cells = statCells(diff)
  assert.deepEqual(cells.map((c) => c.key), ['common', 'local', 'remote'], '顺序固定')
  assert.deepEqual(cells.map((c) => c.count), [2, 2, 1], '共同 2 · 本机独有 2 · 远端独有 1')
  assert.deepEqual(
    cells.map((c) => STAT_KEY[c.key]),
    ['sync.diff.stat.common', 'sync.diff.stat.local', 'sync.diff.stat.remote'],
    '三格各有自己的文案键',
  )
})

test('tailEmptyKey：0 条那一侧说的是"本机"还是"远端"，两侧不能同一句', () => {
  /*
   * 两块长得一样，只说「这一侧没有多出来的」，读的人得靠位置猜那是哪一侧。所以两侧各一句，由这里
   * 决定挑哪句——判据放在逻辑层，界面只负责 t() 一下。
   */
  assert.equal(tailEmptyKey('local'), 'sync.diff.tail.empty.local')
  assert.equal(tailEmptyKey('remote'), 'sync.diff.tail.empty.remote')
  assert.notEqual(tailEmptyKey('local'), tailEmptyKey('remote'), '两侧不能指向同一句')
})
