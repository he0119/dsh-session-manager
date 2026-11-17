import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import { concatBuffersAsync, joinTextAsync, splitLinesAsync } from '../../src/shared/text-chunks.ts'

test('splitLinesAsync：与 split 逐项一致（空文本、结尾换行、跨段）', async () => {
  assert.deepEqual(await splitLinesAsync(''), [''])
  assert.deepEqual(await splitLinesAsync('a\nb'), ['a', 'b'])
  assert.deepEqual(await splitLinesAsync('a\nb\n'), ['a', 'b', ''])
  const lines = Array.from({ length: 1000 }, (_, index) => `line-${index}-${'x'.repeat(3000)}`)
  const text = `${lines.join('\n')}\n`
  assert.deepEqual(await splitLinesAsync(text), text.split('\n'))
})

test('joinTextAsync：与 join 逐字符一致（含空数组与分隔符）', async () => {
  assert.equal(await joinTextAsync([], '\n'), '')
  assert.equal(await joinTextAsync(['a', 'b'], '\n'), 'a\nb')
  assert.equal(await joinTextAsync(['', ''], '\n'), '\n')
  const parts = Array.from({ length: 1000 }, (_, index) => `${index}:${'x'.repeat(3000)}`)
  assert.equal(await joinTextAsync(parts, '\n'), parts.join('\n'))
})

test('concatBuffersAsync：与 Buffer.concat 逐字节一致（含空块）', async () => {
  const parts = [Buffer.from('a'), Buffer.alloc(0), randomBytes(3 * 1024 * 1024)]
  assert.deepEqual(await concatBuffersAsync(parts), Buffer.concat(parts))
})

test('concatBuffersAsync：大输入在拼完之前会让出（别一次按住主线程）', async () => {
  let ticked = false
  const pending = concatBuffersAsync([Buffer.alloc(5 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024)])
  setImmediate(() => {
    ticked = true
  })
  await pending
  assert.equal(ticked, true)
})

test('joinTextAsync：大输入在拼完之前会让出', async () => {
  let ticked = false
  const pending = joinTextAsync(['x'.repeat(5 * 1024 * 1024), 'y'.repeat(5 * 1024 * 1024)], '')
  setImmediate(() => {
    ticked = true
  })
  await pending
  assert.equal(ticked, true)
})

test('splitLinesAsync：大输入在切完之前会让出', async () => {
  let ticked = false
  const pending = splitLinesAsync(`${'x'.repeat(5 * 1024 * 1024)}\n${'y'.repeat(5 * 1024 * 1024)}`)
  setImmediate(() => {
    ticked = true
  })
  const lines = await pending
  assert.equal(ticked, true)
  assert.deepEqual(lines.map((line) => line.length), [5 * 1024 * 1024, 5 * 1024 * 1024])
})
