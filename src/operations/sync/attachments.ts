// 附件对象在远端共享库里的搬运：清单、取回、上传、修缺口。
//
// 包本身只带日志；对象按内容寻址放在 `attachments/<前两位>/<id>`，两台机器共用一份——推送只补远端缺的、
// 拉取只取本机缺的。同步不把对象塞进包里：自动推送每写完一轮就重推一次，塞进包里会让一辈子不变的
// 字节被反复上传。
//
// @module dsh-session-manager/operations/sync/attachments

import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { commitAttachmentObjectAsync, isImportedSessionLog, scanAttachmentRefs, type AttachmentPort, type AttachmentRef } from '../../shared/attachments.ts'
import type { DiscoveredSession } from '../../shared/library/discovery.ts'
import { decodeLogTextChunked } from '../../shared/log/log-decode.ts'
import { type RemoteLibrary, type RemoteIndex, SYNC_NAMESPACE_DIR, type IndexedAttachment } from './index.ts'
import type { SessionLogFile } from '../../shared/types.ts'
import { type SessionBundle, entryBytes, attachmentActionOf, type ImportOutcome } from '../transfer/transfer.ts'
import type { SyncDeps } from './sync.ts'

/**
 * 远端**共享**对象库的目录名（与机器格同级）。
 *
 * 对象是内容寻址、写完就不改的，所以两台机器共用一个：同一条会话被两台机器各推一次、同一张图被多条
 * 会话引用，远端都只留一份。同步**不把对象塞进包里**（包照旧只有日志）：同步是"一条会话一个包"，而
 * 自动推送每写完一轮就重推一次，塞进包里的话那些一辈子不变的字节会被反复上传一遍。
 *
 * 这个名字是**保留的**：列机器格时跳过它，否则远端会多出一台叫 `attachments` 的"机器"。
 */
export const SYNC_ATTACHMENTS_DIR = 'attachments'

/** 对象 id 里那 64 位十六进制（远端目录按它的前两位分成子目录，与本机附件库同形）。 */
function attachmentHex(ref: AttachmentRef): string {
  return ref.id.slice('sha256:'.length)
}

/** 索引里那一项 ↔ 内存里的引用（`bytes` 不往返：索引里不存它）。 */
export function indexedAttachmentOf(ref: AttachmentRef): IndexedAttachment {
  return { kind: ref.kind, id: ref.id, ...(ref.name === undefined ? {} : { name: ref.name }) }
}

/** 索引里那一项读回内存里的引用（清单里没有 `bytes`，判"本机在不在"时退回看文件）。 */
function attachmentRefOfIndexed(item: IndexedAttachment): AttachmentRef {
  return { kind: item.kind, id: item.id, ...(item.name === undefined ? {} : { name: item.name }) }
}

/** 对象在远端共享库里的路径（相对资源根）。 */
export function remoteAttachmentPath(ref: AttachmentRef): string {
  return `${remoteAttachmentDir(ref)}/${attachmentHex(ref)}`
}

/** 对象所在的那一层目录（`list()` 一次就把这一层已有的对象名全拿到）。 */
export function remoteAttachmentDir(ref: AttachmentRef): string {
  const library = ref.kind === 'image' ? 'objects' : 'file-objects'
  const hex = attachmentHex(ref)
  return `${SYNC_NAMESPACE_DIR}/${SYNC_ATTACHMENTS_DIR}/${library}/${hex.slice(0, 2)}`
}

/**
 * 一条日志文件扫出来的附件引用（键：路径；失效判据：`size + mtimeMs`）。
 *
 * 为什么要有它：补对象那一步要为整库每条会话扫一遍日志，而"扫出哪些附件"只取决于文件内容；日志只在
 * 会话被写时才变。没有缓存时每点一次「同步」都把 1.2 GB 日志整份解压（实测 144 秒），有缓存之后同一份
 * 文件只解一次——第二次同步、自动推送之后的补扫都直接命中。
 *
 * `imported` 与引用一起缓存：同一份文本上判"这是不是导入会话"（见 `isImportedSessionLog()`）只是多
 * 一遍子串搜索，不该在第二次同步时再付一次。
 *
 * 上限按文件数（与指纹缓存同一量级）；超了整份丢掉重来，不做 LRU：这里的键只是路径，丢了最多再解一遍。
 */
const attachmentRefCache = new Map<string, ScannedLog>()

/** 附件引用缓存最多记多少个文件。 */
const ATTACHMENT_REF_CACHE_MAX = 4096

/** 一份日志的解码结论：引用了什么，以及它是不是导入会话。 */
export interface ScannedLog {
  stamp?: string
  refs: AttachmentRef[]
  /** 这条日志是不是 DeepSeek 官网导出导入的会话（见 `isImportedSessionLog()`）。 */
  imported: boolean
}

/** 附件引用缓存的形状（测试要 "每一轮互不影响" 时注入一份新的）。 */
export type AttachmentRefCache = Map<string, ScannedLog>

/** 新建一份附件引用缓存（测试用；生产用进程里那一份）。 */
export function createAttachmentRefCache(): AttachmentRefCache {
  return new Map()
}

/**
 * 一条会话在磁盘上的日志引用了哪些对象（推送与补对象两处都要的那些）。
 *
 * 与导出那条路共用同一套扫描（`scanAttachmentRefs()`：整篇字符串预筛、命中才逐行解析，按 `kind:id`
 * 去重）：包不带对象，所以这份引用只用来决定"远端共享库里还缺哪些"。
 *
 * **分块解压**（`decodeLogTextChunked()`：128 KB 一块、块间让出事件循环）：本机最大的一份日志压缩后
 * 16.8 MB、解开 48 MB，整份一次解会把宿主按住两秒多——而这个函数要为整库每条会话的每个代次调用一次。
 *
 * **结果按文件缓存**（`size + mtimeMs`）：同一份文件在这次进程里只解一次。没有缓存时每点一次同步都要
 * 把整库解压一遍（本机 1.2 GB、144 秒），缓存之后第二次同步接近 0。
 *
 * @param files 这条会话的代次文件。
 * @param cache 缓存；缺省是进程里那一份（键：路径）。
 * @returns 去重后的引用，以及这条会话是不是导入的（任一代次带上导入来源即算）。
 */
export async function attachmentRefsOfFiles(
  files: readonly SessionLogFile[],
  cache: AttachmentRefCache = attachmentRefCache,
): Promise<{ refs: AttachmentRef[]; imported: boolean }> {
  const found = new Map<string, AttachmentRef>()
  let imported = false
  for (const file of files) {
    const scanned = await attachmentRefsOfFile(file, cache)
    if (scanned.imported) imported = true
    for (const ref of scanned.refs) found.set(`${ref.kind}:${ref.id}`, ref)
  }
  return { refs: [...found.values()], imported }
}

/** 一个文件里扫出来的引用与导入标记；命中缓存就直接给。 */
export async function attachmentRefsOfFile(file: SessionLogFile, cache: AttachmentRefCache): Promise<ScannedLog> {
  let stamp: string | undefined
  try {
    const info = statSync(file.path)
    stamp = `${String(info.size)}:${String(info.mtimeMs)}`
  } catch {
    // 读不到戳（文件刚被删 / 换掉）：直接解一遍，不往缓存里写一个来历不清的答案。
  }
  const hit = stamp === undefined ? undefined : cache.get(file.path)
  if (hit !== undefined && hit.stamp === stamp) return hit
  const bytes = await readFile(file.path)
  const text = await decodeLogTextChunked(bytes, file.compression)
  const scanned: ScannedLog = { refs: scanAttachmentRefs(text), imported: isImportedSessionLog(text) }
  if (stamp !== undefined) {
    const entry = { ...scanned, stamp }
    if (cache.size >= ATTACHMENT_REF_CACHE_MAX && !cache.has(file.path)) cache.clear()
    cache.set(file.path, entry)
    return entry
  }
  return scanned
}

/**
 * 一个包里的日志引用了哪些对象（拉取那一侧要取的那些）。
 *
 * 从**包里的字节**读，不读本机那份：拉取与"覆盖本机"这两条路上，本机那份要么还不存在、要么正要被换
 * 掉。包是自校验过的（`readBundle()` 逐条核过偏移与 sha256），所以这里的偏移一定落在载荷内。
 *
 * 包自己带来的对象（v2 的包：旧版本推送的，或别人手工放进来的）从这份名单里摘掉——它们由导入那条
 * 路随包应用，共享库里没有它们，去那儿取只会白跑一趟并报一串假问题。
 */
export async function attachmentRefsOfBundle(
  bundle: SessionBundle,
): Promise<{ refs: AttachmentRef[]; imported: boolean }> {
  const packed = new Set(bundle.attachments.map((entry) => `${entry.kind}:${entry.id}`))
  const found = new Map<string, AttachmentRef>()
  let imported = false
  for (const session of bundle.sessions) {
    for (const file of session.files) {
      const text = await decodeLogTextChunked(entryBytes(bundle, file), file.compression)
      if (isImportedSessionLog(text)) imported = true
      for (const ref of scanAttachmentRefs(text)) {
        const key = `${ref.kind}:${ref.id}`
        if (!packed.has(key)) found.set(key, ref)
      }
    }
  }
  return { refs: [...found.values()], imported }
}

/**
 * 远端这一层已有的对象名（`list()` 一次就把那一层全部名字给回来）。
 *
 * 一次同步里每个前缀只列一次并缓存：推送与"补对象"两步共用同一份，问过的层不会问第二遍。
 *
 * @returns 名字集合；`undefined` = 这一次列失败（已经记进 `problems`），调用方跳过这个对象。
 */
export async function remoteObjectNamesIn(
  deps: SyncDeps,
  listed: Map<string, Set<string>>,
  ref: AttachmentRef,
  problems: string[],
): Promise<Set<string> | undefined> {
  const dir = remoteAttachmentDir(ref)
  const cached = listed.get(dir)
  if (cached !== undefined) return cached
  try {
    const entries = await deps.dav.list(dir)
    const names = new Set(entries.filter((entry) => entry.kind === 'file').map((entry) => entry.name))
    listed.set(dir, names)
    return names
  } catch (error) {
    problems.push(`列远端 ${dir} 失败：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 引用某个对象的那几条会话（会话 id → 标题）。
 *
 * "本机与远端都没有"这件事要报两样东西：少了几个对象（数），以及是哪几条会话在用它们（谁）。对象是
 * 内容寻址的、一张图常被几条会话共用，所以最后要按会话折一次——见 `summarizeAbsent()`。
 */
export type AttachmentOwners = Map<string, string | undefined>

/**
 * 本机要、远端共享库里也没有的那些对象（键 `kind:id`），每个记着引用它的会话。
 *
 * 为什么不是一个纯 id 集合：那句汇总说得清"几个对象"，说不清"哪条会话"，而用户要处置的正是后者
 * （去持有这些对象的机器上把这几条推上来）。
 */
export type AbsentObjects = Map<string, AttachmentOwners>

/** 记一个"两边都没有"的对象；同一个对象被几条会话引用时把会话并进来。 */
export function noteAbsent(absent: AbsentObjects, ref: AttachmentRef, owners: AttachmentOwners): void {
  const key = `${ref.kind}:${ref.id}`
  const found = absent.get(key)
  if (found === undefined) {
    absent.set(key, new Map(owners))
    return
  }
  for (const [id, title] of owners) {
    if (found.get(id) === undefined) found.set(id, title)
  }
}

/**
 * 把"两边都没有"的那些对象折成一句汇总要用的两个数：对象数与会话清单（按缺的个数从多到少）。
 *
 * @param absent 这一轮攒下来的对象。
 * @returns 对象数与逐条会话（`count` 是这条会话引用的、去重后的对象个数）。
 */
export function summarizeAbsent(absent: AbsentObjects): {
  objects: number
  sessions: AbsentAttachmentSession[]
} {
  const per = new Map<string, { title?: string; count: number }>()
  for (const owners of absent.values()) {
    for (const [id, title] of owners) {
      const found = per.get(id)
      if (found === undefined) {
        per.set(id, { ...(title === undefined ? {} : { title }), count: 1 })
        continue
      }
      found.count += 1
      if (found.title === undefined && title !== undefined) found.title = title
    }
  }
  const sessions: AbsentAttachmentSession[] = [...per].map(([sessionId, item]) => ({
    sessionId,
    ...(item.title === undefined ? {} : { title: item.title }),
    count: item.count,
  }))
  sessions.sort((left, right) => right.count - left.count || (left.sessionId < right.sessionId ? -1 : 1))
  return { objects: absent.size, sessions }
}

/**
 * 从共享库取一个对象应用（调用方已经确认远端有它）。
 *
 * 字节照导入那条路的规格应用：`commitAttachmentObject()` 先写 `.part` 再 rename、`0o400`；本机已经有了
 * 的算 `present`（同一个对象被多条会话引用时只真写一次）。单个对象取不回来只记问题：一个对象缺失不该
 * 把整条会话挡在库外，与导入同一条标准。
 *
 * @param ignoreAbsent 这条会话是导入的（见 `isImportedSessionLog()`）：远端也没有时不记账。导入器给
 *   非图片文件写的是合成的引用，字节从来没进过任何库，报出来也没有处置动作（没有哪台机器持有它们）。
 */
export async function fetchAttachment(
  deps: SyncDeps,
  port: AttachmentPort,
  ref: AttachmentRef,
  counters: SyncAttachmentIn,
  problems: string[],
  absent: AbsentObjects,
  owners: AttachmentOwners,
  ignoreAbsent = false,
): Promise<void> {
  const path = port.pathOf(ref)
  if (path === undefined) {
    problems.push(`宿主容不下附件 ${ref.id}（${ref.kind}），这一个没能从远端取回`)
    return
  }
  try {
    const bytes = await deps.dav.get(remoteAttachmentPath(ref))
    if ((await commitAttachmentObjectAsync(path, bytes)) === 'present') counters.present += 1
    else {
      counters.written += 1
      counters.bytes += bytes.length
    }
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 404) {
      // 「远端也没有」不是错误，是"持有这些对象的机器还没推送它们"这一种状态：按**会话**记一笔，
      // 收尾汇总成一句（一个会话引用几十张图时，逐条对象报会把问题清单淹掉，而它们要的处置是同一件事）。
      // 导入会话除外：那种引用没有字节可等（见上面的 `ignoreAbsent`）。
      if (!ignoreAbsent) noteAbsent(absent, ref, owners)
      return
    }
    problems.push(`取附件 ${ref.id} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 从远端共享库取回这条会话缺的对象。
 *
 * 本机已有的（`attachmentActionOf()` 说 `present`）一个字节都不取——这是这条路存在的意义之一：换台
 * 机器拉同一批会话时，两台机器共用的那张图只传一次。
 *
 * @param owners 这些对象属于哪条会话（远端也没有的那些按它点名，见 `noteAbsent()`）。
 * @param imported 这条会话是导入的：远端也没有的对象不记账（同 `fetchAttachment()` 的 `ignoreAbsent`）。
 */
export async function pullAttachments(
  deps: SyncDeps,
  port: AttachmentPort,
  refs: readonly AttachmentRef[],
  counters: SyncAttachmentIn,
  problems: string[],
  absent: AbsentObjects,
  owners: AttachmentOwners,
  report?: AttachmentReporter,
  imported = false,
): Promise<void> {
  // 本机已经有的那些只记个数、不进分母（同上：不花时间的条数不进分母）。
  const pending: AttachmentRef[] = []
  for (const ref of refs) {
    if (attachmentActionOf(port, ref) === 'present') counters.present += 1
    else pending.push(ref)
  }
  for (const [index, ref] of pending.entries()) {
    report?.(index, pending.length, ref)
    await fetchAttachment(deps, port, ref, counters, problems, absent, owners, imported)
  }
}

/**
 * 把导入那条路落下的**随包对象**记进这次同步的对象账。
 *
 * 这一版推送的包只有日志（对象走共享库），但远端那份包可能是 v2 的（旧版本推的、别人手工放上去的）：
 * 那种包的对象由 `applyImport()` 应用，不经过下面这条共享库的路。两边都记同一本账，界面那句「另取回
 * 附件对象 N 个」才对得上这一次到底搬了几个。
 */
export function countPackedAttachments(outcome: ImportOutcome, counters: SyncAttachmentIn): void {
  counters.written += outcome.attachmentWritten
  counters.present += outcome.attachmentPresent
  counters.bytes += outcome.attachmentBytes
}

/**
 * 把这条会话引用到的对象补进远端共享库（远端已有的一个字节都不传）。
 *
 * 对象是内容寻址的，"远端已经有这个名字"就等于"内容一模一样"，不必再比大小、也不必先 `ensure()`
 * （`put()` 自己把父集合建出来）。
 *
 * 本机库里没有的对象（引用在、字节不在）算 `missing`：与导出那枚响应头同一个交代——用户需要知道
 * "这次有几张图没能带走"，而不是等到了另一台机器上才发现图挂了。
 */
/**
 * 上报"正在处理第几个附件对象"。
 *
 * 相位名与导入那条路一样（`attach`），界面那个进度块两种动作共用 `progress.attach` 那一句。同步这条
 * 以前只有**会话级**的进度：对象是在某一条会话的步骤里传的（补对象那一趟更是整库尺度），一条会话几十
 * 张图时，界面会停在同一行上几分钟不动——而"传了多少"恰恰是那一趟唯一在变的东西。
 *
 * `total` 数的是"要看过的对象"（含远端已有、本机已缺那几种只需核一下的），不是"要传的字节"：分母与
 * 分子同标准，条才会匀速走。
 *
 * @param done 从 0 开始的序号（界面按 `done + 1` 说"正在处理第几个"，与另外几段同一个标准）。
 * @param total 这一批要看的对象总数。
 * @param ref 当前这一个（界面只拿它当 key，认得出是哪个对象）。
 */
export type AttachmentReporter  = (done: number, total: number, ref: AttachmentRef) => void

export async function pushAttachments(
  deps: SyncDeps,
  port: AttachmentPort,
  refs: readonly AttachmentRef[],
  listed: Map<string, Set<string>>,
  counters: SyncAttachmentOut,
  problems: string[],
  report?: AttachmentReporter,
): Promise<void> {
  // 先分拣一遍：本机没有的那些（`missing`）与远端已经有的那些（`skipped`）都**不进分母**——它们不花
  // 时间，算进去进度条就走不满（同一条规矩，见 [同步进度走 SSE](../../../.agents/notes/implemented/architecture/2026-10-03-sync-progress-streams-over-sse.md)）。
  // 这一遍只 stat 不读字节：真要传的那几个留到下一遍再读，内存里不必压着一份整库的对象。
  const pending: AttachmentRef[] = []
  for (const ref of refs) {
    const path = port.pathOf(ref)
    if (path === undefined || !existsSync(path)) {
      counters.missing += 1
      continue
    }
    const names = await remoteObjectNamesIn(deps, listed, ref, problems)
    if (names === undefined) continue
    if (names.has(attachmentHex(ref))) {
      counters.skipped += 1
      continue
    }
    pending.push(ref)
  }
  for (const [index, ref] of pending.entries()) {
    report?.(index, pending.length, ref)
    const path = port.pathOf(ref)
    let bytes: Buffer
    try {
      bytes = await readFile(path as string)
    } catch {
      counters.missing += 1
      continue
    }
    const names = await remoteObjectNamesIn(deps, listed, ref, problems)
    if (names === undefined) continue
    try {
      await deps.dav.put(remoteAttachmentPath(ref), bytes)
      names.add(attachmentHex(ref))
      counters.uploaded += 1
      counters.bytes += bytes.length
    } catch (error) {
      problems.push(`推送附件 ${ref.id} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 补对象：把本机与远端共享库对齐（两个方向都做）。
 *
 * 计划按**日志**的指纹判"两边一样"，对象却不在那个判据里，于是有两类会话它一条都不会动——而它们恰恰
 * 是这台机器上"图挂了"的全部来路：
 *
 *  - **本机缺**：这条会话是早先拉过来的（那时对象还不会跟着同步走）→ 远端有就取回来；
 *  - **远端缺**：这条会话是旧版本推送的（那时的包只有日志）→ 本机有就传上去。
 *
 * 两条都只发生在"日志两边一样、谁也没打算动这条会话"的情形里，所以放在这里，而不是塞进计划：计划改动
 * 一条会话意味着写日志、改注册表那一整套，而这两件事一个字节的日志都不动。
 *
 * 只在**手动同步**时做（后台那条只推不拉的路不跑）：这一步要把本机带引用的日志都解开扫一遍，是整库
 * 尺度的开销——值得花在"用户点了同步"这一次上，不值得每写完一轮就花一次。远端也没有的那些只汇总成
 * 一句（逐条报会把问题清单淹掉）。
 *
 * @param handled 这次已经拉取 / 覆盖 / 推送过的会话（它们那两条路自己处理过对象了）。
 * @param known 远端索引里认得的会话 id：本机有、远端却不认得的那些不替它往共享库传对象（那条会话压根
 *   还没同步过，凭什么占远端的空间）。
 */
export async function repairAttachments(
  deps: SyncDeps,
  port: AttachmentPort,
  local: readonly DiscoveredSession[],
  handled: ReadonlySet<string>,
  remote: RemoteLibrary,
  /** 这一趟判成"两边一样"的会话：只有它们能用远端条目里记的附件清单。 */
  identical: ReadonlySet<string>,
  /** 自己那一格的条目（补记附件清单时写回）。 */
  ownedEntries: Map<string, RemoteIndex['entries'][number]>,
  ownDirName: string,
  listed: Map<string, Set<string>>,
  incoming: SyncAttachmentIn,
  outgoing: SyncAttachmentOut,
  problems: string[],
  absent: AbsentObjects,
  onScan?: (done: number, total: number, id: string, label?: string) => void,
  report?: AttachmentReporter,
): Promise<boolean> {
  /** 本机缺的那些（远端有就取回来）。 */
  const wanted = new Map<string, AttachmentRef>()
  /** 每个"本机缺"的对象被哪几条会话引用（远端也没有时按它点名，见 `noteAbsent()`）。 */
  const wantedOwners = new Map<string, AttachmentOwners>()
  /** 本机有、远端索引里也认得这条会话的对象（远端缺就传上去）。 */
  const extra = new Map<string, AttachmentRef>()
  /**
   * 判过、确实是导入会话的那些 id（见 `isImportedSessionLog()`）。
   *
   * 只为"真有本机缺对象"的会话去判：判据要读日志，而整库那些对象齐的会话不该为它多解一遍。
   */
  const importedSessions = new Set<string>()
  /** 已经问过"是不是导入"的会话（问过的不再问，避免同一趟里重复解码）。 */
  const checkedImports = new Set<string>()
  /** 这一趟补记进自己索引的条目数（收尾时据此决定要不要再写一次索引）。 */
  let learned = 0
  const candidates = local.filter((session) => !handled.has(session.id))
  for (const [index, session] of candidates.entries()) {
    onScan?.(index, candidates.length, session.id, session.title)
    const entry = remote.entries.get(session.id)
    /*
     * 索引里已经记着附件清单、而且这条本机副本与那条记录逐字节一致时，直接用它——这是这件事从
     * "整库解压 144 秒"变成"毫秒"的那一步。不一致就不能用：那条清单描述的是另一份内容。
     */
    const fromIndex =
      entry !== undefined && entry.attachments !== undefined && identical.has(session.id) ? entry.attachments : undefined
    const scanned = fromIndex === undefined ? await attachmentRefsOfFiles(session.files) : undefined
    const refs = scanned?.refs ?? (fromIndex ?? []).map((item) => attachmentRefOfIndexed(item))
    // 引用与导入标记是同一次解码算出来的，走到这里就用掉，别为同一份日志再解一遍。
    if (scanned?.imported === true) importedSessions.add(session.id)
    // 自己那一格的老条目还没有这一项：算过就补上，下一次（重启之后）不必再解一遍。
    if (fromIndex === undefined && entry !== undefined && entry.machine === ownDirName && identical.has(session.id)) {
      const current = ownedEntries.get(entry.id)
      if (current !== undefined) {
        ownedEntries.set(entry.id, {
          ...current,
          attachments: refs.map((ref) => indexedAttachmentOf(ref)),
        })
        learned += 1
      }
    }
    const remoteKnows = remote.entries.has(session.id)
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`
      // 两个集合按"本机有没有"分开，互不重叠：同一个对象不该既算"没取回来"又算"没传上去"。
      if (attachmentActionOf(port, ref) === 'create') {
        wanted.set(key, ref)
        const owners = wantedOwners.get(key) ?? new Map<string, string | undefined>()
        owners.set(session.id, session.title)
        wantedOwners.set(key, owners)
        /*
         * 这条会话缺对象、而引用清单是从索引里拿的（这一趟没解过日志）：到这里才需要知道它是不是导入
         * 的。**只对真有缺口的会话付这一次**——整库那些"两边一样、对象也齐"的会话照旧一个字节都不解。
         */
        if (scanned === undefined && !importedSessions.has(session.id) && !checkedImports.has(session.id)) {
          checkedImports.add(session.id)
          if ((await attachmentRefsOfFiles(session.files)).imported) importedSessions.add(session.id)
        }
      } else if (remoteKnows) extra.set(key, ref)
    }
  }
  if (wanted.size > 0) {
    // 先判"远端有没有"（列一次目录就够），再取：远端也没有的那些只进那句汇总，不算进度里的活。
    const toFetch: AttachmentRef[] = []
    for (const ref of wanted.values()) {
      const key = `${ref.kind}:${ref.id}`
      const owners = wantedOwners.get(key) ?? new Map<string, string | undefined>()
      /*
       * 引用它的会话**全是**导入会话时，这个对象没有字节可等：导入器给非图片文件写的是合成的引用
       * （见 `isImportedSessionLog()`），本机没有、远端也永远不会有人推上来，报出来是一句空等。
       * 只忽略"全都导入"的：同一个对象若还被一条真实会话引用着，那仍然是缺（照旧记账）。
       */
      const ignoreAbsent = owners.size > 0 && [...owners.keys()].every((id) => importedSessions.has(id))
      const names = await remoteObjectNamesIn(deps, listed, ref, problems)
      if (names === undefined) continue
      if (!names.has(attachmentHex(ref))) {
        if (!ignoreAbsent) noteAbsent(absent, ref, owners)
        continue
      }
      toFetch.push(ref)
    }
    for (const [index, ref] of toFetch.entries()) {
      report?.(index, toFetch.length, ref)
      const owners = wantedOwners.get(`${ref.kind}:${ref.id}`) ?? new Map<string, string | undefined>()
      const ignoreAbsent = owners.size > 0 && [...owners.keys()].every((id) => importedSessions.has(id))
      await fetchAttachment(deps, port, ref, incoming, problems, absent, owners, ignoreAbsent)
    }
  }
  // 远端缺的那些交给推送那一段：它自己按前缀列一次、只传远端真没有的（两个方向共用同一份缓存）。
  if (extra.size > 0) {
    await pushAttachments(deps, port, [...extra.values()], listed, outgoing, problems, report)
  }
  return learned > 0
}

/**
 * 这次从远端共享库取回、落进本机附件库的对象。
 *
 * `bytes` 是这些对象的字节数（不含会话日志，`bytesIn` 才是日志那一边）。逐条写不进去的写进
 * `problems`（与会话那边的失败面分开：一个对象取不回来不该把整条会话挡在库外，与导入同一条标准）。
 */
export interface SyncAttachmentIn {
  written: number
  /** 本来就在本机库里的（远端有、本机也有，一个字节都不取）。 */
  present: number
  bytes: number
}

/**
 * 引用了"本机与远端共享库都没有"的对象的一条会话。
 *
 * 那一句汇总只说得出"少了 N 个对象"，说不出是哪条会话——而用户下一步要做的正是"去持有这些对象的
 * 那台机器上把这几条推上来"。所以收尾时按会话折一份，界面（与工具）逐条点名，带「只看这一条」。
 */
export interface AbsentAttachmentSession {
  sessionId: string
  /** 会话标题（读得到时带上；读不到就只报 id）。 */
  title?: string
  /** 这条会话引用的、本机与远端都没有的对象个数（按对象去重）。 */
  count: number
}

/** 这次补进远端共享库的对象。 */
export interface SyncAttachmentOut {
  uploaded: number
  /** 远端本来就有、这次没传的。 */
  skipped: number
  bytes: number
  /** 本机库里有引用、但对象不在本机：这次带不上去（与导出那枚 `missing` 同一个交代）。 */
  missing: number
}
