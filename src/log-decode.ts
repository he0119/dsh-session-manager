/**
 * 把一份多帧 zstd 日志解成文本，**分块推进、每块之间把事件循环让出去**。
 *
 * 为什么需要它：同步里"两边各自写过"的那些对要读整份日志比内容（见 `sync.ts` 的
 * `contentRelationsOf()`）。`decodeAll()` 是一整份塞进解压器的一次同步调用——本机真实日志里最大的一份
 * （压缩后 13.7 MB、解开 48 MB）一次就占住主线程约 1.8 秒，宿主在这段时间里连一个 HTTP 请求都接不了；
 * 单条会话几十 MB 时这个停顿能到十几秒（线上那次"网页一直转圈"就是这么来的）。
 *
 * 这里换 fzstd 的流式解码器：按 {@link DECODE_CHUNK_BYTES} 一块一块 `push()`，块与块之间让出一轮
 * 事件循环。同一份日志实测（13.7 MB → 44 MB 文本）：
 *
 * | 推法 | 总耗时 | 主线程最长一次停顿 |
 * | --- | --- | --- |
 * | 整份一次（`decodeAll`） | 1826 ms | 1826 ms |
 * | 128 KB 一块 | 2069 ms | 58 ms |
 *
 * 总耗时只多 13%，但主线程不再被整份解压按死。输出与 `decodeAll()` **逐字符一致**（多帧也一样：
 * 解码器认得帧头，`test/log-decode.test.ts` 用拼接的多帧日志钉住这一点）。
 *
 * @module dsh-session-manager/log-decode
 */

import { Decompress, decompress } from 'fzstd'
import { StringDecoder } from 'node:string_decoder'

/**
 * 一次推给解码器的压缩字节数。
 *
 * 这个值是按"一块解完别让主线程停太久"量的：128 KB 一块在本机那份大日志上主线程最长停 58 ms、总耗时
 * 2069 ms；64 KB 更细（47 ms）但总耗时多 16%；256 KB 就开始出现 150 ms 级的停顿。
 */
export const DECODE_CHUNK_BYTES = 128 * 1024

/** 让出一轮事件循环：把后续的解码排到下一轮宏任务，中间那些 HTTP 请求才轮得上。 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * 分块解压一串 zstd 帧，返回解出来的文本。
 *
 * @param bytes 压缩字节（可以是一串首尾相接的帧，与日志文件同一个形状）。
 * @param chunkBytes 一次推多少压缩字节（缺省 {@link DECODE_CHUNK_BYTES}）。
 * @returns 解出来的全部文本。
 */
export async function decodeAllChunked(bytes: Buffer, chunkBytes: number = DECODE_CHUNK_BYTES): Promise<string> {
  if (bytes.length === 0) return ''
  try {
    return await decodeChunks(bytes, chunkBytes)
  } catch {
    /*
     * 流式那条认不出的，退回整份解压。
     *
     * 只有一种已知情形会走到这儿：一个 Raw 块比 128 KB 还大（zstd 规定 Raw 块最大 128 KB，所以这种
     * 数据本来就不合法），流式挪到块中间就认不出来。宁可让这一对把主线程多占一会儿，也不能把一份
     * 读得出的日志判成"读不出"——那会让这条会话永远停在"两边各自写过"。
     */
    return Buffer.from(decompress(bytes)).toString('utf8')
  }
}

/** 真正的分块那一半：按块推进，块与块之间让出事件循环。 */
async function decodeChunks(bytes: Buffer, chunkBytes: number): Promise<string> {
  // 块边界可能切在一个多字节字符中间，`StringDecoder` 负责把半个字符留到下一块，拼出来的文本才与
  // 整份解压逐字符一致（`Buffer.concat().toString()` 也正确，但要多拷一份几十 MB 的缓冲）。
  const decoder = new StringDecoder('utf8')
  const parts: string[] = []
  const stream = new Decompress((data) => {
    parts.push(decoder.write(Buffer.from(data)))
  })
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, bytes.length)
    stream.push(bytes.subarray(offset, end), end >= bytes.length)
    // 最后一块之后不必再让：循环已经结束，调用方紧接着自己会 await。
    if (end < bytes.length) await yieldToLoop()
  }
  parts.push(decoder.end())
  return parts.join('')
}

/**
 * 与 `attachments.ts` 的 `decodeLogText()` 同形，只是 zstd 那一路改成分块解压。
 *
 * @param bytes 日志字节（压缩的或原样的）。
 * @param compression 这一步的压缩方式（`'zstd'` 或别的 / 空）。
 * @param chunkBytes 一次推多少压缩字节。
 * @returns 日志文本。
 */
export async function decodeLogTextChunked(
  bytes: Buffer,
  compression: string | null,
  chunkBytes: number = DECODE_CHUNK_BYTES,
): Promise<string> {
  return compression === 'zstd' ? decodeAllChunked(bytes, chunkBytes) : bytes.toString('utf8')
}
