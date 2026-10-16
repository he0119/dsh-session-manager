// src/transfer.ts — 会话的导出与导入（`.dshsess` 包）。
//
// 容器形状（一条 gzip 流，`gunzip` 之后就是「清单 + 载荷」）：
//
//   gzip( 'DSHSESS1\n' | u32le 清单长度 | 清单 JSON | 各文件的原始字节 | 各附件对象的原始字节 )
//
// 为什么自己拼一层而不是 tar：本模块只需要"清单 + 一段连续载荷"，而 tar 的 512 字节头、
// 路径长度限制与 PAX 扩展在这个固定用途上全是负担。载荷是**原始日志字节**，不重新编码——
// 日志内部本来就是 zstd 帧，解了再压只会让"导出的东西"与"磁盘上的东西"不再是一回事。
//
// 为什么整包压一层而不是逐文件压：日志的 zstd 帧大多已是压缩态，逐文件再压收益接近零，
// 却把"解出来看一眼"变成要写代码的事。整包 gzip 对**迁移重写过的 raw-block 帧**（未压缩；
// 本包 zstd-frame 的手写编码器产出的就是这种）是实打实的收益，对已压缩的也只是几十字节开销。
//
// 为什么 v2 要带附件对象：日志里只有**引用**（`attachmentId: "sha256:…"`），图片与文件的字节在
// 宿主的附件库里（见 [attachments.ts](./attachments.ts) 的文件头）。只带日志的包换一个 `$DSH_HOME`
// 落地，用户看到的是「图片加载失败，点击重试」，而且点多少次都一样——引用在、对象不在。所以 v2 把
// "这条会话引用到的对象"也放进载荷，清单里各记一条（内容寻址 id、属于哪个库、字节数与偏移）。
//
// 读的兼容面：**一个对象都不带的包照旧写 v1**（清单形状与升级前逐字节同形，装旧版的宿主也读得了），
// **真要带对象才升 v2**；两侧都读 v1 与 v2。向后兼容是刻意的：旧包必须能继续导入，否则"升级一次"
// 就等于把以前导出的东西作废；反过来，没对象的包也没有理由让别人读不了。
//
// 不变式（readBundle 逐条校验，坏包绝不进入导入流程）：
//   - magic 认，formatVersion 落在可读范围内（1..2）；
//   - 每个文件条目的 [offset, offset + bytes) 落在载荷内，且 sha256 对得上；
//   - 每个附件条目的 [offset, offset + bytes) 落在载荷内，且 sha256 等于它 id 里那一段
//     （内容寻址的名字就是内容本身，两者不符时这个对象谁都不该信）；
//   - 会话目录名必须等于 encodeSegment(id)——宿主启动时会校验目录名与 header id 一致，
//     不满足的包要在这里拒掉，而不是让它去污染会话库。
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import {
  commitAttachmentObject,
  decodeLogText,
  isAttachmentId,
  scanAttachmentRefs,
  type AttachmentKind,
  type AttachmentPort,
  type AttachmentRef,
} from './attachments.ts'
import { canonicalDir } from './canonical-path.ts'
import { encodeSegment, sessionDir } from './paths.ts'
import { reHome, writeRegistryAtomic } from './registry.ts'
import { foldTitleInFrames } from './session-title.ts'
import { relocateHeaderCwd, relocateHeaderCwdText } from './session-log.ts'
import type { DecodeAll, ProgressReporter, RegistryChange, SessionLogFile, WorkspaceRegistryState } from './types.ts'

/** 容器 magic。换代时改这一串，而不是悄悄改变字段含义。 */
export const BUNDLE_MAGIC = 'DSHSESS1\n'
/** 写出去的清单格式版本（与 magic 一起构成「这个包我读得懂」的双重判据）。 */
export const BUNDLE_FORMAT_VERSION = 2
/**
 * 还读得懂的最老清单版本。
 *
 * v1 与 v2 的差别只有"有没有 attachments 那一节"，其余字段同义，所以读法共用一条路：v1 读出来就是
 * 一张空的附件表。再老的版本不存在（v1 是本插件第一版包格式）。
 */
export const BUNDLE_MIN_FORMAT_VERSION = 1

/** 导出源：一条已发现的会话。 */
export interface ExportSource {
  id: string
  cwd?: string
  createdAt: number
  /** 会话目录（`<root>/<projectDirName>/<encodeSegment(id)>`）。 */
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

/**
 * 清单里的一个附件对象条目。
 *
 * 不带 `sha256` 字段：`id` 本身就是内容摘要（`sha256:<hex>`），再写一份只会多出"两处不一致"这种
 * 可能性，校验时按 `id` 里那一段核载荷。
 */
export interface BundleAttachmentEntry {
  /** 内容寻址 id（`sha256:<hex>`）。 */
  id: string
  /** 属于哪个库（图片 / 文件）。 */
  kind: AttachmentKind
  bytes: number
  /** 相对载荷起点的偏移。 */
  offset: number
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
  /** 包里的附件对象（v1 包没有这一节，读出来是空表）。 */
  attachments: BundleAttachmentEntry[]
  /** 载荷：各条目原始字节按清单顺序的拼接。 */
  payload: Buffer
}

/** 带了对象的那些列表：导出侧要在包打出之后才知道"带走了几个、还缺几个"。 */
export interface AttachmentPackReport {
  /** 进包的对象条数。 */
  packed: number
  /** 进包对象的字节数（未压缩）。 */
  bytes: number
  /**
   * 日志引用了、但本机附件库里找不到的对象。
   *
   * 不是错误：库里确实可能没有（对象被清理过、会话是从别处搬来的、宿主换过 `$DSH_HOME`）。
   * 这几条照样进包就无从谈起，只能如实报出来——用户看到的是"这几张图带不走"，而不是一个失败。
   */
  missing: AttachmentRef[]
}

/** `buildBundle()` 里附件那一段的依赖。 */
export interface AttachmentPackOptions {
  /** 附件库端口（引用 → 本机绝对路径）。 */
  port: AttachmentPort
  /** 解码器：扫日志里的引用要把日志解开。 */
  decodeAll: DecodeAll
  /** 打包完之后报一次（带走了几个、缺几个）。 */
  onReport?: (report: AttachmentPackReport) => void
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 把若干会话打成 `.dshsess` 字节。
 *
 * 附件的收集分两步：先逐条会话把日志解开、扫出引用（`scanAttachmentRefs()`，同一个对象被多条会话
 * 引用只算一次），再逐个把对象读进来。扫描是这一步多出来的开销，所以只在 `options.attachments` 给了
 * 端口时才做——**没有附件服务的宿主上一个字节都不多解**，那个包照旧是 v1（清单里连 `attachments`
 * 那一节都没有，与升级前同形）。
 *
 * @param sources 会话源（每个源的所有代次文件都进包，保持与磁盘一致）。
 * @param options.now 清单时间戳，便于测试注入。
 * @param options.onProgress 逐条会话报一次（`phase: 'pack'`）：每条要把它全部代次的字节读出来、
 *   算一次 sha256，整库导出时这一步是真花时间的（实测 250 条 / 70.9 MB 约 1.4 秒）。
 * @param options.attachments 附件那一段（端口 + 解码器 + 报告回调）；缺席 = 这个包不带对象。
 * @throws 某个文件读不到时抛错（不产出半成品包）。
 */
export function buildBundle(
  sources: readonly ExportSource[],
  options: {
    now?: string
    source?: BundleSourceInfo
    onProgress?: ProgressReporter
    attachments?: AttachmentPackOptions
  } = {},
): Buffer {
  const parts: Buffer[] = []
  const sessions: BundleSession[] = []
  let offset = 0
  /** 收集到的引用：去重键带上 kind（图片库与文件库里的对象互不相干）。 */
  const wanted = new Map<string, AttachmentRef>()

  for (const [index, source] of sources.entries()) {
    options.onProgress?.({
      phase: 'pack',
      total: sources.length,
      done: index,
      id: source.id,
      // 导出这条路刻意不读标题（见 web.ts 的 exportSessions）：id 就是它手里有的那个名字。
      label: source.id,
    })
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
      if (options.attachments !== undefined) {
        for (const ref of scanAttachmentRefs(decodeLogText(buf, file.compression, options.attachments.decodeAll))) {
          wanted.set(`${ref.kind}:${ref.id}`, ref)
        }
      }
    }
    sessions.push({
      id: source.id,
      cwd: source.cwd,
      createdAt: source.createdAt,
      dirName: encodeSegment(source.id),
      files,
    })
  }

  const attachments: BundleAttachmentEntry[] = []
  const missing: AttachmentRef[] = []
  let attachmentBytes = 0
  if (options.attachments !== undefined) {
    const { port, onReport } = options.attachments
    const list = [...wanted.values()]
    for (const [index, ref] of list.entries()) {
      options.onProgress?.({ phase: 'attach', total: list.length, done: index, id: ref.id })
      const path = port.pathOf(ref)
      if (path === undefined) {
        missing.push(ref)
        continue
      }
      let buf: Buffer
      try {
        buf = readFileSync(path)
      } catch {
        // 端口给了路径但读不到（对象被清掉、权限不对）：与"库里就没有"同一种交代——用户关心的是
        // "这张图这次带不走"，不是 errno。
        missing.push(ref)
        continue
      }
      attachments.push({ id: ref.id, kind: ref.kind, bytes: buf.length, offset })
      parts.push(buf)
      offset += buf.length
      attachmentBytes += buf.length
    }
    onReport?.({ packed: attachments.length, bytes: attachmentBytes, missing })
  }

  /*
   * 格式号按"这个包到底多带了什么"来定，而不是按"这份代码是哪一版"：一个对象都没有（没给端口、
   * 日志里没有引用、或者引用的对象本机就没有）时写 v1——清单里连 `attachments` 那一节都不出现，
   * 与升级前逐字节同形，装旧版的宿主照旧读得了。真要带对象才升 v2，因为那时老宿主确实读不了。
   */
  const formatVersion = attachments.length > 0 ? BUNDLE_FORMAT_VERSION : BUNDLE_MIN_FORMAT_VERSION
  const manifest = JSON.stringify({
    formatVersion,
    createdAt: options.now ?? new Date().toISOString(),
    source: options.source ?? {},
    sessions,
    ...(attachments.length === 0 ? {} : { attachments }),
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
    attachments?: unknown
  }
  const formatVersion = manifest.formatVersion
  if (
    typeof formatVersion !== 'number' ||
    !Number.isInteger(formatVersion) ||
    formatVersion < BUNDLE_MIN_FORMAT_VERSION ||
    formatVersion > BUNDLE_FORMAT_VERSION
  ) {
    throw new Error(`unsupported bundle formatVersion ${String(formatVersion)}`)
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

  // v1 没有这一节（`undefined` 才是"老包"，也是现在写出来的"一个对象都没带"那种包）；空数组是别的
  // 写入者留下的"这包里没有对象"——两者读出来都一样是空表，判定不必再分。写成别的形状就是坏包。
  if (manifest.attachments !== undefined && !Array.isArray(manifest.attachments)) {
    throw new Error('bundle manifest attachments is not an array')
  }
  const attachments: BundleAttachmentEntry[] = []
  for (const value of (manifest.attachments ?? []) as BundleAttachmentEntry[]) {
    if (!isAttachmentId(value?.id)) throw new Error(`bundle attachment has an invalid id ${String(value?.id)}`)
    if (value.kind !== 'image' && value.kind !== 'file') {
      throw new Error(`bundle attachment ${value.id} has an unknown kind ${String(value.kind)}`)
    }
    if (typeof value.bytes !== 'number' || typeof value.offset !== 'number' || value.bytes < 0 || value.offset < 0) {
      throw new Error(`bundle attachment ${value.id} has a malformed entry`)
    }
    if (value.offset + value.bytes > payload.length) {
      throw new Error(`bundle attachment ${value.id} points outside the payload`)
    }
    const slice = payload.subarray(value.offset, value.offset + value.bytes)
    if (sha256(slice) !== value.id.slice('sha256:'.length)) {
      throw new Error(`bundle attachment ${value.id} failed its sha256 check (corrupted bundle)`)
    }
    attachments.push({ id: value.id, kind: value.kind, bytes: value.bytes, offset: value.offset })
  }

  return {
    formatVersion,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    source: (typeof manifest.source === 'object' && manifest.source !== null
      ? manifest.source
      : {}) as BundleSourceInfo,
    sessions,
    attachments,
    payload,
  }
}

/** 取某个文件条目的字节。 */
export function entryBytes(bundle: SessionBundle, entry: BundleFileEntry): Buffer {
  return bundle.payload.subarray(entry.offset, entry.offset + entry.bytes)
}

/** 取某个附件条目的字节（读的时候已按 id 里的 sha256 核过）。 */
export function attachmentBytes(bundle: SessionBundle, entry: BundleAttachmentEntry): Buffer {
  return bundle.payload.subarray(entry.offset, entry.offset + entry.bytes)
}

// ── 导入 ──────────────────────────────────────────────────────────────────

/**
 * 扫一遍会话库，收集**已存在的会话目录名**（encodeSegment(id) → 目录路径，取第一个）。
 *
 * 会话 id 在整库里按注册表记账是全局唯一的，所以冲突检测必须扫所有项目目录，不能只看目标项目目录：
 * 只扫目标项目目录会让同一个 id 在库里悄悄出现两份，而宿主的注册表只记得住一份。
 */
function scanExistingSessionDirs(root: string): Map<string, string> {
  const found = new Map<string, string>()
  let projectDirNames: string[]
  try {
    projectDirNames = readdirSync(root)
  } catch {
    return found
  }
  for (const projectDirName of projectDirNames) {
    const projectDirPath = join(root, projectDirName)
    let entries: string[]
    try {
      if (!statSync(projectDirPath).isDirectory()) continue
      entries = readdirSync(projectDirPath)
    } catch {
      continue
    }
    for (const name of entries) {
      if (found.has(name)) continue
      const path = join(projectDirPath, name)
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
  /**
   * 包里的标题（日志事件里折叠出来的；包里没有就是 undefined，界面此时显示 id）。
   *
   * 不改清单格式：标题本来就在日志里跟着包一起走，再从载荷里读一遍即可（见 `bundleTitle()`）。
   * 因此别的版本/别的工具产出的包，只要日志里有标题事件，这里也能显示。
   */
  title?: string
  action: 'create' | 'skip'
  /** action === 'skip' 时的原因（面向用户，可读）。 */
  reason?: string
  /** 包里的原 cwd（缺省表示这条会话本来就没有 cwd）。 */
  fromCwd?: string
  /** 落盘后的 cwd；包里的会话没有 cwd 时保持没有（落 `_no-cwd` 项目目录）。 */
  toCwd?: string
  /** 目标会话目录。 */
  dir: string
  files: Array<{ name: string; bytes: number }>
}

/** 一次导入的计划（纯计算，不写盘）。 */
export interface ImportPlan {
  /** 有可落地内容（会创建会话，或会补上附件对象）且无阻塞问题。 */
  ok: boolean
  problems: string[]
  entries: ImportEntry[]
  /** 会被创建的会话 id（按包内顺序）。 */
  created: string[]
  /** 会被重新归属到目标工作区的会话 id。 */
  rehomed: string[]
  /** 载荷总字节数（日志）。 */
  bytes: number
  /** 包里的附件对象：本机没有的、本来就在的、落不了的。 */
  attachments: ImportAttachmentEntry[]
  /** 本条会话日志之外的附件字节数（会被写下去的）。 */
  attachmentBytes: number
  /** 会被写进目标附件库的对象条数（`attachments` 里 action === 'create' 的那些）。 */
  attachmentAdds: number
  nextRegistry: WorkspaceRegistryState | null
  registryChange: RegistryChange | null
}

/**
 * 计划里的一条附件对象。
 *
 * 三条分支与"会发生什么"一一对应：`create` 会写下去（本机缺这个对象）、`present` 本机已有（一个字节
 * 都不写）、`unavailable` 落不了（宿主不认识这种引用，或没有附件服务）——最后一种要如实报出来，
 * 因为用户会去界面上找那几张图，而它们不会出现。
 */
export interface ImportAttachmentEntry {
  id: string
  kind: AttachmentKind
  bytes: number
  action: 'create' | 'present' | 'unavailable'
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
  /**
   * 解码器：给了才会读包里的标题（`ImportEntry.title`）。
   *
   * 可选是因为它只影响**展示**：包已经整份在内存里，折叠标题不需要碰盘，但要多解一段字节；
   * 不关心标题的调用方（工具层）不传，就一个字节都不解。
   */
  decodeAll?: DecodeAll
  /**
   * 目标附件库的端口（引用 → 本机绝对路径）。
   *
   * 缺席 = 这个宿主没有附件服务：包里的对象读不出来也落不下去，计划里那几条一律报 `unavailable`，
   * 日志照旧导入（退化成 v1 那种"只带日志"的结果，与升级前一致）。
   */
  attachments?: AttachmentPort
  now?: string
  newId?: string
  /**
   * 预演进度：`scan`（扫一遍库里已有的会话目录，分母 0）→ `read`（逐条读包里的日志折标题，
   * 分母是包里的条数——这一段是导入预演的大头，包里每条会话都要解一段字节）→
   * `attach`（逐个数一遍包里的附件对象在不在本机，分母是包里的对象数）。
   */
  onProgress?: ProgressReporter
}

function hasCwd(session: BundleSession): boolean {
  return session.cwd !== undefined && session.cwd !== null && session.cwd !== ''
}

/**
 * 包里的标题：载荷已经整份在内存里，按代次取最新那一代，在它的开头有界地折一次标题。
 *
 * 只解最新一代的前缀（与 `session-title.readLogTitle` 同一口径）：标题是宿主在会话开头落的，
 * 老代次的标题必然也被后一代继承，代次越新越接近"最后一条生效"。
 * @returns 标题；没有解码器、没有文件或读不到时为 undefined。
 */
function bundleTitle(bundle: SessionBundle, session: BundleSession, decodeAll: DecodeAll | undefined): string | undefined {
  if (decodeAll === undefined) return undefined
  let newest: BundleFileEntry | undefined
  for (const file of session.files) {
    if (newest === undefined || file.version > newest.version) newest = file
  }
  if (newest === undefined) return undefined
  return foldTitleInFrames(bundle.payload.subarray(newest.offset, newest.offset + newest.bytes), decodeAll)
}

/**
 * 规划一次导入（不写任何字节）。
 *
 * 判定顺序（每条会话独立）：
 *   1. 库里已有同 id 的会话目录 → skip。**导入永不覆盖**：冲突只报告，不合并、不顶掉；
 *   2. 其余 → create：日志的 header cwd 改写成 `targetCwd`（原本没有 cwd 的保持没有，
 *      落 `_no-cwd` 项目目录，也就不参与注册表重挂）。
 */
export function planImport(bundle: SessionBundle, options: ImportOptions): ImportPlan {
  const { root, registry, title, decodeAll, now, newId } = options
  /*
   * 落地目录换成宿主存的那个拼写：改写进 header 的 `cwd` 与注册表里那条记录的 `path` 都是它，两者
   * 不一致时宿主认不出这条工作区（见 canonical-path.ts）。没有 cwd 的会话用不到它，空串照旧。
   */
  const targetCwd = canonicalDir(options.targetCwd)
  // 库那一遍扫描没有"第几条"可讲（它是整库的目录项，条数与包里的条数不是一回事）：报一段没有分母的，
  // 界面只说"正在扫描会话库…"，与同步读远端索引那一段同一个口径。
  options.onProgress?.({ phase: 'scan', total: 0, done: 0 })
  const existingDirs = scanExistingSessionDirs(root)
  const entries: ImportEntry[] = []
  const problems: string[] = []
  const created: string[] = []
  const rehomed: string[] = []
  let bytes = 0

  for (const [index, session] of bundle.sessions.entries()) {
    options.onProgress?.({
      phase: 'read',
      total: bundle.sessions.length,
      done: index,
      id: session.id,
      // 标题就是这一步要从日志里折出来的东西，所以它此刻还不知道：用 id 当名字。
      label: session.id,
    })
    const withCwd = hasCwd(session)
    const dir = sessionDir(root, withCwd ? targetCwd : undefined, session.id)
    const files = session.files.map((file) => ({ name: file.name, bytes: file.bytes }))
    const existing = existingDirs.get(encodeSegment(session.id))
    const sessionTitle = bundleTitle(bundle, session, decodeAll)
    const titled = sessionTitle === undefined ? {} : { title: sessionTitle }

    if (existing !== undefined) {
      entries.push({
        id: session.id,
        ...titled,
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
      ...titled,
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

  /*
   * 附件对象与"会话会不会被创建"无关：对象是内容寻址的、只补不改，所以**跳过的会话照样补它的对象**。
   * 这正是"这台机器上已经有日志、只有图挂了"那类现状的修复路径（重导一次同一个包，日志一个字节都不
   * 覆盖，缺的对象补上）。
   */
  const attachmentEntries: ImportAttachmentEntry[] = []
  let attachmentBytes = 0
  let attachmentAdds = 0
  for (const [index, item] of bundle.attachments.entries()) {
    options.onProgress?.({ phase: 'attach', total: bundle.attachments.length, done: index, id: item.id })
    const action = attachmentAction(options.attachments, item)
    if (action === 'create') {
      attachmentBytes += item.bytes
      attachmentAdds += 1
    }
    attachmentEntries.push({ id: item.id, kind: item.kind, bytes: item.bytes, action })
  }

  return {
    ok: problems.length === 0 && (created.length > 0 || attachmentAdds > 0),
    problems,
    entries,
    created,
    rehomed,
    bytes,
    attachments: attachmentEntries,
    attachmentBytes,
    attachmentAdds,
    nextRegistry,
    registryChange,
  }
}

/**
 * 一个对象在本机算什么：要写下去（`create`）、本来就在（`present`）、还是落不了（`unavailable`）。
 *
 * 判据是**路径 + 字节数**：对象名就是内容的 sha256，所以"同名同字节数"已经足够说明本机这份就是它
 * （真读一遍再核 sha256 要把每个对象都过一遍盘，而读写两侧各自都会验一次）。字节数对不上（上次崩在
 * 半途、被人动过）时不报 `present`——那是**会重写**的一支，计划里必须算进"会发生写"的那些。
 *
 * 导入预演与同步两处共用这一条：两处对"本机有没有"必须是同一个说法，否则同一条会话在两个页面会报
 * 不同的数。声明的大小不知道时（老日志的引用里没有 `bytes`）退回"文件在就算在"。
 *
 * @param port 宿主附件库端口；缺席（宿主没有附件服务）= 这一条谁都落不了。
 * @param ref 引用（`bytes` 是日志或清单里声明的字节数，可以没有）。
 */
export function attachmentActionOf(
  port: AttachmentPort | undefined,
  ref: { id: string; kind: AttachmentKind; bytes?: number },
): ImportAttachmentEntry['action'] {
  const path = port?.pathOf({ id: ref.id, kind: ref.kind })
  if (path === undefined) return 'unavailable'
  try {
    return ref.bytes === undefined || statSync(path).size === ref.bytes ? 'present' : 'create'
  } catch {
    return 'create'
  }
}

function attachmentAction(
  port: AttachmentPort | undefined,
  entry: BundleAttachmentEntry,
): ImportAttachmentEntry['action'] {
  return attachmentActionOf(port, entry)
}

/** 落地结果。 */
export interface ImportOutcome {
  written: string[]
  bytes: number
  /** 写进目标附件库的对象条数。 */
  attachmentWritten: number
  /** 本机本来就有、一个字节都没动的对象条数。 */
  attachmentPresent: number
  /** 写下去的附件字节数。 */
  attachmentBytes: number
  /**
   * 没能落地的附件（宿主不认识这种引用、路径写不进去…）。
   *
   * 与日志那条路不同，这里**不抛**：日志是这条包的主体，一个附件写不进去不该让整次导入失败
   * （退化成升级前那种"日志进来了、图还是挂的"），但用户必须看到是哪几个对象没落地。
   */
  attachmentProblems: string[]
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
 * 顺序是**先对象、后日志**：会话目录一旦出现，宿主下一次列会话就会把它连同图片一起读；对象要是这时
 * 还没落下去，用户看到的就是升级前那种"图挂了"。反过来（先日志后对象）会留下一个窗口期，而这段窗口
 * 里的表现正是这次要修掉的那个现象。
 *
 * 每个日志文件先写成 `<规范名>.part` 再 rename 过去：`parseSessionLogName` 不认 `.part`，
 * 所以中途崩溃留下的是"发现阶段会忽略的文件"，而不是一个只有半截日志、却看起来正常的会话
 * ——半个会话被宿主读进去比没有会话更糟。附件对象同理（见 attachments.ts 的
 * `commitAttachmentObject()`）。
 *
 * 附件那一条路**不抛**（见 `ImportOutcome.attachmentProblems`）：日志写不进去是失败，对象写不进去是
 * 这几个对象没补上，退化成升级前的结果而不是整次导入作废。
 *
 * @throws 任一日志文件写失败时抛错；已写完的会话保留，本函数不做跨会话回滚（由报告交代清楚）。
 */
export function applyImport(
  bundle: SessionBundle,
  plan: ImportPlan,
  options: ImportOptions & { decodeAll: DecodeAll; writeRegistry?: boolean },
): ImportOutcome {
  const byId = new Map(bundle.sessions.map((session) => [session.id, session]))
  const written: string[] = []
  let bytes = 0

  const attachmentProblems: string[] = []
  let attachmentWritten = 0
  let attachmentPresent = 0
  let attachmentBytesWritten = 0
  if (bundle.attachments.length > 0) {
    if (options.attachments === undefined) {
      attachmentProblems.push(`这个宿主没有附件服务，包里的 ${bundle.attachments.length} 个附件对象没有落地`)
    } else {
      for (const [index, entry] of bundle.attachments.entries()) {
        options.onProgress?.({ phase: 'attach', total: bundle.attachments.length, done: index, id: entry.id })
        const path = options.attachments.pathOf({ id: entry.id, kind: entry.kind })
        if (path === undefined) {
          attachmentProblems.push(`宿主容不下附件 ${entry.id}（${entry.kind}），这一个没有落地`)
          continue
        }
        try {
          if (commitAttachmentObject(path, attachmentBytes(bundle, entry)) === 'present') {
            attachmentPresent += 1
          } else {
            attachmentWritten += 1
            attachmentBytesWritten += entry.bytes
          }
        } catch (error) {
          attachmentProblems.push(
            `附件 ${entry.id} 落地失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  const creating = plan.entries.filter((entry) => entry.action === 'create')
  for (const [index, entry] of creating.entries()) {
    // 逐条会话报一次：分母是**会创建**的那些（跳过的那些一个字节都不写，算进分母进度条就走不满）。
    options.onProgress?.({
      phase: 'write',
      total: creating.length,
      done: index,
      id: entry.id,
      label: entry.title ?? entry.id,
    })
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
    options.onProgress?.({ phase: 'registry', total: 0, done: 0 })
    writeRegistryAtomic(options.registryPath, plan.nextRegistry)
    registryWritten = true
  }

  return {
    written,
    bytes,
    attachmentWritten,
    attachmentPresent,
    attachmentBytes: attachmentBytesWritten,
    attachmentProblems,
    registryWritten,
  }
}
