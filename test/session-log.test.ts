import assert from 'node:assert/strict'
import test from 'node:test'

import { decompress } from 'fzstd'

import { readSessionLog, relocateHeaderCwd } from '../src/session-log.ts'
import type { DecodeAll, SessionHeader } from '../src/types.ts'
import { encodeRawFrame } from '../src/zstd-frame.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

const FROM = 'C:\\Users\\hmy01\\Downloads'
const TO = 'C:\\Users\\hmy01\\Works\\Temp\\dsh-temp'

/** 造一条"一条事件一帧"的日志，形状与宿主落盘一致。 */
function makeLog(header: Partial<SessionHeader>, events: unknown[]): Buffer {
  const frames = [encodeRawFrame(JSON.stringify(header) + '\n')]
  for (const e of events) frames.push(encodeRawFrame(JSON.stringify(e) + '\n'))
  return Buffer.concat(frames)
}

const header: SessionHeader = {
  type: 'session',
  version: 4,
  id: 'session-abc',
  createdAt: 1,
  cwd: FROM,
  isSeeded: false,
  delegationDepth: 0,
}
const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: `我把东西放在 ${FROM} 下` }] } },
  { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
]

test('readSessionLog：解析 header 与正文', () => {
  const { header: h, lines } = readSessionLog(makeLog(header, events), decodeAll)
  assert.equal(h.id, 'session-abc')
  assert.equal(h.cwd, FROM)
  assert.equal(lines.length, 5)
})

test('relocateHeaderCwd：只改 cwd，其余逐字节不变', () => {
  const buf = makeLog(header, events)
  const before = decodeAll(buf).split('\n')
  const r = relocateHeaderCwd(buf, { from: FROM, to: TO, decodeAll })

  assert.equal(r.header.cwd, FROM)
  assert.equal(r.nextHeader.cwd, TO)
  assert.equal(r.events, 3)
  assert.equal(r.unchanged, undefined)

  const after = decodeAll(r.buffer).split('\n')
  assert.equal(after.length, before.length)
  // header 行是 JSON 文本，路径以 \\ 转义出现，因此按 JSON 转义形式比对
  assert.equal(after[0], before[0]?.replace(JSON.stringify(FROM), JSON.stringify(TO)))
  for (let i = 1; i < before.length; i++) {
    assert.equal(after[i], before[i], `第 ${i} 行（正文）必须逐字节不变——正文里的旧路径是历史事实`)
  }
  // 正文里的旧路径是**历史事实**（当时确实写在旧目录），必须保留。
  const escapedFrom = JSON.stringify(FROM).slice(1, -1)
  assert.ok(after.join('\n').includes(escapedFrom), '正文中的旧路径应保留')
  assert.equal(after.find((l) => l.includes('user/message'))?.includes(escapedFrom), true)
})

test('relocateHeaderCwd：尾部帧字节原样保留（可审计）', () => {
  const buf = makeLog(header, events)
  const r = relocateHeaderCwd(buf, { from: FROM, to: TO, decodeAll })
  const newTail = decodeAll(r.buffer).split('\n').slice(1).join('\n')
  const oldTail = decodeAll(buf).split('\n').slice(1).join('\n')
  assert.equal(newTail, oldTail)
})

test('relocateHeaderCwd：cwd 已是目标值时幂等且不改写', () => {
  const already: SessionHeader = { ...header, cwd: TO }
  const buf = makeLog(already, events)
  const r = relocateHeaderCwd(buf, { from: FROM, to: TO, decodeAll })
  assert.equal(r.unchanged, true)
  assert.deepEqual(r.buffer, buf)
  assert.equal(r.events, 3)
})

test('relocateHeaderCwd：from 不匹配时拒绝（防误改）', () => {
  const buf = makeLog(header, events)
  assert.throws(() => relocateHeaderCwd(buf, { from: 'C:\\other', to: TO, decodeAll }), /expected C:\\other/)
})

test('relocateHeaderCwd：header 无 cwd 时拒绝', () => {
  const noCwd: Partial<SessionHeader> = { ...header }
  delete noCwd.cwd
  assert.throws(() => relocateHeaderCwd(makeLog(noCwd, events), { from: undefined, to: TO, decodeAll }), /no cwd/)
})

test('relocateHeaderCwd：首行不是 header 时拒绝', () => {
  const bad = Buffer.concat([encodeRawFrame('{"type":"turn/start"}\n'), encodeRawFrame('{}\n')])
  assert.throws(() => relocateHeaderCwd(bad, { from: FROM, to: TO, decodeAll }), /not a session header/)
})

test('relocateHeaderCwd：首帧含多行时拒绝（假定首帧只承载 header）', () => {
  const twoLines = Buffer.concat([
    encodeRawFrame(JSON.stringify(header) + '\n' + '{"type":"turn/start"}\n'),
    encodeRawFrame('{}\n'),
  ])
  assert.throws(() => relocateHeaderCwd(twoLines, { from: FROM, to: TO, decodeAll }), /expected exactly the header/)
})

test('relocateHeaderCwd：保留 header 的可选字段与顺序', () => {
  const rich: SessionHeader = {
    type: 'session',
    version: 4,
    id: 'session-abc',
    createdAt: 1,
    cwd: FROM,
    parentSession: 'session-p',
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: 2,
    agentPreset: 'standard',
  }
  const r = relocateHeaderCwd(makeLog(rich, events), { from: FROM, to: TO, decodeAll })
  assert.equal(r.nextHeader.parentSession, 'session-p')
  assert.equal(r.nextHeader.origin, 'subagent')
  assert.equal(r.nextHeader.delegationDepth, 2)
  assert.equal(r.nextHeader.agentPreset, 'standard')
  assert.equal(Object.keys(r.nextHeader).length, Object.keys(rich).length)
})
