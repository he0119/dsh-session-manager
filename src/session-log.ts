// src/session-log.ts — 单个会话日志文件的读取与「保结构」cwd 改写。
//
// 核心不变式：只改写首行 header 的 cwd 值，其余字节在语义与字节两个层面都不变。
// 会话正文里出现的旧路径属于**历史事实**（当时确实写在旧目录），保持原样。
import type { CompressFrame, DecodeAll, SessionHeader } from './types.ts'
import { foldTitle } from './session-title.ts'
import { encodeRawFrame, splitFirstFrame, splitFirstFrameFast, ZSTD_MAGIC } from './zstd-frame.ts'

/** 首个 header 行里的 cwd 值（JSON 字符串字面量，含引号）。 */
const CWD_FIELD = /"cwd":"(?:[^"\\]|\\.)*"/

/** 读出的日志内容。 */
export interface SessionLog {
  text: string
  lines: string[]
  header: SessionHeader
}

/**
 * 读出一个会话日志文件。
 * @param buf 日志字节。
 * @param decodeAll 多帧感知解码器。
 * @returns 正文、按行拆分的结果与 header。
 * @throws 首行不是合法 session header 时抛错。
 */
export function readSessionLog(buf: Buffer, decodeAll: DecodeAll): SessionLog {
  const text = decodeAll(buf)
  const lines = text.split('\n')
  const firstLine = lines[0]
  if (!firstLine || !firstLine.includes('"type":"session"')) {
    throw new Error('session log first line is not a session header')
  }
  let header: SessionHeader
  try {
    header = JSON.parse(firstLine) as SessionHeader
  } catch (error) {
    throw new Error(
      `session log header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { text, lines, header }
}

/** 文本形态 cwd 改写的结果。 */
export interface RelocateTextResult {
  /** 改写后的完整正文（`unchanged` 为 true 时与原样相同）。 */
  text: string
  header: SessionHeader
  nextHeader: SessionHeader
  /** cwd 已是目标值、未做任何改写。 */
  unchanged?: boolean
}

/**
 * 只替换正文首行 header 里的 cwd 值（明文形态）。
 *
 * 与帧形态的 [`relocateHeaderCwd`] 共用同一套不变式与同一份 `CWD_FIELD`：改完之后除 cwd 外
 * header 一个字段都不能变，cwd 必须真的变成目标值。无法切帧的日志（v0 的明文 `session.jsonl`）
 * 与导入流程里已经解码好的正文都走这里。
 *
 * @throws 首行不是合法 header、没有 cwd 字段、或校验不过时抛错（不产出半成品）。
 */
export function relocateHeaderCwdText(text: string, to: string, from?: string): RelocateTextResult {
  const lines = text.split('\n')
  const firstLine = lines[0]
  if (!firstLine || !firstLine.includes('"type":"session"')) {
    throw new Error('session log first line is not a session header')
  }
  let header: SessionHeader
  try {
    header = JSON.parse(firstLine) as SessionHeader
  } catch (error) {
    throw new Error(
      `session log header is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (header.cwd === to) return { text, header, nextHeader: header, unchanged: true }
  if (from !== undefined && header.cwd !== from) {
    throw new Error(`session ${header.id}: header cwd is ${header.cwd}, expected ${from}`)
  }
  if (header.cwd === undefined) {
    throw new Error(`session ${header.id}: header has no cwd to rewrite`)
  }
  if (!CWD_FIELD.test(firstLine)) {
    throw new Error(`session ${header.id}: header line has no cwd field`)
  }

  lines[0] = firstLine.replace(CWD_FIELD, '"cwd":' + JSON.stringify(to))

  // 校验：除 cwd 外，header 不得发生任何变化（防止正则误伤）。
  const nextHeader = JSON.parse(lines[0] ?? '{}') as SessionHeader
  const a: Partial<SessionHeader> = { ...header }
  const b: Partial<SessionHeader> = { ...nextHeader }
  delete a.cwd
  delete b.cwd
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`session ${header.id}: header changed beyond cwd`)
  }
  if (nextHeader.cwd !== to) throw new Error(`session ${header.id}: cwd rewrite did not take effect`)

  return { text: lines.join('\n'), header, nextHeader }
}

/** cwd 改写的结果。 */
export interface RelocateResult {
  /** 新日志字节（`unchanged` 为 true 时与原样相同）。 */
  buffer: Buffer
  /** 原 header。 */
  header: SessionHeader
  /** 改写后的 header。 */
  nextHeader: SessionHeader
  /** 首帧结束的字节偏移（`unchanged` 时为 0）。 */
  boundary: number
  /** 新首帧的字节数（`unchanged` 时为 0）。 */
  firstFrameBytes: number
  /** 正文事件行数。 */
  events: number
  /** cwd 已是目标值、未做任何改写。 */
  unchanged?: boolean
}

/** `relocateHeaderCwd` 的选项。 */
export interface RelocateOptions {
  /** 期望的当前 cwd；不符即拒绝，避免误改。 */
  from?: string
  /** 目标 cwd。 */
  to: string
  decodeAll: DecodeAll
  /** 首帧压缩器；缺省用手写 raw-block 帧（无需依赖）。 */
  compressFrame?: CompressFrame
}

/**
 * 改写 header 的 cwd，产出新日志字节。
 *
 * 只重写第一个 frame；其余 frame 原样拼接，因此尾部与原文逐字节一致。
 *
 * @throws 校验失败时抛错（不产出半成品）。
 */
export function relocateHeaderCwd(buf: Buffer, options: RelocateOptions): RelocateResult {
  const { from, to, decodeAll, compressFrame = encodeRawFrame } = options
  const { lines, header } = readSessionLog(buf, decodeAll)
  // 事件数 = 首行之外的非空行（日志以 '\n' 结尾，直接 lines.length-1 会多算一个空串）
  const events = lines.slice(1).filter((line) => line !== '').length

  if (header.cwd === to) {
    return { buffer: buf, header, nextHeader: header, boundary: 0, firstFrameBytes: 0, events, unchanged: true }
  }
  if (from !== undefined && header.cwd !== from) {
    throw new Error(`session ${header.id}: header cwd is ${header.cwd}, expected ${from}`)
  }
  if (header.cwd === undefined) {
    throw new Error(`session ${header.id}: header has no cwd to rewrite`)
  }

  const split = splitFirstFrame(buf, decodeAll)
  if (!split) throw new Error(`session ${header.id}: could not locate a consistent first-frame boundary`)
  if (!split.first.includes('\n')) {
    throw new Error(`session ${header.id}: first frame does not contain a complete header line`)
  }

  const firstLines = split.first.split('\n')
  if (firstLines.length - 1 !== 1) {
    throw new Error(
      `session ${header.id}: first frame carries ${firstLines.length - 1} lines, expected exactly the header`,
    )
  }

  // 首帧正文交给文本形态的改写：同一套不变式（只有 cwd 变、cwd 真的变了）只留一份实现。
  const firstFrame = relocateHeaderCwdText(split.first, to, from)

  const compressed = compressFrame(firstFrame.text)
  const buffer = Buffer.concat([compressed, split.rest])

  // 自校验：整体解码必须等于「只换掉首行」的期望文本。
  const expected = [firstFrame.text.split('\n')[0], ...lines.slice(1)].join('\n')
  if (decodeAll(buffer) !== expected) {
    throw new Error(`session ${header.id}: round-trip mismatch after rewrite`)
  }

  return {
    buffer,
    header,
    nextHeader: firstFrame.nextHeader,
    boundary: split.boundary,
    firstFrameBytes: compressed.length,
    events,
  }
}

/** 浅改写（只解首帧）的结果。 */
export interface RelocateShallowResult {
  /** 新日志字节（`unchanged` 为 true 时与原样相同）。 */
  buffer: Buffer
  /** 原 header。 */
  header: SessionHeader
  /** 改写后的 header。 */
  nextHeader: SessionHeader
  /** 首帧结束的字节偏移（`unchanged` 时为 0）。 */
  boundary: number
  /** cwd 已是目标值、未做任何改写。 */
  unchanged?: boolean
}

/**
 * 只改 header 的 cwd，且**只解首帧**：给"读一读就算"的用途（内容指纹）用。
 *
 * 与 [`relocateHeaderCwd`] 同一套不变式——同一份 `CWD_FIELD`、同样要求首帧只承载 header 一行、
 * 同样只在 cwd 与目标不同时才产出新字节——差别只有两处，都是为了不白花钱：
 *
 *   1. 不做"改写结果整体可解码"的自校验：那份校验保护的是**写出去的字节**，而这条路一个字节都不写；
 *   2. 不整篇解码：首帧之外的内容既不解、也不参与改写，原样拼回去。
 *
 * 于是同一条会话的产出与 [`relocateHeaderCwd`] 逐字节相同（`test/session-log.test.ts` 逐份比对），
 * 但 6 MB 的日志从"解四遍"降到"解首帧一遍"。
 *
 * @throws 首帧切不出来、首帧不止一行、header 无 cwd、或 cwd 之外发生变化时抛错（不产出半成品）。
 */
export function relocateHeaderCwdShallow(buf: Buffer, options: RelocateOptions): RelocateShallowResult {
  const { from, to, decodeAll, compressFrame = encodeRawFrame } = options
  const split = splitFirstFrameFast(buf, decodeAll)
  if (!split) throw new Error('could not locate a first-frame boundary')

  const firstLines = split.first.split('\n')
  if (firstLines.length - 1 !== 1) {
    throw new Error(`first frame carries ${firstLines.length - 1} lines, expected exactly the header`)
  }

  const firstFrame = relocateHeaderCwdText(split.first, to, from)
  if (firstFrame.unchanged) {
    return { buffer: buf, header: firstFrame.header, nextHeader: firstFrame.nextHeader, boundary: 0, unchanged: true }
  }

  return {
    buffer: Buffer.concat([compressFrame(firstFrame.text), split.rest]),
    header: firstFrame.header,
    nextHeader: firstFrame.nextHeader,
    boundary: split.boundary,
  }
}


/**
 * 把一份日志落成“另一条会话”（同步裁决里落选那一份的去处）：换 header 的 `id`，并给最新一条标题
 * 加上来源标记，如「原标题 · 来自 robot-test 2026-10-12 20:05」。
 *
 * 为什么是“改最后一条标题”而不是“插一条新标题”：v4 日志要求事件 `seq` 与它在正文里的位置一样密
 * （宿主 `event.seq !== index` 即拒绝）。插在最后一条标题之后、后续事件之前，标记的 `seq` 会比后面
 * 那些大，整份日志立刻不合法；而改最后一条标题只动它的 `data.title`，`seq` 与位置都不变，原文的标题
 * 文字仍作为前缀保留。只重压那一帧，其余帧逐字节原样拼回。没有标题时标记追加到末尾（末尾之后没有
 * 事件，`seq` 仍连续）；小日志的标题读取预算够得着，大日志本来也没有标题可读。
 *
 * 顺序（zstd）：首帧解出 header 换 `id`、用 `compressFrame`（缺省手写 raw-block 帧）写回；含最后一条
 * 标题的那一帧用新标题重压，其余帧原样拼接。明文那一半同义（没有帧，逐行改，自校验也走明文）。
 *
 * @throws 首帧没有完整 header、事件 `seq` 不连续、或自校验不过时抛错（不产出半成品）。
 */
export function branchSessionLog(
  buf: Buffer,
  compression: string | null,
  /** `machine` 缺席 = 只换 id 不写标记（多代次里只有最新一代带标记标题）。 */
  options: { newId: string; machine?: string; time?: string; decodeAll: DecodeAll; compressFrame?: CompressFrame },
): Buffer {
  const { newId, decodeAll } = options
  const machine = options.machine
  const now = options.time ?? new Date().toISOString()
  const compressFrame = options.compressFrame ?? encodeRawFrame

  if (compression === 'zstd') {
    const frames = splitFrames(buf)
    if (frames.length === 0) throw new Error('branchSessionLog: no frames to rewrite')
    const texts: string[] = []
    for (const [index, frame] of frames.entries()) {
      try {
        texts.push(decodeAll(buf.subarray(frame.start, frame.end)))
      } catch (error) {
        throw new Error(`branchSessionLog: frame ${index} does not decode: ${String(error)}`)
      }
    }
    const last = lastEventInFrames(texts)
    const title = lastTitleInFrames(texts)
    if (machine === undefined) {
      const out = Buffer.concat([
        compressFrame(rewriteHeaderId(texts[0] as string, newId)),
        ...frames.slice(1).map((frame) => buf.subarray(frame.start, frame.end)),
      ])
      assertBranched(decodeAll(out), newId, undefined)
      return out
    }
    if (title === undefined) {
      const marked = markedTitle('', machine, last ?? { seq: -1, time: now })
      const marker = markerLine(marked, (last?.seq ?? -1) + 1, now)
      const out = Buffer.concat([
        compressFrame(rewriteHeaderId(texts[0] as string, newId)),
        ...frames.slice(1).map((frame) => buf.subarray(frame.start, frame.end)),
        compressFrame(marker),
      ])
      assertBranched(decodeAll(out), newId, marked)
      return out
    }
    const marked = markedTitle(title.title, machine, last ?? title)
    const replaced = markTitleInFrame(texts[title.frame] as string, title.line, marked)
    const out: Buffer[] = []
    for (const [index, frame] of frames.entries()) {
      if (index === title.frame) {
        out.push(compressFrame(index === 0 ? rewriteHeaderId(replaced, newId) : replaced))
      } else if (index === 0) {
        out.push(compressFrame(rewriteHeaderId(texts[0] as string, newId)))
      } else {
        out.push(buf.subarray(frame.start, frame.end))
      }
    }
    const buffer = Buffer.concat(out)
    assertBranched(decodeAll(buffer), newId, marked)
    return buffer
  }

  const text = buf.toString('utf8')
  const trailingNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (trailingNewline) lines.pop()
  if (machine === undefined) {
    lines[0] = rewriteHeaderId(lines[0] ?? '', newId)
    const out = Buffer.from(lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8')
    assertBranched(out.toString('utf8'), newId, undefined)
    return out
  }
  const last = lastEventInLines(lines)
  const title = lastTitleInLines(lines)
  let marked: string
  if (title === undefined) {
    marked = markedTitle('', machine, last ?? { seq: -1, time: now })
    lines.push(markerLine(marked, (last?.seq ?? -1) + 1, now).replace(/\n$/, ''))
  } else {
    marked = markedTitle(title.title, machine, last ?? title)
    lines[title.line] = markTitleLine(lines[title.line] as string, marked)
  }
  lines[0] = rewriteHeaderId(lines[0] ?? '', newId)
  const out = Buffer.from(lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8')
  assertBranched(out.toString('utf8'), newId, marked)
  return out
}

/** 一份帧文本里最后一条带 `seq` 的事件（header 不算）。 */
function lastEventInFrames(texts: readonly string[]): { seq: number; time: string } | undefined {
  for (let index = texts.length - 1; index >= 1; index -= 1) {
    const found = lastEventInLines((texts[index] as string).split('\n'))
    if (found !== undefined) return found
  }
  return undefined
}

/** 一组行里最后一条带 `seq` 的事件（header 不算）。 */
function lastEventInLines(lines: readonly string[]): { seq: number; time: string } | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined || line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = parsed as { type?: unknown; seq?: unknown; time?: unknown }
    if (event.type === 'session' || typeof event.seq !== 'number') continue
    return { seq: event.seq, time: typeof event.time === 'string' ? event.time : new Date().toISOString() }
  }
  return undefined
}

/** 最后一条标题所在的帧与行。 */
function lastTitleInFrames(texts: readonly string[]): { frame: number; line: number; title: string; seq: number; time: string } | undefined {
  let found: { frame: number; line: number; title: string; seq: number; time: string } | undefined
  for (const [frame, text] of texts.entries()) {
    const lines = text.split('\n')
    for (const [line, value] of lines.entries()) {
      const title = foldTitle(value)
      if (title === undefined) continue
      const parsed = JSON.parse(value) as { seq?: unknown; time?: unknown }
      found = {
        frame,
        line,
        title,
        seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
        time: typeof parsed.time === 'string' ? parsed.time : new Date().toISOString(),
      }
    }
  }
  return found
}

/** 最后一条标题所在的行。 */
function lastTitleInLines(lines: readonly string[]): { line: number; title: string; seq: number; time: string } | undefined {
  let found: { line: number; title: string; seq: number; time: string } | undefined
  for (const [line, value] of lines.entries()) {
    const title = foldTitle(value)
    if (title === undefined) continue
    const parsed = JSON.parse(value) as { seq?: unknown; time?: unknown }
    found = {
      line,
      title,
      seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
      time: typeof parsed.time === 'string' ? parsed.time : new Date().toISOString(),
    }
  }
  return found
}

/** 只改一帧文本里指定那一行的标题，其余行逐字节不动。 */
function markTitleInFrame(text: string, line: number, marked: string): string {
  const lines = text.split('\n')
  lines[line] = markTitleLine(lines[line] as string, marked)
  return lines.join('\n')
}

/** 只改一行标题事件的 `data.title`，其余字段与转义保持原样。 */
function markTitleLine(line: string, marked: string): string {
  const parsed = JSON.parse(line) as { type?: unknown; data?: { title?: unknown } }
  if (parsed.type !== 'session/title' || typeof parsed.data?.title !== 'string') {
    throw new Error('branchSessionLog: marker target is not a session/title line')
  }
  parsed.data.title = marked
  return JSON.stringify(parsed)
}

/** 改 header 那一行的 `id`（只此一处；其余字段一个字节都不动）。 */
function rewriteHeaderId(headerLine: string, newId: string): string {
  const parsed: unknown = JSON.parse(headerLine)
  const header = parsed as Record<string, unknown>
  if (typeof header['id'] !== 'string') throw new Error('branchSessionLog: header has no id')
  header['id'] = newId
  // 行尾的 '\n' 是这一行与下一帧的分界，丢了就会黏成一行（自校验会当场炸）。
  return JSON.stringify(header) + (headerLine.endsWith('\n') ? '\n' : '')
}

/** 标记标题的文案：「原标题 · 来自 <机器> <时刻>」——原标题缺席时只留后半句。 */
function markedTitle(original: string, machine: string, tail: { time: string }): string {
  const when = tail.time.slice(0, 16).replace('T', ' ')
  return original === '' ? `来自 ${machine} ${when}` : `${original} · 来自 ${machine} ${when}`
}

/** 一条独立的标记事件行（无原标题时追加到末尾）。 */
function markerLine(title: string, seq: number, now: string): string {
  // 事件 time 是 epoch 毫秒（宿主自己的日志就是数字）；这里不能写 ISO 字符串，否则整条事件
  // 进不了 committed 前缀，读日志时同样会报成 torn JSONL。
  const time = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now()
  return JSON.stringify({
    type: 'session/title',
    seq,
    time,
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }) + '\n'
}

/**
 * 自校验：换过的 id 在、标记是唯一那条、也是最新那条；事件 `seq` 从 0 起与位置一一对应
 * （宿主 v4 的 `event.seq !== index` 就是按这一条拒绝的）。
 */
function assertBranched(text: string, newId: string, marker: string | undefined): void {
  const seen: string[] = []
  let id = ''
  let rows = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    const parsed = JSON.parse(line) as { id?: unknown; seq?: unknown }
    if (rows === 0) {
      id = typeof parsed.id === 'string' ? parsed.id : ''
    } else if (parsed.seq !== rows - 1) {
      throw new Error(`branchSessionLog: event seq ${String(parsed.seq)} at row ${rows} is not dense`)
    }
    rows += 1
    const folded = foldTitle(line)
    if (folded !== undefined) seen.push(folded)
  }
  if (id !== newId) throw new Error(`branchSessionLog: header id is ${id}, expected ${newId}`)
  if (marker === undefined) return
  const last = seen[seen.length - 1]
  const count = seen.filter((title) => title === marker).length
  if (count !== 1 || last !== marker) {
    throw new Error(`branchSessionLog: marker must be the newest title, got ${JSON.stringify(seen)}`)
  }
}

/** 按 zstd 魔数把一份字节切成帧（`[start, end)`，顺序即文件顺序）。 */
function splitFrames(buf: Buffer): Array<{ start: number; end: number }> {
  const cuts: number[] = [0]
  for (let i = 1; i + 3 < buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      cuts.push(i)
    }
  }
  cuts.push(buf.length)
  const frames: Array<{ start: number; end: number }> = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const start = cuts[i] as number
    const end = cuts[i + 1] as number
    if (end > start) frames.push({ start, end })
  }
  return frames
}
