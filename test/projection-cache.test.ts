// 投影记录读取器：文件没变时不重读、不重解（列表页每次打开都要读一遍 1300 多个文件）。
//
// 这条缓存只影响"读得多快"，不影响判据：身份对不上照样返回 undefined，文件变了照样重新读。
// 用例里"文件变了"都刻意改大小或改时间戳——同大小、同一毫秒的改写属于已知的理论窗口（见
// src/projection-cache.ts 的说明），不拿它当期望行为钉。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createProjectionReader, readProjectionCache } from '../src/projection-cache.ts'

const SANDBOX = join(import.meta.dirname, '.sandbox', 'projection-cache')

function resetSandbox(): string {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  return SANDBOX
}

function writeRecord(
  dir: string,
  id: string,
  options: {
    createdAt?: number
    cwd?: string
    title?: string
    blank?: boolean
    lastPromptAt?: number
    lastMessageTime?: number
  } = {},
): string {
  const path = join(dir, `${id}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      version: 7,
      record: {
        identity: { formatVersion: 4, createdAt: options.createdAt ?? 1000, cwd: options.cwd ?? '/tmp/project' },
        rows: {
          title: { ver: 1, seq: 1, val: options.title ?? '标题' },
          sessionListMetadata: {
            ver: 1,
            seq: 1,
            val: { blank: options.blank ?? false, lastPromptAt: options.lastPromptAt ?? 111 },
          },
          timeContext: { ver: 2, seq: 1, val: { lastMessageTime: options.lastMessageTime ?? 222 } },
        },
      },
    }),
  )
  return path
}

test('createProjectionReader：文件没变时返回同一份记录（不再读文件、不再解析）', () => {
  const dir = resetSandbox()
  writeRecord(dir, 'session-a', { title: '老标题' })
  const reader = createProjectionReader(dir)
  const query = { id: 'session-a', createdAt: 1000, cwd: '/tmp/project' }

  const first = reader(query)
  const second = reader(query)
  assert.equal(first?.title, '老标题')
  // 同一个对象 = 走的是缓存；`readProjectionCache()` 每次都会新建一份。
  assert.equal(second, first)
})

test('createProjectionReader：文件变了就重新读（标题、空白、两枚活动时间一起更新）', () => {
  const dir = resetSandbox()
  const path = writeRecord(dir, 'session-a', { title: '老标题', blank: false })
  const reader = createProjectionReader(dir)
  const query = { id: 'session-a', createdAt: 1000, cwd: '/tmp/project' }
  const before = reader(query)
  assert.equal(before?.title, '老标题')

  writeRecord(dir, 'session-a', { title: '新标题（长一点）', blank: true, lastMessageTime: 999 })
  const after = reader(query)
  assert.notEqual(after, before)
  assert.equal(after?.title, '新标题（长一点）')
  assert.equal(after?.blank, true)
  assert.equal(after?.lastMessageAt, 999)
})

test('createProjectionReader：只改了修改时间也会重新读（不看内容，看文件戳）', () => {
  const dir = resetSandbox()
  const path = writeRecord(dir, 'session-a', { title: '老标题' })
  const reader = createProjectionReader(dir)
  const query = { id: 'session-a', createdAt: 1000, cwd: '/tmp/project' }
  const before = reader(query)

  const later = new Date(Date.now() + 5000)
  utimesSync(path, later, later)
  const after = reader(query)
  assert.notEqual(after, before)
  assert.equal(after?.title, '老标题')
})

test('createProjectionReader：身份对不上时不返回别人的记录（缓存也不该把它当成这条的）', () => {
  const dir = resetSandbox()
  writeRecord(dir, 'session-a', { createdAt: 1000, cwd: '/tmp/project' })
  const reader = createProjectionReader(dir)

  assert.equal(reader({ id: 'session-a', createdAt: 2000, cwd: '/tmp/project' }), undefined)
  assert.equal(reader({ id: 'session-a', createdAt: 1000, cwd: '/tmp/other' }), undefined)
  assert.equal(reader({ id: 'session-a', createdAt: 1000, cwd: '/tmp/project' })?.title, '标题')
})

test('createProjectionReader：文件不在时 undefined，之后出现了照样读得到', () => {
  const dir = resetSandbox()
  const reader = createProjectionReader(dir)
  const query = { id: 'session-late', createdAt: 1000, cwd: '/tmp/project' }

  assert.equal(reader(query), undefined)
  writeRecord(dir, 'session-late', { title: '后来才写的' })
  assert.equal(reader(query)?.title, '后来才写的')
})

test('readProjectionCache：不经过缓存也读得出同一份字段（缓存不该是唯一入口）', () => {
  const dir = resetSandbox()
  writeRecord(dir, 'session-a', { title: '原地读', lastMessageTime: 777 })
  const record = readProjectionCache(dir, { id: 'session-a', createdAt: 1000, cwd: '/tmp/project' })
  assert.deepEqual(record, { title: '原地读', blank: false, lastPromptAt: 111, lastMessageAt: 777 })
})
