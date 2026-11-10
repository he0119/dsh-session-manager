// 日志文本缓存：同一份日志连着读好几页时只解压一次，文件变了必须重读。
//
// 这一层只影响"翻页快不快"，不影响"看到的是不是最新的"：判据是 size + mtimeMs，日志被追加、被改写
// 都会让它对不上。用例里的"变了"都改大小或改时间戳；同大小同毫秒的改写是已知的理论窗口
// （见 src/log-text-cache.ts），不拿它当期望行为钉。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createLogTextCache } from '../src/log-text-cache.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const SANDBOX = join(import.meta.dirname, '.sandbox', 'log-text-cache')

function resetSandbox(): string {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  return SANDBOX
}

/** 写一份多帧 zstd 日志（与宿主写出来的同一个形状）。 */
function writeLog(path: string, lines: readonly string[]): void {
  writeFileSync(path, Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))))
}

const HEADER = JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: 1000, cwd: '/tmp/project' })

test('createLogTextCache：文件没变时直接给上一次切好的行（不重读、不再解压）', async () => {
  const dir = resetSandbox()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeLog(path, [HEADER, JSON.stringify({ type: 'user/message', seq: 0, data: {} })])

  const cache = createLogTextCache()
  const first = await cache.linesOf({ path, compression: 'zstd' })
  const second = await cache.linesOf({ path, compression: 'zstd' })
  // 每帧都以换行结尾，所以切开之后末尾有一个空串（readTranscript 会跳过它）。
  assert.deepEqual(first, [HEADER, JSON.stringify({ type: 'user/message', seq: 0, data: {} }), ''])
  // 同一个数组 = 走的是缓存；重新解压会新建一份。
  assert.equal(second, first)
})

test('createLogTextCache：日志被追加之后读到的是新的那条（大小变了就得重读）', async () => {
  const dir = resetSandbox()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeLog(path, [HEADER, JSON.stringify({ type: 'user/message', seq: 0, data: { text: '一' } })])
  const cache = createLogTextCache()
  assert.equal((await cache.linesOf({ path, compression: 'zstd' })).length, 3)

  writeLog(path, [
    HEADER,
    JSON.stringify({ type: 'user/message', seq: 0, data: { text: '一' } }),
    JSON.stringify({ type: 'assistant/message', seq: 1, data: { text: '二' } }),
  ])
  const after = await cache.linesOf({ path, compression: 'zstd' })
  assert.equal(after.length, 4)
  assert.ok(after[2]!.includes('assistant/message'))
})

test('createLogTextCache：只改了修改时间也重读（判据是文件戳，不是内容）', async () => {
  const dir = resetSandbox()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeLog(path, [HEADER])
  const cache = createLogTextCache()
  const before = await cache.linesOf({ path, compression: 'zstd' })

  const later = new Date(Date.now() + 5000)
  utimesSync(path, later, later)
  const after = await cache.linesOf({ path, compression: 'zstd' })
  assert.notEqual(after, before)
  assert.deepEqual(after, before)
})

test('createLogTextCache：解开之后超过上限的那份不缓存（照旧每次现解）', async () => {
  const dir = resetSandbox()
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeLog(path, [HEADER, JSON.stringify({ type: 'user/message', seq: 0, data: {} })])
  const cache = createLogTextCache({ maxChars: 1 })

  const first = await cache.linesOf({ path, compression: 'zstd' })
  const second = await cache.linesOf({ path, compression: 'zstd' })
  assert.deepEqual(second, first)
  assert.notEqual(second, first, '超过上限就不该留下缓存')
})

test('createLogTextCache：不认识的压缩方式按原样文本读（v0 的 session.jsonl）', async () => {
  const dir = resetSandbox()
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${HEADER}\n{"type":"user/message","seq":0}\n`)
  const cache = createLogTextCache()
  assert.deepEqual(await cache.linesOf({ path, compression: null }), [HEADER, '{"type":"user/message","seq":0}', ''])
})

test('createLogTextCache：文件读不到时抛错（调用方据此报"这份日志读不出来"）', async () => {
  const dir = resetSandbox()
  const cache = createLogTextCache()
  await assert.rejects(cache.linesOf({ path: join(dir, 'nope.v4.jsonl.zstd'), compression: 'zstd' }), /ENOENT/)
})
