// src/zstd-frame.ts — zstd 多帧容器的读写原语（零 DSH 依赖）。
//
// 为什么需要这一层：宿主按「一条事件一次 flush」追加写日志，磁盘上的 .zstd 是
// **多帧拼接**（实测一条日志可达上千帧）。而 node:zlib 的 zstdDecompress /
// createZstdDecompress 只解第一帧、其余静默丢弃，且对截断不报错——只解首帧就
// 只剩 session 头一行，会让整个会话看起来"没有内容"。
//
// 因此本模块：
//   1. 不自己挑解码器，由调用方注入（插件里注入 fzstd）；
//   2. 提供 assertMultiFrameAware() 主动探测注入的解码器是否"只解首帧"；
//   3. 改写只重写**第一个 frame**，其余帧字节原样保留——产出结构与宿主自己写出的
//      一致，且尾部可审计地逐字节不变；
//   4. 提供纯手写的 raw-block 帧编码器，使写侧不依赖任何压缩器（fzstd 只能解压，
//      node:zlib 的 zstd 有 Node 版本下限）。
import type { CompressFrame, DecodeAll } from './types.ts'

/** zstd 帧魔术字节（小端 0xFD2FB528）。 */
export const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const

/**
 * 构造一个只含「单个 raw（未压缩）block」的合法 zstd 帧。
 *
 * RFC 8878 布局：Magic | Frame_Header_Descriptor | [Window_Descriptor] | [Dict_ID] |
 * Frame_Content_Size | Block_Header(3, LE) | block data。
 * 取 Single_Segment=1（故省略 Window_Descriptor）、无校验和、Block_Type=Raw，
 * 于是无需熵编码即可手写。
 *
 * @param text 该帧承载的明文字符串（UTF-8）。
 * @returns 完整的 zstd 帧 Buffer。
 */
export const encodeRawFrame: CompressFrame = (text: string): Buffer => {
  const bytes = Buffer.from(String(text), 'utf8')
  const size = bytes.length

  // Frame_Content_Size 字段宽度由 FCS_flag 决定；Single_Segment=1 时 flag 0 表示 1 字节。
  let fcsFlag: number
  let fcs: Buffer
  if (size < 256) {
    fcsFlag = 0
    fcs = Buffer.from([size])
  } else if (size <= 65535 + 256) {
    fcsFlag = 1
    const v = size - 256
    fcs = Buffer.from([v & 0xff, (v >> 8) & 0xff])
  } else if (size <= 0xffffffff) {
    fcsFlag = 2
    fcs = Buffer.alloc(4)
    fcs.writeUInt32LE(size, 0)
  } else {
    throw new Error('raw frame content too large for 4-byte Frame_Content_Size')
  }

  const descriptor = (fcsFlag << 6) | (1 << 5) // Single_Segment=1, Content_Checksum=0, Dict_ID=0
  const blockHeaderValue = 1 | (0 << 1) | (size << 3) // Last_Block=1, Block_Type=0(Raw), Block_Size=size
  const blockHeader = Buffer.from([
    blockHeaderValue & 0xff,
    (blockHeaderValue >> 8) & 0xff,
    (blockHeaderValue >> 16) & 0xff,
  ])

  return Buffer.concat([Buffer.from([...ZSTD_MAGIC, descriptor]), fcs, blockHeader, bytes])
}

/** 扫描出所有可能是帧起始的偏移（含 magic 的位置）+ 末尾哨兵。 */
function frameStartCandidates(buf: Buffer): number[] {
  const out: number[] = []
  for (let i = 1; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      out.push(i)
    }
  }
  out.push(buf.length)
  return out
}

/** 首帧切分结果。 */
export interface FirstFrameSplit {
  /** 首帧明文。 */
  first: string
  /** 其余帧的**原始字节**（不做任何重编码）。 */
  rest: Buffer
  /** 首帧结束的字节偏移。 */
  boundary: number
}

/**
 * 定位第一个 frame 的字节边界。
 *
 * 判据是自洽性而非"猜魔数"：找到一个偏移 i，使
 *   decodeAll(buf[0..i)) + decodeAll(buf[i..)) === decodeAll(buf)
 * 且前半段是完整的行（以 '\n' 结尾）。截断的帧会被解码器抛错或被该等式排除，
 * 因此不会误判压缩载荷中偶然出现的魔术字节。
 *
 * @param buf 完整日志字节。
 * @param decodeAll 多帧感知解码器。
 * @param options.requireLineBoundary 是否要求首帧以换行结尾（默认 true）。
 * @returns 切分结果；`null` 分支对可解码输入不可达（见下方注释）。
 * @throws 整份不可解码时由 decodeAll 抛出（宁可失败也不猜）。
 */
export function splitFirstFrame(
  buf: Buffer,
  decodeAll: DecodeAll,
  options: { requireLineBoundary?: boolean } = {},
): FirstFrameSplit | null {
  const requireLine = options.requireLineBoundary !== false
  const full = decodeAll(buf)
  for (const i of frameStartCandidates(buf)) {
    const headRaw = buf.subarray(0, i)
    const tailRaw = buf.subarray(i)
    let head: string
    let tail: string
    try {
      head = decodeAll(headRaw)
    } catch {
      continue // 截断帧：解码器抛错，跳过
    }
    try {
      tail = tailRaw.length === 0 ? '' : decodeAll(tailRaw)
    } catch {
      continue
    }
    if (head + tail !== full) continue
    if (requireLine && i !== buf.length && !head.endsWith('\n')) continue
    return { first: head, rest: tailRaw, boundary: i }
  }
  // 可解码的输入必然在 i = buf.length 处成立（head = full、tail = ''），
  // 因此这里不可达；保留是为了在 decodeAll 语义被改写时仍然显式失败而非返回半成品。
  return null
}

/**
 * 低成本定位首帧边界：只解候选前缀，**不**整篇解码、不做 `head + tail === full` 那份自洽校验。
 *
 * 与 [`splitFirstFrame`] 的差别只有那一份校验，而它在这里是多余的：截断的帧会被解码器拒绝
 * （fzstd 报 `unexpected EOF`），所以"候选前缀能解出、且以换行结尾"这个判据本身已经够用。那份校验
 * 要求整篇解码外加一次尾部解码，一条 6 MB 的会话要多花两秒——只读用途（内容指纹）不该为它买单。
 *
 * **只读用途**用它；要把切分结果拿去改写并落盘（`relocateHeaderCwd`）时仍然用 [`splitFirstFrame`]：
 * 那条路上多花的时间买的是"写出去的字节整体可解码"。
 *
 * @param buf 完整日志字节。
 * @param decodeAll 多帧感知解码器。
 * @returns 切分结果；`rest` 是其余帧的原始字节，不做任何重编码。
 */
export function splitFirstFrameFast(buf: Buffer, decodeAll: DecodeAll): FirstFrameSplit | null {
  // 不预先算出全部候选（`frameStartCandidates` 会扫完整篇）：首帧边界通常就在文件开头几百字节处，
  // 逐字节找到即返回，于是扫描量与文件大小无关。
  for (let i = 1; i <= buf.length; i += 1) {
    const atEnd = i === buf.length
    if (
      !atEnd &&
      !(
        buf[i] === ZSTD_MAGIC[0] &&
        buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] &&
        buf[i + 3] === ZSTD_MAGIC[3]
      )
    ) {
      continue
    }
    let head: string
    try {
      head = decodeAll(buf.subarray(0, i))
    } catch {
      continue // 截断帧：解码器抛错，跳过
    }
    if (!atEnd && !head.endsWith('\n')) continue
    return { first: head, rest: buf.subarray(i), boundary: i }
  }
  return null
}

/**
 * 主动探测解码器是否为"多帧感知"。
 *
 * 这是把导致数据丢失的静默截断变成启动期硬失败的守卫：构造两个 raw 帧，
 * 只解首帧的解码器会返回 'A' 而非 'AB'。
 *
 * @param decodeAll 待探测的解码器。
 * @throws 当解码器不返回全部帧内容（含只解首帧、抛错、返回空）。
 */
export function assertMultiFrameAware(decodeAll: DecodeAll): void {
  const probe = Buffer.concat([encodeRawFrame('A'), encodeRawFrame('B')])
  let got: string
  try {
    got = decodeAll(probe)
  } catch (error) {
    throw new Error(
      `zstd decoder rejected a valid two-frame stream: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (got !== 'AB') {
    throw new Error(
      `zstd decoder is not multi-frame aware: expected "AB" from a two-frame stream, got ${JSON.stringify(got)}. ` +
        'This is the silent truncation of single-frame-only decoders (e.g. node:zlib zstdDecompress); use fzstd.',
    )
  }
}
