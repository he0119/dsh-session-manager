// src/discovery.ts — 会话发现：扫分桶、只解首帧读 header。
//
// 性能取舍：整份解码一条 6MB 日志约 1～2 秒，而发现阶段只需要 header（首个 frame）。
// 首帧实测仅 ~200 字节，因此这里只解码**候选前缀**，不碰其余帧。
// 严格的自洽性切分（decodeAll(前) + decodeAll(后) === decodeAll(整体)）留给执行阶段，
// 发现阶段用"前缀可解码 + 以换行结尾 + 能解析成合法 header"三重判据，够严且便宜。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseSessionLogName } from './paths.ts'
import { projectKey } from './project-key.ts'
import type { DecodeAll, SessionHeader, SessionLogFile } from './types.ts'
import { ZSTD_MAGIC } from './zstd-frame.ts'

/** header 必须含有的键（宿主 isHeaderLine 的必填集）。 */
const HEADER_REQUIRED = ['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth'] as const

function isHeaderShape(value: unknown): value is SessionHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    HEADER_REQUIRED.every((k) => Object.hasOwn(v, k)) &&
    v['type'] === 'session' &&
    typeof v['id'] === 'string' &&
    typeof v['version'] === 'number' &&
    typeof v['createdAt'] === 'number' &&
    (v['cwd'] === undefined || typeof v['cwd'] === 'string')
  )
}

/** 廉价读出的 header。 */
export interface QuickHeader {
  header: SessionHeader
  /** 首帧结束偏移（回退整份解码时为文件长度）。 */
  boundary: number
  /** 已解码的文本（至少含 header 行）。 */
  text: string
}

/**
 * 廉价读出会话 header：只解首帧。
 * @param buf 日志字节。
 * @param decodeAll 多帧感知解码器。
 * @param options.searchLimit 在多少字节内寻找首帧边界（超出则回退整份解码）。
 * @throws 无法解析出合法 header 时抛错。
 */
export function readHeaderQuick(
  buf: Buffer,
  decodeAll: DecodeAll,
  options: { searchLimit?: number } = {},
): QuickHeader {
  const searchLimit = options.searchLimit ?? 65536
  const candidates: number[] = []
  const limit = Math.min(buf.length, searchLimit)
  for (let i = 1; i + 3 < limit; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      candidates.push(i)
    }
  }
  if (buf.length <= searchLimit) candidates.push(buf.length)

  for (const i of candidates) {
    let text: string
    try {
      text = decodeAll(buf.subarray(0, i))
    } catch {
      continue
    }
    if (!text.endsWith('\n')) continue
    const firstLine = text.split('\n')[0] ?? ''
    if (!firstLine.startsWith('{"type":"session"')) continue
    try {
      const header: unknown = JSON.parse(firstLine)
      if (isHeaderShape(header)) return { header, boundary: i, text }
    } catch {
      // 截断的 JSON：不是真边界
    }
  }

  // 回退：整份解码（慢，但正确）
  const text = decodeAll(buf)
  const firstLine = text.split('\n')[0] ?? ''
  const header: unknown = JSON.parse(firstLine)
  if (!isHeaderShape(header)) throw new Error('log does not start with a well-formed session header')
  return { header, boundary: buf.length, text: firstLine + '\n' }
}

/** 一个分桶目录下发现的一个会话。 */
export interface DiscoveredSession {
  /** 目录名（应等于 encodeSegment(header.id)）。 */
  dirName: string
  /** 会话目录的绝对路径。 */
  dir: string
  id: string
  cwd: string | undefined
  createdAt: number
  header: SessionHeader
  /** 该会话目录里的代次日志文件，按代次升序。 */
  files: SessionLogFile[]
}

/**
 * 扫描一个分桶目录下的全部会话。
 * @param bucketDir 形如 `<root>/--C-Users-me-proj--` 的目录。
 * @param decodeAll 多帧感知解码器。
 * @returns 会话数组，按 createdAt 降序（新→旧，与宿主账本显示顺序一致）。
 */
export function scanBucket(bucketDir: string, decodeAll: DecodeAll): DiscoveredSession[] {
  const out: DiscoveredSession[] = []
  for (const dirName of readdirSync(bucketDir)) {
    const dir = join(bucketDir, dirName)
    if (!statSync(dir).isDirectory()) continue
    const files: SessionLogFile[] = []
    let header: SessionHeader | null = null
    for (const name of readdirSync(dir)) {
      const parsed = parseSessionLogName(name)
      if (!parsed) continue
      const path = join(dir, name)
      const buf = readFileSync(path)
      const { header: h } = readHeaderQuick(buf, decodeAll)
      if (header && h.id !== header.id) throw new Error(`inconsistent header ids inside ${dir}`)
      if (header && h.cwd !== header.cwd) throw new Error(`inconsistent header cwd inside ${dir}`)
      header = h
      files.push({ name, path, version: parsed.version, compression: parsed.compression, bytes: buf.length })
    }
    if (!header || files.length === 0) continue // 只有临时/伴生文件的目录
    files.sort((a, b) => a.version - b.version)
    out.push({ dirName, dir, id: header.id, cwd: header.cwd, createdAt: header.createdAt, header, files })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/** 分桶目录路径（cwd → 桶名）。 */
export function bucketOf(root: string, cwd: string): string {
  return join(root, projectKey(cwd))
}
