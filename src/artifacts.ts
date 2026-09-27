// src/artifacts.ts — "会话中创建的文件"的提取与搬迁规划。
//
// 证据强弱分层（这是本模块的核心取舍）：
//   1. write 工具的 file_path        —— 权威：会话确实写了这个文件
//   2. deliverables/presented        —— 权威：会话主动交付给用户的产物
//   3. edit 工具的 file_path         —— 权威但语义不同：**修改**而非创建
//   4. pwsh/bash 命令里的造物路径     —— 启发式：正则扫命令，可能有噪声
//
// 两个必须做的收窄：
//   * **与磁盘存在性求交**：实测 51 个候选里 39 个早已被会话自己删掉，
//     不存在的路径不能进搬迁计划；
//   * **剪掉嵌套**：若某目录要被整体搬走，它内部的文件就不该再单独搬一遍。
import { cpSync, existsSync as fsExists, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'

import type { ArtifactMove, ArtifactSkip } from './types.ts'

// ── 路径方言 ──────────────────────────────────────────────────────────────
//
// 会话日志里记的是**当时那台机器**的路径，而这次迁移可能跑在另一个平台上：日志写着
// `C:\Users\me\Downloads\x.txt`，本进程却在 Linux 上。拿宿主的 `node:path` 直接处理它，
// `isAbsolute('C:\\…')` 在 Linux 上是 false，于是它被当成相对路径拼到当前工作目录后面
// （`/repo/C:\Users\me\Downloads/x.txt`）——包含判断、相对化、目标路径会跟着一起错，
// 而且错得安静：规划看起来成功，产物却指向一个不存在的路径。
//
// 所以先认**方言**（盘符 / UNC → win32，`/` 开头 → posix），再用同一方言的实现去算；
// 相对路径按 `cwd` 的方言解析。两个方言之间没有包含关系——Windows 路径不可能位于一个
// POSIX 目录里，这时 `isInside` 直接给 false，而不是凑出一个看似合理的相对路径。
type Flavor = 'win32' | 'posix'

/** 只用得到这几个：够本模块全部算术，也避免 win32/posix 的联合类型在调用点上打架。 */
interface PathApi {
  normalize(p: string): string
  resolve(...p: string[]): string
  relative(from: string, to: string): string
  join(...p: string[]): string
  isAbsolute(p: string): boolean
}

const PATH_API: Record<Flavor, PathApi> = { win32, posix }
const HOST_FLAVOR: Flavor = process.platform === 'win32' ? 'win32' : 'posix'

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/
/** `\\server\share\…`——日志里出现过的那种 UNC 写法；`//server` 歧义太大，不认。 */
const WINDOWS_UNC = /^\\\\/

function flavorOf(p: string): Flavor | undefined {
  if (WINDOWS_DRIVE.test(p) || WINDOWS_UNC.test(p)) return 'win32'
  if (p.startsWith('/')) return 'posix'
  return undefined
}

/** 第一个能定下方言的候选；都没有就落到宿主。 */
function flavorFor(...candidates: Array<string | undefined>): Flavor {
  for (const candidate of candidates) {
    if (!candidate) continue
    const flavor = flavorOf(candidate)
    if (flavor) return flavor
  }
  return HOST_FLAVOR
}

function apiOf(flavor: Flavor): PathApi {
  return PATH_API[flavor]
}

/**
 * 把一个已经定过方言的路径规范化。
 *
 * 有方言的路径**只做 normalize**：在 Linux 上 `posix.resolve('D:\\a\\b')` 会返回
 * `/repo/D:\a\b`，那正是这里要避免的"修正"。没有方言（相对路径）才按宿主那套解析。
 */
function canonical(p: string, flavor: Flavor): string {
  const api = apiOf(flavor)
  return flavorOf(p) ? api.normalize(p) : api.resolve(p)
}

/** 路径包含判断（同一方言内比较；不同方言恒为 false）。 */
export function isInside(child: string, parent: string): boolean {
  const childFlavor = flavorOf(child)
  const parentFlavor = flavorOf(parent)
  if (childFlavor && parentFlavor && childFlavor !== parentFlavor) return false
  const flavor = childFlavor ?? parentFlavor ?? HOST_FLAVOR
  const api = apiOf(flavor)
  const rel = api.relative(canonical(parent, flavor), canonical(child, flavor))
  return rel !== '' && !rel.startsWith('..') && !api.isAbsolute(rel)
}

/** 相对路径按 cwd 的方言解析；绝对路径按它自己的方言规范化；空值返回 null。 */
export function resolveArtifactPath(p: string | null | undefined, cwd: string): string | null {
  const s = String(p ?? '')
  if (!s) return null
  const flavor = flavorOf(s) ?? flavorFor(cwd)
  const api = apiOf(flavor)
  return flavorOf(s) ? api.normalize(s) : api.resolve(cwd, s)
}

/** 造物动词的启发式（仅在命令确实提到该路径时才算候选）。 */
const SHELL_CREATE_VERB =
  /(New-Item|mkdir|Copy-Item|Move-Item|Out-File|Set-Content|Add-Content|Expand-Archive|Compress-Archive|Rename-Item|git\s+clone|npm\s+create|pnpm\s+create)/i

const KIND_RANK: Record<string, number> = { created: 0, delivered: 1, modified: 2, shell: 3 }

/** 一个产物候选。 */
export interface ArtifactCandidate {
  path: string
  /** created | modified | delivered | shell */
  kind: string
  /** 认为它是产物的证据来源，便于审计。 */
  via: string[]
}

/**
 * 从单个会话日志正文里提取产物候选。
 * @param text 已解码的完整日志正文（多帧全解，不是只解首帧）。
 * @param options.cwd 会话工作目录，用于解析相对路径。
 */
export function extractArtifactsFromLog(
  text: string,
  options: { cwd?: string } = {},
): { candidates: ArtifactCandidate[] } {
  const cwd = options.cwd
  const found = new Map<string, ArtifactCandidate>()
  const add = (raw: string | null | undefined, kind: string, via: string): void => {
    const path = resolveArtifactPath(raw, cwd ?? process.cwd())
    if (!path) return
    const prev = found.get(path)
    // 取证据更强的 kind；同时累计来源
    if (!prev || (KIND_RANK[kind] ?? 9) < (KIND_RANK[prev.kind] ?? 9)) {
      found.set(path, { path, kind, via: [...(prev?.via ?? []), via] })
    } else {
      prev.via.push(via)
    }
  }

  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue
    let e: Record<string, unknown>
    try {
      e = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = e['type']
    const data = e['data'] as Record<string, unknown> | undefined
    if (type === 'tool/call') {
      const name = data?.['name']
      let args: unknown = data?.['arguments']
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = null
        }
      }
      const a = args as Record<string, unknown> | null
      const p = a?.['file_path']
      if (typeof p === 'string' && name === 'write') add(p, 'created', 'write')
      else if (typeof p === 'string' && name === 'edit') add(p, 'modified', 'edit')
      // 命令面：只在命令里出现且含造物动词时记为启发式候选
      const cmd = a?.['command']
      if (typeof cmd === 'string' && SHELL_CREATE_VERB.test(cmd) && cwd) {
        const tokens = cmd.match(/[A-Za-z]:\\[^"'\s;)\]]+|(?<![\w-])[^\s"';)\]]*[\\/][^\s"';)\]]+/g) ?? []
        for (const token of tokens) {
          const path = resolveArtifactPath(token.replace(/[\\/]+$/, ''), cwd)
          if (path && isInside(path, cwd)) add(path, 'shell', `shell:${typeof name === 'string' ? name : 'command'}`)
        }
      }
    } else if (type === 'deliverables/presented') {
      const files = data?.['files']
      if (Array.isArray(files)) {
        for (const f of files) {
          const p = (f as Record<string, unknown> | null)?.['path']
          if (typeof p === 'string') add(p, 'delivered', 'deliverables')
        }
      }
    }
  }
  return { candidates: [...found.values()] }
}

/** `planArtifactMoves` 的选项。 */
export interface PlanArtifactOptions {
  /** 会话 id 与已解码的完整日志正文。 */
  sessions: Array<{ id: string; text: string }>
  /** 源工作区目录（只搬它内部的产物）。 */
  fromDir: string
  /** 目标工作区目录。 */
  toDir: string
  /** 参与搬迁的 kind 集合（缺省 created + delivered + modified）。 */
  includeKinds?: string[]
  exists?: (p: string) => boolean
  isDirectory?: (p: string) => boolean
}

/** 产物搬迁规划结果。 */
export interface ArtifactPlanResult {
  moves: ArtifactMove[]
  problems: string[]
  skipped: ArtifactSkip[]
}

/**
 * 规划产物搬迁。
 */
export function planArtifactMoves(options: PlanArtifactOptions): ArtifactPlanResult {
  const {
    sessions,
    fromDir,
    toDir,
    includeKinds = ['created', 'delivered', 'modified'],
    exists = fsExists,
    isDirectory = (p: string): boolean => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    },
  } = options

  const problems: string[] = []
  const skipped: ArtifactSkip[] = []
  const byPath = new Map<
    string,
    { sourcePath: string; kind: string; isDir: boolean; sessionIds: string[] }
  >()

  for (const session of sessions) {
    const { candidates } = extractArtifactsFromLog(session.text, { cwd: fromDir })
    for (const c of candidates) {
      if (!includeKinds.includes(c.kind)) {
        skipped.push({ path: c.path, reason: `kind ${c.kind} excluded`, sessionId: session.id })
        continue
      }
      if (!isInside(c.path, fromDir)) {
        skipped.push({ path: c.path, reason: 'outside the source workspace', sessionId: session.id })
        continue
      }
      if (!exists(c.path)) {
        skipped.push({ path: c.path, reason: 'no longer on disk', sessionId: session.id })
        continue
      }
      const prev = byPath.get(c.path)
      if (prev) prev.sessionIds.push(session.id)
      else byPath.set(c.path, { sourcePath: c.path, kind: c.kind, isDir: isDirectory(c.path), sessionIds: [session.id] })
    }
  }

  // 剪掉被别的 move（目录）包含的路径，避免重复搬迁
  const all = [...byPath.values()].sort((a, b) => a.sourcePath.length - b.sourcePath.length)
  const kept: ArtifactMove[] = []
  for (const m of all) {
    if (kept.some((k) => k.isDir && isInside(m.sourcePath, k.sourcePath))) continue
    kept.push({ ...m, relative: '', targetPath: '' })
  }

  for (const m of kept) {
    // 相对化与拼接都用**产物自己的方言**：它已经被 isInside 认可在 fromDir 之内，两者同源。
    // 用宿主那套算的话，`C:\Users\me\x.txt` 会相对化成一个带盘符的怪串。
    const flavor = flavorFor(m.sourcePath, fromDir)
    const api = apiOf(flavor)
    m.relative = api.relative(canonical(fromDir, flavor), canonical(m.sourcePath, flavor))
    m.targetPath = apiOf(flavorFor(toDir, m.sourcePath)).join(toDir, m.relative)
    if (exists(m.targetPath)) problems.push(`artifact target already exists: ${m.targetPath}`)
  }

  return { moves: kept, problems, skipped }
}

/**
 * 搬迁产物（同卷 rename；跨卷退化为 copy + 删除）。
 */
export function applyArtifactMoves(moves: readonly ArtifactMove[]): { moved: number; copies: number } {
  let moved = 0
  let copies = 0
  for (const m of moves) {
    mkdirSync(dirname(m.targetPath), { recursive: true })
    try {
      renameSync(m.sourcePath, m.targetPath)
      moved++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      cpSync(m.sourcePath, m.targetPath, { recursive: true })
      rmSync(m.sourcePath, { recursive: true, force: true })
      copies++
    }
  }
  return { moved, copies }
}
