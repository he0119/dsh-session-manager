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

import { locateSession, readLogHeader, scanAll } from '../src/discovery.ts'
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

// 按 id 直接定位：内容视图每翻一页都要定位一次，所以它不能是"扫一遍整库再筛"。
// 这组用例同时钉住兜底：目录名不是 id 的编码时仍要能找到，找不到才算真的没有。
test('locateSession：只读这一条，不为其它会话折标题（整库扫一遍会为每条都调一次）', () => {
  const root = resetSandbox()
  writeLog(join(root, '--proj-a--', 'session-a'), headerOf('session-a', { createdAt: 3000 }))
  writeLog(join(root, '--proj-a--', 'session-b'), headerOf('session-b', { createdAt: 2000 }))
  writeLog(join(root, '--proj-b--', 'session-c'), headerOf('session-c', { createdAt: 1000 }))

  const titled: string[] = []
  const record = { title: '投影里的标题' }
  const session = locateSession(root, 'session-a', decodeAll, {
    projection: (query) => {
      assert.equal(query.id, 'session-a', '只为这一条读投影记录')
      return record
    },
    resolveTitle: (query) => {
      titled.push(query.id)
      return query.id === 'session-a' ? '只该问这一条' : undefined
    },
  })

  assert.equal(session?.id, 'session-a')
  assert.equal(session?.createdAt, 3000)
  assert.equal(session?.meta, record)
  assert.equal(session?.title, '只该问这一条')
  assert.deepEqual(titled, ['session-a'], '整库扫描会给三条都折一遍标题')
})

test('locateSession：库里没有这条时 undefined', () => {
  const root = resetSandbox()
  writeLog(join(root, '--proj-a--', 'session-a'), headerOf('session-a'))

  assert.equal(locateSession(root, 'session-missing', decodeAll), undefined)
})

test('locateSession：同一个 id 在两个项目目录里时取新建的那一条', () => {
  const root = resetSandbox()
  writeLog(join(root, '--proj-a--', 'session-dup'), headerOf('session-dup', { createdAt: 1000 }))
  writeLog(join(root, '--proj-b--', 'session-dup'), headerOf('session-dup', { createdAt: 5000 }))

  assert.equal(locateSession(root, 'session-dup', decodeAll)?.createdAt, 5000)
})

test('locateSession：目录名不是 id 的编码时退回整库扫一遍，仍然找得到', () => {
  const root = resetSandbox()
  // 手改过 / 早期版本留下的库：目录名叫别的，header 里才是真 id。
  writeLog(join(root, '--proj-a--', 'not-the-encoded-id'), headerOf('session-odd'))

  assert.equal(locateSession(root, 'session-odd', decodeAll)?.id, 'session-odd')
})

test('locateSession：目录名对得上、header 里的 id 对不上时不算这条会话，但那条会话本身还找得到', () => {
  const root = resetSandbox()
  writeLog(join(root, '--proj-a--', 'session-x'), headerOf('session-y'))

  // 目录名叫 session-x，里面却是 session-y：按 id 找 session-x 不能被同名目录骗过去。
  assert.equal(locateSession(root, 'session-x', decodeAll), undefined)
  // 而 session-y 确实在库里（整库扫描也列得出它），兜底要把它找出来，不能因为目录名怪就丢。
  assert.equal(locateSession(root, 'session-y', decodeAll)?.id, 'session-y')
})
