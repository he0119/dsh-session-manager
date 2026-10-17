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
 * 把一份日志落成"另一条会话"（同步裁决里落选那一份的去处）：换 header 的 `id`，并插一条**标记标题**
 * （`session/title`），如「原标题 · 来自 robot-test 2026-10-12 20:05」。
 *
 * 为什么是"插"而不是"改"：标题的语义是**最新一条 `session/title` 生效**（见 `foldTitle()`），所以标记
 * 只要排在所有原标题之后就一定赢。位置取"最后一个含标题事件的那一帧之后"：原标题都在开头（实测前
 * ~26KB），标记因此也在开头——而读标题的两条路都只扫开头（`readLogTitle()` 的 256KB 预算、包预演的
 * 最新帧），排在末尾的标记两头都读不到。**不动**其余帧的字节：原文既不重压也不改内容。
 *
 * 顺序（zstd）：首帧解出 header 换 `id`、用 `compressFrame`（缺省手写 raw-block 帧）写回；其余帧原样
 * 拼接，只在最后一个含标题事件的帧之后插一帧标记；自校验整份解出来只剩一个标题、且是标记那一个。
 * 明文那一半同义（没有帧，逐行改写，自校验也走明文）。
 *
 * @throws 首帧没有完整 header、或自校验不过时抛错（不产出半成品）。
 */
export function branchSessionLog(
  buf: Buffer,
  compression: string | null,
  /** `machine` 缺席 = 只换 id 不插标记（多代次里只有最新一代带标记标题）。 */
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
    let after = 0
    let original = ''
    for (const [index, text] of texts.entries()) {
      const folded = foldTitle(text)
      if (folded !== undefined) {
        original = folded
        after = index
      }
    }
    const marker = machine === undefined ? undefined : markerLine(original, machine, lastLine(texts), now)
    const out: Buffer[] = [compressFrame(rewriteHeaderId(texts[0] as string, newId))]
    if (marker === undefined) {
      const buffer = Buffer.concat([out[0] as Buffer, ...frames.slice(1).map((frame) => buf.subarray(frame.start, frame.end))])
      assertBranched(decodeAll(buffer), newId, undefined)
      return buffer
    }
    for (const [index, frame] of frames.entries()) {
      if (index === 0) continue
      out.push(buf.subarray(frame.start, frame.end))
      if (index === after && marker !== undefined) out.push(compressFrame(marker))
    }
    if (after === 0) out.splice(1, 0, compressFrame(marker))
    const buffer = Buffer.concat(out)
    assertBranched(decodeAll(buffer), newId, marker === undefined ? undefined : (JSON.parse(marker) as { data: { title: string } }))
    return buffer
  }
  const lines = buf.toString('utf8').split('\n')
  let after = 0
  let original = ''
  for (const [index, line] of lines.entries()) {
    if (index === 0 || line === '') continue
    const folded = foldTitle(line)
    if (folded !== undefined) {
      original = folded
      after = index
    }
  }
  const marker = machine === undefined ? undefined : markerLine(original, machine, lastLine(lines), now)
  lines[0] = rewriteHeaderId(lines[0] ?? '', newId)
  if (marker !== undefined) lines.splice(after + 1, 0, marker)
  const buffer = Buffer.from(lines.join('\n'), 'utf8')
  assertBranched(buffer.toString('utf8'), newId, marker === undefined ? undefined : (JSON.parse(marker) as { data: { title: string } }))
  return buffer
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

/** 改 header 那一行的 `id`（只此一处；其余字段一个字节都不动）。 */
function rewriteHeaderId(headerLine: string, newId: string): string {
  const parsed: unknown = JSON.parse(headerLine)
  const header = parsed as Record<string, unknown>
  if (typeof header['id'] !== 'string') throw new Error('branchSessionLog: header has no id')
  header['id'] = newId
  // 行尾的 '\n' 是这一行与下一帧的分界，丢了就会黏成一行（自校验会当场炸）。
  return JSON.stringify(header) + (headerLine.endsWith('\n') ? '\n' : '')
}

/** 整份日志里最后一条非空行（标记行的 `seq` 接着它往下写）。 */
function lastLine(texts: readonly string[]): { seq: number; time: string } {
  for (let i = texts.length - 1; i >= 0; i--) {
    const lines = (texts[i] as string).split('\n').filter((line) => line !== '')
    const line = lines[lines.length - 1]
    if (line === undefined) continue
    try {
      const parsed = JSON.parse(line) as { seq?: unknown; time?: unknown }
      return {
        seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
        time: typeof parsed.time === 'string' ? parsed.time : new Date().toISOString(),
      }
    } catch {
      return { seq: 0, time: new Date().toISOString() }
    }
  }
  return { seq: 0, time: new Date().toISOString() }
}

/** 标记那一行：「原标题 · 来自 <机器> <时刻>」——原标题缺席时只留后半句。 */
function markerLine(
  original: string,
  machine: string,
  tail: { seq: number; time: string },
  now: string,
): string {
  const when = tail.time.slice(0, 16).replace('T', ' ')
  const marked = original === '' ? `来自 ${machine} ${when}` : `${original} · 来自 ${machine} ${when}`
  // 事件行都以换行结尾：这一行是**独立一帧**，少了行尾就与下一帧黏成一行。
  return JSON.stringify({ type: 'session/title', seq: tail.seq + 1, time: now, data: { title: marked } }) + '\n'
}

/** 自校验：换过的 id 在、标记是唯一那条标题（也是最新那条）。 */
function assertBranched(text: string, newId: string, marker: { data: { title: string } } | undefined): void {
  const seen: string[] = []
  let id = ''
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue
    if (index === 0) {
      const parsed = JSON.parse(line) as { id?: unknown }
      id = typeof parsed.id === 'string' ? parsed.id : ''
    }
    const folded = foldTitle(line)
    if (folded !== undefined) seen.push(folded)
  }
  if (id !== newId) throw new Error(`branchSessionLog: header id is ${id}, expected ${newId}`)
  // 标记**不删**原标题（原文一个字节都不动），它只要排在最后就一定赢——所以核的是"最后那条是标记、
  // 且标记只出现一次"。
  if (marker === undefined) return
  const last = seen[seen.length - 1]
  const count = seen.filter((title) => title === marker.data.title).length
  if (count !== 1 || last !== marker.data.title) {
    throw new Error(`branchSessionLog: marker must be the newest title, got ${JSON.stringify(seen)}`)
  }
}
