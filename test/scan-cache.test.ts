// 扫描缓存：库没变就复用上一次的结果，变了必须重扫。
//
// 这条缓存只影响"看到多新"，不影响任何写盘判断——所以它的每条失效路径都要钉死：新增 / 删除会话、日志
// 内容变了（哪怕大小没变）、投影缓存变了、库根换了，以及"文件刚被写过"那一种（粗粒度时间戳下指纹可能
// 看不出区别，只能不复用）。测试里凡是"库已经静止"的情形都要把文件时间戳调旧，否则永远落在 racy 窗口里。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { decompress } from 'fzstd'

import { createProjectionReader } from '../src/projection-cache.ts'
import { createScanCache } from '../src/scan-cache.ts'
import type { DecodeAll, SessionHeader } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const SANDBOX_ROOT = join(import.meta.dirname, '.sandbox', 'scan-cache')

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

interface Sandbox {
  readonly root: string
  readonly projectionDir: string
}

function resetSandbox(name: string): Sandbox {
  const base = join(SANDBOX_ROOT, name)
  rmSync(base, { recursive: true, force: true })
  const root = join(base, 'sessions')
  const projectionDir = join(base, 'session_projcache', 'sessions')
  mkdirSync(root, { recursive: true })
  mkdirSync(projectionDir, { recursive: true })
  return { root, projectionDir }
}

/**
 * 把时间戳调旧。
 *
 * 缓存对"扫描开始前一秒内被写过的文件"一律不认（见 scan-cache.ts 的 racy 处理），所以"库已经静止"
 * 这件事要靠这里造出来。
 */
function backdate(path: string, secondsAgo = 120): void {
  const when = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(path, when, when)
}

function writeSession(root: string, id: string, options: { text?: string } = {}): string {
  const projectDir = join(root, '--tmp-project--')
  const dir = join(projectDir, id)
  mkdirSync(dir, { recursive: true })
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1000,
    cwd: '/tmp/project',
    isSeeded: false,
    delegationDepth: 0,
  }
  const lines = [JSON.stringify(header), JSON.stringify({ type: 'user/message', seq: 0, data: { text: options.text ?? 'hi' } })]
  const path = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(path, Buffer.concat(lines.map((line) => encodeRawFrame(`${line}\n`))))
  backdate(path)
  return path
}

function writeProjection(dir: string, id: string, title: string, secondsAgo = 120): void {
  const path = join(dir, `${id}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: 1000, cwd: '/tmp/project' },
        rows: { title: { ver: 1, seq: 1, val: title } },
      },
    }),
  )
  backdate(path, secondsAgo)
}

test('库没变：第二次直接用上一次的结果，不再读每条会话的投影记录', () => {
  const sandbox = resetSandbox('unchanged')
  writeSession(sandbox.root, 'session-a')
  writeSession(sandbox.root, 'session-b')

  const scans = createScanCache()
  let asked = 0
  const projection = (query: { id: string }) => {
    asked += 1
    return { title: `记录-${query.id}` }
  }

  const first = scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.equal(asked, 2, '第一次扫描每条会话读一次')
  const before = asked

  const second = scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.equal(asked, before, '库没变就不该再读')
  assert.deepEqual(second.map((s) => s.id), first.map((s) => s.id))
  assert.deepEqual(second.map((s) => s.meta?.title), ['记录-session-a', '记录-session-b'])
  // 返回的是副本数组：调用方改数组本身不该把缓存里的那份一起改掉。
  assert.notEqual(second, first)
})

test('新增一条会话：指纹里的目录清单变了，必须重扫', () => {
  const sandbox = resetSandbox('added')
  writeSession(sandbox.root, 'session-a')
  const scans = createScanCache()
  let asked = 0
  const projection = () => {
    asked += 1
    return undefined
  }
  scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  writeSession(sandbox.root, 'session-b')

  const after = scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.deepEqual(after.map((s) => s.id).sort(), ['session-a', 'session-b'])
})

test('投影记录变了（标题被重写）：那些文件在指纹里，结果必须跟着变', () => {
  const sandbox = resetSandbox('projection')
  writeSession(sandbox.root, 'session-a')
  writeProjection(sandbox.projectionDir, 'session-a', '老标题')

  const scans = createScanCache()
  const projection = createProjectionReader(sandbox.projectionDir)
  const first = scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.equal(first[0]!.meta?.title, '老标题')

  // 两个时间戳必须真的不同：整条用例跑完只要几毫秒，用同一个"两分钟前"可能落进同一毫秒。
  writeProjection(sandbox.projectionDir, 'session-a', '新标题', 60)
  const second = scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.equal(second[0]!.meta?.title, '新标题')
})

test('日志被原样写回（大小不变、mtime 变了）：指纹看得见这一枚', () => {
  const sandbox = resetSandbox('mtime')
  const path = writeSession(sandbox.root, 'session-a')
  const scans = createScanCache()
  let asked = 0
  const projection = () => {
    asked += 1
    return undefined
  }
  scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  const before = asked

  // 字节完全一样地写回：size 不变、inode 不变，只有 mtime 变——这正是"只看大小"会漏掉的那种改动。
  const same = readFileSync(path)
  writeFileSync(path, same)
  backdate(path, 90)
  assert.equal(statSync(path).size, same.length, '前提：大小确实没变')
  scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.ok(asked > before, 'mtime 变了就必须重扫')
})

test('文件刚被写过（落在 racy 窗口里）：这次不复用', () => {
  const sandbox = resetSandbox('racy')
  // 不调时间戳：文件的 mtime 就是"刚才"。
  const projectDir = join(sandbox.root, '--tmp-project--')
  const dir = join(projectDir, 'session-fresh')
  mkdirSync(dir, { recursive: true })
  const header: SessionHeader = {
    type: 'session',
    version: 4,
    id: 'session-fresh',
    createdAt: 1000,
    cwd: '/tmp/project',
    isSeeded: false,
    delegationDepth: 0,
  }
  writeFileSync(
    join(dir, 'session.v4.jsonl.zstd'),
    Buffer.concat([JSON.stringify(header), JSON.stringify({ type: 'user/message', seq: 0, data: {} })].map((line) => encodeRawFrame(`${line}\n`))),
  )

  const scans = createScanCache()
  let asked = 0
  const projection = () => {
    asked += 1
    return undefined
  }
  scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  const before = asked
  scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.ok(asked > before, '刚写过的文件宁可多扫一次，也不交出可能过期的结果')
})

test('换了库根：键对不上，不复用上一次的结果', () => {
  const sandbox = resetSandbox('root')
  const otherRoot = join(SANDBOX_ROOT, 'root', 'other-sessions')
  mkdirSync(otherRoot, { recursive: true })
  writeSession(sandbox.root, 'session-a')
  writeSession(otherRoot, 'session-x')

  const scans = createScanCache()
  const projection = () => undefined
  const a = scans.scan(sandbox.root, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  const b = scans.scan(otherRoot, decodeAll, { projection, projectionDir: sandbox.projectionDir })
  assert.deepEqual(a.map((s) => s.id), ['session-a'])
  assert.deepEqual(b.map((s) => s.id), ['session-x'])
})
