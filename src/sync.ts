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
// 落地目录要先归一成**宿主存的那个拼写**（`canonicalize`，见 canonical-path.ts）：仓库根来自
// `git rev-parse --show-toplevel`（Windows 上是 `C:/…`），映射值来自用户手输，而宿主把工作区路径
// 与会话 cwd 都存成 `fs.realpath` 归一之后的样子、并按字符串相等比成员资格。不归一的话同一个目录
// 会多出一条谁也不认的工作区记录（那条记录登记的那些会话全被滤掉，界面上是个空工作区）。
//
// 为什么一机一格：WebDAV 没有锁，多台机器共写一份 `index.json` 就是"后写的盖掉先写的"。每台机器
// 只写自己那一格、读别人的全部，就不需要锁。
//
// 冲突口径：**空白不搬运，两边都有按"谁更新"择新**。
//
//   - 空白会话（宿主投影缓存判 `blank`，与迁移页同一条口径：建出来但一轮都没开始过）本机不会上传，
//     也会从这台机器自己的那份索引里撤下来——它没有内容可同步，别的机器也就不必再看到它；反过来，
//     本机这条是空白而远端那条有内容时，以远端为准（空的没什么可保的）。
//   - 同一 id 两边都有：内容一致不动；本机严格领先（远端确实是本机这份的前缀）重新推送刷新；
//     **远端领先**（代次是超集）或**两边各自写过**时，比一个"谁更新"——本机那份的最后活动时间取宿主
//     投影缓存里的两枚钟（`lastPromptAt` 最后一次提问、`timeContext.lastMessageTime` 最后一条消息，
//     取晚的那枚），远端那份取索引里记的同一个值。远端更新就把本机那份**先备份再换掉**（走导入那条
//     编排，理由见下面 pull 的说明）；本机更新就把自己这一格刷成最新。两边的时间有一个读不到（老索引
//     没这个字段、宿主没挂投影缓存）就退回旧口径：不动，只在报告里说清。
//
// 为什么要那枚细的钟：只比"最后一次提问"时，"推送之后本机又跑了几轮、两边的日志各自长出来"这种
// 情况两边的提问时间往往一模一样，于是最该分高下的场合反而判不出来（本机这份被日志重写切过之后尤其
// 如此）。`lastMessageTime` 把 agent 自己写进去的也算进去，正好补这一段。
//
// 为什么"谁更新"用的是宿主折出来的活动时间而不是文件修改时间：文件的 mtime 经不起复制（下载、
// 解包、备份还原都会把它抹平），而这两枚钟与日志内容同生共死，落地改写 cwd 时也不受影响。
// 判据仍然**不**拿时间反推"谁是祖先"：代次那边的四种关系是结构性的，时间只在结构判不出来时分高下。
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalDir, type DirCanonicalizer } from './canonical-path.ts'
import { warmCheckpoints, type WarmDeps } from './checkpoint-warm.ts'
import type { DavPort } from './dav.ts'
import { scanAll, type DiscoveredSession } from './discovery.ts'
import { createBackup } from './journal.ts'
import { encodeSegment } from './paths.ts'
import { createGitRunner, repoLocation, type GitRunner, type RepoLocation } from './repo.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import { takeEffectOnHostAll, type EffectDeps } from './take-effect.ts'
import { relocateHeaderCwdShallow, relocateHeaderCwdText } from './session-log.ts'
import type { TitleQuery } from './session-title.ts'
import { applyImport, buildBundle, planImport, readBundle, type ExportSource, type ImportOptions, type SessionBundle } from './transfer.ts'
import type { DecodeAll, EffectOutcome, RegistryChange, WarmOutcome, WorkspaceRegistryState } from './types.ts'
import type { SessionMeta } from './visibility.ts'

/** 远端本插件独占的那层目录（相对资源根），机器格就放在它下面：`url` 可以填服务器/账号根。 */
export const SYNC_NAMESPACE_DIR = 'dsh-session-manager'
/** 每台机器自己的索引文件名。 */
export const SYNC_INDEX_FILE = 'index.json'
/** 会话包的后缀（与界面上导出的文件同名同格式）。 */
export const SYNC_BUNDLE_EXT = '.dshsess'
/** 索引里的自描述标识（别的工具写进来的 index.json 不该被当成自己人）。 */
export const SYNC_INDEX_UNIT = 'dsh-session-manager/sync'
/**
 * 当前索引格式版本。
 *
 * 2 起每条记录多一个可选的 `lastPromptAt`（最后一次提问），3 起写的是 `lastActiveAt`（最后一枚钟，
 * 见 `activeAt()`）。读的一侧收全三种情形：版本 1 的老索引照旧能用，只有 `lastPromptAt` 的版本 2
 * 拿它当活动时间，版本 3 用 `lastActiveAt`。缺这一项的那些条目判不出谁更新，退回"不动"。
 */
export const SYNC_INDEX_VERSION = 3

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
  /**
   * 这台机器上这条会话的最后活动时间（毫秒时间戳，宿主两枚钟里晚的那枚，见 `activeAt()`）。
   *
   * 跨机器比"谁更新"用的就是它；读不到（老索引、宿主没挂投影缓存）就没有这一项，那几条判不出高下。
   */
  lastActiveAt?: number
  /**
   * 版本 2 写的那枚钟（最后一次提问）。新记录不再写它，但**读**的时候仍然认：已经推送过的那些格子
   * 里记着它，丢掉就等于让那些条目退回"判不出谁更新"。
   */
  lastPromptAt?: number
  /** 贡献这条记录的机器 id（拉取时要知道去哪个格子取）。 */
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
      ? relocateHeaderCwdShallow(bytes, { to: CWD_PLACEHOLDER, decodeAll }).buffer
      : Buffer.from(relocateHeaderCwdText(bytes.toString('utf8'), CWD_PLACEHOLDER).text, 'utf8')
  } catch {
    return bytes
  }
}

/**
 * 与"这台机器上的 cwd"无关的内容指纹。
 *
 * 落地会把别人的 cwd 改写成这台机器的路径（库目录名与 header 的 `cwd` 绑死，不改写就落不下来），
 * 于是同一份会话在两台机器上的**字节不同**。判据要是按字节比，拉取来的那份会被判成"两边各自写过"：
 * 报告里的理由是错的（其实是同一份），更要紧的是它在那台机器上**继续写之后也无法再推送回远端**——新代次永远
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

/** 两边各自写过时，谁更新的结论。 */
export type NewerSide = 'local' | 'remote' | 'unknown'

/**
 * 比"谁更新"：本机那份的活动时间与远端索引里记的那个。
 *
 * 两边都拿得到才下结论，缺一个就是 `unknown`——**不下手**好过按半个事实覆盖掉一份；两边一样新也
 * 归 `unknown`（同一次活动各写各的，随手挑一个赢家会凭空丢掉另一份）。这几种都退回旧口径：报告里
 * 说清是"远端更新"还是"两边各自写过"，但一个字节都不动。
 *
 * @param mine 本机那份的最后活动时间（`activeAt()` 折出来的；缺席 = 不知道）。
 * @param theirs 远端索引里记的那一枚（老索引没有这一项）。
 * @returns 谁更新，或判不出来。
 */
/**
 * 这条本机会话"最后一次动"在什么时候。
 *
 * 宿主给了两枚钟，取**晚的**那枚：`lastPromptAt` 是最后一次提问（列表那一行记的，粗），
 * `lastMessageTime` 是最后一条消息——agent 自己写进去的也算（细）。只取前者的话，"推送之后本机
 * 又跑了几轮、两边的日志各自长出来"这种最该分高下的场合，两边的提问时间往往一模一样，于是判不出来。
 *
 * @param meta 投影缓存里读到的这条会话（缺席 = 宿主没挂缓存）。
 * @returns 毫秒时间戳；两枚钟都读不到就是 `undefined`（那几条退回"不动"）。
 */
function activeAt(meta: SessionMeta | undefined): number | undefined {
  const values = [meta?.lastPromptAt, meta?.lastMessageAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  return values.length === 0 ? undefined : Math.max(...values)
}

/**
 * 远端索引条目里那枚钟：新记录写 `lastActiveAt`，版本 2 那份记在 `lastPromptAt` 里。
 *
 * @param entry 远端那条记录；本机这条在远端没有对应格子时是 `undefined`（那时没有钟可读）。
 */
function remoteActiveAt(entry: { lastActiveAt?: number; lastPromptAt?: number } | undefined): number | undefined {
  return entry?.lastActiveAt ?? entry?.lastPromptAt
}

export function newerSide(mine: number | undefined, theirs: number | undefined): NewerSide {
  if (mine === undefined || theirs === undefined) return 'unknown'
  if (mine > theirs) return 'local'
  if (theirs > mine) return 'remote'
  return 'unknown'
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
  /**
   * `create` = 本机本来没有这条；`replace` = 本机那份被这一份顶掉（旧的那份先备份）；
   * `skip` = 不拉（缺映射、目标不存在）。
   */
  action: 'create' | 'replace' | 'skip'
  /** 机器可读的分类（界面按它挑文案与过滤，不去解析 `reason`）。 */
  code: 'missing' | 'remote-ahead' | 'remote-newer' | 'blank-local' | 'no-mapping' | 'missing-target'
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
  code: 'missing' | 'local-ahead' | 'local-newer' | 'identical' | 'remote-ahead' | 'diverged'
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
  /** 会被拉取来的会话 id。 */
  pullIds: string[]
  /** 会被推送的会话 id（`upload` 与 `update` 都在里面）。 */
  pushIds: string[]
  /** 本机判为空白、这次不参与同步的会话 id（按发现顺序；它们不在上面两张表里）。 */
  blank: string[]
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
  /**
   * 读这条本机会话的空白与最后活动时间（宿主投影缓存；见 visibility.ts 的 `SessionMeta`）。
   *
   * 缺席 = 两件事都不知道：空白按"非空白"处理（宁可不判，也不把用户看得见的会话悄悄踢出同步），
   * 活动时间按"比不出来"处理（退回"不动"）。这与迁移页那边 `resolveBlank` 缺席时的口径一致。
   */
  sessionMeta?: (session: DiscoveredSession) => SessionMeta | undefined
  /**
   * 这条会话是不是还在宿主内存里（在跑 / 已打开）。
   *
   * 只有"覆盖本机那份"这一步要问它：宿主手里有内存副本与写句柄，日志被换掉之后它还会接着往里写
   * （与删除拒掉活会话同一件事）。缺席 = 判断不了，按"都不活着"处理。
   */
  isLive?: (id: string) => boolean
  /**
   * 把落地目录换成宿主存的那个拼写（缺省 `canonicalDir`，见 canonical-path.ts）。
   *
   * 计划里报的 `toCwd` 与落地用的必须是同一个字符串，所以归一发生在**计划**这一层：预演看到的目标、
   * 改写进 header 的 cwd、注册表里那条记录的 `path` 因此是同一份值。可注入是为了让计划这条纯计算的
   * 测试不必真建目录。
   */
  canonicalize?: DirCanonicalizer
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

/** 活动时间的可读形式（报告里用；读不到就说读不到，别显示成 1970）。 */
function timeText(value: number | undefined): string {
  return value === undefined ? '没记活动时间' : new Date(value).toISOString()
}

/**
 * 算一次同步的计划：哪几条拉取、哪几条推送、哪些不动和为什么。
 *
 * 判定顺序：
 *   1. 远端有、本机没有 → 拉取（`cwd` 要能映射到本机一个真实存在的目录；没有 `cwd` 的会话不需要映射）；
 *   2. 本机有 → 远端没有就推送；两边都有按关系定：
 *      - 内容一致 → 不动；
 *      - 本机严格领先（共有的代次逐条一致）→ 重新推送一次，把远端刷新到最新；
 *      - 远端领先（本机这份确实是它的前缀）、或两边各自写过而**远端更新的**→ 覆盖本机那份（先备份）；
 *      - 两边各自写过而**本机更新的**→ 重新推送一次，把自己这一格刷成最新；
 *      - 判不出谁更新 → 不动，理由里写清是"远端更新"还是"两边各自写过"、以及为什么比不出来；
 *   3. 本机这条是空白会话（宿主投影缓存判 `blank`）→ **不上传**，也不算"远端已经有这一份"；它没有
 *      内容可传，所以只进 `plan.blank`（界面拿它说一句"跳过 N 条空白会话"）。唯一的例外是远端那条
 *      有内容：空的没什么可保的，那时以远端为准（走上面"覆盖本机那份"那条路）。
 *
 * 判据是代次指纹（**与 cwd 无关**，见 `contentFingerprint`）加一个"谁更新"的活动时间。两个都不知道
 * 的组合一律不动：宁可少做，也不按半个事实覆盖掉一份。
 *
 * @param input 本机库、远端索引、映射表与几个可注入的判据。
 * @returns 计划；`problems` 非空时 `ok` 为 false。
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const hashFile = input.hashFile ?? fileFingerprint
  const isDirectory = input.isDirectory ?? defaultIsDirectory
  const canonicalize = input.canonicalize ?? canonicalDir
  const problems: string[] = []
  const local = new Map(input.local.map((session) => [session.id, session]))
  const pull: SyncPullEntry[] = []
  const push: SyncPushEntry[] = []
  const pullIds: string[] = []
  const pushIds: string[] = []
  const blank: string[] = []
  let bytesIn = 0
  let bytesOut = 0

  // 远端独有的：拉取。cwd 要能落到本机一个真实存在的目录，否则这条跳过（报告里说清为什么）。
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
    const picked =
      input.mapping.get(entry.cwd) ??
      (viaRepo === undefined ? undefined : joinRepoPath(viaRepo, entry.repoPath))
    if (picked === undefined) {
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
    // 归一之后再谈"落到哪儿"：仓库根来自 git（Windows 上是 `C:/…`），映射值来自用户手输，两者都可能是
    // 宿主不认的另一种拼写（见 canonical-path.ts）。
    const target = canonicalize(picked)
    if (!isDirectory(target)) {
      problems.push(`同步映射把 ${entry.cwd} 指到了 ${target}，但那不是一个存在的目录`)
      pull.push({ ...base, toCwd: target, action: 'skip', code: 'missing-target', reason: `目标目录不存在：${target}` })
      continue
    }
    pull.push({ ...base, toCwd: target, action: 'create', code: 'missing' })
    pullIds.push(id)
    bytesIn += bytes
  }

  // 本机这侧的：远端没有就推送，两边都有就（按关系 + 谁更新）决定推送、覆盖本机那份、还是不动。
  for (const session of input.local) {
    const remote = input.remote.entries.get(session.id)
    const meta = input.sessionMeta?.(session)
    const isBlank = meta?.blank === true
    /** 本机这条"最后一次动"什么时候（两枚钟里晚的那枚）。远端那枚按同一把尺子取自索引。 */
    const mineActiveAt = activeAt(meta)
    const theirActiveAt = remoteActiveAt(remote)
    const bytes = session.files.reduce((sum, file) => sum + file.bytes, 0)
    const common = {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      bytes,
    }
    if (remote === undefined) {
      if (isBlank) {
        // 空白会话没有内容可传：不推、也不进自己那份索引（见 runSync 里的索引重写）。
        blank.push(session.id)
        continue
      }
      push.push({ ...common, action: 'upload', code: 'missing' })
      pushIds.push(session.id)
      bytesOut += bytes
      continue
    }
    const mine = fingerprints(session, hashFile)
    const theirs = remote.files
    const kind = relation(mine, theirs)
    if (kind === 'identical') {
      // 空白会话不摆成"远端已经有这一份"：它没内容，这一行只会让人以为它参与了同步。
      if (isBlank) blank.push(session.id)
      else push.push({ ...common, action: 'skip', code: 'identical', machine: remote.machine, reason: '远端已经有这一份' })
      continue
    }
    if (kind === 'local-ahead') {
      if (isBlank) {
        // 空白会话永远不上传：远端那份是它的后缀也一样，没有内容值得刷新。
        blank.push(session.id)
        continue
      }
      // 共有的代次逐条一致，远端确实是本机这份的前缀：重新推送不会盖掉它缺的那些代次。
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
    /*
     * 到这里只剩「远端领先」与「两边各自写过」：两者都可能要**覆盖本机那份**。
     *
     * 远端领先是结构性的（本机这份确实是它的前缀），不需要时间就知道它更新；两边各自写过才要时间
     * 分高下，而空白那份不用比分——它没有内容可保。
     */
    const side = kind === 'remote-ahead' || isBlank ? 'remote' : newerSide(mineActiveAt, theirActiveAt)
    if (side === 'local') {
      push.push({
        ...common,
        action: 'update',
        code: 'local-newer',
        machine: remote.machine,
        reason:
          `同一个 id 两边各自写过（本机 ${versionsText(mine)}，${remote.machine} ${versionsText(theirs)}），` +
          `本机这份更新（${timeText(mineActiveAt)} 对 ${timeText(theirActiveAt)}）——重新推送把自己这一格刷成最新`,
      })
      pushIds.push(session.id)
      bytesOut += bytes
      continue
    }
    if (side === 'remote') {
      if (input.isLive?.(session.id) === true) {
        // 覆盖要动本机那份文件，而宿主手里还有它的内存副本与写句柄（与删除拒掉活会话同一件事）。
        push.push({
          ...common,
          action: 'skip',
          code: kind,
          machine: remote.machine,
          reason: `${remote.machine} 那份更新，但本机这条还在宿主内存里（运行中或已打开）——先关掉它再同步`,
        })
        continue
      }
      /*
       * 落地目录：**本机这条自己的 cwd 优先**。这条会话在本机已经有家（还有工作区登记），不该因为
       * 远端记着另一条路径就把它搬走；本机这条没有 cwd 时才按"显式映射 → 仓库身份"认，与新建拉取
       * 同一条路。两种来路都要归一：本机这条的 cwd 也可能是宿主不认的另一种拼写（分隔符、大小写、
       * 结尾分隔符）。
       */
      let target = session.cwd === undefined ? undefined : canonicalize(session.cwd)
      if (target === undefined) {
        const viaRepo = remote.repo === undefined ? undefined : input.repos?.get(remote.repo)
        const picked =
          remote.cwd === undefined
            ? undefined
            : input.mapping.get(remote.cwd) ??
              (viaRepo === undefined ? undefined : joinRepoPath(viaRepo, remote.repoPath))
        target = picked === undefined ? undefined : canonicalize(picked)
        if (target === undefined && remote.cwd !== undefined) {
          push.push({
            ...common,
            action: 'skip',
            code: kind,
            machine: remote.machine,
            reason: `本机这条没有 cwd，远端记的是 ${remote.cwd}，本机又没有它的同步映射——先补映射再同步`,
          })
          continue
        }
        if (target !== undefined && !isDirectory(target)) {
          problems.push(`同步映射把 ${remote.cwd ?? ''} 指到了 ${target}，但那不是一个存在的目录`)
          push.push({
            ...common,
            action: 'skip',
            code: kind,
            machine: remote.machine,
            reason: `目标目录不存在：${target}`,
          })
          continue
        }
      }
      pull.push({
        id: session.id,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(remote.cwd === undefined ? {} : { fromCwd: remote.cwd }),
        ...(target === undefined ? {} : { toCwd: target }),
        machine: remote.machine,
        bytes,
        action: 'replace',
        code: kind === 'remote-ahead' ? 'remote-ahead' : isBlank ? 'blank-local' : 'remote-newer',
        reason:
          kind === 'remote-ahead'
            ? `${remote.machine} 那份更新（本机 ${versionsText(mine)}，它到 ${versionsText(theirs)}）——先备份本机这份再换成它`
            : isBlank
              ? `本机这条是空白会话，${remote.machine} 那份有内容——先备份再换成它`
              : `同一个 id 两边各自写过（本机 ${versionsText(mine)}，${remote.machine} ${versionsText(theirs)}），` +
                `${remote.machine} 那份更新（${timeText(theirActiveAt)} 对本机 ${timeText(mineActiveAt)}）——先备份本机这份再换成它`,
      })
      pullIds.push(session.id)
      bytesIn += bytes
      continue
    }
    // 分叉、且有一边读不到活动时间（老索引 / 宿主没挂投影缓存）：退回旧口径，两条都不动，理由是"比不出来"。
    push.push({
      ...common,
      action: 'skip',
      code: 'diverged',
      machine: remote.machine,
      reason:
        `同一个 id 两边各自写过（本机 ${versionsText(mine)}，${remote.machine} ${versionsText(theirs)}），` +
        `又判不出谁更新（本机 ${timeText(mineActiveAt)}、远端 ${timeText(theirActiveAt)}）——两条都不动`,
    })
  }

  return {
    ok: problems.length === 0,
    problems,
    pull,
    push,
    pullIds,
    pushIds,
    blank,
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
      ...(typeof entry.lastActiveAt === 'number' && Number.isFinite(entry.lastActiveAt)
        ? { lastActiveAt: entry.lastActiveAt }
        : {}),
      ...(typeof entry.lastPromptAt === 'number' && Number.isFinite(entry.lastPromptAt)
        ? { lastPromptAt: entry.lastPromptAt }
        : {}),
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
 * 一次连通性探测的结论码。
 *
 * 判定在宿主侧（这里），**文案在浏览器半侧**：同一个码在两种语言里是两句话，而宿主不该猜用户装了哪
 * 一种；网络层的原始原因（状态行、`getaddrinfo ENOTFOUND`）原样走 `detail`，那部分本来就翻不了。
 */
export type SyncTestCode =
  /** 资源根应答了、认证过了：远端这就通了（命名空间还没建也算通，第一次同步会自建）。 */
  | 'ok'
  /** 401：服务器要认证，而它不认这套（或压根没带上凭据）。 */
  | 'unauthenticated'
  /** 403：认证过了，但这个账号没这个权限。 */
  | 'forbidden'
  /** 404：地址上没这个资源——多半是 `sync.url` 写错了。 */
  | 'notFound'
  /** 405 / 501：服务器不接受 PROPFIND，这不像一个 WebDAV 地址。 */
  | 'unsupported'
  /** 状态码为 0：DNS、连接、TLS 或超时。 */
  | 'unreachable'
  /** 5xx：服务器自己出错了。 */
  | 'serverError'
  /** 认不出的状态码：如实报出来，不硬塞进上面任何一类。 */
  | 'other'

/** 「测试连接」的结论（不含文案）。 */
export interface SyncTestResult {
  code: SyncTestCode
  /** 判定依据的那个状态码（传输层错误为 0）。 */
  status: number
  /** 命名空间集合已经存在。 */
  namespaceExists: boolean
  /** 命名空间里已经有的机器格（按名字排序）；不存在时为空。 */
  machines: string[]
  /** 命名空间的直接子项数（文件也算）。 */
  entries: number
  /** 原始原因一句话；连得上时不带。 */
  detail?: string
}

/** 状态码 → 结论码（`detail` 与"带没带凭据"由调用方补）。 */
function classifyStatus(status: number): SyncTestCode {
  if (status === 0) return 'unreachable'
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'notFound'
  if (status === 405 || status === 501) return 'unsupported'
  if (status >= 500) return 'serverError'
  return 'other'
}

/**
 * 测一次能不能连上远端：**只读**，不改远端任何东西。
 *
 * 两次 PROPFIND（资源根 Depth 0 + 本插件的命名空间 Depth 1）。为什么不顺手 MKCOL 一下命名空间、
 * 甚至 PUT 一个探针文件来把"写权限"也验了：测试不该改远端——第一次同步本来就会 MKCOL 那一次，而
 * 往别人的服务器上留文件（还得指望删掉）不是"测连接"该做的事。代价是只读共享会测出"连得上"，
 * 直到确认那一步才失败；界面那句话里说清了这次探测没写任何东西。
 *
 * @param dav 远端。
 * @returns 结论码、判定依据的状态码，以及命名空间里已有的机器格。
 */
export async function testSyncConnection(dav: DavPort): Promise<SyncTestResult> {
  const probe = await dav.probe(SYNC_NAMESPACE_DIR)
  // 失败的那个状态码：资源根没过就是它；资源根过了，命名空间除 404（还没建）以外的状态才算失败。
  const failed = !probe.rootOk
    ? probe.rootStatus
    : probe.collectionStatus === 207 || probe.collectionStatus === 404
      ? undefined
      : probe.collectionStatus
  if (failed !== undefined) {
    return {
      code: classifyStatus(failed),
      status: failed,
      namespaceExists: false,
      machines: [],
      entries: 0,
      ...(probe.detail === undefined ? {} : { detail: probe.detail }),
    }
  }
  const machines = probe.entries
    .filter((entry) => entry.kind === 'collection')
    .map((entry) => entry.name)
    .sort()
  return {
    code: 'ok',
    status: 207,
    namespaceExists: probe.collectionExists,
    machines,
    entries: probe.entries.length,
    ...(probe.detail === undefined ? {} : { detail: probe.detail }),
  }
}

/**
 * 读远端：列机器格、逐格读索引、按 id 取并集。
 *
 * 同一个 id 有多台机器贡献时按两步取一份：
 *   1. **领先**的那份赢（代次是另一个的超集、且共有代次内容一致）；
 *   2. 没有领先关系（两边各自写过）时，**活动时间更晚**的那份赢；两边的时间有一边读不到（老索引），
 *      才按目录名排序取第一个（排序保证结果确定）。
 *
 * 第 2 步不只是"取一份"：一台机器把自己更新那份推上来之后（它只写自己那一格），别的机器读到的就是
 * 更新的那一份——不去看时间的话，两台各自续写过的机器谁的格子名排前面谁赢，更新那份反而可能读不到。
 * 某个格子读不到只记问题，不阻塞其它格子。
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
      // 404 = 这台机器还没推送过内容（或推送了一半）：不算问题，它这次不贡献任何会话。
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
       * "格子名排序取第一个"本来够用——但一台机器把拉取来的会话继续写下去之后，它的格子里是更长的那份，
       * 而格子名恰好排在前面时，别处拉到的会是旧的那份（缺最新代次，还看不出少）。两边各自写过时更糟：
       * 谁的格子名排前面谁赢，而"谁更新"跟格子名没有任何关系，所以这里再比一道活动时间（与 `planSync`
       * 里那条判据同一个值）；两边的时间有一边读不到，才退回按格子名排序取第一个（`machines` 已排序，
       * 结果确定）。
       */
      const relationNow = relation(full.files, existing.files)
      const leading =
        relationNow === 'local-ahead' ||
        (relationNow === 'diverged' && newerSide(remoteActiveAt(full), remoteActiveAt(existing)) === 'local')
      if (leading) entries.set(entry.id, full)
    }
  }
  return { machines, entries, indexes, problems }
}

/**
 * 一次同步进行中的一条进度事件。
 *
 * 同步是这个插件里唯一"按条走网络"的长动作：本机有几百条会话时，一次整库同步就是几百次往返，
 * 界面不能只有一个"同步中…"。事件按**每开始处理一条**发一次（不是每完成一条），所以 `done` 是
 * 已经做完的条数，界面拿 `done + 1` 说"正在处理第几条"，进度条因此一路走到最后一格。
 *
 * 六段（`phase`）各有各的分母，合起来算一个百分比只会骗人：算计划要先扫本机、再读远端索引、再逐个
 * 目录认本机仓库的身份（真机量到这一段比前两段加起来还长：13 个目录跑一轮 `git rev-parse` 约
 * 0.2 秒）、最后逐条比对内容，然后落地再分拉与推两段（先拉的 3 条与后推的 84 条同样不是一个分母）。
 * **预演与落地报的是同一套事件**：落地那边也要先算一遍计划，用户按下确认后到第一条拉取完成之间那段
 * 空档，靠的就是前面这四个阶段。
 */
export interface SyncProgress {
  /**
   * 这一段是什么：
   *   - `scan` / `remote` / `repo` / `compare`：算计划的四段（预演与落地都有）；
   *   - `pull` / `push`：真写盘的两段（只有落地有）。
   */
  phase: 'scan' | 'remote' | 'repo' | 'compare' | 'pull' | 'push'
  /**
   * 这一段一共多少条（计划里定下、真会做的那些；跳过的没算进来）。
   *
   * `0` 表示这一段**没有条数可讲**（例如读一次远端索引）：界面只摆那句话，不摆进度条——画一条
   * 1/1 的会让人以为"已经做完了"，而它其实还在等。
   */
  total: number
  /** 这一段已经做完几条。 */
  done: number
  /** 正在开始处理的那条会话 id（`scan` / `remote` / `compare` 没有"某一条"，缺席）。 */
  id?: string
  /** 界面上怎么称呼它（标题优先，读不到退回 id）——与清单里同一套口径。 */
  label?: string
}

/** 落地的结果。 */
export interface SyncOutcome {
  plan: SyncPlan
  /** 这次是不是真的写盘了（`apply` 为 false 时全是只读）。 */
  applied: boolean
  /** 拉取并落盘的会话 id。 */
  pulled: string[]
  /**
   * 其中**覆盖掉本机原来那份**的会话 id（它们是 `pulled` 的子集）。
   *
   * 单独列出来是因为这一类的代价不同：本机那份内容被换掉了，旧的那份只在备份里（`kind: 'replace'`，
   * 界面与工具都据此多说一句）。
   */
  replaced: string[]
  /** 推送的会话。 */
  pushed: Array<{ id: string; action: 'upload' | 'update' }>
  /** 实际写进库的字节数。 */
  bytesIn: number
  /** 实际 PUT 上去的包字节数（gzip 之后的）。 */
  bytesOut: number
  registryWritten: boolean
  indexWritten: boolean
  /**
   * 拉取改的那几笔注册表有没有被宿主接住（见 take-effect.ts）：`undefined` = 这次没写注册表
   * （预演或纯推送）。
   */
  effect?: EffectOutcome
  /**
   * 拉取来的会话在本机没有宿主的投影检查点（它们从没在本机活过）：这一步是"请宿主重新折一遍"的结果，
   * 缺席 = 这次没有落到本机的会话（见 checkpoint-warm.ts）。
   */
  warm?: WarmOutcome
  problems: string[]
}

/** `runSync()` 的依赖。 */
export interface SyncDeps extends EffectDeps, WarmDeps {
  dav: DavPort
  settings: SyncSettings
  sessionsRoot: string
  registryPath: string
  /** 备份根目录：远端那份更新、要覆盖本机那份时，旧的那份先按迁移/删除那套备份进来。 */
  backupRoot: string
  decodeAll: DecodeAll
  resolveTitle?: (query: TitleQuery) => string | undefined
  /**
   * 读宿主投影缓存里这条会话的空白与最后活动时间（见 visibility.ts 的 `SessionMeta`）。
   *
   * 缺席 = 两件事都不知道（空白不判、时间比不出来）：工具层在没有投影缓存时会走这一条，界面那侧
   * 一律注入（`createSessionMetaResolver`）。
   */
  sessionMeta?: (query: { id: string; createdAt: number; cwd?: string }) => SessionMeta | undefined
  /**
   * 宿主内存里活着的会话 id（`ctx.sessions.list()`，见 src/index.ts）。
   *
   * 只有"覆盖本机那份"这一步问它：宿主手里有内存副本与写句柄，日志被换掉之后它还会接着写
   * （与删除拒掉活会话同一件事）。缺席 = 判断不了。
   */
  liveSessionIds?: () => ReadonlySet<string>
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
      return { problem: `注册表没通过校验（本次拉取来的会话会落成未分组）：${check.problems.join('；')}` }
    }
    return { registry }
  } catch (error) {
    return {
      problem: `读不到注册表 ${path}（本次拉取来的会话会落成未分组）：${error instanceof Error ? error.message : String(error)}`,
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
 * @param options.onProgress 每开始处理一条调一次（见 `SyncProgress`）；调用方拿它推进度条。预演与
 *   落地报的是同一套事件（算计划的四段 + 写盘的两段）。回调同步调用、不 await，所以它自己不许抛
 *   （`src/web.ts` 那一侧把它写进 SSE 响应）。
 * @returns 结果；单条失败只记进 `problems`，不半路放弃整次同步。
 */
export async function runSync(
  deps: SyncDeps,
  options: { apply: boolean; onProgress?: (event: SyncProgress) => void },
): Promise<SyncOutcome> {
  const problems: string[] = []
  const report = options.onProgress
  // 第一段：扫本机。冷启动时这一段是大头（每条会话要读头、折标题），所以它值得一条进度。
  const local = scanAll(deps.sessionsRoot, deps.decodeAll, {
    ...(deps.resolveTitle === undefined ? {} : { resolveTitle: deps.resolveTitle }),
    ...(report === undefined ? {} : { onProgress: (done, total) => report({ phase: 'scan', done, total }) }),
  })
  // 第二段：读远端索引。一次网络往返，没有"第几条"可讲——`total: 0` 就是"这一段没有分母"，
  // 界面只摆那句"正在读取远端索引…"、不摆条（画一条 1/1 的会让人以为已经做完了）。
  report?.({ phase: 'remote', done: 0, total: 0 })
  const remote = await readRemoteLibrary(deps.dav, deps.settings)
  const normalized = normalizeMapping(deps.settings.mapping)

  /*
   * 项目身份（git remote）：本机的哪些目录是同一个项目。
   *
   * 只在真用得上时问 git——远端有带身份的条目，或者本机这次要推送内容——否则整库同步会被一串
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
    const candidates = repoCandidates(deps, local)
    for (let index = 0; index < candidates.length; index += 1) {
      // 第三段：逐个候选目录问一次 git。目录数不多，但每个目录要起一个 git 进程——真机上这一段
      // 比扫本机与读远端索引加起来还长，没有进度的话进度条会停在这儿半秒。
      report?.({ phase: 'repo', done: index, total: candidates.length })
      const found = await locate(candidates[index] as string)
      // 同一个身份在本机只认第一个（候选目录已排序）：结果要确定，不随扫描顺序变。
      if (found !== undefined && !repos.has(found.repo)) repos.set(found.repo, found.root)
    }
  }
  // 指纹走"与 cwd 无关"的那份：落地会改写 cwd，按字节比会把拉取来的那份判成"两边各自写过"。
  const contentHash = (path: string, version: number, compression: string | null): FileFingerprint =>
    contentFingerprint(path, version, compression, deps.decodeAll)
  //
  // 第四段（比对）的分母：**两边都有**的那些会话的文件数。本机独有的那些只算字节、不读内容，
  // 所以不进分母——不然进度条会停在一半（这正是 `SyncProgress` 一句"各有各的分母"的意思）。
  const compareTotal = local.reduce(
    (sum, session) => (remote.entries.has(session.id) ? sum + session.files.length : sum),
    0,
  )
  let compared = 0
  /** 算计划时用的指纹：同一件事顺带报"比对到第几条"。 */
  const planHash = (path: string, version: number, compression: string | null): FileFingerprint => {
    report?.({ phase: 'compare', done: compared, total: compareTotal })
    const fingerprint = contentHash(path, version, compression)
    compared += 1
    return fingerprint
  }
  /*
   * 投影缓存那两件事（空白、最后活动时间）按会话读一次就够：算计划要它、写回索引时还要它。宿主没给
   * 这个口子（工具层在没挂投影缓存的宿主上就是这样）时什么都不读，两件事都按"不知道"处理。
   */
  const metaCache = new Map<string, SessionMeta | undefined>()
  const metaOf = (session: Pick<DiscoveredSession, 'id' | 'createdAt' | 'cwd'>): SessionMeta | undefined => {
    const cached = metaCache.get(session.id)
    if (cached !== undefined || metaCache.has(session.id)) return cached
    const value = deps.sessionMeta?.({
      id: session.id,
      createdAt: session.createdAt,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    })
    metaCache.set(session.id, value)
    return value
  }
  // 活会话这件事只读一次：覆盖本机那一步会逐条问它，而宿主那份列表在一次同步里不会变。
  const live = deps.liveSessionIds?.()
  const plan = planSync({
    local,
    remote,
    mapping: normalized.mapping,
    repos,
    hashFile: planHash,
    ...(deps.sessionMeta === undefined ? {} : { sessionMeta: metaOf }),
    ...(live === undefined ? {} : { isLive: (id: string): boolean => live.has(id) }),
  })
  plan.problems.unshift(...normalized.problems)
  plan.problems.push(...remote.problems)
  plan.ok = plan.problems.length === 0

  if (!options.apply) {
    return {
      plan,
      applied: false,
      pulled: [],
      replaced: [],
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
  const replaced: string[] = []
  const pushed: Array<{ id: string; action: 'upload' | 'update' }> = []
  let bytesIn = 0
  let bytesOut = 0
  let registryWritten = false
  /** 拉取改的那几笔注册表（按执行顺序），整批落地之后一起交给宿主。 */
  const registryChanges: RegistryChange[] = []

  // ── 拉取：取包 → 自校验 → 走导入那条编排 ────────────────────────────────────
  const loose = readRegistryLoose(deps.registryPath)
  if (loose.problem !== undefined) problems.push(loose.problem)
  let registry = loose.registry
  /*
   * 只把"真会拉取"的那些算进进度分母：跳过的（库里有同 id、没配映射…）不计，否则进度条永远走不满。
   * 「覆盖本机」也是拉取（那份内容从远端来），所以和"新建"共用一个分母：方向一样，只是它多一步
   * 先备份再顶掉本机那份。
   */
  const pullJobs = plan.pull.filter((entry) => entry.action === 'create')
  const replaceJobs = plan.pull.filter((entry) => entry.action === 'replace')
  const pullTotal = pullJobs.length + replaceJobs.length
  for (let index = 0; index < pullJobs.length; index += 1) {
    const entry = pullJobs[index] as SyncPullEntry
    options.onProgress?.({
      phase: 'pull',
      total: pullTotal,
      done: index,
      id: entry.id,
      label: entry.title ?? entry.id,
    })
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
      if (importPlan.registryChange !== null) registryChanges.push(importPlan.registryChange)
      const outcome = applyImport(bundle, importPlan, importOptions)
      if (outcome.registryWritten) registryWritten = true
      pulled.push(...outcome.written)
      bytesIn += outcome.bytes
    } catch (error) {
      problems.push(`拉取 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /*
   * ── 覆盖本机的那几条：先取包、再备份、最后顶掉本机那份 ────────────────────────
   *
   * 三步的顺序是安全边界，不是风格：包取不到 / 坏了就一个字节都不动本机那份；备份不成功同样一条都不
   * 动（备份是旧那份**唯一**的副本，`kind: 'replace'` 见 journal.ts）。只有前两步都过了才落到"撤掉
   * 旧目录、按导入落地"。
   *
   * 为什么要先撤掉整个目录、而不是逐文件覆盖：同一目录里留着旧代次就是坏数据（宿主把目录里的代次
   * 一起读进来），而新旧两份的代次名可能重合、也可能不重合，逐文件覆盖两种都处理不对。
   */
  if (replaceJobs.length > 0) {
    const fetched = new Map<string, SessionBundle>()
    for (const entry of replaceJobs) {
      try {
        fetched.set(entry.id, readBundle(await deps.dav.get(remoteBundlePath(entry.machine, entry.id))))
      } catch (error) {
        problems.push(
          `覆盖 ${entry.id} 失败（远端那包取不到或坏了，本机那份没动）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    const ready = replaceJobs.filter((entry) => fetched.has(entry.id))
    let backedUp = false
    if (ready.length > 0) {
      try {
        createBackup({
          backupRoot: deps.backupRoot,
          registryPath: deps.registryPath,
          sessions: ready.flatMap((entry) => {
            const session = byId.get(entry.id)
            return session === undefined ? [] : [{ id: entry.id, sourceDir: session.dir, files: session.files }]
          }),
          kind: 'replace',
          ...(deps.now === undefined ? {} : { now: deps.now() }),
        })
        backedUp = true
      } catch (error) {
        problems.push(
          `覆盖本机那份之前备份失败，这批 ${ready.length} 条一条都没动：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    for (let index = 0; backedUp && index < ready.length; index += 1) {
      const entry = ready[index] as SyncPullEntry
      const session = byId.get(entry.id)
      const bundle = fetched.get(entry.id)
      if (session === undefined || bundle === undefined) continue
      options.onProgress?.({
        phase: 'pull',
        total: pullTotal,
        done: pullJobs.length + index,
        id: entry.id,
        label: entry.title ?? session.title ?? entry.id,
      })
      try {
        rmSync(session.dir, { recursive: true, force: true })
        const importOptions: ImportOptions & { decodeAll: DecodeAll } = {
          root: deps.sessionsRoot,
          targetCwd: entry.toCwd ?? '',
          ...(registry === undefined ? {} : { registry }),
          registryPath: deps.registryPath,
          decodeAll: deps.decodeAll,
        }
        const importPlan = planImport(bundle, importOptions)
        if (importPlan.nextRegistry !== null) registry = importPlan.nextRegistry
        if (importPlan.registryChange !== null) registryChanges.push(importPlan.registryChange)
        const outcome = applyImport(bundle, importPlan, importOptions)
        if (outcome.registryWritten) registryWritten = true
        pulled.push(...outcome.written)
        if (outcome.written.includes(entry.id)) replaced.push(entry.id)
        bytesIn += outcome.bytes
      } catch (error) {
        problems.push(`覆盖 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ── 让宿主认下这批改动：拉取会把会话挂到目标工作区（改注册表），与迁移是同一条语义。
  //    整批落地之后按顺序收口一次，而不是每条会话各来一遍。注册表终态一并交过去：宿主没接住时
  //    它会用内存副本盖掉这次写盘，那时得靠这份终态写回来（见 take-effect.ts 的 `restoreRegistry()`）。
  const effect = registryWritten
    ? await takeEffectOnHostAll(registryChanges, deps, { registry })
    : undefined
  /*
   * ── 接着请宿主把这批会话的列表元数据折出来（同一个收口点）─────────────────────
   *
   * 侧边栏那一行的名字不来自日志：宿主对"从没在本机活过"的会话只读它自己持久化的投影检查点，读不到就
   * 显示"未命名"；而检查点只在活的会话（创建 / `turn/end` / 释放）时被写。拉取来的会话恰好两样都不占，
   * 于是标题、空白判据、最后活动时间一起缺——最后这一样还会让下一次同步的"谁更新"判不出来。详见
   * checkpoint-warm.ts：这一步只是把宿主自己的冷读走一遍，失败逐条兜住，不影响上面的落地结论。
   */
  const warm = await warmCheckpoints(pulled, deps)

  // ── 推送：整包 PUT，然后重写自己那一格的索引 ────────────────────────────────
  const ownDirName = machineDirName(deps.settings.machineId)
  const own = remote.indexes.get(ownDirName)
  const ownEntries = new Map<string, RemoteIndex['entries'][number]>()
  for (const entry of own?.entries ?? []) {
    // 索引只描述"我这台机器现在还拿得出的会话"：本机删掉的下一次推送就从索引里消失
    // （远端那份包不主动删；别的机器自己那份记录照旧）。
    if (byId.has(entry.id)) ownEntries.set(entry.id, entry)
  }
  /*
   * 两类要主动从自己这格撤下来：
   *   - **空白会话**：没有内容可贡献，留着它只会让别的机器把它拉走；
   *   - **刚换成远端那份的**：本机这份现在是别人那份内容，自己这格的旧记录（以及那个包）描述的是
   *     已经不在的那份，留着会让"同一个 id 有多台贡献"那条判据去比两份不同的指纹。
   * 例外是从**自己这格**换回来的那条：那格的记录描述的正是刚落地这份内容（判据与 cwd 无关），留着是
   * 对的——撤掉反而会让远端整个少一条会话。
   */
  for (const id of plan.blank) ownEntries.delete(id)
  for (const entry of replaceJobs) if (entry.machine !== ownDirName) ownEntries.delete(entry.id)
  /*
   * 老索引里的条目没有活动时间（版本 1 一个都没有，版本 2 记的是粗的那枚提问时间）。本机这条恰好与
   * 远端**完全一致**时（两侧指纹都算过、就是同一份内容），顺手把本机投影缓存里的活动时间补上去：
   * 不然这些从此不再变化的会话永远缺时间，两边各自写过时那次比较就只能退回"判不出来"。只补这一种
   * ——其余条目的指纹可能已经不描述本机现状，给它们改时间就成了撒谎。
   *
   * 版本 2 那种只记了提问时间的条目也在这里升级：算出来的活动时间不会比它早，写上去之后下次比较用的
   * 就是细的那枚（`activeAt()` 取的是两枚钟里晚的）。
   */
  for (const entry of plan.push) {
    if (entry.action !== 'skip' || entry.code !== 'identical') continue
    const current = ownEntries.get(entry.id)
    const session = byId.get(entry.id)
    if (current === undefined || session === undefined) continue
    const active = activeAt(metaOf(session))
    if (active === undefined || current.lastActiveAt === active) continue
    // 旧的提问时间那枚钟不再保留：两条说的是同一件事，留两条只会让"哪条是真的"变成一个要猜的问题。
    const { lastPromptAt: _dropped, ...rest } = current
    ownEntries.set(entry.id, { ...rest, lastActiveAt: active })
  }
  const pushJobs = plan.push.filter((entry) => entry.action === 'upload' || entry.action === 'update')
  for (let index = 0; index < pushJobs.length; index += 1) {
    const entry = pushJobs[index] as SyncPushEntry
    const session = byId.get(entry.id)
    if (session === undefined) continue
    options.onProgress?.({
      phase: 'push',
      total: pushJobs.length,
      done: index,
      id: entry.id,
      label: session.title ?? entry.title ?? entry.id,
    })
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
      // 活动时间跟着记录一起上去：别的机器靠它判"两边各自写过时谁更新"（见 planSync 与 readRemoteLibrary）。
      const meta = metaOf(session)
      const active = activeAt(meta)
      ownEntries.set(entry.id, {
        id: session.id,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(found === undefined ? {} : { repo: found.repo, repoPath: found.repoPath }),
        createdAt: session.createdAt,
        ...(active === undefined ? {} : { lastActiveAt: active }),
        files: fingerprints(session, contentHash),
      })
      // 到这里只剩 upload / update 两种（上面筛过），写成三元的形状让类型也跟着收窄。
      pushed.push({ id: entry.id, action: entry.action === 'update' ? 'update' : 'upload' })
      bytesOut += bundle.length
    } catch (error) {
      problems.push(`推送 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`)
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
    replaced,
    pushed,
    bytesIn,
    bytesOut,
    registryWritten,
    indexWritten,
    ...(effect === undefined ? {} : { effect }),
    // 没落到本机任何一条时（纯推送 / 什么都没做）这一步根本没跑，就别摆一个空结论。
    ...(pulled.length === 0 ? {} : { warm }),
    problems,
  }
}
