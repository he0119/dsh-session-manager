// 发现阶段只读文件开头那一段（`src/discovery.ts` 的 `readLogHeader()`）。
//
// 为什么值得单独钉：整库 1003 个日志文件合计 619 MB，而 header 那一帧实测只有 168～299 字节——为它读整份
// 是这个库里最贵的一次白读。改成只读前缀之后有两条边界必须守住：
//   1. 报出去的**字节数**仍是整份文件（界面那一列与同步的内容指纹比的是整份日志）；
//   2. 首帧万一比前缀还大，必须退回读整份，而不是把这条会话丢掉。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { readLogHeader, scanAll } from '../src/discovery.ts'
import type { DecodeAll, SessionHeader } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const SANDBOX = join(import.meta.dirname, '.sandbox', 'discovery')

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

function resetSandbox(): string {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  return SANDBOX
}

function headerOf(id: string, extra: Record<string, unknown> = {}): SessionHeader & Record<string, unknown> {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1000,
    cwd: '/tmp/project',
    isSeeded: false,
    delegationDepth: 0,
    ...extra,
  }
}

/** 写一个代次日志：首帧是 header 行，后面按需跟几帧。 */
function writeLog(dir: string, header: SessionHeader & Record<string, unknown>, tail: readonly string[] = []): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(
    path,
    Buffer.concat([JSON.stringify(header), ...tail].map((line) => encodeRawFrame(`${line}\n`))),
  )
  return path
}

test('readLogHeader：只看开头一段，但报的字节数是整份文件', () => {
  const root = resetSandbox()
  const huge = 'x'.repeat(400 * 1024)
  const path = writeLog(join(root, 'big'), headerOf('session-big'), [JSON.stringify({ type: 'user/message', seq: 0, data: { text: huge } })])

  const { header, bytes } = readLogHeader(path, decodeAll)
  assert.equal(header.id, 'session-big')
  // 整份约 400 KB，读的只是开头 64 KB：报出去的数字必须是整份（否则界面上的大小与同步比的内容对不上）。
  assert.equal(bytes, statSync(path).size)
  assert.ok(bytes > 400 * 1024, `应当报整份大小，实际 ${bytes}`)
})

test('readLogHeader：首帧比前缀还大时退回读整份，不丢这条会话', () => {
  const root = resetSandbox()
  // 把 header 那一行本身撑到 64 KB 以上：前缀里没有完整的那一帧，只能整份读。
  const path = writeLog(join(root, 'fat'), headerOf('session-fat', { padding: 'y'.repeat(80 * 1024) }))

  const { header, bytes } = readLogHeader(path, decodeAll)
  assert.equal(header.id, 'session-fat')
  assert.equal(bytes, statSync(path).size)
})

test('scanAll：整库扫描照旧报每条会话的字节数合计（只读前缀不等于只报前缀）', () => {
  const root = resetSandbox()
  const tail = [JSON.stringify({ type: 'user/message', seq: 0, data: { text: 'z'.repeat(200 * 1024) } })]
  const a = writeLog(join(root, '--tmp-project--', 'session-a'), headerOf('session-a'), tail)
  const b = writeLog(join(root, '--tmp-project--', 'session-b'), headerOf('session-b'))

  const sessions = scanAll(root, decodeAll)
  const byId = new Map(sessions.map((session) => [session.id, session]))
  assert.equal(byId.get('session-a')!.files.reduce((sum, file) => sum + file.bytes, 0), statSync(a).size)
  assert.equal(byId.get('session-b')!.files.reduce((sum, file) => sum + file.bytes, 0), statSync(b).size)
  assert.ok(statSync(a).size > 200 * 1024)
})
