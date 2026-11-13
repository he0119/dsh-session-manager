// test/relative-time.test.ts — "多久以前"这一句话的档位。
//
// 为什么单独测：页头那枚同步状态每天都要念一次它，边界（59 秒 / 60 分钟 / 24 小时）错一格就会说出
// "0 分钟前"这种话，而那种错在界面上看着只是"有点怪"，没人会去报。
import assert from 'node:assert/strict'
import test from 'node:test'

import { relativeLabel } from '../src/client/logic/relativeTime.ts'

const NOW = Date.parse('2026-11-12T12:00:00.000Z')
const at = (ms: number): string => relativeLabel(NOW - ms, NOW).key
const count = (ms: number): number | undefined => {
  const label = relativeLabel(NOW - ms, NOW)
  return label.key === 'time.justNow' ? undefined : label.count
}

test('不到一分钟说"刚刚"', () => {
  assert.equal(at(0), 'time.justNow')
  assert.equal(at(59_000), 'time.justNow')
})

test('分钟、小时、天各按整数向下取', () => {
  assert.equal(at(60_000), 'time.minutes')
  assert.equal(count(60_000), 1)
  assert.equal(count(59 * 60_000), 59)
  assert.equal(at(60 * 60_000), 'time.hours')
  assert.equal(count(23 * 3_600_000), 23)
  assert.equal(at(24 * 3_600_000), 'time.days')
  assert.equal(count(45 * 24 * 3_600_000), 45, '再久也照实说，不换成"很久以前"')
})

test('时钟不同步（记录比现在还晚）当"刚刚"，不吐负数', () => {
  assert.equal(at(-5 * 60_000), 'time.justNow')
  assert.equal(at(Number.NaN), 'time.justNow')
})
