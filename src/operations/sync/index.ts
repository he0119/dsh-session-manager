// 远端那套布局：机器格、索引正文、会话包与附件对象的路径，以及把索引读回来、把计划写下去。
//
// 远端不是"库"，只是一批包加一份索引：`<url>/dsh-session-manager/<machineId>/index.json`。一机一格是
// 因为 WebDAV 没有锁——多台机器共写一份索引就是"后写的盖掉先写的"；每台机器只写自己那一格、读别人的
// 全部，就不需要锁。
//
// @module dsh-session-manager/operations/sync/index

import { isAttachmentId } from '../../shared/attachments.ts'
import type { DavPort } from './dav.ts'
import { encodeSegment } from '../../shared/paths.ts'
import { type FileFingerprint, relation } from './fingerprint.ts'
import type { SyncSettings } from './settings.ts'
import { SYNC_ATTACHMENTS_DIR } from './attachments.ts'
import { longerSide, newerSide, remoteActiveAt, type RemoteCopiesPort } from './sync.ts'

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

/** 一份索引正文的上限：正常 1400 条约 0.5～0.7 MB，32 MB 足够，坏文件不整份解析。 */
export const MAX_INDEX_TEXT_BYTES = 32 * 1024 * 1024

/** 一份索引最多收多少条会话记录：防止一个失控的远端把内存撑满。 */
export const MAX_INDEX_ENTRIES = 100_000

/**
 * 索引里记下的一条附件引用：只记身份，不记字节数（取本机路径与远端对象名都用不到它）。
 *
 * 为什么记进索引：补对象那一步要知道"这条会话引用过哪些对象"，而唯一能算出来的办法是把日志解压一遍。
 * 整库解压 1.2 GB 实测 144 秒，把这句结论跟着索引带上，别的机器读索引就够了，一个字节的日志都不用解。
 */
export interface IndexedAttachment {
  kind: 'image' | 'file'
  id: string
  /** 文件对象在日志里带的名字（图片没有）：算本机路径的最后一段要用它。 */
  name?: string
}

/** 远端索引里的一条会话。 */
export interface RemoteSessionEntry {
  id: string
  cwd?: string
  title?: string
  /** 跨机器的项目身份（仓库 remote 规范化之后，见 [repo.ts](../../shared/repo.ts)）；老索引没有这一项。 */
  repo?: string
  /** 会话的 cwd 在仓库根之下的相对路径（POSIX 分隔符，仓库根是 `.`）。 */
  repoPath?: string
  createdAt: number
  files: FileFingerprint[]
  /**
   * 这条会话的日志引用过哪些附件对象（由推送它的那台机器算好写进来）。
   *
   * 缺席 = 还没算过（老版本写的索引，或者推送它的机器没有附件服务）：补对象时退回"本地解一遍日志"，
   * 算完顺手补进自己那一格的索引。有它（哪怕是空数组）就不必解日志——这正是把整库 144 秒的扫描变成
   * 毫秒级的那一项；空数组说的是"查过，一个都没有"，与"没查过"必须分得开。
   */
  attachments?: IndexedAttachment[]
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

/**
 * 一条"这台机器把它删了"的记录（墓碑）。
 *
 * 为什么需要它：删除只删本机，远端各机器格子里那份还好端端躺着，下一次同步就把它当"远端有、本机
 * 没有"重新拉回来（见 [删除跟着墓碑走](../../../.agents/notes/implemented/feature/2026-11-15-deletion-travels-with-the-tombstone.md)）。
 * 墓碑说的是"我在 `at` 这一刻删掉了它，谁的那份比这旧就别再当它还在"。
 *
 * 存在**删它的那台机器自己那份索引**里：每台机器只写自己那一格（同步的既有边界），不会出现两台机器
 * 同时改同一份索引。
 */
export interface IndexedDeletion {
  id: string
  /** 删除时刻（毫秒时间戳）。 */
  at: number
}

/** 一台机器写下的索引（`index.json` 的解析结果）。 */
export interface RemoteIndex {
  machineId: string
  updatedAt?: string
  pluginVersion?: string
  entries: Array<Omit<RemoteSessionEntry, 'machine'>>
  /** 删过并要求别再拉回来的那些会话（见 `IndexedDeletion`）；老索引没有这一项。 */
  deleted?: readonly IndexedDeletion[]
}

/** 一条生效的墓碑：谁删的、什么时候。 */
export interface Tombstone extends IndexedDeletion {
  /** 删它的是哪台机器（报告里指名）。 */
  machine: string
}

/**
 * 把所有机器索引里的删除记录合成一份（同一个 id 取最晚的那次删除）。
 *
 * 为什么取最晚：两台机器各删过一次时，"更晚的那次"才是要拿来跟副本活动时间比的那把尺子。
 *
 * @param remote 读回来的远端库。
 * @returns 会话 id → 墓碑。
 */
export function tombstonesOf(remote: RemoteLibrary): Map<string, Tombstone> {
  const found = new Map<string, Tombstone>()
  for (const [machine, index] of remote.indexes) {
    for (const item of index.deleted ?? []) {
      const current = found.get(item.id)
      if (current === undefined || item.at > current.at) found.set(item.id, { id: item.id, at: item.at, machine })
    }
  }
  return found
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

/**
 * 一条会话在远端某台机器格子里的位置（`GET /remote` 的响应里的一项）。
 *
 * 远端是"一条会话一个包、一台机器一个格子"：同一条会话可能同时躺在几台机器的格子里（各自推过一次），
 * 所以界面上问"这条会话在远端哪儿"的答案是一份清单，不是一处。
 */
export interface RemotePlacement {
  /** 贡献这一份的机器（格子名，也就是那台机器的 `machineId`）。 */
  machine: string
  /** 包在远端资源根下的路径（`dsh-session-manager/<机器>/<id>.dshsess`）。 */
  path: string
  /** 那份日志的总字节数（未压缩；索引里各代次 `bytes` 之和）。 */
  bytes: number
  /** 那份在这台机器上的最后活动时间（毫秒时间戳；老索引没记时缺席）。 */
  lastActiveAt?: number
}

/**
 * `GET /remote` 的响应：远端每一台机器的格子里都有哪几条会话、各在什么路径。
 *
 * 为什么整份给：界面（右栏）选中一条会话就要看到它的位置，按会话现问一次网络会让每次点选都等一次
 * NAS；而读的只是每台机器那份 `index.json`（不是包本身），一次读齐很小。
 */
export interface RemotePlacementMap {
  /** 这份是读出来的时刻（毫秒时间戳）。 */
  at: number
  /** 读到索引的机器（按格子名排序）。 */
  machines: string[]
  /** 会话 id → 它在各格子里的位置（同一 id 多台时按最后活动时间从新到旧）。 */
  sessions: Record<string, RemotePlacement[]>
  /** 读索引时遇到的问题（某一台机器的索引读不到之类）：界面据此说"这里可能不全"。 */
  problems: string[]
}

/**
 * 把读回来的远端库摊成"会话 id → 位置清单"。
 *
 * 与 `RemoteLibrary.entries`（每个 id 只留**赢的那一份**）刻意不同：那里判"该拿哪一份"，这里回答
 * "这一条在远端哪些格子里有"，所以按机器逐份列全，一台机器都不漏。
 *
 * @param remote 读回来的远端库。
 * @param now 这次读的时刻（毫秒）。
 * @returns 会话 id → 位置清单。
 */
export function remotePlacements(remote: RemoteLibrary, now: number): RemotePlacementMap {
  const sessions: Record<string, RemotePlacement[]> = {}
  for (const [machine, index] of remote.indexes) {
    for (const entry of index.entries) {
      const list = (sessions[entry.id] ??= [])
      list.push({
        machine,
        path: remoteBundlePath(machine, entry.id),
        bytes: entry.files.reduce((sum, file) => sum + file.bytes, 0),
        ...(entry.lastActiveAt === undefined ? {} : { lastActiveAt: entry.lastActiveAt }),
      })
    }
  }
  for (const list of Object.values(sessions)) {
    // 同一 id 多台机器都有：最近动过的那份排前面（时间是跨机器比"谁更新"用的同一枚钟）。
    list.sort(
      (left, right) => (right.lastActiveAt ?? 0) - (left.lastActiveAt ?? 0) || (left.machine < right.machine ? -1 : 1),
    )
  }
  return { at: now, machines: [...remote.machines], sessions, problems: [...remote.problems] }
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
  const value = parsed as {
    unit?: unknown
    version?: unknown
    entries?: unknown
    deleted?: unknown
    updatedAt?: unknown
    pluginVersion?: unknown
  }
  /*
   * 自描述字段：写入端 `indexPayload()` 一直在写这两个，读端以前没看。别的工具往同一个目录里放一份
   * `index.json`、或者将来格式升版时，至少要在这里认出来，而不是把里面的 `entries` 当成自己人照读。
   * 两项都允许缺席（最早那版索引没有它们），但写了就必须对。
   */
  if (value.unit !== undefined && value.unit !== SYNC_INDEX_UNIT) {
    problems.push(`${machine} 的 ${SYNC_INDEX_FILE} 不是本插件的索引（unit=${JSON.stringify(value.unit)}）`)
    return undefined
  }
  if (value.version !== undefined) {
    if (
      typeof value.version !== 'number' ||
      !Number.isInteger(value.version) ||
      value.version < 1 ||
      value.version > SYNC_INDEX_VERSION
    ) {
      problems.push(
        `${machine} 的 ${SYNC_INDEX_FILE} 版本 ${String(value.version)} 不受支持（本插件读到 ${SYNC_INDEX_VERSION}）`,
      )
      return undefined
    }
  }
  if (!Array.isArray(value.entries)) {
    problems.push(`${machine} 的 ${SYNC_INDEX_FILE} 没有 entries 数组`)
    return undefined
  }
  if (value.entries.length > MAX_INDEX_ENTRIES) {
    problems.push(
      `${machine} 的 ${SYNC_INDEX_FILE} 记录太多（${value.entries.length} 条，上限 ${MAX_INDEX_ENTRIES}），整份跳过`,
    )
    return undefined
  }
  const entries: RemoteIndex['entries'] = []
  for (const raw of value.entries) {
    const entry = raw as Partial<RemoteSessionEntry>
    if (typeof entry?.id !== 'string' || entry.id === '') {
      problems.push(`${machine} 的索引里有一条没有 id 的记录，已跳过`)
      continue
    }
    const files: FileFingerprint[] = []
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      if (
        typeof file?.version !== 'number' ||
        !Number.isFinite(file.version) ||
        file.version < 0 ||
        typeof file.bytes !== 'number' ||
        !Number.isFinite(file.bytes) ||
        file.bytes < 0 ||
        typeof file.sha256 !== 'string'
      ) {
        continue
      }
      files.push({ version: file.version, bytes: file.bytes, sha256: file.sha256 })
    }
    if (files.length === 0) {
      problems.push(`${machine} 的索引里 ${entry.id} 没有任何代次记录，已跳过`)
      continue
    }
    const attachments: IndexedAttachment[] = []
    for (const raw of Array.isArray(entry.attachments) ? entry.attachments : []) {
      const item = raw as Partial<IndexedAttachment>
      if (item?.kind !== 'image' && item?.kind !== 'file') continue
      /*
       * id 会直接拼成远端对象路径（`remoteAttachmentPath()` 取 `sha256:` 后面那一段），
       * 不校验的话 `aa/../../x` 这种值能让客户端去取共享库外面的东西。
       */
      if (!isAttachmentId(item.id)) continue
      attachments.push({
        kind: item.kind,
        id: item.id,
        ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
      })
    }
    entries.push({
      id: entry.id,
      ...(typeof entry.cwd === 'string' && entry.cwd !== '' ? { cwd: entry.cwd } : {}),
      ...(typeof entry.title === 'string' && entry.title !== '' ? { title: entry.title } : {}),
      ...(Array.isArray(entry.attachments) ? { attachments } : {}),
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
  /*
   * 删除记录（墓碑）：读不出来的跳过并说一句，不编一个时间——一个来历不明的时间要么让一条还活着的
   * 会话被删掉，要么让一条该删的复活，两种都比"这条记录没读到"更糟。
   */
  const deleted: IndexedDeletion[] = []
  for (const raw of Array.isArray(value.deleted) ? value.deleted : []) {
    const item = raw as Partial<IndexedDeletion>
    if (typeof item?.id !== 'string' || item.id === '' || typeof item.at !== 'number' || !Number.isFinite(item.at)) {
      problems.push(`${machine} 的索引里有一条读不出来的删除记录，已跳过`)
      continue
    }
    deleted.push({ id: item.id, at: item.at })
  }
  return {
    machineId: machine,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.pluginVersion === 'string' ? { pluginVersion: value.pluginVersion } : {}),
    entries,
    ...(deleted.length === 0 ? {} : { deleted }),
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
      // 共享对象库那一层与机器格同级，不是一台机器（它的 index.json 是 404，本来就什么都不贡献，
      // 但会显示成"远端机器：attachments"）。
      .filter((entry) => entry.kind === 'collection' && entry.name !== SYNC_ATTACHMENTS_DIR)
      .map((entry) => entry.name)
      // 集合名来自远端：`..` 会让后面的 index 路径跑到命名空间外面；正常机器格名由
      // `machineDirName()` 编出来，不会长成这样。
      .filter((name) => name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'))
      .sort()
  } catch (error) {
    problems.push(`列远端 ${SYNC_NAMESPACE_DIR}/ 失败：${error instanceof Error ? error.message : String(error)}`)
    return { machines, entries, indexes, problems }
  }
  /*
   * 先把所有格子的 `index.json` 一起读出去。每台机器的格子是独立对象，读一份的往返（跨公网时几百毫秒）
   * 不该叠在下一份前面；一台机器的格子通常不到十份，一次性发出去不会把远端压垮。
   *
   * 读回来之后仍按 `machines` 的顺序合并：同一 id 在多格出现时，"谁领先"的判据（代次关系、字节数、
   * 活动时间、格子名兜底）依赖固定的遍历顺序，并发只省等待，不改结果。
   */
  type IndexRead = { dirName: string; text: string } | { dirName: string; error: unknown }
  const reads = await Promise.all(
    machines.map(async (dirName): Promise<IndexRead> => {
      try {
        const bytes = await dav.get(`${SYNC_NAMESPACE_DIR}/${dirName}/${SYNC_INDEX_FILE}`, {
          maxBytes: MAX_INDEX_TEXT_BYTES,
        })
        if (bytes.length > MAX_INDEX_TEXT_BYTES) {
          return {
            dirName,
            error: new Error(`索引 ${bytes.length} 字节，超过上限 ${MAX_INDEX_TEXT_BYTES}`),
          }
        }
        return { dirName, text: bytes.toString('utf8') }
      } catch (error) {
        return { dirName, error }
      }
    }),
  )
  for (const read of reads) {
    const { dirName } = read
    if ('error' in read) {
      // 404 = 这台机器还没推送过内容（或推送了一半）：不算问题，它这次不贡献任何会话。
      if ((read.error as { status?: number } | null)?.status === 404) continue
      problems.push(
        `读远端 ${dirName}/${SYNC_INDEX_FILE} 失败：${read.error instanceof Error ? read.error.message : String(read.error)}`,
      )
      continue
    }
    const index = parseIndex(read.text, dirName, problems)
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
      // 同代次、内容不同时先看字节数（追加写的日志里更长的就是更新的），比不出长短才退回活动时间。
      const longer = relationNow === 'diverged' ? longerSide(full.files, existing.files) : 'unknown'
      const leading =
        relationNow === 'local-ahead' ||
        (relationNow === 'diverged' &&
          (longer === 'local' || (longer === 'unknown' && newerSide(remoteActiveAt(full), remoteActiveAt(existing)) === 'local')))
      if (leading) entries.set(entry.id, full)
    }
  }
  return { machines, entries, indexes, problems }
}

/**
 * 一台机器格的 `index.json` 正文。
 *
 * 推送、整理两处都写这一份东西，形状必须一致（`parseIndex()` 只认这一种）：谁写都经过这里，免得一边
 * 加了字段、另一边漏掉，远端出现两份长得不一样的索引。
 */
export function indexPayload(
  deps: RemoteCopiesPort,
  entries: RemoteIndex['entries'],
  deleted: readonly IndexedDeletion[] = [],
): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        unit: SYNC_INDEX_UNIT,
        version: SYNC_INDEX_VERSION,
        machineId: deps.settings.machineId,
        updatedAt: (deps.now?.() ?? new Date()).toISOString(),
        ...(deps.pluginVersion === undefined ? {} : { pluginVersion: deps.pluginVersion }),
        entries,
        // 墓碑只在有东西时才写：没有删过任何会话的机器，索引形状与这一天之前逐字节相同。
        ...(deleted.length === 0 ? {} : { deleted }),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
}
