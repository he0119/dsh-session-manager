// src/shared/text-chunks.ts — 大文本/大缓冲的分块切分与拼接。
//
// 这些操作本身不慢，慢在“一次做完整份”：45MB 文本的 `split()` 或 `join()` 会在主线程上按住
// 几十到上百毫秒。这里只做一件事：把同一份结果切成小段推进，段间让出一轮事件循环。
//
// 判据：输出必须与整份 `split()` / `join()` / `Buffer.concat()` 逐字节或逐字符相同；调用方
// 不需要知道分段边界。
// @module dsh-session-manager/shared/text-chunks

/** 让出一轮事件循环。 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** 一段文本/缓冲处理多少数据后让出。 */
const CHUNK_CHARS = 2 * 1024 * 1024
const CHUNK_BYTES = 4 * 1024 * 1024

/**
 * 与 `text.split('\n')` 同一份结果，只是按 2M 字符一段切开、段间让出。
 *
 * @param text 完整文本。
 * @returns 行数组；空文本返回 `['']`，与 `split` 一致。
 */
export async function splitLinesAsync(text: string): Promise<string[]> {
  if (text.length === 0) return ['']
  const lines: string[] = []
  let carry = ''
  for (let offset = 0; offset < text.length; offset += CHUNK_CHARS) {
    const piece = text.slice(offset, offset + CHUNK_CHARS)
    const parts = piece.split('\n')
    if (carry !== '') {
      parts[0] = carry + parts[0]
      carry = ''
    }
    if (offset + CHUNK_CHARS < text.length) carry = parts.pop() ?? ''
    lines.push(...parts)
    await yieldToLoop()
  }
  if (carry !== '') lines.push(carry)
  return lines
}

/**
 * 与 `parts.join(separator)` 同一份结果，只是每 2M 字符归一组、组间让出。
 *
 * 先按小段累积，最后只拼二十来段，避免一次分配几十 MB 的字符串。
 */
export async function joinTextAsync(parts: readonly string[], separator = ''): Promise<string> {
  if (parts.length === 0) return ''
  const groups: string[] = []
  let current = ''
  let currentChars = 0
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      current += separator
      currentChars += separator.length
    }
    current += part
    currentChars += part.length
    if (currentChars >= CHUNK_CHARS) {
      groups.push(current)
      current = ''
      currentChars = 0
      await yieldToLoop()
    }
  }
  if (current !== '' || groups.length === 0) groups.push(current)
  await yieldToLoop()
  return groups.join('')
}

/**
 * 与 `Buffer.concat(chunks)` 同一份结果，只是按 4MB 一段拷、段间让出。
 *
 * 190MB 的请求体一次 `Buffer.concat` 实测 82ms；先分配目标缓冲再分段拷贝，总耗时相近，
 * 单段停顿回到几毫秒。
 */
export async function concatBuffersAsync(chunks: readonly Buffer[]): Promise<Buffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = Buffer.allocUnsafe(total)
  let offset = 0
  for (const chunk of chunks) {
    let inner = 0
    while (inner < chunk.length) {
      const take = Math.min(CHUNK_BYTES, chunk.length - inner)
      chunk.copy(out, offset, inner, inner + take)
      offset += take
      inner += take
      await yieldToLoop()
    }
  }
  return out
}
