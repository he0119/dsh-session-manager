// src/sync.ts — 把 WebDAV 当**运输层**的会话同步（计划与落地）。
//
// 远端不是"库"，只是一批包加一份索引：
//
//   <url>/dsh-session-manager/<machineId>/index.json       这台机器贡献了哪些会话
//   <url>/dsh-session-manager/<machineId>/<encodeSegment(id)>.dshsess   一条会话一个包
//
// 最上面那一层插件命名空间（`SYNC_NAMESPACE_DIR`）由本插件独占、机器格直接放在它下面：`url` 因此可以
// 填服务器根或账号根，而不是必须精确指到一个专供本插件的集合。命名空间与机器格都由 `put()` 的逐层
// MKCOL 自建。
//
// 为什么远端不能直接放会话库：库里的目录名是 `projectKey(cwd)`，header 里的 `cwd` 又与目录名绑死
// （见 paths.ts）。两台机器的同一个项目路径不同，字节级的库互不相认。所以这里只放大包，落地一律
// 走 `transfer.ts` 的 `planImport/applyImport`——由它把 `cwd` 改写成**这台机器**的路径。
//
// 为什么一机一格：WebDAV 没有锁，多台机器共写一份 `index.json` 就是"后写的盖掉先写的"。每台机器
// 只写自己那一格、读别人的全部，就不需要锁。
//
// 冲突口径与 `transfer.ts` 一致：**只增不覆盖**。库里已有同 id 的会话就不拉；远端那份比自己新的
// 也照样不动，只在报告里说清楚（见 `relation()` 的四种关系）。反过来，如果本机严格领先于远端，
// 就把包重推一次——此时两边共有的代次逐条一致，远端那份确实是本地这份的前缀，覆盖不会丢数据。
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { DavPort } from './dav.ts'
import { scanAll, type DiscoveredSession } from './discovery.ts'
import { encodeSegment } from './paths.ts'
import { createGitRunner, repoLocation, type GitRunner, type RepoLocation } from './repo.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import { relocateHeaderCwd, relocateHeaderCwdText } from './session-log.ts'
import type { TitleQuery } from './session-title.ts'
import { applyImport, buildBundle, planImport, readBundle, type ExportSource, type ImportOptions } from './transfer.ts'
import type { DecodeAll, WorkspaceRegistryState } from './types.ts'

/** 远端本插件独占的那层目录（相对资源根），机器格就放在它下面：`url` 可以填服务器/账号根。 */
export const SYNC_NAMESPACE_DIR = 'dsh-session-manager'
/** 每台机器自己的索引文件名。 */
export const SYNC_INDEX_FILE = 'index.json'
/** 会话包的后缀（与界面上导出的文件同名同格式）。 */
export const SYNC_BUNDLE_EXT = '.dshsess'
/** 索引里的自描述标识（别的工具写进来的 index.json 不该被当成自己人）。 */
export const SYNC_INDEX_UNIT = 'dsh-session-manager/sync'
/** 当前索引格式版本。 */
export const SYNC_INDEX_VERSION = 1

/** 解析后的同步设置（配置里的原始形态见 tools.ts 的 `SyncConfig`）。 */
export interface SyncSettings {
  /** 远端资源根（WebDAV 集合）。 */
  url: string
  /** 这台机器的标识（也是它在远端占的那一格的目录名）。 */
  machineId: string
  /** 显式映射：远端 `cwd` → 这台机器上的目录。 */
  mapping: Record<string, string>
  username?: string
  password?: string
  timeoutMs?: number
}

/** 一条会话里某个代次日志的指纹。 */
export interface FileFingerprint {
  version: number
  bytes: number
  sha256: string
}

/** 远端索引里的一条会话。 */
export interface RemoteSessionEntry {
  id: string
  cwd?: string
  title?: string
  /** 跨机器的项目身份（仓库 remote 规范化之后，见 [repo.ts](./repo.ts)）；老索引没有这一项。 */
  repo?: string
  /** 会话的 cwd 在仓库根之下的相对路径（POSIX 分隔符，仓库根是 `.`）。 */
  repoPath?: string
  createdAt: number
  files: FileFingerprint[]
  /** 贡献这条记录的机器 id（拉包时要知道去哪个格子取）。 */
  machine: string
}

/** 一台机器写下的索引（`index.json` 的解析结果）。 */
export interface RemoteIndex {
  machineId: string
  updatedAt?: string
  pluginVersion?: string
  entries: Array<Omit<RemoteSessionEntry, 'machine'>>
}

/** 远端读回来的东西。 */
export interface RemoteLibrary {
  /** 读到索引的机器 id（按目录名排序）。 */
  machines: string[]
  /** id → 条目；同一个 id 有多台机器贡献时取领先的那份，否则按机器 id 排序取第一个（结果确定）。 */
  entries: Map<string, RemoteSessionEntry>
  /** 各机器的索引（推送时要在自己那份上做增量）。 */
  indexes: Map<string, RemoteIndex>
  problems: string[]
}

/** 映射表归一化结果。 */
export interface NormalizedMapping {
  mapping: Map<string, string>
  problems: string[]
}

/**
 * 归一化映射表。
 *
 * 归一化只做一件事：去掉结尾分隔符（`/a/b/` 与 `/a/b` 是同一个目录）。**不做**大小写折叠——
 * Windows 上大小写差异由使用者自己对齐，猜错了会把会话落到一个不是他要的目录里。
 * @param raw 配置里的映射表。
 * @returns 归一化后的映射与它的问题（空键、空值、归一化后重复）。
 */
export function normalizeMapping(raw: Record<string, string> | undefined): NormalizedMapping {
  const mapping = new Map<string, string>()
  const problems: string[] = []
  for (const [from, to] of Object.entries(raw ?? {})) {
    const key = String(from).trim().replace(/(.)\/+$/, '$1')
    const value = String(to).trim().replace(/(.)\/+$/, '$1')
    if (key === '') {
      problems.push('同步映射里有一条空的来源路径（远端 cwd）')
      continue
    }
    if (value === '') {
      problems.push(`同步映射 ${key} 的目标是空路径`)
      continue
    }
    if (mapping.has(key)) {
      problems.push(`同步映射里 ${key} 出现了两次（去掉结尾斜杠之后重名）`)
      continue
    }
    mapping.set(key, value)
  }
  return { mapping, problems }
}

/** 机器格的目录名。 */
export function machineDirName(machineId: string): string {
  return encodeSegment(machineId)
}

/** 某个格子里那条会话的包路径（相对资源根）。 */
export function remoteBundlePath(machineId: string, id: string): string {
  return `${SYNC_NAMESPACE_DIR}/${machineDirName(machineId)}/${encodeSegment(id)}${SYNC_BUNDLE_EXT}`
}

/** 某个格子的索引路径（相对资源根）。 */
export function remoteIndexPath(machineId: string): string {
  return `${SYNC_NAMESPACE_DIR}/${machineDirName(machineId)}/${SYNC_INDEX_FILE}`
}

/** 默认的文件指纹：整文件 sha256。 */
export function fileFingerprint(path: string, version: number): FileFingerprint {
  const bytes = readFileSync(path)
  return { version, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * 会话各代次日志的指纹。
 *
 * `hashFile` 收 `compression` 是因为"与 cwd 无关的内容指纹"要先按压缩形态解出首帧（见
 * [contentFingerprint]）；只按字节哈希的实现忽略这个参数即可。
 */
function fingerprints(
  session: DiscoveredSession,
  hashFile: (path: string, version: number, compression: string | null) => FileFingerprint,
): FileFingerprint[] {
  return session.files.map((file) => hashFile(file.path, file.version, file.compression))
}

/** 用来比较的内容指纹里，header 的 cwd 归一化成的占位符（NUL 不可能出现在真实路径里）。 */
const CWD_PLACEHOLDER = '\u0000dsm-sync-cwd'

/** 把 header 的 cwd 抹成占位符之后的内容字节；认不出的形态原样返回（退回按字节比）。 */
function contentBytes(bytes: Buffer, compression: string | null, decodeAll: DecodeAll): Buffer {
  try {
    return compression === 'zstd'
      ? relocateHeaderCwd(bytes, { to: CWD_PLACEHOLDER, decodeAll }).buffer
      : Buffer.from(relocateHeaderCwdText(bytes.toString('utf8'), CWD_PLACEHOLDER).text, 'utf8')
  } catch {
    return bytes
  }
}

/**
 * 与"这台机器上的 cwd"无关的内容指纹。
 *
 * 落地会把别人的 cwd 改写成这台机器的路径（库目录名与 header 的 `cwd` 绑死，不改写就落不下来），
 * 于是同一份会话在两台机器上的**字节不同**。判据要是按字节比，拉下来的那份会被判成"两边各自写过"：
 * 报告里的理由是错的（其实是同一份），更要紧的是它在那台机器上**继续写之后也推不回去**——新代次永远
 * 留在本机。所以索引里存的是把 cwd 归一化之后的哈希：cwd 是"这份会话在这台机器上落在哪儿"，不是
 * "这是哪份会话"。
 *
 * `bytes` 仍然是文件的真实字节数（报告里的体积得是真数）。
 *
 * @param path 日志文件路径。
 * @param version 代次。
 * @param compression 压缩形态（`zstd` 走保结构的帧改写，明文走同义的行改写）。
 * @param decodeAll 多帧感知解码器。
 * @returns 指纹。
 */
export function contentFingerprint(
  path: string,
  version: number,
  compression: string | null,
  decodeAll: DecodeAll,
): FileFingerprint {
  const bytes = readFileSync(path)
  const content = contentBytes(bytes, compression, decodeAll)
  return { version, bytes: bytes.length, sha256: createHash('sha256').update(content).digest('hex') }
}

/** 两条会话的代次集合是否完全一样。 */
function sameVersions(left: readonly FileFingerprint[], right: readonly FileFingerprint[]): boolean {
  if (left.length !== right.length) return false
  const versions = new Set(right.map((file) => file.version))
  return left.every((file) => versions.has(file.version))
}

/** `left` 的代次是不是 `right` 的严格超集（相等不算）。 */
function versionsAhead(left: readonly FileFingerprint[], right: readonly FileFingerprint[]): boolean {
  const mine = new Set(left.map((file) => file.version))
  const theirs = new Set(right.map((file) => file.version))
  if (mine.size <= theirs.size) return false
  for (const version of theirs) if (!mine.has(version)) return false
  return true
}

/** 共有代次的内容是否逐条一致（"这两份是不是同一个东西"）。 */
function sameContent(left: readonly FileFingerprint[], right: readonly FileFingerprint[]): boolean {
  const theirs = new Map(right.map((file) => [file.version, file.sha256]))
  for (const file of left) {
    const other = theirs.get(file.version)
    if (other !== undefined && other !== file.sha256) return false
  }
  return true
}

/** 同一 id 在两边的关系。 */
export type SyncRelation = 'identical' | 'local-ahead' | 'remote-ahead' | 'diverged'

/**
 * 判两个副本的关系。
 * @param mine 本机这份的代次指纹。
 * @param theirs 远端那份的代次指纹。
 * @returns 四种关系之一；不在这四种里的都归 `diverged`（分叉）。
 */
export function relation(mine: readonly FileFingerprint[], theirs: readonly FileFingerprint[]): SyncRelation {
  if (sameVersions(mine, theirs)) return sameContent(mine, theirs) ? 'identical' : 'diverged'
  if (sameContent(mine, theirs)) {
    if (versionsAhead(mine, theirs)) return 'local-ahead'
    if (versionsAhead(theirs, mine)) return 'remote-ahead'
  }
  return 'diverged'
}

/** 代次列表的可读描述（报告里用）。 */
function versionsText(files: readonly FileFingerprint[]): string {
  const versions = files.map((file) => file.version).sort((a, b) => a - b)
  if (versions.length === 0) return '无日志'
  const first = versions[0] as number
  const last = versions[versions.length - 1] as number
  return first === last ? `v${first}` : `v${first}–v${last}`
}

/** 拉取方向的一条。 */
export interface SyncPullEntry {
  id: string
  title?: string
  /** 包里的原 cwd。 */
  fromCwd?: string
  /** 落盘后的 cwd（没有 cwd 的会话没有这一项，落 `_no-cwd`）。 */
  toCwd?: string
  /** 贡献这条的机器。 */
  machine: string
  /** 包里这些日志的字节数（用于报告）。 */
  bytes: number
  action: 'create' | 'skip'
  /** 机器可读的分类（界面按它挑文案与过滤，不去解析 `reason`）。 */
  code: 'missing' | 'no-mapping' | 'missing-target'
  reason?: string
}

/** 推送方向的一条。 */
export interface SyncPushEntry {
  id: string
  title?: string
  cwd?: string
  /** 本地这份的字节数（未压缩；远端实际收到的是 gzip 之后的包）。 */
  bytes: number
  action: 'upload' | 'update' | 'skip'
  /** 机器可读的分类（界面按它挑文案与过滤，不去解析 `reason`）。 */
  code: 'missing' | 'local-ahead' | 'identical' | 'remote-ahead' | 'diverged'
  /** 远端那一份由哪台机器贡献（"远端领先 / 两边各自写过"要指名道姓）。 */
  machine?: string
  reason?: string
}

/** 一次同步的计划（纯计算，不碰网络也不写盘）。 */
export interface SyncPlan {
  /** 没有阻塞问题（映射配错、目标目录不存在等）。 */
  ok: boolean
  problems: string[]
  pull: SyncPullEntry[]
  push: SyncPushEntry[]
  /** 会被拉下来的会话 id。 */
  pullIds: string[]
  /** 会被推上去的会话 id（`upload` 与 `update` 都在里面）。 */
  pushIds: string[]
  bytesIn: number
  bytesOut: number
  localCount: number
  remoteCount: number
  /** 远端有索引的机器。 */
  machines: string[]
}

/** `planSync()` 的入参。 */
export interface SyncPlanInput {
  /** 本机整库（`scanAll()` 的结果）。 */
  local: readonly DiscoveredSession[]
  remote: RemoteLibrary
  mapping: ReadonlyMap<string, string>
  /**
   * 身份 → 本机仓库根（`repoLocation()` 扫出来的）。
   *
   * 两张表的分工：`mapping` 是用户显式配的（他说了算），`repos` 是从本机磁盘上认出来的项目。显式的
   * 先赢——配了映射就按映射落地，不会因为"本机恰好也有这个仓库"而改道。两边都没有就跳过（照旧）。
   */
  repos?: ReadonlyMap<string, string>
  /** 算指纹；计划阶段只对"两边都有"的会话算（整库哈希不该被白算）。 */
  hashFile?: (path: string, version: number, compression: string | null) => FileFingerprint
  /** 目标目录是不是真的存在（映射对不上真实目录就不落地）。 */
  isDirectory?: (path: string) => boolean
}

/**
 * 本机仓库根 + 仓库内相对路径 → 落地目录。
 *
 * 相对路径来自**别的机器**（那边记的是 POSIX 分隔符），这里交给 `join` 归一化：同一平台内是拼路径，
 * 跨平台时 `join` 会把 `/` 当分隔符处理，落到本机该有的形状。
 */
function joinRepoPath(root: string, repoPath: string | undefined): string {
  return repoPath === undefined || repoPath === '.' ? root : join(root, repoPath)
}

/** 默认的目录判据。 */
function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 算一次同步的计划：哪几条拉下来、哪几条推上去、哪些不动和为什么。
 *
 * 判定顺序：
 *   1. 远端有、本机没有 → 拉（`cwd` 要能映射到本机一个真实存在的目录；没有 `cwd` 的会话不需要映射）；
 *   2. 本机有 → 远端没有就推；两边都有就**一律不拉**（只增不覆盖）：
 *      - 内容一致 → 不动；
 *      - 本机严格领先（共有的代次逐条一致）→ 重推一次，把远端刷新到最新；
 *      - 远端领先 / 两边各自写过 → 不动，理由里写清是哪一种。
 *
 * @param input 本机库、远端索引、映射表与两个可注入的判据。
 * @returns 计划；`problems` 非空时 `ok` 为 false。
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const hashFile = input.hashFile ?? fileFingerprint
  const isDirectory = input.isDirectory ?? defaultIsDirectory
  const problems: string[] = []
  const local = new Map(input.local.map((session) => [session.id, session]))
  const pull: SyncPullEntry[] = []
  const push: SyncPushEntry[] = []
  const pullIds: string[] = []
  const pushIds: string[] = []
  let bytesIn = 0
  let bytesOut = 0

  // 远端独有的：拉。cwd 要能落到本机一个真实存在的目录，否则这条跳过（报告里说清为什么）。
  for (const [id, entry] of input.remote.entries) {
    if (local.has(id)) continue
    const bytes = entry.files.reduce((sum, file) => sum + file.bytes, 0)
    const base = {
      id,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.cwd === undefined ? {} : { fromCwd: entry.cwd }),
      machine: entry.machine,
      bytes,
    }
    if (entry.cwd === undefined) {
      // 没有 cwd 的会话不硬塞一个：照着包里的样子落 `_no-cwd`，也不进注册表（与导入同一条口径）。
      pull.push({ ...base, action: 'create', code: 'missing' })
      pullIds.push(id)
      bytesIn += bytes
      continue
    }
    // 落地顺序：显式映射（用户配了就算数）→ 仓库身份 + 仓库内相对路径（配置不必每台机器一份）→ 跳过。
    const viaRepo = entry.repo === undefined ? undefined : input.repos?.get(entry.repo)
    const target =
      input.mapping.get(entry.cwd) ??
      (viaRepo === undefined ? undefined : joinRepoPath(viaRepo, entry.repoPath))
    if (target === undefined) {
      pull.push({
        ...base,
        action: 'skip',
        code: 'no-mapping',
        reason:
          `没有 ${entry.cwd} → 本机的同步映射，先补映射再同步` +
          (entry.repo === undefined ? '' : `；也没在本机找到仓库 ${entry.repo}`),
      })
      continue
    }
    if (!isDirectory(target)) {
      problems.push(`同步映射把 ${entry.cwd} 指到了 ${target}，但那不是一个存在的目录`)
      pull.push({ ...base, toCwd: target, action: 'skip', code: 'missing-target', reason: `目标目录不存在：${target}` })
      continue
    }
    pull.push({ ...base, toCwd: target, action: 'create', code: 'missing' })
    pullIds.push(id)
    bytesIn += bytes
  }

  // 本机这侧的：远端没有就推，两边都有就（按关系）决定推还是不推、以及为什么不动。
  for (const session of input.local) {
    const remote = input.remote.entries.get(session.id)
    const bytes = session.files.reduce((sum, file) => sum + file.bytes, 0)
    const common = {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      bytes,
    }
    if (remote === undefined) {
      push.push({ ...common, action: 'upload', code: 'missing' })
      pushIds.push(session.id)
      bytesOut += bytes
      continue
    }
    const mine = fingerprints(session, hashFile)
    const theirs = remote.files
    const kind = relation(mine, theirs)
    if (kind === 'local-ahead') {
      // 共有的代次逐条一致，远端确实是本机这份的前缀：重推不会盖掉它缺的那些代次。
      push.push({
        ...common,
        action: 'update',
        code: 'local-ahead',
        reason: `远端停在 ${versionsText(theirs)}，本机到 ${versionsText(mine)}`,
      })
      pushIds.push(session.id)
      bytesOut += bytes
      continue
    }
    if (kind === 'identical') {
      push.push({ ...common, action: 'skip', code: 'identical', machine: remote.machine, reason: '远端已经有这一份' })
      continue
    }
    push.push({
      ...common,
      action: 'skip',
      code: kind,
      machine: remote.machine,
      reason:
        kind === 'remote-ahead'
          ? `${remote.machine} 那份更新（本机 ${versionsText(mine)}，它到 ${versionsText(theirs)}）——同 id 不覆盖，本机不动`
          : `同一个 id 两边各自写过（本机 ${versionsText(mine)}，${remote.machine} ${versionsText(theirs)}）——两条都不动`,
    })
  }

  return {
    ok: problems.length === 0,
    problems,
    pull,
    push,
    pullIds,
    pushIds,
    bytesIn,
    bytesOut,
    localCount: input.local.length,
    remoteCount: input.remote.entries.size,
    machines: input.remote.machines,
  }
}

/**
 * 解析一份索引 JSON。
 * @param text 索引原文。
 * @param machine 这台机器的目录名（报告里指名用）。
 * @param problems 收集问题（坏条目跳过，不炸整次同步）。
 * @returns 索引；整个文件读不出形状时 undefined。
 */
export function parseIndex(text: string, machine: string, problems: string[]): RemoteIndex | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    problems.push(
      `${machine} 的 ${SYNC_INDEX_FILE} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) {
    problems.push(`${machine} 的 ${SYNC_INDEX_FILE} 不是一个对象`)
    return undefined
  }
  const value = parsed as { entries?: unknown; updatedAt?: unknown; pluginVersion?: unknown }
  const entries: RemoteIndex['entries'] = []
  for (const raw of Array.isArray(value.entries) ? value.entries : []) {
    const entry = raw as Partial<RemoteSessionEntry>
    if (typeof entry?.id !== 'string' || entry.id === '') {
      problems.push(`${machine} 的索引里有一条没有 id 的记录，已跳过`)
      continue
    }
    const files: FileFingerprint[] = []
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      if (typeof file?.version !== 'number' || typeof file.bytes !== 'number' || typeof file.sha256 !== 'string') {
        continue
      }
      files.push({ version: file.version, bytes: file.bytes, sha256: file.sha256 })
    }
    if (files.length === 0) {
      problems.push(`${machine} 的索引里 ${entry.id} 没有任何代次记录，已跳过`)
      continue
    }
    entries.push({
      id: entry.id,
      ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
      ...(typeof entry.title === 'string' && entry.title !== '' ? { title: entry.title } : {}),
      ...(typeof entry.repo === 'string' && entry.repo !== '' ? { repo: entry.repo } : {}),
      ...(typeof entry.repoPath === 'string' && entry.repoPath !== '' ? { repoPath: entry.repoPath } : {}),
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
      files,
    })
  }
  return {
    machineId: machine,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.pluginVersion === 'string' ? { pluginVersion: value.pluginVersion } : {}),
    entries,
  }
}

/**
 * 读远端：列机器格、逐格读索引、按 id 取并集。
 *
 * 同一个 id 有多台机器贡献时取**领先**的那份（代次超集且共有代次一致），没有领先关系就按目录名排序取
 * 第一个（排序保证结果确定）。某个格子读不到只记问题，
 * 不阻塞其它格子。
 * @param dav 远端。
 * @param settings 同步设置（只需要机器格所在的资源根）。
 * @returns 并集、各机器索引与问题清单。
 */
export async function readRemoteLibrary(dav: DavPort, settings: SyncSettings): Promise<RemoteLibrary> {
  const problems: string[] = []
  const entries = new Map<string, RemoteSessionEntry>()
  const indexes = new Map<string, RemoteIndex>()
  let machines: string[] = []
  try {
    const listed = await dav.list(SYNC_NAMESPACE_DIR)
    machines = listed
      .filter((entry) => entry.kind === 'collection')
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    problems.push(`列远端 ${SYNC_NAMESPACE_DIR}/ 失败：${error instanceof Error ? error.message : String(error)}`)
    return { machines, entries, indexes, problems }
  }
  for (const dirName of machines) {
    let text: string
    try {
      text = (await dav.get(`${SYNC_NAMESPACE_DIR}/${dirName}/${SYNC_INDEX_FILE}`)).toString('utf8')
    } catch (error) {
      // 404 = 这台机器还没推过东西（或推了一半）：不算问题，它这次不贡献任何会话。
      if ((error as { status?: number } | null)?.status === 404) continue
      problems.push(`读远端 ${dirName}/${SYNC_INDEX_FILE} 失败：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const index = parseIndex(text, dirName, problems)
    if (index === undefined) continue
    indexes.set(dirName, index)
    for (const entry of index.entries) {
      const full = { ...entry, machine: dirName }
      const existing = entries.get(entry.id)
      if (existing === undefined) {
        entries.set(entry.id, full)
        continue
      }
      /*
       * 同一个 id 有多台贡献时：**领先**的那份赢（代次是另一个的超集、且共有代次内容一致）。
       *
       * "格子名排序取第一个"在只增不覆盖下本来够用——但一台机器把拉下来的会话继续写下去之后，它的格子
       * 里是更长的那份，而格子名恰好排在前面时，别处拉到的会是旧的那份（缺最新代次，还看不出少）。
       * 内容一致或两边各自写过时仍然按格子名排序取第一个（`machines` 已排序，结果确定）。
       */
      if (relation(full.files, existing.files) === 'local-ahead') entries.set(entry.id, full)
    }
  }
  return { machines, entries, indexes, problems }
}

/** 落地的结果。 */
export interface SyncOutcome {
  plan: SyncPlan
  /** 这次是不是真的写盘了（`apply` 为 false 时全是只读）。 */
  applied: boolean
  /** 拉下来并落盘的会话 id。 */
  pulled: string[]
  /** 推上去的会话。 */
  pushed: Array<{ id: string; action: 'upload' | 'update' }>
  /** 实际写进库的字节数。 */
  bytesIn: number
  /** 实际 PUT 上去的包字节数（gzip 之后的）。 */
  bytesOut: number
  registryWritten: boolean
  indexWritten: boolean
  problems: string[]
}

/** `runSync()` 的依赖。 */
export interface SyncDeps {
  dav: DavPort
  settings: SyncSettings
  sessionsRoot: string
  registryPath: string
  decodeAll: DecodeAll
  resolveTitle?: (query: TitleQuery) => string | undefined
  pluginVersion?: string
  now?: () => Date
  /** 跑 git 的入口（读项目身份用）；缺省是真去跑 git。测试里注入一个假的，不必真建仓库。 */
  git?: GitRunner
}

/** 读注册表；读不到按"没有注册表"处理（会话照旧落地，只是不进工作区分组）。 */
function readRegistryLoose(path: string): { registry?: WorkspaceRegistryState; problem?: string } {
  try {
    const registry = readRegistry(path)
    const check = validateRegistry(registry)
    if (!check.ok) {
      return { problem: `注册表没通过校验（本次拉下来的会话会落成未分组）：${check.problems.join('；')}` }
    }
    return { registry }
  } catch (error) {
    return {
      problem: `读不到注册表 ${path}（本次拉下来的会话会落成未分组）：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 本机的候选项目目录：会话的 cwd + 注册表里登记的工作区路径（去重、排序）。
 *
 * 为什么是这两处：会话的 cwd 是"我在这儿干过活"的地方，注册表路径是"我把它当工作区"的地方——一个
 * 项目只要在这里出现过，就能被认出来。排序是为了让"同一个身份认到哪个根"这件事有确定答案。
 */
function repoCandidates(deps: SyncDeps, local: readonly DiscoveredSession[]): string[] {
  const dirs = new Set<string>()
  for (const session of local) if (session.cwd !== undefined && session.cwd !== '') dirs.add(session.cwd)
  const loose = readRegistryLoose(deps.registryPath)
  for (const record of Object.values(loose.registry?.tables.workspaces ?? {})) {
    if (typeof record.path === 'string' && record.path !== '') dirs.add(record.path)
  }
  return [...dirs].sort()
}

/**
 * 跑一次同步。
 *
 * 拉取那一侧复用 `planImport/applyImport`（与设置页的「导入」是同一条路），所以包的自校验、
 * `.part` 落地、注册表重挂、`_no-cwd` 的口径都不用在这里重写一遍：同步只是"从哪儿拿包"与
 * "往哪儿放包"这两件事不同。
 *
 * @param deps 远端、设置与本地库的位置。
 * @param options.apply 为 false 只算计划（除了读远端，什么都不写）。
 * @returns 结果；单条失败只记进 `problems`，不半路放弃整次同步。
 */
export async function runSync(deps: SyncDeps, options: { apply: boolean }): Promise<SyncOutcome> {
  const problems: string[] = []
  const local = scanAll(
    deps.sessionsRoot,
    deps.decodeAll,
    deps.resolveTitle === undefined ? {} : { resolveTitle: deps.resolveTitle },
  )
  const remote = await readRemoteLibrary(deps.dav, deps.settings)
  const normalized = normalizeMapping(deps.settings.mapping)

  /*
   * 项目身份（git remote）：本机的哪些目录是同一个项目。
   *
   * 只在真用得上时问 git——远端有带身份的条目，或者本机这次要推东西——否则整库同步会被一串
   * `git rev-parse` 拖慢，而它一条都用不到。同一个目录只问一次（`locate` 缓存），因为一次同步里
   * 会话数远多于项目数。
   */
  const git = deps.git ?? createGitRunner()
  const located = new Map<string, Promise<RepoLocation | undefined>>()
  const locate = (dir: string): Promise<RepoLocation | undefined> => {
    const cached = located.get(dir)
    if (cached !== undefined) return cached
    const pending = repoLocation(dir, git)
    located.set(dir, pending)
    return pending
  }
  const repos = new Map<string, string>()
  if ([...remote.entries.values()].some((entry) => entry.repo !== undefined)) {
    for (const dir of repoCandidates(deps, local)) {
      const found = await locate(dir)
      // 同一个身份在本机只认第一个（候选目录已排序）：结果要确定，不随扫描顺序变。
      if (found !== undefined && !repos.has(found.repo)) repos.set(found.repo, found.root)
    }
  }
  // 指纹走"与 cwd 无关"的那份：落地会改写 cwd，按字节比会把拉下来的那份判成"两边各自写过"。
  const contentHash = (path: string, version: number, compression: string | null): FileFingerprint =>
    contentFingerprint(path, version, compression, deps.decodeAll)
  const plan = planSync({ local, remote, mapping: normalized.mapping, repos, hashFile: contentHash })
  plan.problems.unshift(...normalized.problems)
  plan.problems.push(...remote.problems)
  plan.ok = plan.problems.length === 0

  if (!options.apply) {
    return {
      plan,
      applied: false,
      pulled: [],
      pushed: [],
      bytesIn: 0,
      bytesOut: 0,
      registryWritten: false,
      indexWritten: false,
      problems: [],
    }
  }

  const byId = new Map(local.map((session) => [session.id, session]))
  const pulled: string[] = []
  const pushed: Array<{ id: string; action: 'upload' | 'update' }> = []
  let bytesIn = 0
  let bytesOut = 0
  let registryWritten = false

  // ── 拉：取包 → 自校验 → 走导入那条编排 ────────────────────────────────────
  const loose = readRegistryLoose(deps.registryPath)
  if (loose.problem !== undefined) problems.push(loose.problem)
  let registry = loose.registry
  for (const entry of plan.pull) {
    if (entry.action !== 'create') continue
    try {
      const bytes = await deps.dav.get(remoteBundlePath(entry.machine, entry.id))
      const bundle = readBundle(bytes)
      // 没有 cwd 的会话不看 targetCwd（`planImport` 只对带 cwd 的会话用它），这里给空串是照契约填参。
      const importOptions: ImportOptions & { decodeAll: DecodeAll } = {
        root: deps.sessionsRoot,
        targetCwd: entry.toCwd ?? '',
        ...(registry === undefined ? {} : { registry }),
        registryPath: deps.registryPath,
        decodeAll: deps.decodeAll,
      }
      const importPlan = planImport(bundle, importOptions)
      if (importPlan.nextRegistry !== null) registry = importPlan.nextRegistry
      const outcome = applyImport(bundle, importPlan, importOptions)
      if (outcome.registryWritten) registryWritten = true
      pulled.push(...outcome.written)
      bytesIn += outcome.bytes
    } catch (error) {
      problems.push(`拉 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── 推：整包 PUT，然后重写自己那一格的索引 ────────────────────────────────
  const own = remote.indexes.get(machineDirName(deps.settings.machineId))
  const ownEntries = new Map<string, RemoteIndex['entries'][number]>()
  for (const entry of own?.entries ?? []) {
    // 索引只描述"我这台机器现在还拿得出的会话"：本机删掉的下一次推送就从索引里消失
    // （远端那份包不主动删；别的机器自己那份记录照旧）。
    if (byId.has(entry.id)) ownEntries.set(entry.id, entry)
  }
  for (const entry of plan.push) {
    if (entry.action !== 'upload' && entry.action !== 'update') continue
    const session = byId.get(entry.id)
    if (session === undefined) continue
    try {
      const source: ExportSource = {
        id: session.id,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        createdAt: session.createdAt,
        dir: session.dir,
        files: session.files,
      }
      const bundle = buildBundle([source], {
        now: (deps.now?.() ?? new Date()).toISOString(),
        source: {
          sessionsRoot: deps.sessionsRoot,
          ...(deps.pluginVersion === undefined ? {} : { pluginVersion: deps.pluginVersion }),
        },
      })
      await deps.dav.put(remoteBundlePath(deps.settings.machineId, entry.id), bundle)
      // 身份是"这条会话属于哪个项目"的机器无关说法：别的机器凭它 + 仓库内相对路径落地，不必配映射。
      const found = session.cwd === undefined ? undefined : await locate(session.cwd)
      ownEntries.set(entry.id, {
        id: session.id,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(found === undefined ? {} : { repo: found.repo, repoPath: found.repoPath }),
        createdAt: session.createdAt,
        files: fingerprints(session, contentHash),
      })
      pushed.push({ id: entry.id, action: entry.action })
      bytesOut += bundle.length
    } catch (error) {
      problems.push(`推 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let indexWritten = false
  try {
    const payload = Buffer.from(
      JSON.stringify(
        {
          unit: SYNC_INDEX_UNIT,
          version: SYNC_INDEX_VERSION,
          machineId: deps.settings.machineId,
          updatedAt: (deps.now?.() ?? new Date()).toISOString(),
          ...(deps.pluginVersion === undefined ? {} : { pluginVersion: deps.pluginVersion }),
          entries: [...ownEntries.values()],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    await deps.dav.put(remoteIndexPath(deps.settings.machineId), payload)
    indexWritten = true
  } catch (error) {
    problems.push(`写远端索引失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    plan,
    applied: true,
    pulled,
    pushed,
    bytesIn,
    bytesOut,
    registryWritten,
    indexWritten,
    problems,
  }
}
