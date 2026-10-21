// 分块解压：输出与整份解压逐字符一致，块再小也一样；中途会把事件循环让出去。
import assert from 'node:assert/strict'
import test from 'node:test'

import { decompress } from 'fzstd'

import { DECODE_CHUNK_BYTES, decodeAllChunked, decodeLogTextChunked } from '../src/log-decode.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

/** 整份解压的参照实现（与 `src/tools.ts` 的 `decodeAll` 同一份）。 */
const decodeAll = (bytes: Buffer): string => Buffer.from(decompress(bytes)).toString('utf8')

/** 造一份"每行一帧"的日志字节，形状与宿主写出来的 `session.v4.jsonl.zstd` 一样。 */
function logBytes(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`)))
}

test('log-decode：分块解压与整份解压逐字符一致（多帧、中文、任意块边界）', async () => {
  const lines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-一', cwd: '/home/用户/proj' }),
    JSON.stringify({ type: 'user/message', seq: 0, data: { text: '中文一条：把事件循环让出去' } }),
    JSON.stringify({ type: 'assistant/message', seq: 1, data: { text: 'emoji 也来一个 🐟，还有全角符号，。' } }),
  ]
  const bytes = logBytes(lines)
  const expected = decodeAll(bytes)
  assert.equal(await decodeAllChunked(bytes), expected, '缺省块大小')
  // 逐字节推进：每一块都切在多字节字符中间，拼出来还得一样。
  assert.equal(await decodeAllChunked(bytes, 1), expected, '一块一个字节')
  assert.equal(await decodeAllChunked(bytes, 3), expected, '一块三个字节')
  assert.equal(await decodeAllChunked(bytes, expected.length), expected, '块比整份还大')
})

test('log-decode：空文件与不压缩的日志', async () => {
  assert.equal(await decodeAllChunked(Buffer.alloc(0)), '')
  const plain = Buffer.from('{"type":"session"}\n', 'utf8')
  assert.equal(await decodeLogTextChunked(plain, null), plain.toString('utf8'))
  assert.equal(await decodeLogTextChunked(plain, 'none'), plain.toString('utf8'))
})

test('log-decode：解压过程中会把事件循环让出去（同一个进程里的请求才轮得上）', async () => {
  // 一份够大的日志：缺省块大小下要推好几块，中间有几轮让出。
  const line = JSON.stringify({ type: 'assistant/message', seq: 0, data: { text: 'x'.repeat(2_000) } })
  const bytes = logBytes(Array.from({ length: 2_000 }, () => line))
  assert.ok(bytes.length > DECODE_CHUNK_BYTES * 4, '前提：这份日志要推好几块')
  const timer = new Promise<'定时器'>((resolve) => {
    setTimeout(() => resolve('定时器'), 0)
  })
  const decoded = decodeAllChunked(bytes)
  const raced = decoded.then(() => '解压完了' as const)
  // 谁先落地：分块解压中途让出事件循环，定时器才排得进来说话；整份解压会把这一段占满，定时器只能排在它之后。
  assert.equal(await Promise.race([timer, raced]), '定时器')
  await decoded
})
