// src/paths.ts — 会话日志路径的构造与解析（复刻宿主口径）。
//
// 目录布局（宿主 src/index.ts）：
//   <root>/<projectKey(cwd)>/<encodeSegment(id)>/session.vN.jsonl.zstd
// 会话 id 与 cwd 共同决定路径；加载时校验二者与磁盘目录一致，否则硬失败。
import { dirname, join } from 'node:path'

import { NO_CWD_DIR, projectKey } from './project-key.ts'

const SAFE = /^[A-Za-z0-9._-]$/

/**
 * 复刻宿主的 encodeSegment()：把任意字符串编码成单个安全路径段（单射）。
 *
 * 与 projectKey 不同：不折叠分隔符，且特判 `.` / `..` 以防目录穿越。
 *
 * @param raw 会话 id 等原始字符串，不可为空。
 * @returns 可安全用作目录名的段。
 */
export function encodeSegment(raw: string): string {
  const s = String(raw ?? '')
  if (s.length === 0) throw new Error('cannot encode an empty path segment')
  if (s === '.') return '~002E'
  if (s === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && SAFE.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** 会话格式代次文件名（不含压缩后缀）。v0 无版本分量，vN（N>=1）带小写 vN。 */
export function sessionFormatLogFilename(version: number): string {
  const v = Number(version)
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`invalid session format version: ${version}`)
  return v === 0 ? 'session.jsonl' : `session.v${v}.jsonl`
}

/** 代次文件名 + 压缩后缀（当前宿主写 zstd）。 */
export function generationLogFilename(version: number, compression = 'zstd'): string {
  return sessionFormatLogFilename(version) + (compression ? `.${compression}` : '')
}

// 与 dsh-chat-import 的 sources/dsh.mjs 同款：只认规范名，避免把临时/非规范名当日志。
const SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/i

/** 解析出的会话日志文件名信息。 */
export interface ParsedSessionLogName {
  version: number
  compression: string | null
}

/**
 * 解析会话日志文件名。
 * @param name 目录项名称。
 * @returns 代次与压缩后缀，非会话日志返回 undefined。
 */
export function parseSessionLogName(name: string): ParsedSessionLogName | undefined {
  const m = SESSION_LOG_RE.exec(String(name ?? ''))
  if (!m) return undefined
  return {
    version: Number(m[1] ?? 0),
    compression: /\.zstd$/i.test(String(name)) ? 'zstd' : null,
  }
}

/** 会话所属的项目目录（cwd 缺省时落在 `_no-cwd`）。 */
export function projectDir(root: string, cwd: string | undefined | null): string {
  return join(root, cwd === undefined || cwd === null ? NO_CWD_DIR : projectKey(cwd))
}

/** 会话自身的目录。 */
export function sessionDir(root: string, cwd: string | undefined, id: string): string {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/** 会话某代次日志文件的完整路径。 */
export function sessionLogPath(
  root: string,
  cwd: string | undefined,
  id: string,
  version: number,
  compression = 'zstd',
): string {
  return join(sessionDir(root, cwd, id), generationLogFilename(version, compression))
}

/**
 * 宿主投影缓存的会话记录目录：`<storages>/session_projcache/sessions`。
 *
 * 由 `registryPath` 反推（账本与缓存同在 `<storages>` 下，而配置里只暴露前者）：那个目录里
 * 每条会话一个 `<encodeSegment(id)>.json`，是宿主自己列会话时读的东西，标题也在里面
 * （见 session-title.ts）。读不到就当没有缓存——标题照样能从日志里读，只是慢一点。
 *
 * @param registryPath 账本文件路径（`<storages>/workspace.json`）。
 * @returns 缓存记录目录（不保证存在）。
 */
export function projectionCacheDir(registryPath: string): string {
  return join(dirname(registryPath), 'session_projcache', 'sessions')
}
