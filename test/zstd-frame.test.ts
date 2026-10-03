import assert from 'node:assert/strict'
import test from 'node:test'

import { decompress } from 'fzstd'

import type { DecodeAll } from '../src/types.ts'
import {
  ZSTD_MAGIC,
  assertMultiFrameAware,
  encodeRawFrame,
  splitFirstFrame,
  splitFirstFrameFast,
} from '../src/zstd-frame.ts'

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

/**
 * 造一个"载荷里真的嵌着 zstd magic 字节"的帧。
 *
 * 不能把 magic 写进字符串：`encodeRawFrame` 会按 UTF-8 重新编码，`0xb5`/`0xfd` 会变成多字节序列，
 * 于是载荷里根本没有那四个字节（这种夹具看起来在测边界，其实什么都没测）。这里先写等长的 ASCII
 * 占位串，再把四个字节盖上去——长度不变，帧仍然合法。
 */
function frameWithEmbeddedMagic(text: string, placeholder = 'XYZW'): Buffer {
  const frame = encodeRawFrame(text)
  const at = frame.indexOf(placeholder, 4)
  assert.ok(at > 0, '占位串必须出现在帧载荷里')
  Buffer.from(ZSTD_MAGIC).copy(frame, at)
  return frame
}

test('splitFirstFrame：载荷中的偶然 magic 字节不会被误判为帧边界', () => {
  const f1 = frameWithEmbeddedMagic('abcXYZWdef\n')
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

test('splitFirstFrameFast：多帧拼接上给出与 splitFirstFrame 相同的切分', () => {
  const f1 = encodeRawFrame('header\n')
  const rest = Buffer.concat([encodeRawFrame('event1\n'), encodeRawFrame('event2\n')])
  const buf = Buffer.concat([f1, rest])
  const fast = splitFirstFrameFast(buf, decodeAll)
  const strict = splitFirstFrame(buf, decodeAll)
  assert.ok(fast && strict)
  assert.equal(fast.first, strict.first)
  assert.equal(fast.boundary, strict.boundary)
  assert.deepEqual(fast.rest, strict.rest)
  assert.equal(fast.boundary, f1.length)
})

test('splitFirstFrameFast：单帧文件退化为整份（rest 为空）', () => {
  const buf = encodeRawFrame('only\n')
  const fast = splitFirstFrameFast(buf, decodeAll)
  assert.ok(fast)
  assert.equal(fast.first, 'only\n')
  assert.equal(fast.boundary, buf.length)
  assert.equal(fast.rest.length, 0)
})

test('splitFirstFrameFast：载荷中的偶然 magic 字节不会被误判为帧边界', () => {
  // 与严格实现那条同形，夹具也一样"真的嵌了 magic 字节"：快路径只解前缀，靠"截断帧解不出来"
  // 把假边界挡掉（严格实现则是靠 head + tail === full）。
  const f1 = frameWithEmbeddedMagic('abcXYZWdef\n')
  const rest = encodeRawFrame('tail\n')
  const fast = splitFirstFrameFast(Buffer.concat([f1, rest]), decodeAll)
  assert.ok(fast)
  assert.equal(fast.boundary, f1.length)
  assert.deepEqual(fast.rest, rest)
})

test('splitFirstFrameFast：前提——截断的帧会被解码器拒绝', () => {
  // 快路径不做 `head + tail === full` 自洽校验，正确性全靠这一条：假边界处的前缀是截断帧，
  // 解码必须失败。若哪天换了会"尽力解一半"的解码器，这条会先红，提醒改用 splitFirstFrame。
  const frame = encodeRawFrame('{"type":"session","cwd":"/x"}\nhello\n')
  for (const cut of [10, 20, 30, frame.length - 5]) {
    assert.throws(() => decodeAll(frame.subarray(0, cut)), /unexpected EOF|invalid|unexpected/i)
  }
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
