// test/session-diff.test.ts — 两条日志的比对：共同到哪条、之后各自写了什么、header 差在哪。
//
// 这份比对是"同一个 id 两边各自写过"那条路上**人做决定**的依据，所以三件事要钉死：
//   1) 共同前缀按原文逐行算，header 不参与（迁移落地会改写 cwd，那不算"事件分叉"）；
//   2) 尾巴的三种关系分得清：续写（一边是另一边的逐字节前缀）与真分叉不是一回事；
//   3) 预览只是"够认出来"，条数、字节数、没列出来的数目都必须如实。
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_DIFF_PREVIEW, diffSessionLogs } from '../src/session-diff.ts'

/** header：只有 `cwd` 按参数变（迁移落地改的就是它）。 */
const header = (cwd = '/home/uy_sun/dev/a'): string =>
  JSON.stringify({ type: 'session', version: 4, id: 'session-abc', createdAt: 1791456394217, cwd, isSeeded: false })

/** 造一行事件：`seq` 自己加，其余原样。与 test/transcript.test.ts 同一套形状。 */
const ev = (seq: number, type: string, data: unknown): string =>
  JSON.stringify({ type, seq, time: 1791456400000 + seq, data })

const user = (seq: number, text: string): string =>
  ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })

const call = (seq: number, name: string, args: string): string =>
  ev(seq, 'tool/call', { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: args })

/** 一条共同的起头：三个事件。 */
const shared = [user(0, '帮我看看这个日志'), call(1, 'bash', '{"command":"ls"}'), ev(2, 'turn/start', { turn: 2 })]

const facts = (localBytes = 100, remoteBytes = 100) => ({ localBytes, remoteBytes })

test('比对：事件逐条一致，只有 header 的 cwd 不同', () => {
  const diff = diffSessionLogs([header('/home/a'), ...shared], [header('/mnt/win/b'), ...shared], facts(100, 200))
  assert.equal(diff.relation, 'same')
  assert.equal(diff.common, 3, '三条事件逐条一致')
  assert.equal(diff.localTail.count, 0)
  assert.equal(diff.remoteTail.count, 0)
  assert.deepEqual(diff.header, [{ field: 'cwd', local: '/home/a', remote: '/mnt/win/b' }])
  assert.deepEqual(diff.local, { events: 3, bytes: 100, problems: 0 })
  assert.deepEqual(diff.remote, { events: 3, bytes: 200, problems: 0 })
})

test('比对：本机那份是远端往前接着写的（不是分叉）', () => {
  const diff = diffSessionLogs(
    [header(), ...shared, user(3, '再帮我算一下'), call(4, 'bash', '{"command":"wc -l"}')],
    [header(), ...shared],
    facts(),
  )
  assert.equal(diff.relation, 'local-extends', '远端那份是本机这部分的前缀')
  assert.equal(diff.common, 3)
  assert.equal(diff.localTail.count, 2)
  assert.equal(diff.remoteTail.count, 0)
  assert.deepEqual(
    diff.localTail.preview.map((item) => [item.index, item.kind, item.brief]),
    [
      [3, 'user', '再帮我算一下'],
      [4, 'tool-call', 'bash {"command":"wc -l"}'],
    ],
    '预览的行号是整份日志里的位置，摘要带工具名与入参',
  )
})

test('比对：远端那份是本机往前接着写的', () => {
  const diff = diffSessionLogs(
    [header(), ...shared],
    [header(), ...shared, user(3, '那边又写了一条')],
    facts(),
  )
  assert.equal(diff.relation, 'remote-extends')
  assert.equal(diff.remoteTail.count, 1)
  assert.equal(diff.remoteTail.preview[0]?.kind, 'user')
})

test('比对：两边各写各的（真分叉），两条尾巴都列出来', () => {
  const diff = diffSessionLogs(
    [header(), ...shared, user(3, '本机这条路'), call(4, 'bash', '{"command":"ls -la"}')],
    [header(), ...shared, user(3, '远端那条路'), ev(4, 'turn/start', { turn: 9 })],
    facts(),
  )
  assert.equal(diff.relation, 'forked')
  assert.equal(diff.common, 3)
  assert.equal(diff.localTail.count, 2)
  assert.equal(diff.remoteTail.count, 2)
  assert.equal(diff.localTail.preview[0]?.brief, '本机这条路')
  assert.equal(diff.remoteTail.preview[0]?.brief, '远端那条路')
  assert.equal(diff.remoteHeader.id, 'session-abc')
})

test('比对：空行不占事件位（尾部换行与中间空行都跳过）', () => {
  const diff = diffSessionLogs(
    [header(), ...shared, '', '  ', user(3, '多一条')],
    [header(), ...shared, ''],
    facts(),
  )
  assert.equal(diff.common, 3)
  assert.equal(diff.localTail.count, 1, '空行不算事件')
  assert.equal(diff.remoteTail.count, 0)
})

test('比对：预览里读不出来的行退回原文，位置与条数照样对齐', () => {
  const diff = diffSessionLogs(
    [header(), ...shared, '这不是 JSON', user(4, '后面还有一条')],
    [header(), ...shared, user(3, '远端一条')],
    facts(),
  )
  assert.equal(diff.relation, 'forked')
  assert.equal(diff.localTail.count, 2)
  assert.deepEqual(
    diff.localTail.preview.map((item) => [item.index, item.type, item.brief]),
    [
      [3, 'unknown', '这不是 JSON'],
      [4, 'user/message', '后面还有一条'],
    ],
    '坏行退回原文，后一条的位置仍然是 4（不因为跳过而对不齐）',
  )
})

test('比对：预览只列前几条，条数、字节与没列出来的数目如实', () => {
  const long = Array.from({ length: 25 }, (_, index) => user(3 + index, `第 ${index} 条`))
  const diff = diffSessionLogs([header(), ...shared, ...long], [header(), ...shared], facts(), { maxPreview: 3 })
  assert.equal(diff.localTail.count, 25)
  assert.equal(diff.localTail.preview.length, 3)
  assert.equal(diff.localTail.hidden, 22)
  assert.ok(diff.localTail.bytes > 0, '尾巴的字节数按行算出来')
})

test('比对：预览里的长正文被截断（界面只要够认出来）', () => {
  const diff = diffSessionLogs(
    [header(), ...shared, user(3, 'x'.repeat(400))],
    [header(), ...shared],
    facts(),
    { previewChars: 30 },
  )
  const brief = diff.localTail.preview[0]?.brief ?? ''
  assert.equal(brief.length, 30)
  assert.ok(brief.endsWith('…'), '截断处给出省略号')
})

test('比对：缺省每条尾巴列 20 条（不传选项也一样）', () => {
  const long = Array.from({ length: 30 }, (_, index) => user(3 + index, `第 ${index} 条`))
  const diff = diffSessionLogs([header(), ...shared, ...long], [header(), ...shared], facts())
  assert.equal(diff.localTail.preview.length, DEFAULT_DIFF_PREVIEW)
  assert.equal(diff.localTail.hidden, 10)
})

test('比对：坏行的条数由调用方给（两边的解析问题各算各的）', () => {
  const diff = diffSessionLogs([header(), ...shared], [header(), ...shared], {
    localBytes: 10,
    remoteBytes: 20,
    localProblems: 0,
    remoteProblems: 2,
  })
  assert.equal(diff.remote.problems, 2)
  assert.equal(diff.local.problems, 0)
})
