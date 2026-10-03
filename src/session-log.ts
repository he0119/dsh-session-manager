// src/session-log.ts — 单个会话日志文件的读取与「保结构」cwd 改写。
//
// 核心不变式：只改写首行 header 的 cwd 值，其余字节在语义与字节两个层面都不变。
// 会话正文里出现的旧路径属于**历史事实**（当时确实写在旧目录），保持原样。
import type { CompressFrame, DecodeAll, SessionHeader } from './types.ts'
import { encodeRawFrame, splitFirstFrame, splitFirstFrameFast } from './zstd-frame.ts'

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
