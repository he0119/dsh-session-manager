import assert from 'node:assert/strict'
import test from 'node:test'

import { decompress } from 'fzstd'

import type { DecodeAll } from '../src/types.ts'
import { assertMultiFrameAware, encodeRawFrame, splitFirstFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

test('encodeRawFrame：小载荷（1 字节 FCS）可被解码器读回', () => {
  const frame = encodeRawFrame('{"type":"session"}')
  assert.deepEqual([...frame.subarray(0, 4)], [0x28, 0xb5, 0x2f, 0xfd])
  assert.equal(decodeAll(frame), '{"type":"session"}')
})

test('encodeRawFrame：跨 256 字节边界（2 字节 FCS）仍然正确', () => {
  const text = 'x'.repeat(300)
  assert.equal(decodeAll(encodeRawFrame(text)), text)
  assert.equal(decodeAll(encodeRawFrame('y'.repeat(255))), 'y'.repeat(255))
  assert.equal(decodeAll(encodeRawFrame('z'.repeat(256))), 'z'.repeat(256))
})

test('encodeRawFrame：多字节 UTF-8 按字节长度计算', () => {
  const text = '会话迁移'
  assert.equal(Buffer.byteLength(text), 12)
  assert.equal(decodeAll(encodeRawFrame(text)), text)
})

test('splitFirstFrame：从多帧拼接中切出首帧并保留其余字节', () => {
  const f1 = encodeRawFrame('header\n')
  const rest = Buffer.concat([encodeRawFrame('event1\n'), encodeRawFrame('event2\n')])
  const buf = Buffer.concat([f1, rest])
  const split = splitFirstFrame(buf, decodeAll)
  assert.ok(split)
  assert.equal(split.first, 'header\n')
  assert.equal(split.boundary, f1.length)
  assert.deepEqual(split.rest, rest, '其余帧必须逐字节不变')
  assert.equal(decodeAll(split.rest), 'event1\nevent2\n')
})

test('splitFirstFrame：单帧文件也能切分（rest 为空）', () => {
  const buf = encodeRawFrame('only\n')
  const split = splitFirstFrame(buf, decodeAll)
  assert.ok(split)
  assert.equal(split.first, 'only\n')
  assert.equal(split.rest.length, 0)
})

test('splitFirstFrame：载荷中的偶然 magic 字节不会被误判为帧边界', () => {
  // 首帧明文里内嵌 zstd magic 字节序列
  const tricky = Buffer.concat([Buffer.from('abc'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('def\n')])
  const f1 = encodeRawFrame(tricky.toString('latin1'))
  const rest = encodeRawFrame('tail\n')
  const split = splitFirstFrame(Buffer.concat([f1, rest]), decodeAll)
  assert.ok(split)
  assert.equal(split.boundary, f1.length)
  assert.deepEqual(split.rest, rest)
})

test('splitFirstFrame：整份不可解码时大声抛错（不静默返回部分结果）', () => {
  const garbage = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff, 0xff])
  assert.throws(() => splitFirstFrame(garbage, decodeAll))
})

test('splitFirstFrame：可解码时恒有切分（退化为整份单帧）', () => {
  // 只要整份能解码，i = buf.length 必然满足 head+'' === full，
  // 因此 null 分支对可解码输入不可达——这是有意的保守设计而非遗漏。
  const single = encodeRawFrame('all-in-one\n')
  const split = splitFirstFrame(single, decodeAll)
  assert.ok(split)
  assert.equal(split.first, 'all-in-one\n')
  assert.equal(split.rest.length, 0)
})

test('assertMultiFrameAware：接受 fzstd', () => {
  assert.doesNotThrow(() => assertMultiFrameAware(decodeAll))
})

test('assertMultiFrameAware：拒绝"只解首帧"的解码器（本次事故的回归防线）', async () => {
  const zlib = await import('node:zlib')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    // 该 Node 没有内置 zstd：跳过（但守卫本身仍由下一条验证）
    return
  }
  const singleFrameOnly: DecodeAll = (buf: Uint8Array): string =>
    zlib.zstdDecompressSync(Buffer.from(buf)).toString('utf8')
  assert.throws(() => assertMultiFrameAware(singleFrameOnly), /not multi-frame aware/)
})

test('assertMultiFrameAware：拒绝抛错的解码器', () => {
  assert.throws(
    () =>
      assertMultiFrameAware(() => {
        throw new Error('boom')
      }),
    /rejected a valid two-frame stream/,
  )
})
