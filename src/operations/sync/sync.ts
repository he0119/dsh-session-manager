// src/operations/sync/sync.ts — 把 WebDAV 当**运输层**的会话同步（计划与应用）。
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
// （见 paths.ts）。两台机器的同一个项目路径不同，字节级的库互不相认。所以这里只放大包，应用一律
// 走 `transfer.ts` 的 `planImport/applyImport`——由它把 `cwd` 改写成**这台机器**的路径。
//
// 目标目录要先归一成**宿主存的那个拼写**（`canonicalize`，见 canonical-path.ts）：仓库根来自
// `git rev-parse --show-toplevel`（Windows 上是 `C:/…`），映射值来自用户手输，而宿主把工作区路径
// 与会话 cwd 都存成 `fs.realpath` 归一之后的样子、并按字符串相等比成员资格。不归一的话同一个目录
// 会多出一条谁也不认的工作区记录（那条记录登记的那些会话全被滤掉，界面上是个空工作区）。
//
// 为什么一机一格：WebDAV 没有锁，多台机器共写一份 `index.json` 就是"后写的盖掉先写的"。每台机器
// 只写自己那一格、读别人的全部，就不需要锁。
//
// 预览与应用是**两次调用、两份数据**：`prepareSync()` 算计划，并把应用真正要用的输入（本机整库、远端
// 索引、项目身份、比对过的指纹、投影缓存那两件事）一起留下；界面按下确认之后由 `syncPrepared()` 拿
// 那份数据应用，不再把同一份计划重算一次。那份数据会旧（它描述的是预览那一刻），所以应用前先由
// `stalePlanReason()` 验一遍"本机与远端还是不是那个样子"：对得上就照它走，对不上就从零重算一遍
// （宁慢不错——覆盖本机那份会撤掉本机目录，判据旧了会丢内容）。`runSync()` 是单次调用那条路
// （工具层与老调用方），算完就用。
//
// 冲突标准：**空白不搬运，两边都有按"谁更新"择新**。
//
//   - 空白会话（宿主投影缓存判 `blank`，与迁移页同一条标准：建出来但一轮都没开始过）本机不会上传，
//     也会从这台机器自己的那份索引里撤下来——它没有内容可同步，别的机器也就不必再看到它；反过来，
//     本机这条是空白而远端那条有内容时，以远端为准（空的没什么可保的）。
//   - 同一 id 两边都有：内容一致不动；本机严格领先（远端确实是本机这份的前缀）重新推送刷新；
//     **远端领先**（代次是超集）或**各自写了对方没有的条目**时，比一个"谁更新"——本机那份的最后活动时间取宿主
//     投影缓存里的两枚钟（`lastPromptAt` 最后一次提问、`timeContext.lastMessageTime` 最后一条消息，
//     取晚的那枚），远端那份取索引里记的同一个值。远端更新就把本机那份**先备份再换掉**（走导入那条
//     编排，理由见下面 pull 的说明）；本机更新就把自己这一格刷成最新。两边的时间有一个读不到（老索引
//     没这个字段、宿主没挂投影缓存）就退回旧标准：不动，只在报告里说清。
//
// 为什么要那枚细的钟：只比"最后一次提问"时，"推送之后本机又跑了几轮、两边的日志各自长出来"这种
// 情况两边的提问时间往往一模一样，于是最该分高下的场合反而判不出来（本机这份被日志重写切过之后尤其
// 如此）。`lastMessageTime` 把 agent 自己写进去的也算进去，正好补这一段。
//
// 为什么"谁更新"用的是宿主折出来的活动时间而不是文件修改时间：文件的 mtime 经不起复制（下载、
// 解包、备份还原都会把它抹平），而这两枚钟与日志内容同生共死，应用改写 cwd 时也不受影响。
// 判据仍然**不**拿时间反推"谁是祖先"：代次那边的四种关系是结构性的，时间只在结构判不出来时分高下。

import { createHash, randomUUID } from 'node:crypto'
import { diffSessionLogs } from './session-diff.ts'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalDir, type DirCanonicalizer } from '../../shared/canonical-path.ts'
import type { AttachmentPort, AttachmentRef } from '../../shared/attachments.ts'
import { warmCheckpoints, type WarmDeps } from '../../shared/host/checkpoint-warm.ts'
import type { DavPort } from './dav.ts'
import { scanAllAsync, type DiscoveredSession } from '../../shared/library/discovery.ts'
import { createBackup } from '../../shared/journal.ts'
import { encodeSegment, parseSessionLogName } from '../../shared/paths.ts'
import { decodeLogTextChunked } from '../../shared/log/log-decode.ts'
import { splitLinesAsync } from '../../shared/text-chunks.ts'
import { createGitRunner, repoLocation, createRepoLocationCache, type GitRunner, type RepoLocation, type RepoLocationLookup } from '../../shared/repo.ts'
import { sessionMetaOfRecord, type SessionMeta } from '../../shared/visibility.ts'
import { type ContentRelation, type FileFingerprint, fileFingerprint, fingerprints, relation, versionsText, type FingerprintOf, fingerprintCached, sharedFingerprintCache, fingerprintChunkedCached, contentRelationCache, relationKey, remember, contentFingerprint } from './fingerprint.ts'
import { type SyncSettings, normalizeMapping, reservedMachineIdProblem } from './settings.ts'
import { type RemoteLibrary, tombstonesOf, readRemoteLibrary, remoteBundlePath, machineDirName, remoteIndexPath, indexPayload, type RemoteIndex, SYNC_NAMESPACE_DIR } from './index.ts'
import { type SyncAttachmentIn, type SyncAttachmentOut, type AbsentAttachmentSession, type AttachmentReporter, type AbsentObjects, countPackedAttachments, pullAttachments, attachmentRefsOfBundle, attachmentRefsOfFiles, pushAttachments, indexedAttachmentOf, repairAttachments, summarizeAbsent } from './attachments.ts'
import { type SyncTidyResult, planTidy, orphanBundles } from './tidy.ts'
import type { ProgressEvent, EffectOutcome, WarmOutcome, DecodeAll, WorkspaceRegistryState, SessionLogFile, ProgressReporter, RegistryChange } from '../../shared/types.ts'
import { type EffectDeps, takeEffectOnHostAll } from '../../shared/host/take-effect.ts'
import type { TitleQuery } from '../../shared/log/session-title.ts'
import type { ProjectionCacheReader } from '../../shared/library/projection-cache.ts'
import { readRegistry, validateRegistry } from '../../shared/registry.ts'
import { readBundleAsync, entryBytes, buildBundleAsync, type ImportOptions, planImport, applyImport, type SessionBundle, type ExportSource } from '../transfer/transfer.ts'
import { type RemoteWriteGate, createRemoteWriteGate } from './remote-write.ts'

/**
 * 这条会话应用到本机的哪个目录：先取本机这条的 cwd 归一，缺席才把远端记的 cwd 按同步映射（或本机
 * 仓库）翻过来。"覆盖本机那份"与裁决"以远端为准"两处用的是同一把尺子。
 */
function resolveLandedCwd(
  input: Pick<SyncPlanInput, 'mapping' | 'repos' | 'canonicalize'>,
  session: Pick<DiscoveredSession, 'cwd'>,
  remote: { cwd?: string; repo?: string; repoPath?: string },
): string | undefined {
  const canonicalize = input.canonicalize ?? canonicalDir
  const mine = session.cwd === undefined ? undefined : canonicalize(session.cwd)
  if (mine !== undefined) return mine
  const viaRepo = remote.repo === undefined ? undefined : input.repos?.get(remote.repo)
  const picked =
    remote.cwd === undefined
      ? undefined
      : input.mapping.get(remote.cwd) ?? (viaRepo === undefined ? undefined : joinRepoPath(viaRepo, remote.repoPath))
  return picked === undefined ? undefined : canonicalize(picked)
}

/**
 * 真分叉那一句怎么开头：说清"各自写了对方没有的条目"与各自多几条（内容关系在手就带条数），不再拿
 * "两边各自写过"当分组名——续写的对已经走 `local-ahead`/`remote-ahead`，说的都是"谁续写了几条"。
 */
function forkText(content: ContentRelation | undefined, machine: string): string {
  if (content === undefined) return '同一个 id 两边各自写了对方没有的条目'
  return `同一个 id 两边各自写了对方没有的条目（本机多 ${content.localTail} 条、${machine} 多 ${content.remoteTail} 条）`
}

/** 两边各自写过时，谁更新的结论。 */
export type NewerSide = 'local' | 'remote' | 'unknown'

/**
 * 比"谁更新"：本机那份的活动时间与远端索引里记的那个。
 *
 * 两边都拿得到才下结论，缺一个就是 `unknown`——**不下手**好过按半个事实覆盖掉一份；两边一样新也
 * 归 `unknown`（同一次活动各写各的，随手挑一个赢家会凭空丢掉另一份）。这几种都退回旧标准：报告里
 * 说清是"远端更新"还是"各自写了对方没有的条目"，但一个字节都不动。
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
export function remoteActiveAt(entry: { lastActiveAt?: number; lastPromptAt?: number } | undefined): number | undefined {
  return entry?.lastActiveAt ?? entry?.lastPromptAt
}

/**
 * 同一代次下比字节数：日志只追加，所以同代次里更长的那份就是续写过的。
 *
 * 为什么要有这一条：代次相同、内容不同（两边各自从同一份往下写）在 `relation()` 眼里就是 `diverged`，
 * 而它只比代次集合与哈希，比不出谁更长。远端合并两格副本时若只按活动时间判，而两边都没记那枚钟
 * （旧版同步推上去的记录、或投影缓存里没有），就只能退回"格子名排序取第一个"——那跟谁更新毫无关系。
 * 一条会话在 A 上写过、被 B 拉下来继续写、B 再推上去，之后 A 的格子名恰好排在前面，每次预览都会说
 * "本机续写了 N 条，重推刷新"，推完还是同一句，永远收敛不了。日志是追加写，同代次更长的那份确实
 * 就是更新的那份，用它当第一判据比格子名可靠。
 *
 * @returns `'local'` = 前者更长，`'remote'` = 后者更长，`'unknown'` = 代次不同或字节数一样（退回比时间）。
 */
export function longerSide(
  mine: readonly FileFingerprint[],
  theirs: readonly FileFingerprint[],
): NewerSide {
  const top = (files: readonly FileFingerprint[]): FileFingerprint | undefined =>
    files.reduce<FileFingerprint | undefined>((best, file) => (best === undefined || file.version > best.version ? file : best), undefined)
  const left = top(mine)
  const right = top(theirs)
  if (left === undefined || right === undefined) return 'unknown'
  if (left.version !== right.version) return 'unknown'
  if (left.bytes > right.bytes) return 'local'
  if (right.bytes > left.bytes) return 'remote'
  return 'unknown'
}

export function newerSide(mine: number | undefined, theirs: number | undefined): NewerSide {
  if (mine === undefined || theirs === undefined) return 'unknown'
  if (mine > theirs) return 'local'
  if (theirs > mine) return 'remote'
  return 'unknown'
}

/**
 * 「两份都保留」时谁占原来的 id，以及为什么。
 *
 * 只有 `remote-newer` 是"远端那份占 id"：比不出来（旧索引没有那枚钟、或者两边一样）、以及更晚的是
 * 远端那份但它这次写不进去地，都由本机这份占。
 */
type BothKeeper = 'local-newer' | 'remote-newer' | 'remote-blocked' | 'unknown'

/**
 * 「两份都保留」那一行计划里的说明：谁占了原来的 id、为什么是它、另一份去了哪。
 *
 * 写在计划里（宿主侧）、界面原样当悬浮提示：理由的判据在这里，界面不该再按码猜一遍。
 * @param why 占 id 的判据（见 `BothKeeper`）。
 * @param machine 远端那份来自哪台机器。
 */
function bothNote(why: BothKeeper, machine: string): string {
  switch (why) {
    case 'local-newer':
      return `两份都保留：本机这份更晚，占住原来的 id（${machine} 那份落成一条新会话）`
    case 'remote-newer':
      return `两份都保留：${machine} 那份更晚，占住原来的 id（本机那份落成一条新会话）`
    case 'remote-blocked':
      return `两份都保留：${machine} 那份更晚，但它这次写不进去地（缺映射、目标目录不存在或会话正开着），改由本机这份占住原来的 id（${machine} 那份落成一条新会话）`
    case 'unknown':
      return `两份都保留：比不出哪份更晚，由本机这份占住原来的 id（${machine} 那份落成一条新会话）`
  }
}

/** 拉取方向的一条。 */
export interface SyncPullEntry {
  id: string
  title?: string
  /** 包里的原 cwd。 */
  fromCwd?: string
  /** 写入磁盘后的 cwd（没有 cwd 的会话没有这一项，落 `_no-cwd`）。 */
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
  code:
    | 'missing'
    | 'remote-ahead'
    | 'remote-newer'
    | 'blank-local'
    | 'no-mapping'
    | 'missing-target'
    | 'keep-remote'
    /** 别处删过了、远端这份比那次删除更旧：不拉回来（见 `SyncDeletedEntry`）。 */
    | 'deleted'
  /**
   * 落选的本机那份也要留（只有「两份都保留」的裁决才置它）：应用时落成一条新会话，原 id 让给远端那份。
   * 缺席 = 只留远端那份，本机这份先备份再被顶掉。
   */
  keepLoser?: true
  reason?: string
}

/**
 * 一条要动却动不了的计划行为什么没动。
 *
 * 与 `code`（两边的内容关系）分开：同样是 `diverged`，有的是"目标目录不存在"、有的是"会话正开着"、
 * 还有的是"判不出谁更新"——三件事该由用户做的事完全不同，界面要按它分组，不能靠解析 `reason`。
 */
export type SyncBlockReason = 'no-mapping' | 'missing-target' | 'live' | 'newer-unknown'

/** 推送方向的一条。 */
export interface SyncPushEntry {
  id: string
  title?: string
  cwd?: string
  /** 本地这份的字节数（未压缩；远端实际收到的是 gzip 之后的包）。 */
  bytes: number
  action: 'upload' | 'update' | 'skip'
  /** 机器可读的分类（界面按它挑文案与过滤，不去解析 `reason`）。 */
  code: 'missing' | 'local-ahead' | 'local-newer' | 'identical' | 'remote-ahead' | 'diverged' | 'keep-local'
  /**
   * 没做成的原因（只有 `action: 'skip'` 的行有）。
   *
   * 缺失 = 旧宿主没这一项，或这一行不是"要动却动不了"的那一类；界面把它归到「其它问题」。
   */
  blockedBy?: SyncBlockReason
  /** 远端那一份由哪台机器贡献（"远端领先 / 两边各自写过"要指名道姓）。 */
  machine?: string
  /**
   * 落选的远端那份也要留（只有「两份都保留」的裁决才置它）：应用时把远端那份落成一条新会话，
   * 原 id 仍由本机这份占着。缺席 = 只留本机这份，远端那份不落到本机。
   */
  keepLoser?: true
  reason?: string
}

/**
 * 别处删过、本机这份更旧的一条会话：这次跟着删（先进备份，再删本机目录与这台机器那一格里的包）。
 *
 * 为什么跟着删而不是留着：留着就会在下一次同步里被当成"本机有、远端没有"重新推上去，删除等于没发生。
 * 判据只有一条：本机这份的最后活动时间不晚于那次删除（见 `Tombstone`）。
 */
export interface SyncDeletedEntry {
  id: string
  title?: string
  /** 谁删的（机器 id）。 */
  by: string
  /** 那次删除的时刻（毫秒时间戳）。 */
  at: number
  /** 本机这份的字节数。 */
  bytes: number
  cwd?: string
}

/**
 * 写索引与清远端要的那几样（同步与"删除时清远端"两处共用；`SyncDeps` 天然满足）。
 */
export type RemoteCopiesPort = {
  dav: DavPort
  settings: SyncSettings
  now?: () => Date
  pluginVersion?: string
}

/** 删除时清远端的结果（见 `removeRemoteCopies()`）。 */
export interface RemoteRemoval {
  /** 从这台机器那一格里真删掉的包数。 */
  removed: number
  /** 删掉的那些包在索引里记的字节数。 */
  bytes: number
  /** 别的机器格子里还留着副本的那些机器（它们下次同步会跟着删）。 */
  others: string[]
  /** 没做成的那几步（远端读不到、包删不掉、索引写不进去）。 */
  problems: string[]
}

/** 一次同步的计划（纯计算，不碰网络也不写入磁盘）。 */
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
  /** 别处删过、本机这份更旧的那些：这次跟着删（见 `SyncDeletedEntry`）。 */
  deleted: SyncDeletedEntry[]
  /** 会被跟着删掉的会话 id。 */
  deletedIds: string[]
  /** 本机判为空白、这次不参与同步的会话 id（按发现顺序；它们不在上面两张表里）。 */
  blank: string[]
  /**
   * 代次与哈希筛不动、需要内容判据的那些对（编排那条异步路据此取两边日志，见 `prepareSync()`）。
   *
   * 单列一项而不是让调用方从行里猜：`pushOnly` 那条路会把分叉行整表摘掉（见 `narrowToPushOnly()`），
   * 而"这一对需要判"与"这一次动不动它"是两件事。
   */
  needsContent: string[]
  bytesIn: number
  bytesOut: number
  localCount: number
  remoteCount: number
  /** 远端有索引的机器。 */
  machines: string[]
}

/** `planSync()` 的入参。 */
/**
 * 两边各自写过时留哪一份：`keep-local` 只留本机这份、`keep-remote` 只留远端那份、`keep-both` 两份都留。
 *
 * 前两种是"只有一份留在这个库里"，另一种那份不再落到本机（远端那份留在原来那台机器上，本机那份被
 * 顶掉之前先备份）；`keep-both` 才把另一份落成一条新会话，占原 id 的那份按最后活动时间定。
 */
export type SyncDecision = 'keep-local' | 'keep-remote' | 'keep-both'

export interface SyncPlanInput {
  /**
   * 内容级的关系（会话 id → 谁是谁的前缀），由编排那条异步路取两边日志算好传进来。
   *
   * 只喂"代次与哈希筛不动"的那些对：它们本该落到 `diverged`（两条都不动），有了内容关系就能定成
   * 领先 / 落后 / 真分叉。缺席 = 没算，照旧归 `diverged`。判据在 `relation()` 一处。
   */
  contentRelations?: ReadonlyMap<string, ContentRelation>
  /**
   * 两边各自写过时的裁决（会话 id → 留哪一份）。
   *
   * 三种标准见 `SyncDecision`：选单边时另一份不留（本机那份先备份再被顶掉；远端那份不落到本机）；
   * 选「两份都保留」时另一份落成一条**新会话**（新 id，标题带「原标题 · 来自 <机器> <时刻>」的来源
   * 标记，见 `branchSessionLog()`），占原 id 的那份按最后活动时间定。缺席 = 这条没有裁决，照旧两条
   * 都不动（`diverged`）。
   */
  decisions?: ReadonlyMap<string, SyncDecision>
  /** 本机整库（`scanAllAsync()` 的结果）。 */
  local: readonly DiscoveredSession[]
  remote: RemoteLibrary
  mapping: ReadonlyMap<string, string>
  /**
   * 身份 → 本机仓库根（`repoLocation()` 扫出来的）。
   *
   * 两张表的分工：`mapping` 是用户显式配的（他说了算），`repos` 是从本机磁盘上认出来的项目。显式的
   * 先赢——配了映射就按映射应用，不会因为"本机恰好也有这个仓库"而改道。两边都没有就跳过（照旧）。
   */
  repos?: ReadonlyMap<string, string>
  /** 算指纹；计划阶段只对"两边都有"的会话算（整库哈希不该被白算）。 */
  hashFile?: (path: string, version: number, compression: string | null) => FileFingerprint
  /** 目标目录是不是真的存在（映射对不上真实目录就不应用）。 */
  isDirectory?: (path: string) => boolean
  /**
   * 读这条本机会话的空白与最后活动时间（宿主投影缓存；见 visibility.ts 的 `SessionMeta`）。
   *
   * 缺席 = 两件事都不知道：空白按"非空白"处理（宁可不判，也不把用户看得见的会话悄悄踢出同步），
   * 活动时间按"比不出来"处理（退回"不动"）。这与迁移页那边 `resolveBlank` 缺席时的标准一致。
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
   * 把目标目录换成宿主存的那个拼写（缺省 `canonicalDir`，见 canonical-path.ts）。
   *
   * 计划里报的 `toCwd` 与应用用的必须是同一个字符串，所以归一发生在**计划**这一层：预览看到的目标、
   * 改写进 header 的 cwd、注册表里那条记录的 `path` 因此是同一份值。可注入是为了让计划这条纯计算的
   * 测试不必真建目录。
   */
  canonicalize?: DirCanonicalizer
  /**
   * **只推不拉**：算出来的计划里只留推送那一侧，拉取与"覆盖本机"一条都不留（见 `planSync()`）。
   *
   * 这是自动推送那条路的开关（`src/operations/sync/sync.ts` 的 `runAutoPush()`）。缺席 = false：界面上手动同步照旧
   * 两个方向都做。
   */
  pushOnly?: boolean
}

/**
 * 本机仓库根 + 仓库内相对路径 → 目标目录。
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
  /** 筛不动、要内容判据的那些对（本机与远端都有、非空白）。 */
  const needsContent: string[] = []
  const blank: string[] = []
  /** 别处删过、本机这份更旧的那些：这次跟着删（见 `SyncDeletedEntry`）。 */
  const deleted: SyncDeletedEntry[] = []
  const deletedIds: string[] = []
  /** 所有机器索引里的删除记录（同一个 id 取最晚那次删除）。 */
  const tombstones = tombstonesOf(input.remote)
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
    /*
     * 别处删过了：远端这份要是比那次删除更旧（或旧索根本没记活动时间），它就是一份没人要的残留——
     * 拉回来等于把删除抹掉。这份包等它那台机器下次同步时自己清掉（各自只管自己那一格）。
     */
    const grave = tombstones.get(id)
    if (grave !== undefined && (entry.lastActiveAt ?? 0) <= grave.at) {
      pull.push({ ...base, action: 'skip', code: 'deleted', reason: `已在 ${grave.machine} 上删除，不再拉回来` })
      continue
    }
    if (entry.cwd === undefined) {
      // 没有 cwd 的会话不硬塞一个：照着包里的样子落 `_no-cwd`，也不进注册表（与导入同一条标准）。
      pull.push({ ...base, action: 'create', code: 'missing' })
      pullIds.push(id)
      bytesIn += bytes
      continue
    }
    // 应用顺序：显式映射（用户配了就算数）→ 仓库身份 + 仓库内相对路径（配置不必每台机器一份）→ 跳过。
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
      problems.push(`同步映射把 ${entry.cwd} 指到了 ${target}，但那不是一个存在的目录`) // 见 missingTargetProblem()
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
    /*
     * 这条在别处被删过：本机这份不比那次删除新，就跟着删（否则下一次同步会把它当"本机有、远端没有"
     * 重新推上去，删除等于没发生）。本机这份更新时保留——那条会话在删除之后还在这台机器上写过，
     * 按"谁更新谁赢"是它赢，墓碑在这台机器上作废。
     */
    const grave = tombstones.get(session.id)
    if (grave !== undefined && (mineActiveAt === undefined || mineActiveAt <= grave.at)) {
      deleted.push({
        id: session.id,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        by: grave.machine,
        at: grave.at,
        bytes,
      })
      deletedIds.push(session.id)
      continue
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
    const kind = relation(mine, theirs, input.contentRelations?.get(session.id))
    if (kind === 'diverged' && !isBlank) needsContent.push(session.id)
    /** 这一对的内容关系（有就按它说话：续写几条、各自多几条）。 */
    const content = input.contentRelations?.get(session.id)
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
        reason:
          content !== undefined
            ? `本机续写了 ${content.localTail} 条（远端停在 ${versionsText(theirs)}，本机到 ${versionsText(mine)}）`
            : `远端停在 ${versionsText(theirs)}，本机到 ${versionsText(mine)}`,
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
    /*
     * 裁决优先于"比谁新"：两边各自写过时用户已经挑好留哪一份。三种标准：
     *   - `keep-local`：只留本机这份——远端那份不落到本机（它还在原来那台机器上）；
     *   - `keep-remote`：只留远端那份——本机这份先备份再被顶掉；
     *   - `keep-both`：两份都留——最后活动时间更晚的那份占原来的 id，另一份落成一条新会话。
     * 空白那份与结构性的"远端领先"不在此列：前者没有内容可保，后者本来就不是分叉。
     */
    const asked = isBlank || kind === 'remote-ahead' ? undefined : input.decisions?.get(session.id)
    /** 应用那一步要用的目录（裁决"留远端那份"要它；与"覆盖本机那份"同一把尺子）。 */
    const target = resolveLandedCwd(input, session, remote)
    /** 远端那份这次真落得下来吗：缺映射、映射指到的目录不存在、会话正开着都算落不下来。 */
    const remoteLands = (): boolean => {
      if (target === undefined && remote.cwd !== undefined) return false
      if (target !== undefined && session.cwd === undefined && !isDirectory(target)) return false
      return input.isLive?.(session.id) !== true
    }
    /**
     * 「两份都保留」为什么由这一方占原 id：比最后活动时间（与"谁更新"同一个值）。
     *
     * 三种退化都归到"本机占"：比不出来（旧索引没记这枚钟、或者两边一样）、以及更晚的是远端那份但它
     * 这次写不进去地。后者不能就这么把行降成"不动"——那等于按了按钮什么也没发生；本机占 id 那份总能
     * 推上去，两份内容也都还在。
     */
    let both: BothKeeper | undefined
    if (asked === 'keep-both') {
      const side = newerSide(mineActiveAt, theirActiveAt)
      both =
        side === 'unknown'
          ? 'unknown'
          : side === 'local'
            ? 'local-newer'
            : remoteLands()
              ? 'remote-newer'
              : 'remote-blocked'
    }
    const decision: SyncDecision | undefined =
      both === undefined ? asked : both === 'remote-newer' ? 'keep-remote' : 'keep-local'
    if (decision === 'keep-local') {
      push.push({
        ...common,
        action: 'update',
        code: 'keep-local',
        ...(both === undefined ? {} : { keepLoser: true }),
        machine: remote.machine,
        reason:
          forkText(content, remote.machine) +
          (both === undefined
            ? `，只保留本机这份（${remote.machine} 那份不落到本机，它还在那台机器上）——把自己这一格刷成最新`
            : `，${bothNote(both, remote.machine)}——把自己这一格刷成最新`),
      })
      pushIds.push(session.id)
      bytesOut += bytes
      continue
    }
    if (decision === 'keep-remote') {
      // 写不进去地的两种情形照旧拦下（与"覆盖本机那份"那两道拦同一标准）：没有映射、或映射指到的目录不存在。
      if (target === undefined && remote.cwd !== undefined) {
        push.push({
          ...common,
          action: 'skip',
          code: 'diverged',
          blockedBy: 'no-mapping',
          machine: remote.machine,
          reason: `本机这条没有 cwd，远端记的是 ${remote.cwd}，本机又没有它的同步映射——先补映射再同步`,
        })
        continue
      }
      if (target !== undefined && session.cwd === undefined && !isDirectory(target)) {
        problems.push(`同步映射把 ${remote.cwd ?? ''} 指到了 ${target}，但那不是一个存在的目录`) // 见 missingTargetProblem()
        push.push({
          ...common,
          action: 'skip',
          code: 'diverged',
          blockedBy: 'missing-target',
          machine: remote.machine,
          reason: `目标目录不存在：${target}`,
        })
        continue
      }
      if (input.isLive?.(session.id) === true) {
        push.push({
          ...common,
          action: 'skip',
          code: 'diverged',
          blockedBy: 'live',
          machine: remote.machine,
          reason: '这条会话正开着（宿主手里还有写句柄），裁决这次不生效',
        })
        continue
      }
      pull.push({
        ...common,
        ...(remote.cwd === undefined ? {} : { fromCwd: remote.cwd }),
        ...(target === undefined ? {} : { toCwd: target }),
        action: 'replace',
        code: 'keep-remote',
        ...(both === undefined ? {} : { keepLoser: true }),
        machine: remote.machine,
        reason:
          forkText(content, remote.machine) +
          (both === undefined
            ? `，只保留 ${remote.machine} 那份（本机这份先备份再被顶掉）`
            : `，${bothNote(both, remote.machine)}——先备份本机这份再换成它`),
      })
      pullIds.push(session.id)
      bytesIn += bytes
      continue
    }
    const side = kind === 'remote-ahead' || isBlank ? 'remote' : newerSide(mineActiveAt, theirActiveAt)
    if (side === 'local') {
      push.push({
        ...common,
        action: 'update',
        code: 'local-newer',
        machine: remote.machine,
        reason:
          `${forkText(content, remote.machine)}（本机 ${versionsText(mine)}，${remote.machine} ${versionsText(theirs)}），` +
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
          blockedBy: 'live',
          machine: remote.machine,
          reason: `${remote.machine} 那份更新，但本机这条还在宿主内存里（运行中或已打开）——重启 DSH 让宿主放手，之后别先点开它再同步`,
        })
        continue
      }
      /*
       * 目标目录：**本机这条自己的 cwd 优先**。这条会话在本机已经有家（还有工作区登记），不该因为
       * 远端记着另一条路径就把它搬走；本机这条没有 cwd 时才按"显式映射 → 仓库身份"认，与新建拉取
       * 同一条路。两种来路都要归一：本机这条的 cwd 也可能是宿主不认的另一种拼写（分隔符、大小写、
       * 结尾分隔符）。
       */
      const target = resolveLandedCwd(input, session, remote)
      if (session.cwd === undefined) {
        if (target === undefined && remote.cwd !== undefined) {
          push.push({
            ...common,
            action: 'skip',
            code: kind,
            blockedBy: 'no-mapping',
            machine: remote.machine,
            reason: `本机这条没有 cwd，远端记的是 ${remote.cwd}，本机又没有它的同步映射——先补映射再同步`,
          })
          continue
        }
        if (target !== undefined && !isDirectory(target)) {
          problems.push(`同步映射把 ${remote.cwd ?? ''} 指到了 ${target}，但那不是一个存在的目录`) // 见 missingTargetProblem()
          push.push({
            ...common,
            action: 'skip',
            code: kind,
            blockedBy: 'missing-target',
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
    // 分叉、且有一边读不到活动时间（老索引 / 宿主没挂投影缓存）：退回旧标准，两条都不动，理由是"比不出来"。
    push.push({
      ...common,
      action: 'skip',
      code: 'diverged',
      blockedBy: 'newer-unknown',
      machine: remote.machine,
      reason:
        `${forkText(content, remote.machine)}（本机 ${versionsText(mine)}，${remote.machine} ${versionsText(theirs)}），` +
        `又判不出谁更新（本机 ${timeText(mineActiveAt)}、远端 ${timeText(theirActiveAt)}）——两条都不动`,
    })
  }

  if (input.pushOnly === true) {
    narrowToPushOnly({ problems, pull, pullIds, push, pushIds })
    // 没有拉取就没有入流量：这一项是"这次往本机写了多少"的报告值，跟着那张表一起归零。
    bytesIn = 0
    /*
     * 只推不拉那一路（后台自动推送）不做删除：跟着删一条会话要先进备份再删目录，那是"用户按下同步、
     * 看过计划"才做的事，不该在后台悄悄发生。
     */
    deleted.length = 0
    deletedIds.length = 0
  }

  return {
    ok: problems.length === 0,
    problems,
    pull,
    push,
    pullIds,
    pushIds,
    deleted,
    deletedIds,
    blank,
    needsContent,
    bytesIn,
    bytesOut,
    localCount: input.local.length,
    remoteCount: input.remote.entries.size,
    machines: input.remote.machines,
  }
}

/**
 * 把一份算好的计划收窄成"**只推不拉**"：拉取整表摘掉，推送表只留真会推的那几种。
 *
 * 这是自动推送那条路（`runAutoPush()`）唯一改判定的地方，两个动作各自有理由：
 *
 * **拉取整表摘掉**。`plan.pull` 不是"远端有什么"，而是"这次要往**本机**放什么"（含"覆盖本机那份"）。
 * 只推的那条路上一个字都不该落到本机——无人在场，而覆盖本机是这个插件里唯一会撤掉本机已有内容的
 * 动作。连同 `pullIds` 与 `bytesIn` 一起清掉，消费方（界面、工具返回值、进度分母）读到的就是同一
 * 件事：这次没有应用。
 *
 * **推送表逐条过滤**，留下的恰好是"本机这一侧确实领先"的那几类：
 *   - `upload` / `missing`（远端没有）：本机独有，推送时只有新增；
 *   - `update` / `local-ahead`（远端停在旧代次）：远端那份是本机这份的前缀，刷新它是纯增量；
 *   - `update` / `local-newer`（两边各自写过而本机更新）：把自己这一格刷成最新，**不碰**本机；
 *   - `skip` / `identical`（内容一致）：留着，它是"这次不用动"的唯一一条说明。
 *
 * 其余 `skip` 全部摘掉，它们是三种"要动本机或判不出来"的情形：`remote-ahead`（远端领先，今天走
 * "覆盖本机那份"）、`diverged`（两边各自写过又判不出谁更新，今天两条都不动，但那是留给**界面**看的
 * 结论）、以及活会话当前那次 skip。留在纯推送的计划里只会让"这次不推它"看起来像一次判断，而在这条
 * 路上它根本不是判断——**这个方向本来就不在**。
 *
 * 摘掉的行不进 `blank`：`blank` 是"空白会话"专用的名单，混进"因为只推所以不推"的条目就把两件事说成
 * 一件了。
 *
 * **`problems` 里那两条"目录不存在"要改写**：它们是拉取侧算目标目录时记下的（映射指到了一个不存在的
 * 目录），而只推的这条路**不看目标目录**——那个坑在这次动作里根本不存在，留着它会让自动推送在界面上
 * 报一个与它无关的错，甚至按 `ok: false` 拦住整轮。原文改成一句把因果说清的话：它只影响拉取。
 *
 * @param plan 已经算完的两张表（就地收窄）。
 */
function narrowToPushOnly(plan: {
  problems: string[]
  pull: SyncPullEntry[]
  pullIds: string[]
  push: SyncPushEntry[]
  pushIds: string[]
}): void {
  for (const [index, problem] of plan.problems.entries()) {
    const rewritten = missingTargetProblem(problem)
    if (rewritten !== undefined) plan.problems[index] = rewritten
  }
  // 拉取整表（含"覆盖本机"那几条）与它的 id 名单一起清空——`bytesIn` 由调用方归零。
  plan.pull.length = 0
  plan.pullIds.length = 0
  const kept = plan.push.filter((entry) => entry.action !== 'skip' || entry.code === 'identical')
  plan.push.length = 0
  plan.push.push(...kept)
  const keptIds = new Set(kept.map((entry) => entry.id))
  for (let index = plan.pushIds.length - 1; index >= 0; index -= 1) {
    if (!keptIds.has(plan.pushIds[index] as string)) plan.pushIds.splice(index, 1)
  }
}

/** 拉取侧那条"映射指到了不存在的目录"的原话，以及只推时替它说的话（见 `narrowToPushOnly()`）。 */
const MISSING_TARGET_RE = /^同步映射把 (.*) 指到了 (.*)，但那不是一个存在的目录$/

/**
 * 把"映射指到了不存在的目录"改写成只推那条路上成立的说法。
 * @param problem 一条 problem 原话。
 * @returns 改写后的话；不是那一条就是 undefined（原样留着）。
 */
function missingTargetProblem(problem: string): string | undefined {
  const matched = MISSING_TARGET_RE.exec(problem)
  if (matched === null) return undefined
  return `同步映射把 ${matched[1]} 指到了 ${matched[2]}，那个目录在不在不影响这次推送（只有拉取才要目标目录）`
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
 * 0.2 秒）、最后逐条比对内容，然后应用再分拉与推两段（先拉的 3 条与后推的 84 条同样不是一个分母）。
 * **预览报的是前四段**；应用那一次要么照着预览那份数据直接走（只多报一条 `remote`——它要重读一次远端
 * 索引，验数据有没有变），要么（数据变了、或这次没有预览数据）从零重算一遍、把那四段照报一遍。所以
 * 按下确认到第一条拉取之间总有一条东西在动，不会对着一动不动的按钮干等。
 */
/**
 * 同步报的那几段（形状与共用词汇完全同源，见 `types.ts` 的 `ProgressEvent`）。
 *
 * `done` 是**已经做完**的条数——事件发在开始处理下一条之前，所以正在处理的是第 `done + 1` 条。
 *
 * 六段各有各的分母：`scan` / `remote` / `repo` / `compare` 是算计划的四段（预览就有），
 * `pull` / `push` 是真写入磁盘的两段。`id` 与 `label` 只有写入磁盘那两段有（"正在处理某一条"），算计划那四段
 * 只报做到哪儿。
 */
export type SyncProgress = ProgressEvent

/** 应用的结果。 */
export interface SyncOutcome {
  plan: SyncPlan
  /** 这次是不是真的写入磁盘了（`apply` 为 false 时全是只读）。 */
  applied: boolean
  /** 拉取并写入磁盘的会话 id。 */
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
  /**
   * 附件对象那一段（远端共享库里搬的那些），按**对象**计而不是按引用计：同一个对象被多条会话引用只
   * 搬一次。宿主没有附件服务时两项都缺席——界面据此什么都不说，而不是报一串 0。
   *
   * 只有真跑（`applied`）时才有意义；预览那一步不知道远端有哪些对象（远端索引里只记日志的指纹，
   * 见 `prepareSync()`），所以计划里报不出这个数。
   */
  attachmentIn?: SyncAttachmentIn
  attachmentOut?: SyncAttachmentOut
  /**
   * 引用了"本机与远端都没有"的对象的那几条会话（见 `AbsentAttachmentSession`）。
   *
   * 缺席 = 这一轮没有这种对象（或宿主没有附件服务）。它与 `problems` 里那句汇总说同一件事：那句报
   * 数、这一项报人。
   */
  absentAttachments?: AbsentAttachmentSession[]
  /**
   * 这次**跟着删掉**的会话（别台机器删过、本机这份更旧，见 `SyncDeletedEntry`）。
   *
   * 缺席 = 这一趟没有要跟着删的。删之前先备份，所以界面给的提示里能带着「撤销」那条路（与删除同一套）。
   */
  deleted?: { ids: string[]; bytes: number }
  registryWritten: boolean
  indexWritten: boolean
  /**
   * 整理远端那一步（勾了才做）：删掉自己那一格里多余的包与没有索引条目的包。
   * 缺席 = 这次没勾、或索引没写成功（那时一个包都不动）。
   */
  tidy?: SyncTidyResult
  /**
   * 拉取改的那几笔注册表有没有被宿主接住（见 take-effect.ts）：`undefined` = 这次没写注册表
   * （预览或纯推送）。
   */
  effect?: EffectOutcome
  /**
   * 拉取来的会话在本机没有宿主的投影检查点（它们从没在本机活过）：这一步是"请宿主重新折一遍"的结果，
   * 缺席 = 这次没有落到本机的会话（见 checkpoint-warm.ts）。
   */
  warm?: WarmOutcome
  /**
   * 这次应用走的哪条路（只有"先预览、后确认"那条路会写它）。
   *
   * 单次调用（工具层那一次 `apply:true`，没有"预览那份"这回事）没有这一项。
   */
  planSource?: SyncPlanSource
  problems: string[]
}

/**
 * 一趟同步「没做到」的一条：一句点名的话，能定位到某条会话时带上它的 id。
 *
 * 为什么单独有这一份：`problems` 是几句汇总（"映射指到了不存在的目录""有 3 个附件对象补不上"），
 * 数得出条数、看不出是哪条会话。同步跑完之后窗口一关，用户手上只剩页头那句"上次同步有 1 条没做到"，
 * 到底哪一条、为什么，`problems` 答不上来（它连会话 id 都没有）。这一份是点名版：每条会话一条，
 * 带上 id，界面据此给出「只看这一条」。
 *
 * 三组字段各有各的用处，缺一不可：
 * - `message` 是一整句（工具输出、旧记录、以及"不属于任何一条会话"的那些都只有它）；
 * - `title` / `detail` 把同一句话拆成"哪条会话"与"为什么"，界面分两行画（50 条的清单里，名字与原因
 *   混在一行时读不出谁是谁）；
 * - `kind` 是机器可读的分类，界面按它分组——"缺附件""两边都写过""目录对不上"要人做的事完全不同。
 */
export interface SyncLeftover {
  /** 一句话，已经点名（会话名 + 原因，或 `problems` 里的原话）。 */
  message: string
  /** 能定位到某条会话时带上 id；映射、远端索引、整理那几步的问题没有这一项。 */
  sessionId?: string
  /** 会话名（有的话）。界面拿它当标题，`sessionId` 单独一行；旧记录没有这一项。 */
  title?: string
  /** 这一条属于哪一类（界面按它分组）。缺失 = 旧记录，界面归到「其它问题」。 */
  kind?: SyncLeftoverKind
  /** 原因那一句，不含会话名与 id。缺失 = 旧记录，界面直接画 `message`。 */
  detail?: string
}

/**
 * 「没做到」的五类（四类具体原因 + 兜底），按界面分组的顺序排。
 *
 * 分类不是按句子猜的：计划行在造出来的时候就带着 `blockedBy`，附件那一段本来就是按会话折的。
 */
export type SyncLeftoverKind = 'attachment' | 'fork' | 'live' | 'path' | 'other'

/** 计划行为什么没做成 → 界面上那一类。 */
function leftoverKindOf(blocked: SyncBlockReason | undefined): SyncLeftoverKind {
  switch (blocked) {
    case 'no-mapping':
    case 'missing-target':
      return 'path'
    case 'live':
      return 'live'
    case 'newer-unknown':
      return 'fork'
    default:
      // 旧宿主没有 `blockedBy`（或以后多出一种我们还不认识的原因）：不猜，归到「其它问题」。
      return 'other'
  }
}

/**
 * 把一次同步的结论摊成"没做到的条目"。
 *
 * 两段来路，顺序就是用户该看的顺序：
 *
 * 1. **逐条会话**：计划里那些 `skip`（`identical` 不算——那本来就"不用做"；`no-mapping` 也不算——
 *    这台机器没有那个项目，见下面那条注释）。它们带着标题与 id，所以点得出名字、跳得回列表。
 * 2. **其它问题**：`plan.problems` 与 `outcome.problems` 的原话（映射指错、远端索引读不动、整理失败
 *    这几类），它们不属于某一条会话，原样列出。
 *
 * 完全一样的句子只留一条（计划与应用两段可能算出同一句）。
 *
 * @param outcome 一次同步（预览或应用）的结论。
 * @returns 点名与否的条目；一件事都没有时是空数组。
 */
export function collectLeftovers(outcome: SyncOutcome): SyncLeftover[] {
  const leftovers: SyncLeftover[] = []
  const seen = new Set<string>()
  const push = (leftover: SyncLeftover): void => {
    if (seen.has(leftover.message)) return
    seen.add(leftover.message)
    leftovers.push(leftover)
  }
  for (const row of [...outcome.plan.pull, ...outcome.plan.push]) {
    // `identical` 是"本来就没事"；`deleted` 是"别处删过了，这次不拉它"——两者都不是没做到。
    if (row.action !== 'skip' || row.code === 'identical' || row.code === 'deleted') continue
    /*
     * 缺映射不算「没做到」：那是"这台机器没有这个项目"，这一条本来就不该落到这里（计划里「这次不动」
     * 那张表已经写清原因）。把它算进来时，从另一台机器同步过来会挂着一串「没有 C:\… → 本机的同步
     * 映射」——实测一台机器上 201 条，状态栏那格于是永远黄着，真正要人看的失败反而被埋掉。
     */
    if (row.code === 'no-mapping') continue
    const reason = 'reason' in row && typeof row.reason === 'string' ? row.reason : row.code
    const title = 'title' in row ? row.title : undefined
    const name = title === undefined || title === '' ? row.id : `${title}（${row.id}）`
    /*
     * 拉取那张表里唯一会跳过的原因是「目标目录不存在」（`no-mapping` 与 `deleted` 上面已经排掉）；
     * 推送那张表带着 `blockedBy`，由它说清是目录、会话正开着、还是判不出谁更新。
     */
    const kind = 'blockedBy' in row ? leftoverKindOf(row.blockedBy) : row.code === 'missing-target' ? 'path' : 'other'
    push({
      message: `${name}：${reason}`,
      sessionId: row.id,
      ...(title === undefined || title === '' ? {} : { title }),
      kind,
      detail: reason,
    })
  }
  /*
   * 附件对象那一头的"没做到"：对象本机没有、远端共享库里也没有（持有它们的机器还没推）。一句汇总只
   * 说得出数，处置却要落到**某一条会话**上，所以这里逐条点名、带上 id（与上面那些跳过同一个形状）。
   */
  for (const item of outcome.absentAttachments ?? []) {
    const detail = `这条会话引用的 ${item.count} 个附件对象本机没有、远端共享库里也没有（持有这些对象的机器还没推送它们）`
    const name = item.title === undefined || item.title === '' ? item.sessionId : `${item.title}（${item.sessionId}）`
    push({
      message: `${name}：${detail}`,
      sessionId: item.sessionId,
      ...(item.title === undefined || item.title === '' ? {} : { title: item.title }),
      kind: 'attachment',
      detail,
    })
  }
  for (const problem of [...outcome.plan.problems, ...outcome.problems]) push({ message: problem, kind: 'other' })
  return leftovers
}

/**
 * 应用走的是哪条路（见 `SyncOutcome.planSource`）。
 *
 * - `reused`：预览之后本机与远端一个字节都没变，**照着预览那份计划应用**——不再扫库、不再比对内容、
 *   也不再把项目身份重问一遍；`plan` 就是用户确认过的那一份（见 `syncPrepared()`）。
 * - `recomputed`：有一处对不上（`reason` 说明是哪一处），这次从零重算了一遍计划，`plan` 是新的那份。
 */
export type SyncPlanSource = { kind: 'reused' } | { kind: 'recomputed'; reason: string }

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
   * 扫本机时每条会话读一次的投影记录（可选，见 projection-cache.ts 与 discovery.ts 的 `ScanOptions`）。
   *
   * 给了就说明"空白与两枚活动时间"在扫描那一趟已经读到了，`sessionMeta` 便不必再按会话读同一个文件；
   * 两个都给时 `sessionMeta` 优先（它是显式注入的那一个）。
   */
  projection?: ProjectionCacheReader
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
  /**
   * 目录 → 项目身份的缓存（见 `createRepoLocationCache()`）。
   *
   * 缺省按"跑 git 的入口"共用进程里那一份：同一台机器上项目身份几乎不变，而算一次计划要为每个候选
   * 目录起三个 git 进程（实测 26 个目录 4.3 秒）。测试里注入一份新的，就是"每一轮都重新问"。
   */
  repoLocations?: RepoLocationLookup
  /**
   * 文件内容指纹（见 `createFingerprintCache()`）。
   *
   * 缺省用进程里那一份（键：路径 + size + mtimeMs）：日志只在会话被写时才变，两次预览之间绝大多数
   * 文件一个字节都没动，没必要再读、再解、再哈希一遍。
   */
  fingerprint?: FingerprintOf
  /**
   * 这次是**只推不拉**（自动推送那条路，见 `runAutoPush()`）。
   *
   * 缺席 = false：界面与工具那两条手动路照旧两个方向都做。它只影响算计划那一步（`planSync()` 据此
   * 摘掉拉取与"覆盖本机"），应用那一侧不需要分支——一份没有拉取的计划，应用自然只剩推与收尾。
   */
  pushOnly?: boolean
  /**
   * 这次上报的进度事件是"谁"的（写进 `ProgressEvent.what`）。
   *
   * 缺席 = `'sync'`：界面上两条手动路不传它，行为与这一项出现之前逐字节相同。自动推送传
   * `'auto-push'`——它可能在用户手点一次同步的同时在后台跑另一轮，没有这一项就分不出两条流。
   */
  progressWhat?: string
  /**
   * 宿主的附件库端口（同 `src/web.ts` 的 `ApiDeps.attachments`：**现探**而不是现拿）。
   *
   * 一次同步里要问它很多次（"这个对象在本机哪个路径"），但服务的到达时机由宿主定，建 deps 的时候
   * 未必已经在了——所以收的是取值函数。缺席 = 这个宿主没有附件服务：包照旧只搬日志、远端共享对象库
   * 一个字节都不碰，与升级前逐字节一致（见 `src/shared/attachments.ts` 的文件头）。
   */
  attachments?: () => AttachmentPort | undefined
  /**
   * 内容关系那份额外的缓存（同步里"两边各自写过"那些对的对法）。
   *
   * 缺省用进程里那一份（见 `contentRelationCache`）；测试要用"每一轮互不影响"的标准时注入一份新的。
   */
  relationCache?: Map<string, ContentRelation>
}

/** 读注册表；读不到按"没有注册表"处理（会话照旧可用，只是不进工作区分组）。 */
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
 * 预览算出来的那份数据：**应用要用的东西全在里面**，确认之后照着它走，不再重算（见 `syncPrepared()`）。
 *
 * 为什么把计划与它的输入一起留下：算一次计划的四段（扫本机 / 读远端索引 / 逐个候选目录问 git / 逐条
 * 比对内容）里，后三段全是要等的活——真机量到 13 个候选目录跑一轮 `git rev-parse` 约 0.2 秒，比对要
 * 读完每一条要参与的日志。预览已经做过一遍，应用再走一遍只是把同样的结论重算一次。
 *
 * 这份数据描述的是**预览那一刻**的本机与远端，本身会旧：应用之前由 `stalePlanReason()` 验一遍，
 * 对不上就从零重算（分叉在 `syncPrepared()`）。
 */
export interface SyncPrepared {
  /** 预览算出来的计划。 */
  plan: SyncPlan
  /** 本机整库（`scanAllAsync()` 的结果）。 */
  local: DiscoveredSession[]
  /** 读回来的远端索引（应用不再读第二遍）。 */
  remote: RemoteLibrary
  /** 项目身份：本机目录 → 仓库根。 */
  repos: Map<string, string>
  /**
   * 目录 → 仓库位置：预览问过 git 的那些。
   *
   * 应用推一条会话时要往自己那份索引里写它的项目身份，本来每个目录还要再问一次 git。身份是"这条会话
   * 属于哪个项目"的机器无关说法，几秒钟之内不会变，而且是给别的机器看的提示——写旧一版不会让谁的
   * 会话落错地方。
   */
  located: Map<string, Promise<RepoLocation | undefined>>
  /** 宿主投影缓存里那两件事（空白、最后活动时间），按会话读出来的那一份。 */
  meta: Map<string, SessionMeta | undefined>
  /**
   * 比对阶段算过的内容指纹（日志路径 → 指纹）。
   *
   * 应用推这些会话时要把它写进自己那份索引：照预览那份走时那些字节已经验过没变，直接用它，不再读
   * 第二遍。
   */
  fingerprints: Map<string, FileFingerprint>
  /**
   * 预览判过的"两边各自写过"那几对的内容关系（会话 id → 关系）。
   *
   * 改一次裁决就要重算计划（那一对从"分叉、都不动"变成推或拉）。关系已经读回来了——读远端包、解压、
   * 比对，一对大日志就是一两秒——重算只该换 `decisions` 再跑一遍纯计算（见 `replanPrepared()`），不能
   * 把这一趟重做。
   */
  relations: Map<string, ContentRelation>
  /** 预览那一刻的事实快照（只用来判"变了没有"，不参与任何判定）。 */
  facts: SyncFacts
  /**
   * 这份计划是"只推不拉"算出来的（见 `SyncPlanInput.pushOnly`）。
   *
   * 应用那一步要看它：只推这份计划里没有一条拉取，所以"应用"实际上只剩"推 + 重写自己那格的索引"。
   * 留这一项给报告与测试一个可断言的形状——否则"这次为什么什么都没拉"只能从两张空表里反推。
   */
  pushOnly: boolean
}

/** 预览那一刻本机与远端的事实：`stalePlanReason()` 拿它与眼下的一刻比。 */
interface SyncFacts {
  /**
   * 那份计划是在哪套输入下算出来的：远端地址、机器名、映射表与三个库位置。
   *
   * 为什么它也算"事实"：界面这次确认时，宿主会**重新解析**一遍同步设置（映射表、机器名都从配置现读），
   * 拿旧的映射表应用就是把会话落到用户刚改掉的那个目录以外的地方。凭据不进这份摘要——它只影响读远端，
   * 换了凭据会在远端指纹那一步露出来。
   */
  settings: string
  /** 本机每条会话的代次文件（名字、字节数、mtime）与投影缓存里那两件事。 */
  local: Array<{
    id: string
    dir: string
    files: Array<{ name: string; bytes: number; mtimeMs?: number }>
    meta?: SessionMeta
  }>
  /** 远端那份索引的指纹（见 `remoteDigest()`）。 */
  remote: string
}

/** `SyncFacts.settings`：映射表按键排序，不受配置文档里的书写顺序影响。 */
function settingsDigest(deps: SyncDeps): string {
  const mapping = Object.entries(deps.settings.mapping)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([from, to]) => `${from}\u0000${to}`)
  return [
    deps.settings.url,
    deps.settings.machineId,
    deps.settings.username ?? '',
    String(deps.settings.timeoutMs ?? ''),
    deps.sessionsRoot,
    deps.registryPath,
    deps.backupRoot,
    ...mapping,
  ].join('\n')
}

/**
 * 一条日志文件的"预览那一刻长什么样"。
 *
 * `mtimeMs` 缺席 = 这一份验不了（stat 失败，或者扫描时读到的字节数与这次 stat 对不上）：调用方按
 * "不新鲜"处理——宁可重算一遍，也不要照着一份来历不清的指纹写入磁盘。
 */
function fileFact(file: SessionLogFile): SyncFacts['local'][number]['files'][number] {
  try {
    const stat = statSync(file.path)
    return { name: file.name, bytes: file.bytes, ...(stat.size === file.bytes ? { mtimeMs: stat.mtimeMs } : {}) }
  } catch {
    return { name: file.name, bytes: file.bytes }
  }
}

/**
 * 远端那份索引的指纹：把计划会读到的每个字段按确定的顺序拼出来再哈希。
 *
 * 比的是"预览与应用之间远端有没有被动过"（见 `stalePlanReason()`）。为什么不直接
 * `JSON.stringify()` 那份索引：文件是别的机器写的，键的顺序不在我们手里。
 *
 * 只拼各机器自己的索引：`entries`（联集）是从它们推出来的，索引一样、联集就一样。
 *
 * @param library 读回来的远端。
 * @returns sha256。
 */
export function remoteDigest(library: RemoteLibrary): string {
  const lines: string[] = []
  for (const machine of [...library.machines].sort()) {
    const index = library.indexes.get(machine)
    if (index === undefined) {
      lines.push(`${machine}\u0000`)
      continue
    }
    const entries = [...index.entries].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    for (const entry of entries) {
      lines.push(
        [
          machine,
          entry.id,
          entry.cwd ?? '',
          entry.title ?? '',
          entry.repo ?? '',
          entry.repoPath ?? '',
          String(entry.createdAt),
          String(entry.lastActiveAt ?? ''),
          String(entry.lastPromptAt ?? ''),
          entry.files.map((file) => `${file.version}:${file.bytes}:${file.sha256}`).sort().join(','),
        ].join('\u0000'),
      )
    }
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** 缺省的跑 git 入口：只建一次，这样进程里那份缓存有唯一的键（见 `repoLocationsFor()`）。 */
const defaultGitRunner = createGitRunner()

/** 缺省的内容指纹：走进程里那一份缓存。 */
function defaultFingerprintOf(decodeAll: DecodeAll): FingerprintOf {
  return (path, version, compression) => fingerprintCached(sharedFingerprintCache, decodeAll, path, version, compression)
}

/**
 * 算一份计划，并且把**应用要用的输入一起留下**。
 *
 * 预览走它，应用也走它（后者拿到的那份数据交给 `applyPreparedSync()`）。四段各有各的分母：
 * `scan` / `remote` / `repo` / `compare`。
 *
 * @param deps 远端、设置与本地库的位置。
 * @param options.onProgress 每开始处理一条调一次（见 `SyncProgress`）。回调同步调用、不 await，所以
 *   它自己不许抛（`src/web.ts` 那一侧把它写进 SSE 响应）。
 * @returns 计划与它的来路。
 */
export async function prepareSync(
  deps: SyncDeps,
  options: {
    onProgress?: ProgressReporter
    pushOnly?: boolean
    decisions?: ReadonlyMap<string, SyncDecision>
  } = {},
): Promise<SyncPrepared> {
  const report = options.onProgress
  /*
   * 这一趟是"只推不拉"吗。两处来路都收：`SyncDeps.pushOnly`（整份依赖都在说这件事，`runAutoPush()`
   * 走这条）与 `options.pushOnly`（只管这一次调用）。析取而不是覆盖：一个设了就是设了。
   */
  const pushOnly = options.pushOnly === true || deps.pushOnly === true
  /** 上报一条事件；`what` 只在调用方给了的时候才带上（缺席与今天逐字节相同）。 */
  const emit = report === undefined ? undefined : (event: Omit<ProgressEvent, 'what'>): void => {
    report(deps.progressWhat === undefined ? event : { ...event, what: deps.progressWhat })
  }
  // 第一段：扫本机。冷启动时这一段是大头（每条会话要读头、折标题），所以它值得一条进度。
  const local = await scanAllAsync(deps.sessionsRoot, deps.decodeAll, {
    ...(deps.resolveTitle === undefined ? {} : { resolveTitle: deps.resolveTitle }),
    // 每条会话的投影记录在这里读一次：标题、空白、两枚活动时间共用它（见 projection-cache.ts）。
    ...(deps.projection === undefined ? {} : { projection: deps.projection }),
    ...(emit === undefined ? {} : { onProgress: (done, total) => emit({ phase: 'scan', done, total }) }),
  })
  // 第二段：读远端索引。一次网络往返，没有"第几条"可讲——`total: 0` 就是"这一段没有分母"，
  // 界面只摆那句"正在读取远端索引…"、不摆条（画一条 1/1 的会让人以为已经做完了）。
  emit?.({ phase: 'remote', done: 0, total: 0 })
  const remote = await readRemoteLibrary(deps.dav, deps.settings)
  const normalized = normalizeMapping(deps.settings.mapping)

  /*
   * 项目身份（git remote）：本机的哪些目录是同一个项目。
   *
   * 只在真用得上时问 git——远端有带身份的条目，或者本机这次要推送内容——否则整库同步会被一串
   * `git rev-parse` 拖慢，而它一条都用不到。同一个目录只问一次（`locate` 缓存），因为一次同步里
   * 会话数远多于项目数。
   */
  const git = deps.git ?? defaultGitRunner
  const sharedLocate = deps.repoLocations ?? createRepoLocationCache(git)
  // 这一趟问过哪些目录也记下来：应用照这份清单接着用（见 `SyncPrepared.located`）。
  const located = new Map<string, Promise<RepoLocation | undefined>>()
  const locate = (dir: string): Promise<RepoLocation | undefined> => {
    const cached = located.get(dir)
    if (cached !== undefined) return cached
    const pending = sharedLocate(dir)
    located.set(dir, pending)
    return pending
  }
  const repos = new Map<string, string>()
  if ([...remote.entries.values()].some((entry) => entry.repo !== undefined)) {
    const candidates = repoCandidates(deps, local)
    for (let index = 0; index < candidates.length; index += 1) {
      // 第三段：逐个候选目录问一次 git。目录数不多，但每个目录要起一个 git 进程——真机上这一段
      // 比扫本机与读远端索引加起来还长，没有进度的话进度条会停在这儿半秒。
      emit?.({ phase: 'repo', done: index, total: candidates.length })
      const found = await locate(candidates[index] as string)
      // 同一个身份在本机只认第一个（候选目录已排序）：结果要确定，不随扫描顺序变。
      if (found !== undefined && !repos.has(found.repo)) repos.set(found.repo, found.root)
    }
  }
  // 指纹走"与 cwd 无关"的那份：应用会改写 cwd，按字节比会把拉取来的那份判成"两边各自写过"。
  // 同一份文件在两次预览之间没动时，`fingerprint`（缺省那个带缓存的）直接给上一次的值。
  const fingerprintOf = deps.fingerprint ?? defaultFingerprintOf(deps.decodeAll)
  const contentHash = (path: string, version: number, compression: string | null): FileFingerprint =>
    fingerprintOf(path, version, compression)
  /** 比对阶段算过的指纹：应用写回自己那份索引时直接用它（见 `SyncPrepared.fingerprints`）。 */
  const fingerprints = new Map<string, FileFingerprint>()
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
    // 缓存先行：内容判据那一步会让计划算两遍，指纹不该跟着算两遍（整库哈希是比对段的大头）。
    const cached = fingerprints.get(path)
    if (cached !== undefined) return cached
    emit?.({ phase: 'compare', done: compared, total: compareTotal })
    const fingerprint = contentHash(path, version, compression)
    fingerprints.set(path, fingerprint)
    compared += 1
    return fingerprint
  }
  /*
   * 比对段先把指纹算完：**分块哈希、块间让出**（`contentFingerprintChunked()`）。
   *
   * 原来这一步藏在 `planSync()` 的同步循环里：整库第一次要读 1.2 GB、哈希 3.1 秒，这段时间主线程一次都
   * 不让出，宿主连一个请求都接不了。计划本身是纯计算（指望指纹已经就绪），所以把"算"提前到这里，
   * `planHash()` 只做查表——它仍然保留同步回退（测试注入了自定义 `fingerprint` 时走老路）。
   */
  if (deps.fingerprint === undefined) {
    for (const session of local) {
      if (!remote.entries.has(session.id)) continue
      for (const file of session.files) {
        if (fingerprints.has(file.path)) continue
        emit?.({ phase: 'compare', done: compared, total: compareTotal })
        fingerprints.set(
          file.path,
          await fingerprintChunkedCached(
            sharedFingerprintCache,
            deps.decodeAll,
            file.path,
            file.version,
            file.compression,
          ),
        )
        compared += 1
      }
    }
  }
  /*
   * 投影缓存那两件事（空白、最后活动时间）按会话读一次就够：算计划要它、写回索引时还要它、应用前
   * 验"有没有变"也要它。宿主没给这个口子（工具层在没挂投影缓存的宿主上就是这样）时什么都不读，
   * 两件事都按"不知道"处理。
   */
  const metaCache = new Map<string, SessionMeta | undefined>()
  /**
   * 这条本机会话的空白与两枚活动时间。
   *
   * 扫描已经读过那条投影记录（`session.meta`）就直接折，不再碰文件；调用方显式注入了 `sessionMeta`
   * 时以它为准。按 id 记一次：算计划要它、写回索引时还要它、应用前验"有没有变"也要它。
   */
  const metaOfSession = (session: Pick<DiscoveredSession, 'id' | 'createdAt' | 'cwd' | 'meta'>): SessionMeta | undefined => {
    if (deps.sessionMeta === undefined) return sessionMetaOfRecord(session.meta)
    return deps.sessionMeta({
      id: session.id,
      createdAt: session.createdAt,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    })
  }
  const metaOf = (session: Pick<DiscoveredSession, 'id' | 'createdAt' | 'cwd' | 'meta'>): SessionMeta | undefined => {
    const cached = metaCache.get(session.id)
    if (cached !== undefined || metaCache.has(session.id)) return cached
    const value = metaOfSession(session)
    metaCache.set(session.id, value)
    return value
  }
  /**
   * 筛不动的那些对，逐对取两边日志判谁是谁的前缀（判据与差异页同一份：`session-diff.ts` 的关系）。
   *
   * 代价只花在这些对上：代次与哈希已经把"同哈希""共有代次逐条一致"都定完了，剩下的才要读内容（实测
   * 量级几十对、单条日志几十 KB）。取不到的一对（网络、包坏、日志读不出来）就退回"筛不动"，那一对照旧
   * 归 `diverged` 两条都不动——下限是不丢内容。
   */
  const contentRelationsOf = async (ids: readonly string[]): Promise<Map<string, ContentRelation>> => {
    const relations = new Map<string, ContentRelation>()
    const byId = new Map(local.map((session) => [session.id, session]))
    /** 这一份缓存由调用方给（测试要把每一轮隔开），缺省是进程里那一份（见 `contentRelationCache`）。 */
    const cache = deps.relationCache ?? contentRelationCache
    for (const [index, id] of ids.entries()) {
      emit?.({ phase: 'relate', done: index, total: ids.length, id })
      try {
        const session = byId.get(id)
        const entry = remote.entries.get(id)
        if (session === undefined || entry === undefined) continue
        /*
         * 两边都没变就直接用上一次算出来的关系。
         *
         * 为什么要缓存：这条路每写完一轮就被自动推送走一遍（见 `runAutoPush()`），而"两边各自写过、
         * 谁也没再动"的那几对**每一轮都一样**——不缓存的话，同一份几十 MB 的日志每轮从 NAS 重下一次、
         * 重解一遍、重比一遍（本机实测三个大对一轮 2.7 秒主线程时间）。键取两边**全部代次的
         * sha256**，任何一边动了一个字节都会换一个键，所以它只是省掉重复劳动，不改变判据。
         */
        const key = relationKey(
          session.files.map((file) => fingerprints.get(file.path)),
          entry.files,
        )
        const remembered = key === undefined ? undefined : cache.get(key)
        if (key !== undefined && remembered !== undefined) {
          relations.set(id, remembered)
          continue
        }
        // gunzip 走线程池、解压分块让出（见 `log-decode.ts`）：这一对再大也别把主线程按死。
        const bundle = await readBundleAsync(await deps.dav.get(remoteBundlePath(entry.machine, id)))
        const bundled = bundle.sessions.find((item) => item.id === id)
        const remoteFile = bundled === undefined ? undefined : [...bundled.files].sort((l, r) => r.version - l.version)[0]
        const localFile = [...session.files].sort((l, r) => r.version - l.version)[0]
        if (remoteFile === undefined || localFile === undefined) continue
        // 与差异页同一标准：读宿主也读的那一份（最高代次）。
        const mine = await readFile(localFile.path)
        const theirs = entryBytes(bundle, remoteFile)
        const diff = diffSessionLogs(
          await splitLinesAsync(await decodeLogTextChunked(mine, localFile.compression)),
          await splitLinesAsync(await decodeLogTextChunked(theirs, remoteFile.compression)),
          { localBytes: mine.byteLength, remoteBytes: theirs.byteLength },
        )
        const relation = {
          relation: diff.relation,
          localTail: diff.localTail.count,
          remoteTail: diff.remoteTail.count,
        }
        relations.set(id, relation)
        if (key !== undefined) remember(cache, key, relation)
      } catch {
        // 取不到就不给这一对内容关系：计划那边退回 `diverged`，两条都不动。
      }
      /*
       * 一对之间让出事件循环。
       *
       * 一条再贵也不该让别的事等一整秒：宿主是同一个进程，同步在后台跑的时候界面的 `/state`、别的
       * 请求都排在这条链子后面（线上那次"网页转圈、SSH 秒回"就是这么来的）。
       */
      await new Promise((resolve) => setImmediate(resolve))
    }
    return relations
  }

  // 活会话这件事只读一次：覆盖本机那一步会逐条问它，而宿主那份列表在一次同步里不会变。
  const live = deps.liveSessionIds?.()
  const planInput = {
    local,
    remote,
    mapping: normalized.mapping,
    repos,
    hashFile: planHash,
    pushOnly,
    ...(options.decisions === undefined ? {} : { decisions: options.decisions }),
    ...(deps.sessionMeta === undefined ? {} : { sessionMeta: metaOf }),
    ...(live === undefined ? {} : { isLive: (id: string): boolean => live.has(id) }),
  }
  /*
   * 计划算两遍：第一遍只为拿到 `needsContent`（代次与哈希筛不动的那些对），第二遍带着内容关系算真
   * 计划。两遍都是纯计算，指纹有缓存（见 `planHash()`），第二遍不重读内容。
   */
  const firstPass = planSync(planInput)
  compared = 0
  const contentRelations = await contentRelationsOf(firstPass.needsContent)
  const plan = planSync({ ...planInput, contentRelations })
  compared = 0
  plan.problems.unshift(...normalized.problems)
  plan.problems.push(...remote.problems)
  // 机器格名撞上共享对象库那个保留名时明说一句（见 `reservedMachineIdProblem()` 里的来由）。
  const reserved = reservedMachineIdProblem(deps.settings.machineId)
  if (reserved !== undefined) plan.problems.push(reserved)
  plan.ok = plan.problems.length === 0

  /*
   * 事实快照：只记"预览那一刻是什么样"。代次文件、投影缓存那两件事、远端索引的指纹都取自这一刻的读取
   * 结果——应用前比这三样，比得上就说明"照着这份计划走"与"现在重算一遍"是同一件事。
   */
  const facts: SyncFacts = {
    settings: settingsDigest(deps),
    local: local.map((session) => {
      const meta = metaOf(session)
      return {
        id: session.id,
        dir: session.dir,
        files: session.files.map(fileFact),
        ...(meta === undefined ? {} : { meta }),
      }
    }),
    remote: remoteDigest(remote),
  }
  return { plan, local, remote, repos, located, meta: metaCache, fingerprints, relations: contentRelations, facts, pushOnly }
}

/**
 * 只重算计划本身：换一组裁决，不重读任何东西。
 *
 * 为什么要有它：同步弹窗里每改一次「以本机为准 / 以远端为准」，计划表就要跟着变（那一对从"分叉、两边都
 * 不动"变成推或拉）。原来这条路是重新走一遍 `prepareSync()`——重扫本机、重读远端索引、重问 git、重算
 * 比对的指纹，几秒起步；而它需要的输入（本机清单、远端索引、项目身份、内容指纹、那几对的内容关系）在
 * 预览那一刻已经全部算出来了，改的只是 `decisions` 这一个参数。计划本身是纯计算（`planSync`），几十
 * 毫秒就够。
 *
 * @param prepared 上一次预览留下的那份（`prepareSync()` 的返回值）。
 * @param deps 只用到设置（映射表与机器名）、活会话与投影记录这几个读法；不会碰磁盘或网络。
 * @param decisions 新的裁决表；缺省 = 不替任何一对挑正本。
 * @returns 换过计划的那一份；其余输入原样带过去（应用的指纹、事实快照都还用得上）。
 */
export function replanPrepared(
  prepared: SyncPrepared,
  deps: Pick<SyncDeps, 'settings' | 'liveSessionIds' | 'sessionMeta' | 'decodeAll'>,
  decisions?: ReadonlyMap<string, SyncDecision>,
): SyncPrepared {
  const normalized = normalizeMapping(deps.settings.mapping)
  /*
   * 指纹只查预览算过的那一份：日志没变的话那个值就是眼下这一份（应用前还会再验一遍事实）。查不到
   * （预览之后新出现的文件）才现算——那是少数，且只在真的要比对时才走到。
   */
  const hashFile = (path: string, version: number, compression: string | null): FileFingerprint =>
    prepared.fingerprints.get(path) ?? contentFingerprint(path, version, compression, deps.decodeAll)
  const metaOf = (session: Pick<DiscoveredSession, 'id'>): SessionMeta | undefined => prepared.meta.get(session.id)
  const live = deps.liveSessionIds?.()
  const plan = planSync({
    local: prepared.local,
    remote: prepared.remote,
    mapping: normalized.mapping,
    repos: prepared.repos,
    hashFile,
    pushOnly: prepared.pushOnly,
    contentRelations: prepared.relations,
    ...(decisions === undefined ? {} : { decisions }),
    ...(deps.sessionMeta === undefined ? {} : { sessionMeta: metaOf }),
    ...(live === undefined ? {} : { isLive: (id: string): boolean => live.has(id) }),
  })
  plan.problems.unshift(...normalized.problems)
  plan.problems.push(...prepared.remote.problems)
  const reserved = reservedMachineIdProblem(deps.settings.machineId)
  if (reserved !== undefined) plan.problems.push(reserved)
  plan.ok = plan.problems.length === 0
  return { ...prepared, plan }
}

/**
 * 只预览的那份结果（界面与工具层两条路共用同一个形状）。
 *
 * @param prepared 预览算出来的那份数据。
 * @returns `applied: false` 的结果：计划在里面，写入磁盘那几项全空。
 */
export function plannedOutcome(prepared: SyncPrepared): SyncOutcome {
  return {
    plan: prepared.plan,
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

// ── 附件对象：远端共享库那一侧（见 `SYNC_ATTACHMENTS_DIR`）────────────────────

/**
 * 删除时清远端：把自己那一格里的包删掉，并在自己那份索引里留一条删除记录（墓碑）。
 *
 * 为什么墓碑必须留下：包没了、索引条目也没了，别的机器下一次同步就会把"远端没有、本机有"那份重新
 * 推上去——包括刚被删的这条会话在**第三台**机器上的副本。墓碑说的是"我在这一刻删了它"，同步据此
 * 不再把它拉回来，也不再让别的机器把它推回来（见 `tombstonesOf()`）。
 *
 * 只动自己那一格：别的机器那格的包与索引归它自己（同步的既有边界，见 `planTidy()` 的注释）。它下次
 * 同步看到墓碑时会把自己那份（比墓碑旧的）删掉；在那之前那份留着，但没人会再拉它。
 *
 * @param deps 远端与设置。
 * @param ids 这次删掉的会话 id。
 * @returns 真删掉几处、多少字节，别的机器上还留着副本的是哪几台，以及没做成的那几步。
 */
export async function removeRemoteCopies(deps: RemoteCopiesPort, ids: readonly string[]): Promise<RemoteRemoval> {
  const problems: string[] = []
  const others = new Set<string>()
  const result: RemoteRemoval = { removed: 0, bytes: 0, others: [], problems }
  if (ids.length === 0) return result
  const remote = await readRemoteLibrary(deps.dav, deps.settings)
  problems.push(...remote.problems)
  const mine = machineDirName(deps.settings.machineId)
  const own = remote.indexes.get(mine)
  const byId = new Map((own?.entries ?? []).map((entry) => [entry.id, entry]))
  /** 包真删掉了的那些（索引条目跟着消失；删失败的留着条目，下一次推送还会重写它）。 */
  const gone = new Set<string>()
  for (const id of ids) {
    const entry = byId.get(id)
    if (entry !== undefined) {
      try {
        await deps.dav.delete(remoteBundlePath(deps.settings.machineId, id))
        result.removed += 1
        result.bytes += entry.files.reduce((sum, file) => sum + file.bytes, 0)
        gone.add(id)
      } catch (error) {
        problems.push(`删远端 ${id} 的包失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    for (const [machine, index] of remote.indexes) {
      if (machine === mine) continue
      if (index.entries.some((item) => item.id === id)) others.add(machine)
    }
  }
  /*
   * 墓碑跟着这次删除写进自己那份索引。写失败要大声说：删除记录没留下，下一次同步就会把它当
   * "远端有、本机没有"重新拉回来——那正是这条路要防的事。
   */
  const deleted = new Map<string, number>()
  for (const item of own?.deleted ?? []) deleted.set(item.id, item.at)
  const at = (deps.now?.() ?? new Date()).getTime()
  for (const id of ids) deleted.set(id, at)
  try {
    await deps.dav.put(
      remoteIndexPath(deps.settings.machineId),
      indexPayload(
        deps,
        (own?.entries ?? []).filter((entry) => !gone.has(entry.id)),
        [...deleted].map(([id, when]) => ({ id, at: when })),
      ),
    )
  } catch (error) {
    problems.push(
      `写远端索引失败，这次删除记录没留下（下次同步可能把这些会话又拉回来）：${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  result.others = [...others].sort()
  return result
}

/**
 * 照着预览那份数据应用：拉取、覆盖、统一处理、推送、重写自己那份索引。
 *
 * 拉取那一侧复用 `planImport/applyImport`（与设置页的「导入」是同一条路），所以包的自校验、
 * `.part` 应用、注册表重挂、`_no-cwd` 的标准都不用在这里重写一遍：同步只是"从哪儿拿包"与
 * "往哪儿放包"这两件事不同。
 *
 * 这一段几乎不问宿主任何东西：会话库、投影缓存、内存里活着的会话都在预览那一刻的输入里，项目身份也
 * 接着用预览问过的那些目录（预览一个身份条目都没见过时它一个目录都没问，那几条要推的目录这时候才问
 * 一次 git）。所以调用方要么刚算完（`runSync()`），要么先验过那份数据还作数（`syncPrepared()`）。
 *
 * @param deps 远端、设置与本地库的位置。
 * @param prepared 预览那份数据。
 * @param options.onProgress 每开始处理一条调一次（`pull` / `push` 两段）。
 * @returns 结果；单条失败只记进 `problems`，不半路放弃整次同步。
 */
export async function applyPreparedSync(
  deps: SyncDeps,
  prepared: SyncPrepared,
  /**
   * `tidy`：收尾时整理自己那一格；`tidyOrphans`：连"索引里没有的孤儿包"一起删（缺省 true，与手动那
   * 一枚按钮一致）。自动同步那一档传 false——索引万一坏过，孤儿包可能是唯一副本（见 `runAutoPush()`）。
   */
  options: { onProgress?: ProgressReporter; tidy?: boolean; tidyOrphans?: boolean } = {},
): Promise<SyncOutcome> {
  const problems: string[] = []
  const { plan, local, remote } = prepared
  /*
   * 整理远端：只算"自己那一格里多余的那些"，删的动作放在索引写完之后（见下面的注释）。预览那次不算它，
   * 那次不改远端；界面在预览里看到的数字由 `/sync` 那一侧按同一份远端索引算一遍。
   */
  const tidyPlan = options.tidy === true ? planTidy(remote, deps.settings.machineId) : undefined
  const tidyIds = new Set((tidyPlan?.entries ?? []).map((entry) => entry.id))
  const byId = new Map(local.map((session) => [session.id, session]))
  /** 这台机器的格子名（删除、写索引与整理都要用，先算好）。 */
  const ownDirName = machineDirName(deps.settings.machineId)
  /*
   * ── 跟着删：别处删过、本机这份更旧的那些（见 `SyncDeletedEntry`）────────────────────
   *
   * 顺序照删除那条路：**先备份，备份不成功就一条都不删**（备份是唯一一份能恢复的副本），再删目录，
   * 最后把这台机器那一格里的包删掉。注册表不动：宿主把"登记了但日志不在"当正常状态（与 remove.ts
   * 同一条标准）。
   */
  const deletedIds = new Set(plan.deletedIds)
  const deletedNow: string[] = []
  let deletedBytes = 0
  if (deletedIds.size > 0) {
    const doomed = plan.deleted
      .map((item) => byId.get(item.id))
      .filter((session): session is DiscoveredSession => session !== undefined)
    let backedUp = true
    try {
      await createBackup({
        backupRoot: deps.backupRoot,
        sessionsRoot: deps.sessionsRoot,
        registryPath: deps.registryPath,
        sessions: doomed.map((session) => ({
          id: session.id,
          sourceDir: session.dir,
          files: session.files,
          ...(session.title === undefined ? {} : { title: session.title }),
        })),
        kind: 'delete',
        ...(deps.now === undefined ? {} : { now: deps.now() }),
      })
    } catch (error) {
      backedUp = false
      deletedIds.clear()
      problems.push(
        `跟着删的备份没成功，这几条这次一条都没删：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (backedUp) {
      for (const session of doomed) {
        try {
          await rm(session.dir, { recursive: true, force: true })
          deletedNow.push(session.id)
          deletedBytes += session.files.reduce((sum, file) => sum + file.bytes, 0)
        } catch (error) {
          problems.push(`跟着删 ${session.id} 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      /*
       * 这台机器那一格里的包也删掉（各机器只管自己那一格：别人的格子在它下次同步时自己清）。
       * 索引条目在写索引那一步一起消失（`ownEntries` 建的时候就把这些 id 摘掉了）。
       */
      const ownHad = new Set((remote.indexes.get(ownDirName)?.entries ?? []).map((entry) => entry.id))
      for (const id of deletedNow) {
        if (!ownHad.has(id)) continue
        try {
          await deps.dav.delete(remoteBundlePath(deps.settings.machineId, id))
        } catch (error) {
          problems.push(`删远端 ${id} 的包失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  /**
   * 上报一条写入磁盘阶段的事件。
   *
   * 与 `prepareSync()` 里那份同名同形：`what` 只在调用方给了的时候才带上（缺席 = 与今天逐字节相同，
   * 界面那两条手动路不传它）。
   */
  const emit = (event: Omit<ProgressEvent, 'what'>): void => {
    options.onProgress?.(deps.progressWhat === undefined ? event : { ...event, what: deps.progressWhat })
  }
  /**
   * 附件对象那一段的报告器（见 `AttachmentReporter`）。
   *
   * `label` 带上这一条会话的名字：对象是在**某一条会话**的步骤里传的，界面把 label 画成一行小标题，
   * 用户才知道这几兆字节是在给谁搬。补对象那一趟不属于任何一条会话，就不给 label。
   */
  const reportAttachments = (label?: string): AttachmentReporter => (done, total, ref) =>
    emit({ phase: 'attach', done, total, id: ref.id, ...(label === undefined ? {} : { label }) })
  /**
   * 预览比对时算过的指纹直接接着用（同一个字节数、同一个 mtime，应用之前验过）。
   *
   * 本机独有的那些预览时没算过（它们不进比对，算它才是白花），这里现算——只有真推送的那几条。
   */
  const fingerprintOf = deps.fingerprint ?? defaultFingerprintOf(deps.decodeAll)
  const contentHash = (path: string, version: number, compression: string | null): FileFingerprint =>
    prepared.fingerprints.get(path) ?? fingerprintOf(path, version, compression)
  /** 投影缓存那两件事用预览读出来的那一份（应用不再问宿主）。 */
  const metaOf = (session: Pick<DiscoveredSession, 'id'>): SessionMeta | undefined => prepared.meta.get(session.id)
  /** 项目身份接着用预览问过 git 的那些；预览没问过的目录（远端一个身份条目都没有时它不问）现在问。 */
  const git = deps.git ?? defaultGitRunner
  const sharedLocate = deps.repoLocations ?? createRepoLocationCache(git)
  const located = new Map(prepared.located)
  const locate = (dir: string): Promise<RepoLocation | undefined> => {
    const cached = located.get(dir)
    if (cached !== undefined) return cached
    const pending = sharedLocate(dir)
    located.set(dir, pending)
    return pending
  }
  const pulled: string[] = []
  const replaced: string[] = []
  const pushed: Array<{ id: string; action: 'upload' | 'update' }> = []
  /**
   * 「两份都保留」但落选那一份没能落成新会话的会话 id。
   *
   * 这些条目**这一步都不动**：另一份还没落到本机，这会儿推上去 / 覆盖掉就把那一份盖掉了——而这条裁决
   * 的全部意义就是"两份都留"。失败照旧逐条进 `problems`。
   */
  const failedBranches = new Set<string>()
  let bytesIn = 0
  let bytesOut = 0
  let registryWritten = false
  /** 拉取改的那几笔注册表（按执行顺序），整批应用之后一起交给宿主。 */
  const registryChanges: RegistryChange[] = []
  /*
   * 附件对象那一段：远端共享库里搬的那些（见 `SYNC_ATTACHMENTS_DIR`）。端口**这一次现探**，整批共用
   * 一个取值——中途到达/消失的服务在两台机器之间翻转的话，中途换端口只会让同一批里前后两条会话按不同
   * 的标准应用。宿主没有这个服务（`port === undefined`）时下面几步全部跳过，包与索引与升级前逐字节
   * 一致。
   */
  const port = deps.attachments?.()
  const attachmentIn: SyncAttachmentIn = { written: 0, present: 0, bytes: 0 }
  const attachmentOut: SyncAttachmentOut = { uploaded: 0, skipped: 0, bytes: 0, missing: 0 }
  /** 一次同步里每个前缀目录只列一次（`list()` 已经把那一层全部对象名给回来了）。 */
  const remoteObjectNames = new Map<string, Set<string>>()
  /**
   * 本机要、远端也没有的那些对象（按对象去重），每个记着引用它的会话。**整轮收尾时汇总成一句**：拉取
   * 那条路与补对象那条路撞上的是同一种状态（持有这些对象的机器还没推送它们），逐条对象报会把问题清单
   * 淹掉——所以数报在那一句里，具体是哪几条会话由 `SyncOutcome.absentAttachments` 逐条点名。
   */
  const absentObjects: AbsentObjects = new Map()

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
  /*
   * 裁决里落选那一份先安个新家：落成一条**新会话**（新 id，标题带「原标题 · 来自 <机器> <时刻>」的
   * 来源标记），再让正本占住原来的 id。顺序反过来就会先把落选那份覆盖掉——那正是"两份都保留"要防的
   * 事。走的是导入那条路（`planImport`/`applyImport`），所以包自校验、改写 header、附件对象与注册表
   * 都与导入同一条不变式。
   *
   * **只有「两份都保留」那一档才走这里**（`entry.keepLoser`）：选单边时另一份不留——本机这份由下面的
   * 覆盖那一步先备份再顶掉，远端那份压根不取回（它还留在原来那台机器上）。
   */
  for (const entry of plan.pull) {
    if (entry.code !== 'keep-remote' || entry.keepLoser !== true) continue
    const session = byId.get(entry.id)
    if (session === undefined) continue
    try {
      // 附件对象不必随包搬：落选那份的日志引用还是那几个 sha，本机对象库里已经有它们。
      const bundle = await readBundleAsync(
        await buildBundleAsync(
          [{ id: session.id, cwd: session.cwd, createdAt: session.createdAt, dir: session.dir, files: session.files }],
          { now: new Date().toISOString() },
        ),
      )
      const importOptions: ImportOptions & { decodeAll: DecodeAll } = {
        root: deps.sessionsRoot,
        targetCwd: session.cwd ?? '',
        ...(registry === undefined ? {} : { registry }),
        registryPath: deps.registryPath,
        decodeAll: deps.decodeAll,
        ...(port === undefined ? {} : { attachments: port }),
        rename: new Map([
          [session.id, { newId: `session-${randomUUID()}`, machine: deps.settings.machineId }],
        ]),
      }
      const importPlan = planImport(bundle, importOptions)
      if (importPlan.nextRegistry !== null) registry = importPlan.nextRegistry
      if (importPlan.registryChange !== null) registryChanges.push(importPlan.registryChange)
      const outcome = await applyImport(bundle, importPlan, importOptions)
      if (outcome.registryWritten) registryWritten = true
      countPackedAttachments(outcome, attachmentIn)
      pulled.push(...outcome.written)
    } catch (error) {
      failedBranches.add(entry.id)
      problems.push(
        `把落选的本机那份落成新会话失败，这一条这次没动（动了会把本机那份盖掉）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  for (const entry of plan.push) {
    if (entry.code !== 'keep-local' || entry.keepLoser !== true) continue
    const session = byId.get(entry.id)
    const machine = entry.machine
    if (session === undefined || machine === undefined) continue
    try {
      const bytes = await deps.dav.get(remoteBundlePath(machine, entry.id))
      const bundle = await readBundleAsync(bytes)
      const importOptions: ImportOptions & { decodeAll: DecodeAll } = {
        root: deps.sessionsRoot,
        targetCwd: session.cwd ?? '',
        ...(registry === undefined ? {} : { registry }),
        registryPath: deps.registryPath,
        decodeAll: deps.decodeAll,
        ...(port === undefined ? {} : { attachments: port }),
        rename: new Map([
          [entry.id, { newId: `session-${randomUUID()}`, machine }],
        ]),
      }
      const importPlan = planImport(bundle, importOptions)
      if (importPlan.nextRegistry !== null) registry = importPlan.nextRegistry
      if (importPlan.registryChange !== null) registryChanges.push(importPlan.registryChange)
      const outcome = await applyImport(bundle, importPlan, importOptions)
      if (outcome.registryWritten) registryWritten = true
      countPackedAttachments(outcome, attachmentIn)
      pulled.push(...outcome.written)
    } catch (error) {
      failedBranches.add(entry.id)
      problems.push(
        `把落选的 ${machine} 那份落成新会话失败，这一条这次没推（推了会把远端那份盖掉）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const pullTotal = pullJobs.length + replaceJobs.length
  for (let index = 0; index < pullJobs.length; index += 1) {
    const entry = pullJobs[index] as SyncPullEntry
    emit({
      phase: 'pull',
      total: pullTotal,
      done: index,
      id: entry.id,
      label: entry.title ?? entry.id,
    })
    try {
      const bytes = await deps.dav.get(remoteBundlePath(entry.machine, entry.id))
      const bundle = await readBundleAsync(bytes)
      // 没有 cwd 的会话不看 targetCwd（`planImport` 只对带 cwd 的会话用它），这里给空串是照契约填参。
      const importOptions: ImportOptions & { decodeAll: DecodeAll } = {
        root: deps.sessionsRoot,
        targetCwd: entry.toCwd ?? '',
        ...(registry === undefined ? {} : { registry }),
        registryPath: deps.registryPath,
        decodeAll: deps.decodeAll,
        // 远端那份包万一是自带的（旧版同步推的、或别人手工放上去的），导入那条路照旧把它当成随包带
        // 来的对象应用；这一版推送的包只有日志，下面那一步负责从共享库补。
        ...(port === undefined ? {} : { attachments: port }),
      }
      /*
       * 先落对象、再写日志：会话不会以"图是挂的"状态先出现在库里（与导入那条编排同一条不变式）。
       * 引用从**包里的日志字节**读，不读本机那份——本机那份这会儿还不存在（或正要被换掉）。
       */
      if (port !== undefined) {
        const bundleRefs = await attachmentRefsOfBundle(bundle)
        await pullAttachments(
          deps,
          port,
          bundleRefs.refs,
          attachmentIn,
          problems,
          absentObjects,
          new Map([[entry.id, entry.title]]),
          reportAttachments(entry.title ?? entry.id),
          bundleRefs.imported,
        )
      }
      const importPlan = planImport(bundle, importOptions)
      if (importPlan.nextRegistry !== null) registry = importPlan.nextRegistry
      if (importPlan.registryChange !== null) registryChanges.push(importPlan.registryChange)
      const outcome = await applyImport(bundle, importPlan, importOptions)
      if (outcome.registryWritten) registryWritten = true
      countPackedAttachments(outcome, attachmentIn)
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
   * 旧目录、按导入应用"。
   *
   * 为什么要先撤掉整个目录、而不是逐文件覆盖：同一目录里留着旧代次就是坏数据（宿主把目录里的代次
   * 一起读进来），而新旧两份的代次名可能重合、也可能不重合，逐文件覆盖两种都处理不对。
   */
  if (replaceJobs.length > 0) {
    const fetched = new Map<string, SessionBundle>()
    for (const entry of replaceJobs) {
      try {
        fetched.set(entry.id, await readBundleAsync(await deps.dav.get(remoteBundlePath(entry.machine, entry.id))))
      } catch (error) {
        problems.push(
          `覆盖 ${entry.id} 失败（远端那包取不到或坏了，本机那份没动）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    // 落选那份没落成新会话的那些不覆盖：本机这份还没被保住（见 `failedBranches`）。
    const ready = replaceJobs.filter((entry) => fetched.has(entry.id) && !failedBranches.has(entry.id))
    let backedUp = false
    if (ready.length > 0) {
      try {
        await createBackup({
          backupRoot: deps.backupRoot,
          sessionsRoot: deps.sessionsRoot,
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
      emit({
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
          ...(port === undefined ? {} : { attachments: port }),
        }
        // 与"新建"那一条同一顺序：对象先落，再写日志。对象是共享的、本机可能早就有，所以这一步多数
        // 情况下一个字节都不取。
        if (port !== undefined) {
          const bundleRefs = await attachmentRefsOfBundle(bundle)
          await pullAttachments(
            deps,
            port,
            bundleRefs.refs,
            attachmentIn,
            problems,
            absentObjects,
            new Map([[entry.id, entry.title ?? session.title]]),
            reportAttachments(entry.title ?? session.title ?? entry.id),
            bundleRefs.imported,
          )
        }
        const importPlan = planImport(bundle, importOptions)
        if (importPlan.nextRegistry !== null) registry = importPlan.nextRegistry
        if (importPlan.registryChange !== null) registryChanges.push(importPlan.registryChange)
        const outcome = await applyImport(bundle, importPlan, importOptions)
        if (outcome.registryWritten) registryWritten = true
        countPackedAttachments(outcome, attachmentIn)
        pulled.push(...outcome.written)
        if (outcome.written.includes(entry.id)) replaced.push(entry.id)
        bytesIn += outcome.bytes
      } catch (error) {
        problems.push(`覆盖 ${entry.id} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // ── 让宿主认下这批改动：拉取会把会话挂到目标工作区（改注册表），与迁移是同一条语义。
  //    整批应用之后按顺序统一处理一次，而不是每条会话各来一遍。注册表终态一并交过去：宿主没接住时
  //    它会用内存副本盖掉这次写入磁盘，那时得靠这份终态写回来（见 take-effect.ts 的 `restoreRegistry()`）。
  const effect = registryWritten
    ? await takeEffectOnHostAll(registryChanges, deps, { registry })
    : undefined
  /*
   * ── 接着请宿主把这批会话的列表元数据折出来（同一个统一处理点）─────────────────────
   *
   * 侧边栏那一行的名字不来自日志：宿主对"从没在本机活过"的会话只读它自己持久化的投影检查点，读不到就
   * 显示"未命名"；而检查点只在活的会话（创建 / `turn/end` / 释放）时被写。拉取来的会话恰好两样都不占，
   * 于是标题、空白判据、最后活动时间一起缺——最后这一样还会让下一次同步的"谁更新"判不出来。详见
   * checkpoint-warm.ts：这一步只是把宿主自己的冷读走一遍，失败逐条兜住，不影响上面的应用结论。
   */
  const warm = await warmCheckpoints(pulled, deps)

  // ── 推送：整包 PUT，然后重写自己那一格的索引 ────────────────────────────────
  const own = remote.indexes.get(ownDirName)
  const ownEntries = new Map<string, RemoteIndex['entries'][number]>()
  for (const entry of own?.entries ?? []) {
    // 索引只描述"我这台机器现在还拿得出的会话"：本机删掉的下一次推送就从索引里消失
    // （远端那份包不主动删；别的机器自己那份记录照旧）。
    if (byId.has(entry.id) && !deletedIds.has(entry.id)) ownEntries.set(entry.id, entry)
  }
  /*
   * 自己那份索引里的删除记录（墓碑）：这条会话又在本机出现了（拉回来、或本机那份更新所以留着），
   * 那次删除就作废，把记录摘掉——不摘的话下一次同步又会拿它去删别人的那份。
   * 别的机器记的墓碑不归这里管，只能由那台机器自己摘。
   */
  const ownDeleted = new Map<string, number>()
  for (const item of own?.deleted ?? []) ownDeleted.set(item.id, item.at)
  for (const id of [...ownDeleted.keys()]) {
    const alive = (byId.has(id) && !deletedIds.has(id)) || pulled.includes(id)
    if (alive) ownDeleted.delete(id)
  }
  /*
   * 两类要主动从自己这格撤下来：
   *   - **空白会话**：没有内容可贡献，留着它只会让别的机器把它拉走；
   *   - **刚换成远端那份的**：本机这份现在是别人那份内容，自己这格的旧记录（以及那个包）描述的是
   *     已经不在的那份，留着会让"同一个 id 有多台贡献"那条判据去比两份不同的指纹。
   * 例外是从**自己这格**换回来的那条：那格的记录描述的正是刚应用这份内容（判据与 cwd 无关），留着是
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
  const pushJobs = plan.push.filter(
    (entry) => (entry.action === 'upload' || entry.action === 'update') && !failedBranches.has(entry.id),
  )
  for (let index = 0; index < pushJobs.length; index += 1) {
    const entry = pushJobs[index] as SyncPushEntry
    const session = byId.get(entry.id)
    if (session === undefined) continue
    emit({
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
      /*
       * 包**只有日志**（照旧 v1）：对象走远端共享库，已经在远端的一个字节都不再传。同步是"一条会话一个
       * 包"、自动推送每写完一轮就重推一次，塞进包里就是让那些一辈子不变的字节反复上传。
       *
       * 顺序照着"先对象、后包"：包一到位，别的机器立刻就能拉到这条会话并按它去找对象（对象先齐，
       * 那一侧才不会出现"会话在、图是挂的"）。中途失败只记问题，包照旧推——一个对象传不上去不该把
       * 整条会话挡在同步之外（与导入那条路同一个标准）。
       */
      /*
       * 这条会话引用过哪些对象：推送要传的那一份，同时记进自己那一格的索引——别的机器补对象时读索引
       * 就够了，不必再把自己的整库日志解压一遍（那一步实测 144 秒，见 `repairAttachments()`）。
       */
      let refs: AttachmentRef[] = []
      // 导入会话的标记跟着清单一起写进索引：别的机器（与本机第二趟）补对象时就不必再解一遍日志。
      let importedSession = false
      if (port !== undefined) {
        const scanned = await attachmentRefsOfFiles(session.files)
        refs = scanned.refs
        importedSession = scanned.imported
        await pushAttachments(
          deps,
          port,
          refs,
          remoteObjectNames,
          attachmentOut,
          problems,
          reportAttachments(session.title ?? entry.title ?? entry.id),
        )
      }
      const bundle = await buildBundleAsync([source], {
        now: (deps.now?.() ?? new Date()).toISOString(),
        source: {
          sessionsRoot: deps.sessionsRoot,
          ...(deps.pluginVersion === undefined ? {} : { pluginVersion: deps.pluginVersion }),
        },
      })
      await deps.dav.put(remoteBundlePath(deps.settings.machineId, entry.id), bundle)
      // 身份是"这条会话属于哪个项目"的机器无关说法：别的机器凭它 + 仓库内相对路径应用，不必配映射。
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
        ...(port === undefined ? {} : { attachments: refs.map((ref) => indexedAttachmentOf(ref)) }),
        ...(importedSession ? { imported: true } : {}),
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
    // 整理掉了的那几条不再写回索引：先写索引、再删包，中途失败最多留下几个没人引用的包。
    await deps.dav.put(
      remoteIndexPath(deps.settings.machineId),
      indexPayload(
        deps,
        [...ownEntries.values()].filter((entry) => !tidyIds.has(entry.id)),
        [...ownDeleted].map(([id, at]) => ({ id, at })),
      ),
    )
    indexWritten = true
  } catch (error) {
    problems.push(`写远端索引失败：${error instanceof Error ? error.message : String(error)}`)
  }

  /*
   * ── 整理自己那一格（勾了才做）──────────────────────────────────────────────
   *
   * 只碰自己那一格：别的机器那格的索引是它下次推送时整份重写的，删它的条目会复活；只删包不删条目更
   * 糟，别人拉取时撞 404。规则与判据见 `planTidy()`。
   *
   * 写索引失败时一步都不删：那时索引里还留着这些条目，删了包就是"条目指向空气"。
   */
  let tidy: SyncTidyResult | undefined
  if (tidyPlan !== undefined && indexWritten) {
    // 孤儿包先列出来：两段合成一个分母，界面那一条进度条才走得完（一次整理只画一条）。
    let orphans: Array<{ name: string; bytes: number }> = []
    /*
     * 自动同步那一档只清**确定多余**的（重复 / 被取代），孤儿包一个不动：索引万一坏过，那些"没有索引
     * 条目的包"可能是某条会话在远端的唯一副本。手动那枚「整理远端」照旧连孤儿一起清（人看着）。
     */
    if (options.tidyOrphans !== false) {
      try {
        /*
         * 已知的包 = 索引里留下的 + 这一次正要删的。少了后一半，刚删掉的那些会在列目录时又被当成"没有
         * 索引条目的孤儿"再删一遍（404 不算错，但账上会多出一笔孤儿）。
         */
        orphans = await orphanBundles(deps.dav, deps.settings.machineId, new Set([...ownEntries.keys(), ...tidyIds]))
      } catch (error) {
        problems.push(`整理远端：列自己那一格失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const total = tidyPlan.entries.length + orphans.length
    let done = 0
    let removed = 0
    let orphansRemoved = 0
    let bytes = tidyPlan.bytes
    for (const entry of tidyPlan.entries) {
      // 每开始删一个就报一次（`done` 是已完成的条数，与其它段同一套标准）；名字带标题，界面那行
      // 小字才不是一串 id。
      emit({ phase: 'tidy', total, done, id: entry.id, label: byId.get(entry.id)?.title ?? entry.id })
      try {
        await deps.dav.delete(remoteBundlePath(deps.settings.machineId, entry.id))
        removed += 1
      } catch (error) {
        problems.push(
          `整理远端：删 ${entry.id} 的旧包失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      done += 1
    }
    for (const orphan of orphans) {
      emit({ phase: 'tidy', total, done, id: orphan.name })
      try {
        await deps.dav.delete(`${SYNC_NAMESPACE_DIR}/${ownDirName}/${orphan.name}`)
        orphansRemoved += 1
        bytes += orphan.bytes
      } catch (error) {
        problems.push(`整理远端：删 ${orphan.name} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      done += 1
    }
    tidy = { removed, orphans: orphansRemoved, bytes }
  }

  /*
   * ── 补对象：日志两边一样、对象却没对齐的那些会话（两个方向，见 `repairAttachments()`）──
   *
   * 放在**推送与索引写完之后**：那时 `pushed` 才是完整的，这一次真搬过对象的会话才摘得干净（放在前面
   * 会让同一个对象被推送那一段与这一段各算一遍）。这一段只碰"索引里早有、日志也没变"的那些会话——
   * 它们的索引条目不是这一次写上去的，所以对象晚一步到位不构成"别的机器拉到一条图挂了的会话"。
   */
  if (port !== undefined && deps.pushOnly !== true) {
    const handled = new Set<string>([...pulled, ...replaced, ...pushed.map((entry) => entry.id)])
    /*
     * 这一趟判成"两边一样"的会话：只有它们的本机副本与远端记录描述同一份内容，远端条目里那份附件
     * 清单才可以直接拿来用（见 `repairAttachments()`）。
     */
    const identical = new Set(
      plan.push.filter((item) => item.action === 'skip' && item.code === 'identical').map((item) => item.id),
    )
    const learned = await repairAttachments(
      deps,
      port,
      local,
      handled,
      remote,
      identical,
      ownEntries,
      ownDirName,
      remoteObjectNames,
      attachmentIn,
      attachmentOut,
      problems,
      absentObjects,
      (done, total, id, label) =>
        emit({ phase: 'attachScan', done, total, id, ...(label === undefined ? {} : { label }) }),
      reportAttachments(),
    )
    // 补记了附件清单：把索引再写一次（只发生在"老条目第一次碰到"的那一趟）。
    if (learned && indexWritten) {
      try {
        await deps.dav.put(
          remoteIndexPath(deps.settings.machineId),
          indexPayload(
            deps,
            [...ownEntries.values()].filter((entry) => !tidyIds.has(entry.id)),
            [...ownDeleted].map(([id, at]) => ({ id, at })),
          ),
        )
      } catch (error) {
        problems.push(`写远端索引失败（补记附件清单）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /*
   * 一轮一句话：本机要、远端也没有的那些对象（两边都是同一种状态，处置也是同一件事）。
   *
   * 数报在这一句里，**具体是哪几条会话**放在 `absentAttachments`：那句话单独看只知道"少了 54 个"，
   * 不知道去持有对象的机器上推哪一条——会话名单由 `collectLeftovers()` 逐条点名（界面据此给出
   * 「只看这一条」）。
   */
  const absent = summarizeAbsent(absentObjects)
  if (absent.objects > 0) {
    problems.push(
      `本机有 ${absent.objects} 个附件对象在远端共享库里也没有，这次补不上（持有这些对象的机器还没推送它们）` +
        (absent.sessions.length === 0 ? '' : `：涉及 ${absent.sessions.length} 条会话`),
    )
  }

  return {
    plan,
    applied: true,
    pulled,
    replaced,
    pushed,
    bytesIn,
    bytesOut,
    // 宿主没有附件服务时两项都缺席（不是"零个对象"）：界面据此什么都不说（见 SyncOutcome 的字段说明）。
    ...(port === undefined ? {} : { attachmentIn, attachmentOut }),
    registryWritten,
    indexWritten,
    ...(effect === undefined ? {} : { effect }),
    // 没落到本机任何一条时（纯推送 / 什么都没做）这一步根本没跑，就别摆一个空结论。
    ...(pulled.length === 0 ? {} : { warm }),
    // 没勾整理、或索引没写成功时都缺席：界面据此什么都不说。
    ...(tidy === undefined ? {} : { tidy }),
    ...(absent.sessions.length === 0 ? {} : { absentAttachments: absent.sessions }),
    ...(deletedNow.length === 0 ? {} : { deleted: { ids: deletedNow, bytes: deletedBytes } }),
    problems,
  }
}

/** 两枚投影缓存结论是不是同一份（同缺同有、值一样）。 */
function sameMeta(left: SessionMeta | undefined, right: SessionMeta | undefined): boolean {
  return (
    left?.blank === right?.blank &&
    left?.lastPromptAt === right?.lastPromptAt &&
    left?.lastMessageAt === right?.lastMessageAt
  )
}

/**
 * 这份预览数据还作不作数（作数 = 应用可以照着它走）。
 *
 * 判据只问"预览之后有没有东西变了"，不问"该不该照原来那份走"：计划是纯计算，输入没变，输出就一样。
 * 五处：
 *   1. **这份计划是在哪套输入下算的**（远端地址、机器名、映射表、三个库位置）：界面这次确认时宿主会重新
 *      解析同步设置，拿旧的映射表应用就会落到用户刚改掉的那个目录以外的地方；
 *   2. **本机的代次文件**：目录里的日志文件不多不少，每个文件的字节数与 mtime 都还是预览那一刻那个
 *      ——"推哪几条"与内容比对都建立在它上面；
 *   3. **投影缓存那两件事**（空白、最后活动时间）：它们决定"这条参不参与""两边谁更新"，变了判定就
 *      可能翻过来；
 *   4. 计划里要**覆盖本机**的那几条，宿主这会儿还没拿在手里：预览时问过，隔了一会儿可能又活了。
 *      那一步要撤掉本机那份目录，与删除拒掉活会话同一个理由；
 *   5. **远端那份索引**：别的机器推过东西就可能把判定翻过来，所以这里重读一次再比指纹。
 *
 * 为什么不按"预览过去多久了"判：按时间只能保证"不太旧"，而这里的判据是结构性的（集合与字节都对得
 * 上），所以隔多久都能照走；反过来，只隔一秒但那条会话刚好又跑了一轮，这里也一定看得出来。预览之后
 * **新建**的会话不在判据里：它不在那份计划里，这次不参与（下一次同步会带上它）。
 *
 * @param deps 远端、设置与本地库的位置。
 * @param prepared 要验的那份预览数据。
 * @param options.onProgress 重读远端索引那一下报一条 `remote`（没有分母，见 `prepareSync()`）。
 * @returns 不能照它走的理由（一句给人看的话）；`undefined` = 还作数。
 */
export async function stalePlanReason(
  deps: SyncDeps,
  prepared: SyncPrepared,
  options: { onProgress?: ProgressReporter } = {},
): Promise<string | undefined> {
  const byId = new Map(prepared.local.map((session) => [session.id, session]))
  // 第一件事：这份计划还是不是拿眼下这套设置算出来的（映射表变了，应用的目录就不是用户改后的那个）。
  if (settingsDigest(deps) !== prepared.facts.settings) {
    return '同步设置（远端地址 / 机器名 / 映射表 / 库位置）在预览之后改过'
  }
  for (const fact of prepared.facts.local) {
    let names: string[]
    try {
      names = readdirSync(fact.dir).filter((name) => parseSessionLogName(name) !== undefined)
    } catch {
      return `本机的 ${fact.id} 这条会话目录已经不在了`
    }
    if (names.sort().join('\n') !== fact.files.map((file) => file.name).sort().join('\n')) {
      return `本机的 ${fact.id} 在预览之后多了一代或少了一代（代次文件变了）`
    }
    for (const file of fact.files) {
      let size = -1
      let mtimeMs = -1
      try {
        const stat = statSync(join(fact.dir, file.name))
        size = stat.size
        mtimeMs = stat.mtimeMs
      } catch {
        return `本机的 ${fact.id} 少了 ${file.name}`
      }
      if (file.mtimeMs === undefined || mtimeMs !== file.mtimeMs || size !== file.bytes) {
        return `本机的 ${fact.id} 在预览之后又动过（${file.name} 与预览那一刻不是一个样子）`
      }
    }
  }
  if (deps.sessionMeta !== undefined || deps.projection !== undefined) {
    for (const fact of prepared.facts.local) {
      const session = byId.get(fact.id)
      if (session === undefined) continue
      // 这里要的是**刚读到的**那一份（`byId` 来自重新扫一遍库），不是预览那一刻缓存下来的值。
      const fresh =
        deps.sessionMeta === undefined
          ? sessionMetaOfRecord(session.meta)
          : deps.sessionMeta({
              id: session.id,
              createdAt: session.createdAt,
              ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            })
      if (!sameMeta(fact.meta, fresh)) return `本机的 ${fact.id} 在预览之后又动过（宿主那份列表元数据变了）`
    }
  }
  const live = deps.liveSessionIds?.()
  if (live !== undefined) {
    for (const entry of prepared.plan.pull) {
      // 覆盖本机那份是这个插件里唯一会撤掉本机已有内容的动作（见上面那条说明）。
      if (entry.action === 'replace' && live.has(entry.id)) {
        return `${entry.id} 这会儿还在宿主内存里（运行中或已打开）：重启 DSH 让宿主放手，之后别先点开它再同步`
      }
    }
  }
  options.onProgress?.({
    phase: 'remote',
    done: 0,
    total: 0,
    ...(deps.progressWhat === undefined ? {} : { what: deps.progressWhat }),
  })
  const remote = await readRemoteLibrary(deps.dav, deps.settings)
  if (remoteDigest(remote) !== prepared.facts.remote) {
    return '远端那份索引在预览之后变了（别的机器推过东西）'
  }
  return undefined
}

/**
 * 应用一次同步：预览那份数据还作数就照着它走（不再重算），变了就从零重算一遍。
 *
 * 这是界面那条路（先预览、后确认）的应用口，`planSource` 报的就是走的哪一条。工具层是单次调用，
 * 没有"预览那份"这回事，直接走 `runSync()`。
 *
 * @param deps 远端、设置与本地库的位置。
 * @param prepared 预览那份数据（`prepareSync()` 的返回值）。
 * @param options.onProgress 每开始处理一条调一次。
 * @returns 应用结果；`planSource.kind === 'recomputed'` 说明这次是重算的（`reason` 是哪一处对不上）。
 */
export async function syncPrepared(
  deps: SyncDeps,
  prepared: SyncPrepared,
  options: {
    onProgress?: ProgressReporter
    decisions?: ReadonlyMap<string, SyncDecision>
    tidy?: boolean
  } = {},
): Promise<SyncOutcome> {
  const reason = await stalePlanReason(deps, prepared, options)
  if (reason === undefined) {
    return { ...(await applyPreparedSync(deps, prepared, options)), planSource: { kind: 'reused' } }
  }
  const outcome = await runSync(deps, {
    apply: true,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.decisions === undefined ? {} : { decisions: options.decisions }),
    ...(options.tidy === undefined ? {} : { tidy: options.tidy }),
  })
  return { ...outcome, planSource: { kind: 'recomputed', reason } }
}

/**
 * 单次跑完一次同步：算计划（应用时接着用它）。
 *
 * 工具层与老调用方走这条——一次调用里预览与应用是同一件事，没有"确认"这一步。界面那条"先预览、后
 * 确认"的路分两次调用：`prepareSync()` + `syncPrepared()`。
 *
 * @param deps 远端、设置与本地库的位置。
 * @param options.apply 为 false 只算计划（除了读远端，什么都不写）。
 * @param options.onProgress 每开始处理一条调一次（见 `SyncProgress`）；预览与应用报的是同一套事件
 *   （算计划的四段 + 写入磁盘的两段）。回调同步调用、不 await，所以它自己不许抛。
 * @returns 结果；单条失败只记进 `problems`，不半路放弃整次同步。
 */
export async function runSync(
  deps: SyncDeps,
  options: {
    apply: boolean
    onProgress?: ProgressReporter
    decisions?: ReadonlyMap<string, SyncDecision>
    tidy?: boolean
  },
): Promise<SyncOutcome> {
  const prepared = await prepareSync(deps, options)
  if (!options.apply) return plannedOutcome(prepared)
  return applyPreparedSync(deps, prepared, options)
}

// ── 自动推送：后台自己跑一轮，**只推不拉** ─────────────────────────────────────────

/**
 * 自动推送这一轮跑没跑、跑成了什么。
 *
 * 形状刻意分两层：`ran` / `skip` 说"这一轮**动了没有、为什么没动**"，`outcome` 才是真跑之后那份
 * 应用结果（与手动同步同一个形状，界面因此能复用同一套解析）。不把两者揉成一个可选字段，是因为
 * "没跑"有三种完全不同的原因（没开、没到点、上一轮还在跑），界面上那三句话也不一样。
 */
export interface AutoPushOutcome {
  /** 这一轮真的算过 / 推过（false 时看 `skip`）。 */
  ran: boolean
  /** 没跑的原因（机器可读，句子在浏览器半侧）。 */
  skip?: AutoPushSkip
  /** 真跑了的应用结果。 */
  outcome?: SyncOutcome
  /** 真跑的开始与结束时刻（毫秒）；没跑就没有。 */
  startedAt?: number
  finishedAt?: number
  /** 已经连续失败几次（跑成功清零）。界面据此在连续失败时说一句。 */
  failures: number
  /** 最近一次失败的原话（跑成功时清空）。 */
  problem?: string
}

/** 自动推送"现在在跑的那一轮"：开始时刻与最后一条进度（还没报过就是 null）。 */
export interface AutoPushRunning {
  startedAt: number
  progress: SyncProgress | null
}

/** `AutoPushTimer.status()` 的回答：跑着的那一轮（没有就是 null）与上一轮的结论。 */
export interface AutoPushStatus {
  running: AutoPushRunning | null
  last: AutoPushOutcome | undefined
}

/**
 * 自动推送那一轮的进展：一条条进度，跑完一条结论。
 *
 * 订阅者是面板那条唯一的长连接（`GET /panel/events`，见 `src/web.ts`）。事件里带的是原始形状
 * （`SyncProgress` / `AutoPushOutcome`），怎么摊平由收的那一侧决定。
 */
export type AutoPushEvent =
  | { type: 'progress'; progress: SyncProgress }
  | { type: 'done'; outcome: AutoPushOutcome }

/**
 * 会话事件的安静窗口（毫秒）：末尾那个会话事件之后安静满这么久，才推一轮。5 分钟。
 *
 * 它既是"攒连发"也是"等人停手"：一轮对话不是只发一次事件（`turn/start`、`step/end`、工具派发、
 * `turn/end`、goal 自动续轮、子智能体起停都会各发一次），用户连着问更是连着来。每个事件都只做一件事
 * ——**把计时重置**。
 *
 * 为什么是 5 分钟而不是十几秒：一轮整库推送在这台机器的真实库上实测要 **20～90 秒**（1024 条会话 /
 * 670 MB，其中上行几十 MB），而"写完一轮 10 秒后就推"会把这段重活儿插在用户下一次说话中间。取 5 分钟
 * 是"用户多半已经转头去干别的"的量级；代价是最后一轮之后最多晚 5 分钟才上云。依据见
 * [让自动推送等安静之后再跑](../../../.agents/notes/implemented/bug-fix/2026-10-22-auto-push-waits-for-quiet.md)。
 *
 * 写入磁盘不靠这个窗口等：宿主侧在调 `touched()` 之前已经 `await sessions.flush(session)` 过了（见
 * `src/tools.ts` 的 `attachAutoPushToSessions()`），窗口纯粹是"别在人还在的时候抢资源"。
 */
export const AUTO_PUSH_QUIET_MS = 300_000

/**
 * 自动推送没跑的原因。
 *
 * - `disabled`：这个宿主/profile 没开自动推送（配置里 `sync.autoPush` 不是 true）；
 * - `busy`：上一轮还在跑（网络慢、条数多），这一轮直接让开——不排队：排队会让积压的轮次一个接一个
 *   跑完，而每一轮读的都是同一份"最新"，重复跑没有意义；
 * - `idle`：有得算但一条都不用推，而且连要撤下的空白会话都没有——这一轮连收尾都不必做。
 *
 * **没有"正在攒连发"这个码**：空闲窗口只**推迟**推送，不会让任何一次询问得到"没跑"——`touched()` 与
 * 界面那枚「立即推送一次」都是"现在就跑"，窗口里照样当场推。所以"在攒"不是一种 `skip`（那是"这次
 * 没跑"的原因），它只是"还没到"。给一个没有消费者的码会有害：它会看起来像一套不存在的机制
 * （同一类问题见 [自动推送那篇](../../../.agents/notes/implemented/feature/2026-10-14-auto-push-is-push-only.md)
 * 里记的那个没有消费者的 `minIntervalMs`）。
 */
export type AutoPushSkip = 'disabled' | 'busy' | 'idle'

/**
 * 调度器的配置读法：每次都现读一眼（`sync` 那一节是活引用，改完不必重启）。
 *
 * 只剩"开不开"：什么时候跑由事件决定（本机写完一轮），没有"隔多久跑一次"这回事了。
 */
export interface AutoPushClock {
  /** 自动推送此刻开着吗。 */
  enabled(): boolean
}

/** `createAutoPushTimer()` 的依赖。 */
export interface AutoPushTimerDeps {
  /**
   * 跑一轮（`runAutoPush()` 的真身由调用方注入；测试注入一个计数的假实现）。
   */
  run: (options?: { onProgress?: ProgressReporter }) => Promise<AutoPushOutcome>
  /** 当前配置（活引用现读）。 */
  clock: AutoPushClock
  now?: () => number
  /** 定时器工厂；缺省用全局的 `setTimeout` / `clearTimeout`（测试注入假的，不必真等）。 */
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /**
   * 写远端格子的互斥锁（与界面端点、工具共用同一把）。
   *
   * 缺省自己造一把：只测调度器时够用；生产由 `src/index.ts` 造一份交给所有入口。
   */
  remoteWrite?: RemoteWriteGate
}

/** 自动推送调度器的对外形状。 */
export interface AutoPushTimer {
  /** 自动推送此刻开着吗。 */
  enabled(): boolean
  /**
   * 当场跑一轮。
   *
   * 两条来路都走它：本机写完一轮（空闲窗口到点，见 `touched()`）与界面那枚「立即推送一次」。
   */
  tick(options?: { onProgress?: ProgressReporter }): Promise<AutoPushOutcome>
  /**
   * 又有会话活动了——起（或续）一个安静窗口，安静 {@link AUTO_PUSH_QUIET_MS} 毫秒之后推一轮。
   *
   * 由宿主侧在**每一个**会话事件之后调（见 `src/tools.ts` 的 `attachAutoPushToSessions()`：`turn/end`
   * 那一次是在 `await sessions.flush(session)` 之后调的，其余事件只算"还在活动"）。窗口内再来事件就
   * 把计时**重置**，所以一整段连着写的时间里一次都不推。
   *
   * 关着的时候什么都不做：不排队、不计数——打开之后写的下一轮会照常触发，没有"欠着一次"这回事。
   */
  touched(): void
  /** 最近一次结论（不碰网络）。 */
  last(): { enabled: boolean; outcome?: AutoPushOutcome }
  /**
   * 这一轮**现在**跑到哪了。
   *
   * 与 `last()` 分开：`last()` 说的是"上一轮结论"，这一份说的是"正跑着的那一轮到了第几条"——界面
   * 进入同步页时拿它接上进度条，而不是让用户只看到一句"上一轮还在跑"（见 `AutoPushRunning`）。
   */
  status(): AutoPushStatus
  /**
   * 订阅"之后的进展"（进度一条条、跑完一条结论）。
   *
   * 只推**订阅之后**发生的事：刚连上来那一轮现在跑到哪，先由 `status()` 说一次（见
   * `GET /panel/events` 开头那条 `auto-push` 事件）。
   *
   * @param listener 收到事件时调一次。
   * @returns 退订函数（连接断了/组件卸了就得调，不然事件一直往死连接上写）。
   */
  subscribe(listener: (event: AutoPushEvent) => void): () => void
  /** 这一次跑完了/已经知道了的结论（`tick()` 自己调，也供外部记一笔）。 */
  note(outcome: AutoPushOutcome): void
  /** 停掉（卸载时）：不再起新的空闲窗口；`tick()` 仍可用（界面那枚按钮不依赖它）。 */
  stop(): void
}

/**
 * 造一个自动推送的调度器。
 *
 * 它只干一件事：收到"本机写完一轮"之后起一个空闲窗口，空下来就推一轮（见 `touched()`）。**没有
 * 周期唤醒**——什么时候推完全由事件决定（见
 * [只在写完一轮之后推](../../../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)）。
 *
 * 要守的只有两件：同一时间只跑一轮（`busy`），以及跑着的时候又来了事件就记一笔、跑完补一次
 * （`settleAgain`）。两份状态都留在这个闭包里，所以它**每个宿主只造一个**。
 *
 * @param deps 跑一轮的动作、配置读法与定时器工厂。
 * @returns 调度器；关着的时候不挂任何定时器，但仍可 `tick()`。
 */
export function createAutoPushTimer(deps: AutoPushTimerDeps): AutoPushTimer {
  const now = deps.now ?? ((): number => Date.now())
  const setTimer = deps.setTimer ?? ((handler: () => void, ms: number): unknown => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout))
  let stopped = false
  /** 正在跑（`busy` 那条判据）：一次只允许一轮，且**由调度器**把关，不指望 `run()` 自己重入安全。 */
  let running: Promise<AutoPushOutcome> | undefined
  let lastOutcome: AutoPushOutcome | undefined
  /** 空闲窗口那个计时器（见 `touched()`）。 */
  let settleHandle: unknown
  /** 上一轮还在跑的时候又来事件：记下来，跑完立刻补一次（不丢用户的这一轮）。 */
  let settleAgain = false
  /**
   * 正跑着的那一轮（`undefined` = 没有）。
   *
   * 为什么由调度器记：一轮可能由两条路发起（本机写完一轮、界面那枚「立即推送一次」），而界面要知道的
   * 是"**不管谁发起的**，现在这一轮跑到哪了"。进度回调在这里包一层，谁发起都记得下。
   */
  let runningState: AutoPushRunning | undefined
  /** 正在听进展的人（界面那条长连接；没人听时是个空集合，广播什么都不做）。 */
  const listeners = new Set<(event: AutoPushEvent) => void>()
  /** 把一条事件发给所有订阅者；订阅者自己的异常吞掉——一个连接坏了不该让这一轮推送失败。 */
  const broadcast = (event: AutoPushEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // 谁坏了就少收一条；退订由它自己的连接负责。
      }
    }
  }

  const note = (outcome: AutoPushOutcome): void => {
    lastOutcome = outcome
  }
  /** 写自己那一格的闸；与手动同步、整理、删除远端、模型工具共用同一把（生产由入口注入）。 */
  const gate = deps.remoteWrite ?? createRemoteWriteGate(now)

  const tick = async (options: { onProgress?: ProgressReporter } = {}): Promise<AutoPushOutcome> => {
    /*
     * 上一轮还在跑：这一轮让开。
     *
     * 报的是**上一轮**那份结论（`lastOutcome`）：`busy` 说的是"这一次请求没被受理"，不是"同步失败了"——
     * 造一条合成的结论会把上一轮真跑出来的结果盖掉，界面上就只剩一句"刚才在忙"。
     */
    if (running !== undefined) return { ran: false, skip: 'busy', failures: failuresOf(lastOutcome) }
    if (!deps.clock.enabled()) return { ran: false, skip: 'disabled', failures: failuresOf(lastOutcome) }
    /*
     * 别的入口正在写远端（手动同步应用、整理、删除远端、工具）：这一轮直接跳过，不排队。排队会让它
     * 拿着读于排队之前的快照去写，反而更容易盖掉别人刚写进去的东西；下一轮安静窗口会自己再来。
     */
    const release = gate.tryAcquire('自动推送')
    if (release === undefined) return { ran: false, skip: 'busy', failures: failuresOf(lastOutcome) }
    const pending = (async (): Promise<AutoPushOutcome> => {
      const startedAt = now()
      runningState = { startedAt, progress: null }
      const outcome = await deps.run({
        // 谁要看这条流都行：调用方给的那一份照旧收到，同时记进 `runningState` 供界面读。
        onProgress: (progress: SyncProgress): void => {
          if (runningState !== undefined) runningState.progress = progress
          options.onProgress?.(progress)
          broadcast({ type: 'progress', progress })
        },
      })
      // `run()` 自己会带 `failures` 与 `problem`（它知道这一轮是失败还是空跑）；这里只补时刻。
      const stamped: AutoPushOutcome = { ...outcome, ...(outcome.ran ? { startedAt, finishedAt: now() } : {}) }
      note(stamped)
      broadcast({ type: 'done', outcome: stamped })
      return stamped
    })()
    running = pending
    try {
      return await pending
    } finally {
      release()
      running = undefined
      runningState = undefined
      // 跑着的时候又来事件：这一轮读的是它开始之前的快照，那一轮得再补一次。
      if (settleAgain) {
        settleAgain = false
        touched()
      }
    }
  }

  /**
   * 又有会话活动了：重置安静窗口。
   *
   * 攒连发与"等人停手"的全部实现就是"重置计时"这一句——每来一个事件，旧的计时器被清掉、重新起一个，
   * 于是"末尾那个事件之后安静满 {@link AUTO_PUSH_QUIET_MS}"才会真跑。所以用户连着问、或者子智能体
   * 还在跑，都推不动它。
   *
   * 正在跑时不重置、也不排队，只记一个"跑完补一次"：这一轮读的快照里没有刚写完的那一笔，直接丢掉
   * 会让用户觉得"我写完了它没推"。
   */
  const touched = (): void => {
    if (stopped || !deps.clock.enabled()) return
    if (running !== undefined) {
      settleAgain = true
      return
    }
    if (settleHandle !== undefined) clearTimer(settleHandle)
    settleHandle = setTimer(() => {
      settleHandle = undefined
      void tick()
    }, Math.max(1, AUTO_PUSH_QUIET_MS))
  }

  return {
    enabled: () => deps.clock.enabled(),
    tick: (options = {}) => tick(options),
    touched,
    last() {
      return {
        enabled: deps.clock.enabled(),
        ...(lastOutcome === undefined ? {} : { outcome: lastOutcome }),
      }
    },
    status() {
      return {
        running:
          runningState === undefined ? null : { startedAt: runningState.startedAt, progress: runningState.progress },
        last: lastOutcome,
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    note,
    stop() {
      stopped = true
      if (settleHandle !== undefined) {
        clearTimer(settleHandle)
        settleHandle = undefined
      }
    },
  }
}

/** 一条结论里记着的连续失败次数（没有结论时是 0）。 */
function failuresOf(outcome: AutoPushOutcome | undefined): number {
  return outcome?.failures ?? 0
}

/**
 * 跑一轮自动推送：**只推不拉**。
 *
 * 与手动同步那条路（`runSync()` / `prepareSync()` + `syncPrepared()`）的三处不同，每一处都是
 * "无人在场"推出来的：
 *
 *   1. **只推不拉**（`pushOnly`）：计划里没有拉取、没有"覆盖本机"，所以这一轮**永远不改本机任何
 *      会话**。这不是省钱，是安全边界——覆盖本机那份要动本机已有内容，界面上那道动作前面挡着一个
 *      确认弹窗，后台不该绕过它。也正因为没有应用那一段，这一轮不必问宿主"这条还活着吗"、不必
 *      备份、不写注册表、不请宿主重折投影检查点：那几件事全都挂在"真有东西落到本机"那条路上。
 *   2. **没有预览与确认**：一次调用算完就应用（`runSync()` 那条单次调用路），而**不是**
 *      `syncPrepared()`——那个是"照着用户确认过的那份计划应用"，后台没有用户确认过的东西。
 *   3. **没得推也要收尾一次**：本机删掉的会话得从**自己那一格的索引**里消失，而今天那一步只在
 *      `applyPreparedSync()` 里（且总是会走到）。所以"计划里一条都不推"时仍要走一次应用——一份空的
 *      计划，落下去只会重写索引。不这么做的话，删掉的会话会永远留在自己的格子索引里，别的机器照着
 *      它去取包时取到一个不存在的对象。
 *
 * 没有速度闸：两条来路（写完一轮、用户手点一次）都是"现在就该跑"，而"隔多久跑一次"这个旋钮已经跟着
 * 兜底定时器一起删掉了（见
 * [只在写完一轮之后推](../../../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)）。
 *
 * @param deps 远端、设置与本地库的位置；`settings.autoPush` 说这次开没开。
 * @param options.failures 这一层维护的连续失败计数（成功清零）。
 * @param options.onProgress 每开始处理一条调一次（与手动那条路同一套事件）。
 * @returns 这一轮的结论；**不抛**——后台任务抛出去没人接，失败进 `failures` 与 `problem`。
 */
/**
 * 本机那格的索引里是不是还留着眼下**已经没有**的会话（见 `runAutoPush()` 的 `idle` 判据）。
 *
 * 判据是集合包含：索引里记着的每个 id 都得在本机现在的库里。本机删掉一条会话之后那个 id 就不在了，
 * 于是这一项为真——值得走一趟应用把索引刷新掉。反过来"本机新加了一条"不算（那时 `pushIds` 里有它，
 * 走不到这个判据）。
 *
 * 只看**自己那一格**：别的机器的格子由它们自己维护，那些记录本来就不该由这里撤。
 *
 * @param prepared 这一轮算出来的数据（`remote.indexes` 是读回来的各机器索引）。
 * @param machineId 这台机器的标识（它那一格的目录名按 `machineDirName()` 折算）。
 * @returns 索引里有本机已经没有的会话时为 true。
 */
function indexNeedsSettling(prepared: SyncPrepared, machineId: string): boolean {
  const own = prepared.remote.indexes.get(machineDirName(machineId))
  if (own === undefined) return false
  const present = new Set(prepared.local.map((session) => session.id))
  return own.entries.some((entry) => !present.has(entry.id))
}

export async function runAutoPush(
  deps: SyncDeps,
  options: {
    failures?: number
    now?: () => number
    onProgress?: ProgressReporter
  } = {},
): Promise<AutoPushOutcome> {
  const now = options.now ?? ((): number => Date.now())
  const failures = options.failures ?? 0
  const config = deps.settings.autoPush
  if (config === undefined || !config.enabled) return { ran: false, skip: 'disabled', failures }
  /*
   * 两档在这一处分岔，其余完全相同（同一个 quiet 窗口、同一套进度、同一份 `AutoPushOutcome`）：
   *
   * - `push`：只推。`pushOnly` 让计划里没有拉取那半，于是这一轮**永远不改本机任何会话**；
   * - `sync`：双向 + 收尾整理自己那一格（只删重复与被取代的包，孤儿包留着）。这一档会动本机：远端
   *   更新时先备份、再顶掉本机那份，正在本机开着的会话仍被跳过——所以它要求用户在设置里明确选了
   *   "双向"才可能发生（见 [那篇决策](../../../.agents/notes/implemented/feature/2026-11-13-auto-sync-runs-both-ways.md)）。
   */
  const mode = config.mode
  const startedAt = now()
  /*
   * 三个条件都成立才是"真的没事干"（`idle`），此时连应用都不走：索引里要写的东西与远端那份逐字节
   * 相同，再 PUT 一次只是白跑一趟网络。三条各自挡一种"看着没事、其实要收尾"的情形：
   *
   *   1. `pushIds` 非空 → 有会话要推；
   *   2. `blank` 非空 → 那几条空白会话要从**远端那份索引**里撤下来（它们本机不上传）；
   *   3. `indexNeedsSettling()` → 本机**删掉**的会话还挂在自己那格索引里。它们不在这一轮的
   *      `plan.local` 里，所以推送表里连 `identical` 行都没有——只看前两条会整类漏掉，而被删的会话
   *      留在索引里，别的机器就会照着它去取一个不存在的包。
   */
  try {
    const roundDeps: SyncDeps =
      mode === 'push'
        ? { ...deps, pushOnly: true, progressWhat: deps.progressWhat ?? 'auto-push' }
        : { ...deps, progressWhat: deps.progressWhat ?? 'auto-push' }
    const prepared = await prepareSync(roundDeps, {
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(mode === 'push' ? { pushOnly: true } : {}),
    })
    /*
     * "真的没事干"要连**整理**一起算：双向那一档即使一条都不用搬，自己那一格里可能躺着几份重复的包，
     * 那一趟仍然值得跑（否则那些包永远没人清）。只推那一档没有整理，条件与原来一样。
     */
    const tidyPlan = mode === 'sync' ? planTidy(prepared.remote, deps.settings.machineId) : undefined
    const idle =
      prepared.plan.pushIds.length === 0 &&
      prepared.plan.blank.length === 0 &&
      (mode === 'push' || prepared.plan.pullIds.length === 0) &&
      !indexNeedsSettling(prepared, deps.settings.machineId) &&
      (tidyPlan === undefined || tidyPlan.entries.length === 0)
    if (idle) {
      const finishedAt = now()
      return { ran: true, skip: 'idle', startedAt, finishedAt, failures }
    }
    const outcome = await applyPreparedSync(roundDeps, prepared, {
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(mode === 'sync' ? { tidy: true, tidyOrphans: false } : {}),
    })
    const finishedAt = now()
    const failed = outcome.problems.length > 0
    return {
      ran: true,
      outcome,
      startedAt,
      finishedAt,
      failures: failed ? failures + 1 : 0,
      ...(failed ? { problem: outcome.problems[0] as string } : {}),
    }
  } catch (error) {
    return {
      ran: false,
      failures: failures + 1,
      problem: error instanceof Error ? error.message : String(error),
    }
  }
}

/*
 * 这一层仍是同步的入口（`src/web.ts`、`src/tools.ts` 与测试都从这里取东西）：拆出去的几块在这里
 * 转出去，调用方不必跟着搬家。真正的定义各在它自己的文件里。
 */
export * from './index.ts'
export * from './settings.ts'
export * from './fingerprint.ts'
export * from './attachments.ts'
export * from './tidy.ts'
