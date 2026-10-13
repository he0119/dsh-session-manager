// test/transcript.test.ts — 会话日志的解析：一条事件一条条目、工具调用不重复、上限与分页不丢事件。
//
// 这份解析的难点全在**边界**：日志里什么都有（合成的 user/message、只在助手消息里出现的 tool-call
// 块、带 isError 的工具结果、读不出来的坏行、6 MB 的会话），而"完整"意味着不能悄悄丢东西。所以这里逐条
// 钉：哪些事件成了哪种条目、哪一格文本、被截断的地方有没有如实记账、分页游标有没有漏条或卡住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { countTranscript, readTranscript } from '../src/transcript.ts'

const HEADER = JSON.stringify({
  type: 'session',
  version: 4,
  id: 'session-abc',
  createdAt: 1791456394217,
  cwd: '/home/uy_sun/dev/test',
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: 'standard',
})

/** 造一行事件：`seq` 自己加，其余原样。 */
const ev = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, seq, time: 1791456400000 + seq, data, ...extra })

/** 一份覆盖主要形状的小日志。 */
const LINES: string[] = [
  HEADER,
  ev(0, 'permission/preset', { preset: 'danger-full-access' }),
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'user/message', {
    content: [{ type: 'text', text: '帮我看看这个日志' }],
    source: { kind: 'user' },
    role: 'user',
    id: 'm1',
  }),
  ev(3, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先看看目录里有什么' },
        { type: 'text', text: '好，我看一下。' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      ],
      source: { kind: 'model', provider: 'p', model: 'm', replayState: { 巨大: '不该出现在时间线里' } },
    },
  }),
  ev(4, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
  ev(5, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'a.txt\nb.txt' }],
      isError: false,
      id: 'r1',
    },
  }, { sourceEventSeqs: [4] }),
  ev(6, 'session/title', { title: '看看日志', messageSeqs: [2], source: { kind: 'provider', provider: 'p' } }),
  ev(7, 'user/message', {
    content: [{ type: 'text', text: 'Generate the session title from this JSON array…' }],
    source: { kind: 'dsh-session-title-llm' },
    role: 'user',
    id: 'm2',
  }),
  ev(8, 'llm/retry', { attempt: 2 }),
  '{"type":"tool/result","seq":9,"time":1791456400009,"data":{ 这行坏了 }}',
  ev(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  '',
]

test('readTranscript：一条事件一条条目，工具调用只算一次', () => {
  const page = readTranscript(LINES)
  assert.equal(page.header.id, 'session-abc')
  assert.equal(page.totalEvents, 11, '空行不算事件')
  assert.equal(page.items.length, 10, '11 条事件里那条坏行解析不出来，只剩 10 条条目')

  const kinds = page.items.map((item) => `${item.index}:${item.kind}`)
  assert.deepEqual(kinds, [
    '0:event',
    '1:event',
    '2:user',
    '3:assistant',
    '4:tool-call',
    '5:tool-result',
    '6:event',
    '7:user',
    '8:event',
    // 坏了的那条（index 9）如实记进 problems，不摆成条目
    '10:event',
  ])
})

test('readTranscript：用户消息、助手消息（思考与正文分格）、合成消息各自照实', () => {
  const page = readTranscript(LINES)
  const human = page.items[2]!
  assert.equal(human.text, '帮我看看这个日志')
  assert.equal(human.synthetic, undefined, 'source.kind 是 user：这条是人发的')
  assert.equal(human.seq, 2)

  const assistant = page.items[3]!
  assert.equal(assistant.text, '好，我看一下。')
  assert.equal(assistant.reasoning, '先看看目录里有什么')
  assert.equal(assistant.turn, 1)
  assert.equal(assistant.step, 1)
  // 助手消息里的 tool-call 块不再单独成条：调用由 `tool/call` 事件代表。
  assert.equal(page.items.filter((item) => item.kind === 'tool-call').length, 1)
  // `source.replayState` 那种几十 KB 的上下文不该漏进正文。
  assert.ok(!JSON.stringify(page.items).includes('不该出现在时间线里'))

  const synthetic = page.items[7]!
  assert.equal(synthetic.synthetic, true, '标题模型那次调用也是 user/message，但要标出来')
})

test('readTranscript：工具名靠 callId 从调用那条补到结果那条，结果里的 sourceEventSeqs 变成一句说明', () => {
  const page = readTranscript(LINES)
  const call = page.items[4]!
  assert.equal(call.name, 'bash')
  assert.equal(call.args, '{"command":"ls"}')
  assert.equal(call.callId, 'call-1')

  const result = page.items[5]!
  assert.equal(result.name, 'bash', '结果自己不带工具名，要和调用对上')
  assert.equal(result.text, 'a.txt\nb.txt')
  assert.equal(result.isError, undefined)
  assert.equal(result.note, '挂在 seq 4')
})

test('readTranscript：控制事件给一句人话，不认识的原样压一行 JSON', () => {
  const page = readTranscript(LINES)
  assert.equal(page.items[0]!.text, '权限预设：danger-full-access')
  assert.equal(page.items[1]!.text, '第 1 轮开始')
  assert.equal(page.items[6]!.text, '标题（模型）：看看日志')
  assert.equal(page.items[8]!.text, '{"attempt":2}', '不认识的事件也要摆出来（完整优先）')
  assert.equal(page.items[9]!.text, '第 1 轮结束（completed）')
})

test('readTranscript：坏行如实记进 problems，不影响其余条目', () => {
  const page = readTranscript(LINES)
  assert.equal(page.problemCount, 1)
  assert.equal(page.problems.length, 1)
  assert.equal(page.problems[0]!.line, 11, '行号按原始文件算（header 是第 1 行）')
  assert.match(page.problems[0]!.error, /JSON/i)
  assert.equal(page.nextCursor, undefined, '读完了就没有下一次游标')
})

test('countTranscript：整份日志的计数只按行头扫，人发的与合成的分开数', () => {
  const counts = countTranscript(LINES)
  assert.equal(counts.events, 11, '数事件按行头走：坏行也占一条（它自己那条记在 problems 里）')
  assert.equal(counts.human, 1)
  assert.equal(counts.synthetic, 1)
  assert.equal(counts.assistant, 1)
  assert.equal(counts.toolCalls, 1)
  assert.equal(counts.toolResults, 2, '坏行那一条的 `"type":"tool/result"` 行头照样读得出来')
  assert.equal(counts.byType['turn/start'], 1)
  assert.equal(counts.byType['llm/retry'], 1)
})

test('readTranscript：分页按事件位走，不重不漏', () => {
  const first = readTranscript(LINES, { limit: 4 })
  assert.equal(first.cursor, 0)
  assert.deepEqual(first.items.map((item) => item.index), [0, 1, 2, 3])
  assert.equal(first.nextCursor, 4)

  const second = readTranscript(LINES, { from: 4, limit: 4 })
  assert.deepEqual(second.items.map((item) => item.index), [4, 5, 6, 7])
  assert.equal(second.nextCursor, 8)

  // 最后一页里那条坏行被跳过：条目少一条，但游标照样推到末尾，不会卡住。
  const third = readTranscript(LINES, { from: 8, limit: 4 })
  assert.deepEqual(third.items.map((item) => item.index), [8, 10])
  assert.equal(third.problemCount, 1)
  assert.equal(third.nextCursor, undefined)

  const all = [...first.items, ...second.items, ...third.items].map((item) => item.index)
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6, 7, 8, 10], '拼起来正好是除坏行外的全部事件')
  // 计数是整份日志的，不随分页变。
  assert.equal(second.counts.events, 11)
  assert.equal(second.totalEvents, 11)
})

test('readTranscript：单格文本按码点截断并记下原长度，emoji 不会被切一半', () => {
  const long = `开头${'🙂'.repeat(30)}结尾`
  const lines = [HEADER, ev(0, 'user/message', { content: [{ type: 'text', text: long }], source: { kind: 'user' } })]
  const page = readTranscript(lines, { maxChars: 10 })
  const item = page.items[0]!
  assert.equal(Array.from(item.text ?? '').length, 10)
  assert.equal(item.text?.includes('开头'), true)
  assert.deepEqual(item.truncated, [{ field: 'text', chars: Array.from(long).length }])
  assert.equal(page.truncatedChars, Array.from(long).length - 10)
})

test('readTranscript：整页文本总量到顶就收尾，把下一条留给下一页', () => {
  const long = 'x'.repeat(1000)
  const lines = [HEADER]
  for (let index = 0; index < 5; index += 1) {
    lines.push(ev(index, 'user/message', { content: [{ type: 'text', text: long }], source: { kind: 'user' } }))
  }
  const page = readTranscript(lines, { maxChars: 1000, maxTotalChars: 2500 })
  assert.equal(page.items.length, 3, '3 条就够 2500 字符了')
  assert.equal(page.nextCursor, 3)
  const rest = readTranscript(lines, { from: page.nextCursor, maxChars: 1000, maxTotalChars: 2500 })
  assert.deepEqual(rest.items.map((item) => item.index), [3, 4])
  assert.equal(rest.nextCursor, undefined)
})

test('readTranscript：上限参数被夹到合法范围，离谱的 limit 不会把整库倒进浏览器', () => {
  const first = readTranscript(LINES, { limit: 100000 })
  assert.equal(first.items.length, 10)
  const zero = readTranscript(LINES, { limit: 0, from: -5 })
  assert.equal(zero.cursor, 0)
  assert.equal(zero.items.length, 1, 'limit 夹到至少 1 条')
})

test('readTranscript：header 读不出来就抛（那是"这份日志读不出来"，不是"这条会话没内容"）', () => {
  assert.throws(() => readTranscript([]), /empty/)
  assert.throws(() => readTranscript(['{"type":"session"}']), /header/)
  assert.throws(() => readTranscript(['not json']), /header/)
})
