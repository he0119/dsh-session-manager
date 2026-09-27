// src/transfer.ts — 会话的导出与导入（`.dshsess` 包）。
//
// 容器形状（一条 gzip 流，`gunzip` 之后就是「清单 + 载荷」）：
//
//   gzip( 'DSHSESS1\n' | u32le 清单长度 | 清单 JSON | 各文件的原始字节 )
//
// 为什么自己拼一层而不是 tar：本模块只需要"清单 + 一段连续载荷"，而 tar 的 512 字节头、
// 路径长度限制与 PAX 扩展在这个固定用途上全是负担。载荷是**原始日志字节**，不重新编码——
// 日志内部本来就是 zstd 帧，解了再压只会让"导出的东西"与"磁盘上的东西"不再是一回事。
//
// 为什么整包压一层而不是逐文件压：日志的 zstd 帧大多已是压缩态，逐文件再压收益接近零，
// 却把"解出来看一眼"变成要写代码的事。整包 gzip 对**迁移重写过的 raw-block 帧**（未压缩；
// 本包 zstd-frame 的手写编码器产出的就是这种）是实打实的收益，对已压缩的也只是几十字节开销。
//
// 不变式（readBundle 逐条校验，坏包绝不进入导入流程）：
//   - magic 与 formatVersion 都认；
//   - 每个文件条目的 [offset, offset + bytes) 落在载荷内，且 sha256 对得上；
//   - 会话目录名必须等于 encodeSegment(id)——宿主启动时会校验目录名与 header id 一致，
//     不满足的包要在这里拒掉，而不是让它去污染会话库。
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { encodeSegment, sessionDir } from './paths.ts'
import { reHome, writeRegistryAtomic } from './registry.ts'
import { relocateHeaderCwd, relocateHeaderCwdText } from './session-log.ts'
import type { DecodeAll, RegistryChange, SessionLogFile, WorkspaceRegistryState } from './types.ts'

/** 容器 magic。换代时改这一串，而不是悄悄改变字段含义。 */
export const BUNDLE_MAGIC = 'DSHSESS1\n'
/** 清单格式版本（与 magic 一起构成「这个包我读得懂」的双重判据）。 */
export const BUNDLE_FORMAT_VERSION = 1

/** 导出源：一条已发现的会话。 */
export interface ExportSource {
  id: string
  cwd?: string
  createdAt: number
  /** 会话目录（`<root>/<bucket>/<encodeSegment(id)>`）。 */
  dir: string
  /** 该目录里的代次日志文件（由 discovery 给出，按代次升序）。 */
  files: readonly SessionLogFile[]
}

/** 清单里的一个文件条目。 */
export interface BundleFileEntry {
  name: string
  version: number
  compression: string | null
  bytes: number
  /** 相对载荷起点的偏移。 */
  offset: number
  sha256: string
}

/** 清单里的一条会话。 */
export interface BundleSession {
  id: string
  cwd?: string
  createdAt: number
  /** 导出时的目录名；导入前与 encodeSegment(id) 对照。 */
  dirName: string
  files: BundleFileEntry[]
}

/** 清单的来源信息（只用于展示与排查，不参与任何判定）。 */
export interface BundleSourceInfo {
  sessionsRoot?: string
  pluginVersion?: string
  note?: string
}

/** 解析后的一个包。 */
export interface SessionBundle {
  formatVersion: number
  createdAt: string
  source: BundleSourceInfo
  sessions: BundleSession[]
  /** 载荷：各条目原始字节按清单顺序的拼接。 */
  payload: Buffer
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 把若干会话打成 `.dshsess` 字节。
 * @param sources 会话源（每个源的所有代次文件都进包，保持与磁盘一致）。
 * @param options.now 清单时间戳，便于测试注入。
 * @throws 某个文件读不到时抛错（不产出半成品包）。
 */
export function buildBundle(
  sources: readonly ExportSource[],
  options: { now?: string; source?: BundleSourceInfo } = {},
): Buffer {
  const parts: Buffer[] = []
  const sessions: BundleSession[] = []
  let offset = 0

  for (const source of sources) {
    if (!source.files.length) throw new Error(`session ${source.id} has no log files to export`)
    const files: BundleFileEntry[] = []
    for (const file of source.files) {
      const buf = readFileSync(file.path)
      files.push({
        name: file.name,
        version: file.version,
        compression: file.compression,
        bytes: buf.length,
        offset,
        sha256: sha256(buf),
      })
      parts.push(buf)
      offset += buf.length
    }
    sessions.push({
      id: source.id,
      cwd: source.cwd,
      createdAt: source.createdAt,
      dirName: encodeSegment(source.id),
      files,
    })
  }

  const manifest = JSON.stringify({
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: options.now ?? new Date().toISOString(),
    source: options.source ?? {},
    sessions,
  })
  const manifestBytes = Buffer.from(manifest, 'utf8')
  const header = Buffer.alloc(BUNDLE_MAGIC.length + 4)
  header.write(BUNDLE_MAGIC, 0, 'utf8')
  header.writeUInt32LE(manifestBytes.length, BUNDLE_MAGIC.length)

  return gzipSync(Buffer.concat([header, manifestBytes, ...parts]))
}

/**
 * 解析并校验一个包。
 * @param bytes 包字节（`.dshsess` 原文）。
 * @throws 任何一项不变式不满足时抛错，消息指出是哪一条。
 */
export function readBundle(bytes: Buffer): SessionBundle {
  let raw: Buffer
  try {
    raw = gunzipSync(bytes)
  } catch (error) {
    throw new Error(
      `not a gzip-compressed session bundle: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (raw.length < BUNDLE_MAGIC.length + 4) throw new Error('bundle is truncated before its manifest')
  if (raw.subarray(0, BUNDLE_MAGIC.length).toString('utf8') !== BUNDLE_MAGIC) {
    throw new Error('bundle magic mismatch (not a .dshsess file, or made by an incompatible version)')
  }

  const manifestLength = raw.readUInt32LE(BUNDLE_MAGIC.length)
  const manifestStart = BUNDLE_MAGIC.length + 4
  const payloadStart = manifestStart + manifestLength
  if (manifestLength <= 0 || payloadStart > raw.length) throw new Error('bundle manifest length is out of range')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.subarray(manifestStart, payloadStart).toString('utf8'))
  } catch (error) {
    throw new Error(
      `bundle manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('bundle manifest is not an object')
  const manifest = parsed as {
    formatVersion?: unknown
    createdAt?: unknown
    source?: unknown
    sessions?: unknown
  }
  if (manifest.formatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new Error(`unsupported bundle formatVersion ${String(manifest.formatVersion)}`)
  }
  if (!Array.isArray(manifest.sessions)) throw new Error('bundle manifest has no sessions array')

  const payload = raw.subarray(payloadStart)
  const sessions: BundleSession[] = []
  for (const value of manifest.sessions as BundleSession[]) {
    if (typeof value?.id !== 'string' || value.id === '') throw new Error('bundle session without an id')
    const expectedDir = encodeSegment(value.id)
    if (value.dirName !== expectedDir) {
      throw new Error(`bundle session ${value.id} has dirName ${String(value.dirName)}, expected ${expectedDir}`)
    }
    if (!Array.isArray(value.files) || value.files.length === 0) {
      throw new Error(`bundle session ${value.id} carries no log files`)
    }
    for (const file of value.files) {
      if (typeof file?.name !== 'string' || typeof file.bytes !== 'number' || typeof file.offset !== 'number') {
        throw new Error(`bundle session ${value.id} has a malformed file entry`)
      }
      if (file.offset < 0 || file.bytes < 0 || file.offset + file.bytes > payload.length) {
        throw new Error(`bundle session ${value.id} file ${file.name} points outside the payload`)
      }
      const slice = payload.subarray(file.offset, file.offset + file.bytes)
      if (sha256(slice) !== file.sha256) {
        throw new Error(`bundle session ${value.id} file ${file.name} failed its sha256 check (corrupted bundle)`)
      }
    }
    sessions.push({
      id: value.id,
      cwd: value.cwd,
      createdAt: value.createdAt,
      dirName: value.dirName,
      files: value.files,
    })
  }

  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    source: (typeof manifest.source === 'object' && manifest.source !== null
      ? manifest.source
      : {}) as BundleSourceInfo,
    sessions,
    payload,
  }
}

/** 取某个文件条目的字节。 */
export function entryBytes(bundle: SessionBundle, entry: BundleFileEntry): Buffer {
  return bundle.payload.subarray(entry.offset, entry.offset + entry.bytes)
}

// ── 导入 ──────────────────────────────────────────────────────────────────

/**
 * 扫一遍会话库，收集**已存在的会话目录名**（encodeSegment(id) → 目录路径，取第一个）。
 *
 * 会话 id 在整库里按注册表记账是全局唯一的，所以冲突检测必须扫所有分桶，不能只看目标分桶：
 * 只扫目标分桶会让同一个 id 在库里悄悄出现两份，而宿主的账本只记得住一份。
 */
function scanExistingSessionDirs(root: string): Map<string, string> {
  const found = new Map<string, string>()
  let buckets: string[]
  try {
    buckets = readdirSync(root)
  } catch {
    return found
  }
  for (const bucket of buckets) {
    const bucketPath = join(root, bucket)
    let entries: string[]
    try {
      if (!statSync(bucketPath).isDirectory()) continue
      entries = readdirSync(bucketPath)
    } catch {
      continue
    }
    for (const name of entries) {
      if (found.has(name)) continue
      const path = join(bucketPath, name)
      try {
        if (statSync(path).isDirectory()) found.set(name, path)
      } catch {
        // 竞态：扫描期间被删掉了，忽略
      }
    }
  }
  return found
}

/** 导入计划里的一条会话。 */
export interface ImportEntry {
  id: string
  action: 'create' | 'skip'
  /** action === 'skip' 时的原因（面向用户，可读）。 */
  reason?: string
  /** 包里的原 cwd（缺省表示这条会话本来就没有 cwd）。 */
  fromCwd?: string
  /** 落盘后的 cwd；包里的会话没有 cwd 时保持没有（落 `_no-cwd` 分桶）。 */
  toCwd?: string
  /** 目标会话目录。 */
  dir: string
  files: Array<{ name: string; bytes: number }>
}

/** 一次导入的计划（纯计算，不写盘）。 */
export interface ImportPlan {
  /** 有可落地内容且无阻塞问题。 */
  ok: boolean
  problems: string[]
  entries: ImportEntry[]
  /** 会被创建的会话 id（按包内顺序）。 */
  created: string[]
  /** 会被重新归属到目标工作区的会话 id。 */
  rehomed: string[]
  /** 载荷总字节数。 */
  bytes: number
  nextRegistry: WorkspaceRegistryState | null
  registryChange: RegistryChange | null
}

/** `planImport()` / `applyImport()` 的选项。 */
export interface ImportOptions {
  /** 会话库根目录。 */
  root: string
  /** 目标工作区目录；包里**有** cwd 的会话会被改写成它。 */
  targetCwd: string
  /** 当前注册表（缺省则不动注册表，导入的会话落成"未分组"）。 */
  registry?: WorkspaceRegistryState
  /** 注册表路径；给了才会落盘。 */
  registryPath?: string
  /** 新建工作区的显示标题。 */
  title?: string
  now?: string
  newId?: string
}

function hasCwd(session: BundleSession): boolean {
  return session.cwd !== undefined && session.cwd !== null && session.cwd !== ''
}

/**
 * 规划一次导入（不写任何字节）。
 *
 * 判定顺序（每条会话独立）：
 *   1. 库里已有同 id 的会话目录 → skip。**导入永不覆盖**：冲突只报告，不合并、不顶掉；
 *   2. 其余 → create：日志的 header cwd 改写成 `targetCwd`（原本没有 cwd 的保持没有，
 *      落 `_no-cwd` 分桶，也就不参与注册表重挂）。
 */
export function planImport(bundle: SessionBundle, options: ImportOptions): ImportPlan {
  const { root, targetCwd, registry, title, now, newId } = options
  const existingDirs = scanExistingSessionDirs(root)
  const entries: ImportEntry[] = []
  const problems: string[] = []
  const created: string[] = []
  const rehomed: string[] = []
  let bytes = 0

  for (const session of bundle.sessions) {
    const withCwd = hasCwd(session)
    const dir = sessionDir(root, withCwd ? targetCwd : undefined, session.id)
    const files = session.files.map((file) => ({ name: file.name, bytes: file.bytes }))
    const existing = existingDirs.get(encodeSegment(session.id))

    if (existing !== undefined) {
      entries.push({
        id: session.id,
        action: 'skip',
        reason: `这个库里已经有同 id 的会话：${existing}`,
        fromCwd: session.cwd,
        dir,
        files,
      })
      continue
    }

    entries.push({
      id: session.id,
      action: 'create',
      fromCwd: session.cwd,
      toCwd: withCwd ? targetCwd : undefined,
      dir,
      files,
    })
    created.push(session.id)
    if (withCwd) rehomed.push(session.id)
    for (const file of session.files) bytes += file.bytes
  }

  let nextRegistry: WorkspaceRegistryState | null = null
  let registryChange: RegistryChange | null = null
  if (registry !== undefined && rehomed.length > 0) {
    try {
      const result = reHome(registry, { sessionIds: rehomed, toPath: targetCwd, title, now, newId })
      nextRegistry = result.registry
      registryChange = result.change
    } catch (error) {
      problems.push(`注册表无法重挂：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    ok: problems.length === 0 && created.length > 0,
    problems,
    entries,
    created,
    rehomed,
    bytes,
    nextRegistry,
    registryChange,
  }
}

/** 落地结果。 */
export interface ImportOutcome {
  written: string[]
  bytes: number
  /** 注册表是否已落盘。 */
  registryWritten: boolean
}

/** 按文件的压缩形态改写 header cwd：zstd 帧走保结构的帧改写，明文走同义的行改写。 */
function rewriteCwd(buf: Buffer, compression: string | null, to: string, decodeAll: DecodeAll): Buffer {
  if (compression === 'zstd') return relocateHeaderCwd(buf, { to, decodeAll }).buffer
  return Buffer.from(relocateHeaderCwdText(buf.toString('utf8'), to).text, 'utf8')
}

/**
 * 落地一次导入。
 *
 * 每个文件先写成 `<规范名>.part` 再 rename 过去：`parseSessionLogName` 不认 `.part`，
 * 所以中途崩溃留下的是"发现阶段会忽略的文件"，而不是一个只有半截日志、却看起来正常的会话
 * ——半个会话被宿主读进去比没有会话更糟。
 *
 * @throws 任一文件写失败时抛错；已写完的会话保留，本函数不做跨会话回滚（由报告交代清楚）。
 */
export function applyImport(
  bundle: SessionBundle,
  plan: ImportPlan,
  options: ImportOptions & { decodeAll: DecodeAll; writeRegistry?: boolean },
): ImportOutcome {
  const byId = new Map(bundle.sessions.map((session) => [session.id, session]))
  const written: string[] = []
  let bytes = 0

  for (const entry of plan.entries) {
    if (entry.action !== 'create') continue
    const session = byId.get(entry.id)
    if (!session) throw new Error(`internal error: plan entry ${entry.id} has no session in the bundle`)

    mkdirSync(entry.dir, { recursive: true })
    for (const file of session.files) {
      const raw = entryBytes(bundle, file)
      const next = entry.toCwd === undefined ? raw : rewriteCwd(raw, file.compression, entry.toCwd, options.decodeAll)
      const part = join(entry.dir, `${file.name}.part`)
      writeFileSync(part, next)
      renameSync(part, join(entry.dir, file.name))
      bytes += next.length
    }
    written.push(entry.id)
  }

  let registryWritten = false
  if (options.writeRegistry !== false && plan.nextRegistry !== null && options.registryPath !== undefined) {
    writeRegistryAtomic(options.registryPath, plan.nextRegistry)
    registryWritten = true
  }

  return { written, bytes, registryWritten }
}
