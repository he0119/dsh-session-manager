import assert from 'node:assert/strict'
import test from 'node:test'

import { decompress } from 'fzstd'

import {
  branchSessionLog,
  readSessionLog,
  relocateHeaderCwd,
  relocateHeaderCwdShallow,
  relocateSessionPaths,
  relocateSessionPathsText,
} from '../src/session-log.ts'
import type { DecodeAll, SessionHeader } from '../src/types.ts'
import { encodeRawFrame, splitFirstFrameFast } from '../src/zstd-frame.ts'

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

test('relocateHeaderCwdShallow：产出与 relocateHeaderCwd 逐字节一致', () => {
  const buf = makeLog(header, events)
  const strict = relocateHeaderCwd(buf, { from: FROM, to: TO, decodeAll })
  const shallow = relocateHeaderCwdShallow(buf, { from: FROM, to: TO, decodeAll })
  assert.deepEqual(shallow.buffer, strict.buffer)
  assert.equal(shallow.boundary, strict.boundary)
  assert.equal(shallow.nextHeader.cwd, TO)
  assert.equal(shallow.header.cwd, FROM)
})

test('relocateHeaderCwdShallow：首帧含多行时与严格实现一样拒绝', () => {
  const twoLines = Buffer.concat([
    encodeRawFrame(JSON.stringify(header) + '\n' + '{"type":"turn/start"}\n'),
    encodeRawFrame('{}\n'),
  ])
  assert.throws(() => relocateHeaderCwdShallow(twoLines, { from: FROM, to: TO, decodeAll }), /expected exactly the header/)
})

test('relocateHeaderCwdShallow：cwd 已是目标值时原样返回', () => {
  const buf = makeLog(header, events)
  const r = relocateHeaderCwdShallow(buf, { from: FROM, to: FROM, decodeAll })
  assert.equal(r.unchanged, true)
  assert.deepEqual(r.buffer, buf)
  assert.equal(r.boundary, 0)
})

test('relocateHeaderCwdShallow：header 无 cwd 时拒绝', () => {
  const { cwd: _omitted, ...noCwd } = header
  assert.throws(
    () => relocateHeaderCwdShallow(makeLog(noCwd, events), { from: undefined, to: TO, decodeAll }),
    /no cwd/,
  )
})

test('relocateHeaderCwdShallow：尾部有坏帧时照样产出（严格实现会因整篇解码失败而拒绝）', () => {
  // 这是两者有意保留的差别：严格实现要保证"写出去的字节整体可解码"，浅改写只读、不写。
  const good = makeLog(header, events)
  const broken = Buffer.concat([good, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff, 0xff, 0xff])])
  assert.throws(() => relocateHeaderCwd(broken, { from: FROM, to: TO, decodeAll }))
  const shallow = relocateHeaderCwdShallow(broken, { from: FROM, to: TO, decodeAll })
  // 首帧之外（含那段坏字节）逐字节原样保留：新首帧长度与旧的不同，所以按"尾巴长度"对齐。
  const split = splitFirstFrameFast(broken, decodeAll)
  assert.ok(split)
  const rest = split.rest
  assert.deepEqual(shallow.buffer.subarray(shallow.buffer.length - rest.length), rest)
  const rewrittenHeader = JSON.parse(
    decodeAll(shallow.buffer.subarray(0, shallow.buffer.length - rest.length)).trim(),
  ) as SessionHeader
  assert.equal(rewrittenHeader.cwd, TO)
  assert.equal(rewrittenHeader.id, header.id)
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


// ── 落成另一条会话：换 id、插一条标记标题 ────────────────────────────────────────

const branchEvents = [
  { type: 'session/title', seq: 0, time: '2026-10-12T04:00:00.000Z', data: { title: '原标题', messageSeqs: [], source: { kind: 'user' } } },
  { type: 'user/message', seq: 1, time: '2026-10-12T04:01:00.000Z', data: { content: [{ type: 'text', text: '正文一条' }] } },
  { type: 'session/title', seq: 2, time: '2026-10-12T04:02:00.000Z', data: { title: '改过名', messageSeqs: [], source: { kind: 'user' } } },
  { type: 'turn/end', seq: 3, time: '2026-10-12T20:05:00.000Z', data: { turn: 1 } },
]
const MARKED = '改过名 · 来自 robot-test 2026-10-12 20:05'

function titlesOf(text: string): string[] {
  const titles: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const parsed = JSON.parse(line) as { type?: unknown; data?: { title?: unknown } }
      if (parsed.type === 'session/title' && typeof parsed.data?.title === 'string') titles.push(parsed.data.title)
    } catch {
      /* 不是事件行 */
    }
  }
  return titles
}

test('branchSessionLog（zstd）：换 id、最后一条标题带来源、正文一字不动', () => {
  const out = branchSessionLog(makeLog(header, branchEvents), 'zstd', {
    newId: 'session-branched',
    machine: 'robot-test',
    time: '2026-10-12T21:00:00.000Z',
    decodeAll,
  })
  const { header: h, lines } = readSessionLog(out, decodeAll)
  assert.equal(h.id, 'session-branched', 'header 的 id 换成了新会话的')
  // 只改最后一条标题的 data.title；前面的标题与正文原样留着。
  assert.deepEqual(titlesOf(lines.join('\n')), ['原标题', MARKED], '最后的标题带来源，前面的原标题还在')
  assert.match(lines.join('\n'), /正文一条/, '正文一字不动')
  const rows = lines.filter((line) => line !== '').map((line) => JSON.parse(line) as { seq?: number })
  assert.deepEqual(rows.slice(1).map((row) => row.seq), [0, 1, 2, 3], 'seq 仍然与位置一一对应')
  const marker = JSON.parse(lines.find((line) => line.includes(MARKED)) ?? '{}') as { seq?: number; time?: string }
  assert.equal(marker.seq, 2, '标记仍是原来那条标题的位置（seq=2）')
  assert.equal(marker.time, '2026-10-12T04:02:00.000Z', '标题事件的时刻不动')
})

test('branchSessionLog（明文）：同一套语义', () => {
  const text = [JSON.stringify(header), ...branchEvents.map((e) => JSON.stringify(e))].join('\n') + '\n'
  const out = branchSessionLog(Buffer.from(text, 'utf8'), null, {
    newId: 'session-branched',
    machine: 'robot-test',
    time: '2026-10-12T21:00:00.000Z',
    decodeAll,
  })
  const lines = out.toString('utf8').split('\n')
  assert.equal((JSON.parse(lines[0] as string) as { id: string }).id, 'session-branched')
  assert.deepEqual(titlesOf(out.toString('utf8')), ['原标题', MARKED], '明文同义：只改最后一条标题')
})

test('branchSessionLog：没有原标题时标记只留来源那半句', () => {
  const only = { ...(branchEvents[1] as Record<string, unknown>), seq: 0 }
  const out = branchSessionLog(makeLog(header, [only]), 'zstd', {
    newId: 'session-branched',
    machine: 'robot-test',
    time: '2026-10-12T21:00:00.000Z',
    decodeAll,
  })
  const lines = readSessionLog(out, decodeAll).lines
  assert.deepEqual(titlesOf(lines.join('\n')), ['来自 robot-test 2026-10-12 04:01'])
  const marker = JSON.parse(lines.find((line) => line.includes('来自 robot-test')) ?? '{}') as {
    time?: unknown
    data?: { messageSeqs?: unknown; source?: unknown }
  }
  assert.equal(typeof marker.time, 'number', '没有原标题时标记的 time 是 epoch 毫秒，不是 ISO 字符串')
  assert.equal(marker.time, Date.parse('2026-10-12T21:00:00.000Z'))
  assert.deepEqual(marker.data?.messageSeqs, [], 'v4 的标题事件必须有 messageSeqs 数组')
  assert.deepEqual(marker.data?.source, { kind: 'user' }, '空 messageSeqs 的标题 source 是 user')
})

// ---- 跟着会话根一起搬的路径（working-directory/change 的 cwd） ----
//
// 这一组钉的是"为什么能修好打不开的会话"：别的系统的写法跟着会话根翻译成本机路径，其余字节不动。

const WIN_ROOT = 'C:\\Users\\me\\Work\\repo'
const POSIX_ROOT = '/home/uy_sun/dev/repo'

/** 造一条"一条事件一帧"的日志，并留下每一帧的原始字节（用来核"没改的帧逐字节不变"）。 */
function makeFramesLog(header: Partial<SessionHeader>, lines: string[]): { buffer: Buffer; frames: Buffer[] } {
  const frames = [encodeRawFrame(JSON.stringify(header) + '\n'), ...lines.map((line) => encodeRawFrame(line + '\n'))]
  return { buffer: Buffer.concat(frames), frames }
}

const workingDirEvents = [
  JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
  JSON.stringify({
    type: 'working-directory/change',
    seq: 1,
    time: 2,
    data: { cwd: `${WIN_ROOT}\\.agents\\worktrees\\fix\\x` },
  }),
  JSON.stringify({ type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: `本来在 ${WIN_ROOT}` }] } }),
  JSON.stringify({ type: 'working-directory/change', seq: 3, time: 4, data: { cwd: WIN_ROOT } }),
  JSON.stringify({ type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } }),
]

test('relocateSessionPaths：working-directory/change 的 cwd 跟着会话根搬（含工作树子路径）', () => {
  const { buffer, frames } = makeFramesLog({ ...header, cwd: WIN_ROOT }, workingDirEvents)
  const r = relocateSessionPaths(buffer, { to: POSIX_ROOT, decodeAll })

  assert.equal(r.unchanged, undefined)
  assert.equal(r.nextHeader.cwd, POSIX_ROOT)
  assert.equal(r.rewritten, 2, '两条 working-directory/change 各算一次')
  assert.deepEqual(r.mappings, [
    { from: `${WIN_ROOT}\\.agents\\worktrees\\fix\\x`, to: '/home/uy_sun/dev/repo/.agents/worktrees/fix/x' },
    { from: WIN_ROOT, to: POSIX_ROOT },
  ])
  assert.deepEqual(r.unmapped, [])

  const lines = decodeAll(r.buffer).split('\n')
  assert.equal(lines[0] && JSON.parse(lines[0]).cwd, POSIX_ROOT)
  const workingDirs = lines
    .filter((line) => line.includes('working-directory/change'))
    .map((line) => JSON.parse(line).data.cwd)
  assert.deepEqual(workingDirs, ['/home/uy_sun/dev/repo/.agents/worktrees/fix/x', POSIX_ROOT])
  // 事件条数与顺序都没变（改动只落在值上）
  assert.equal(r.events, workingDirEvents.length)
  // 没改的帧逐字节原样：turn/start、user/message、turn/end 三帧的原始字节在产出里找得到
  for (const index of [1, 3, 5]) {
    assert.ok(r.buffer.includes(frames[index] as Buffer), `第 ${index} 帧没有被改，字节必须原样保留`)
  }
  // 要重压的只有三帧：header 一帧 + 两条 working-directory/change 各一帧。
  assert.equal(r.frames, 3)
})

test('relocateSessionPaths：正文里的旧路径是历史事实，一个字节都不动', () => {
  const { buffer } = makeFramesLog({ ...header, cwd: WIN_ROOT }, workingDirEvents)
  const r = relocateSessionPaths(buffer, { to: POSIX_ROOT, decodeAll })
  const messageLine = decodeAll(r.buffer)
    .split('\n')
    .find((line) => line.includes('user/message'))
  assert.ok(messageLine?.includes(JSON.stringify(WIN_ROOT).slice(1, -1)), '用户消息正文里的旧路径必须原样保留')
})

test('relocateSessionPaths：本机就合法的路径不动（那属于历史事实）', () => {
  // 同一台机器上换目录（/home/me/old → /home/me/new）：旧路径在本机照样是绝对路径，宿主读得出来，
  // 所以它是历史事实，跟着搬的只有"本机不认的"那些（另一台机器/另一种系统的写法）。
  const events = [
    JSON.stringify({ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: '/home/me/old/.agents/x' } }),
    JSON.stringify({ type: 'working-directory/change', seq: 1, time: 2, data: { cwd: '/home/me/old' } }),
  ]
  const { buffer } = makeFramesLog({ ...header, cwd: '/home/me/old' }, events)
  const r = relocateSessionPaths(buffer, { to: '/home/me/new', decodeAll })
  assert.equal(r.rewritten, 0, '本机合法的路径一条都不该改')
  assert.equal(r.nextHeader.cwd, '/home/me/new', 'header 照旧换成本机路径')
  assert.ok(decodeAll(r.buffer).includes('"/home/me/old/.agents/x"'), '事件里的旧路径原样保留')
})

test('relocateSessionPaths：foreignOnly:false 时连本机合法的路径也跟着搬（留给明确的调用方）', () => {
  const events = [
    JSON.stringify({ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: '/home/me/old/.agents/x' } }),
  ]
  const { buffer } = makeFramesLog({ ...header, cwd: '/home/me/old' }, events)
  const r = relocateSessionPaths(buffer, { to: '/home/me/new', decodeAll, foreignOnly: false })
  assert.equal(r.rewritten, 1)
  assert.ok(decodeAll(r.buffer).includes('"/home/me/new/.agents/x"'))
})

test('relocateSessionPaths：映射不上的值原样保留，并记进 unmapped', () => {
  const events = [
    JSON.stringify({ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: 'D:\\elsewhere' } }),
  ]
  const { buffer } = makeFramesLog({ ...header, cwd: WIN_ROOT }, events)
  const r = relocateSessionPaths(buffer, { to: POSIX_ROOT, decodeAll })
  assert.deepEqual(r.unmapped, ['D:\\elsewhere'])
  assert.equal(r.rewritten, 0)
  assert.ok(decodeAll(r.buffer).includes('D:\\\\elsewhere'), '映射不上的值原样保留')
  assert.equal(r.nextHeader.cwd, POSIX_ROOT, 'header 照旧换成目标根')
})

test('relocateSessionPaths：改完再改一遍是幂等的（unchanged）', () => {
  const { buffer } = makeFramesLog({ ...header, cwd: WIN_ROOT }, workingDirEvents)
  const once = relocateSessionPaths(buffer, { to: POSIX_ROOT, decodeAll })
  const twice = relocateSessionPaths(once.buffer, { to: POSIX_ROOT, decodeAll })
  assert.equal(twice.unchanged, true)
  assert.deepEqual(twice.buffer, once.buffer)
})

test('relocateSessionPathsText：明文（v0）日志走同一条判据', () => {
  const text = [JSON.stringify({ ...header, cwd: WIN_ROOT }), ...workingDirEvents].join('\n') + '\n'
  const r = relocateSessionPathsText(text, { to: POSIX_ROOT })
  assert.equal(r.nextHeader.cwd, POSIX_ROOT)
  assert.equal(r.rewritten, 2)
  assert.ok(r.text.includes(`"cwd":"/home/uy_sun/dev/repo"`))
})

test('relocateSessionPathsText：from 与 header 都对不上时当场抛（防误改）', () => {
  const text = [JSON.stringify({ ...header, cwd: '/somewhere/else' }), ...workingDirEvents].join('\n') + '\n'
  assert.throws(() => relocateSessionPathsText(text, { from: WIN_ROOT, to: POSIX_ROOT }), /expected/)
})

test('relocateSessionPathsText：修已落地的日志（header 已是本机路径）只要给 from 就能改事件', () => {
  const text = [
    JSON.stringify({ ...header, cwd: POSIX_ROOT }),
    JSON.stringify({ type: 'working-directory/change', seq: 0, time: 1, data: { cwd: `${WIN_ROOT}\\.agents\\x` } }),
  ].join('\n') + '\n'
  const r = relocateSessionPathsText(text, { from: WIN_ROOT, to: POSIX_ROOT })
  assert.equal(r.rewritten, 1)
  assert.ok(r.text.includes('"/home/uy_sun/dev/repo/.agents/x"'))
})
