// src/log-text-cache.ts — 同一份日志被连着读好几页时，只解压一次。
//
// 为什么需要它：会话内容视图是**按页**取日志的（一页 80 条事件），而页面上的"往下接""查看全文"都各自
// 发一次请求。每条请求原来都要把整份日志读进来、整份解压、再按行切开（见 web.ts 的 `/transcript`）：
// 本机最大的一份 16.9 MB / 9269 条事件，一次解压约 1.5 秒，按 80 条一页要翻 116 页——每翻一页都重来一遍
// 的话，这份日志会被解压一百多次。日志没变时，切出来的行也不变，所以留**一份**在内存里就够。
//
// 三条边界：
//
//   - 只留一份（最后打开的那条会话）：这一页同时只可能看一条会话；留一份最省内存，也够用。
//   - 文件变了就重读：判据是 `size + mtimeMs`，日志被追加、被改写都会让它对不上。判据的粒度与
//     scan-cache.ts 的指纹同一套，风险也一样（同一毫秒、大小不变的改写看不出来）——最坏是翻页时少看一条
//     刚写进去的事件，下一次请求时间戳变了自然读到。
//   - 太大的不缓存：解开的文本是 UTF-16，一个字符两字节，45 MB 文本就是 90 MB 常驻内存。超过上限的
//     那条照旧每次现解（只是慢一点，不占内存）。
//
// 解压本身用 log-decode.ts 的分块版本（块与块之间让出事件循环）：整份一次解压会把宿主主线程按死一秒
// 半，那段时间里网页别的请求都排着——这一页只是要看日志，不该让整个宿主陪着停。
//
// @module dsh-session-manager/log-text-cache
import { readFileSync, statSync } from 'node:fs'

import { decodeLogTextChunked } from './log-decode.ts'

/** 要读的日志：路径与压缩方式（与 discovery.ts 的 `SessionLogFile` 同形）。 */
export interface LogTextSource {
  path: string
  compression: string | null
}

/** 一页一页读同一份日志时用的缓存。 */
export interface LogTextCache {
  /**
   * 读出这份日志的每一行（第一行是 header）。
   *
   * @param source 日志路径与压缩方式。
   * @returns 按行切开的文本；文件没变时直接用上一次的结果。
   * @throws 文件读不到、解不开时抛错（调用方按"这份日志读不出来"报 422）。
   */
  linesOf(source: LogTextSource): Promise<string[]>
}

/**
 * 缓存最多留多少字符的解开文本。
 *
 * 64M 字符 ≈ 128 MB 内存（UTF-16 一个字符两字节），本机最大的一份是 4560 万字符，正好装得下——它也是
 * 翻页最费时的那一份。再大的不缓存。
 */
export const DEFAULT_CACHED_LOG_CHARS = 64 * 1024 * 1024

/** 造一份日志文本缓存。 */
export function createLogTextCache(options: { maxChars?: number } = {}): LogTextCache {
  const maxChars = options.maxChars ?? DEFAULT_CACHED_LOG_CHARS
  let entry: { readonly key: string; readonly lines: string[] } | undefined
  return {
    async linesOf(source) {
      let key: string | undefined
      try {
        const stat = statSync(source.path)
        key = `${source.path}\u0000${stat.size}:${stat.mtimeMs}:${source.compression ?? ''}`
        if (entry !== undefined && entry.key === key) return entry.lines
      } catch {
        // 文件刚好被删 / 读不动：下面的 readFileSync 会抛同一件事，交给调用方按"读不出来"处理。
      }
      // 先把上一份放掉再解新的：这一页只看一条会话，没有理由让两份几千万字符的文本同时被引用。
      entry = undefined
      const text = await decodeLogTextChunked(readFileSync(source.path), source.compression)
      const lines = text.split('\n')
      // 判据拿的是**读之前**的 stat：文件在我们读的这一刻又长了，这份结果就不会被当成"文件没变"复用。
      if (key !== undefined && text.length <= maxChars) entry = { key, lines }
      return lines
    },
  }
}
