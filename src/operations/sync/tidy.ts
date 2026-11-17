// 整理远端：连通性探测，以及清理孤儿包与失效索引条目。
//
// @module dsh-session-manager/operations/sync/tidy

import type { DavPort } from './dav.ts'
import { encodeSegment } from '../../shared/paths.ts'
import { type FileFingerprint, relation } from './fingerprint.ts'
import { type RemoteLibrary, readRemoteLibrary, remoteBundlePath, machineDirName, remoteIndexPath, indexPayload, SYNC_NAMESPACE_DIR, SYNC_BUNDLE_EXT } from './index.ts'
import { SYNC_ATTACHMENTS_DIR } from './attachments.ts'
import { longerSide, type SyncDeps } from './sync.ts'
import type { ProgressReporter, ProgressEvent } from '../../shared/types.ts'

/** 整理远端时的一条：自己那一格里哪个包可以删、留下的那份在哪一格。 */
export interface TidyEntry {
  id: string
  /** 留下来的那份所在的格子（报告里指名）。 */
  machine: string
  /** `duplicate` = 另一格那份与这一份一模一样；`superseded` = 另一格那份更全。 */
  reason: 'duplicate' | 'superseded'
  /** 这一份在索引里记的代次字节数之和（给界面报"约多少 MB"）。 */
  bytes: number
}

/** 一次整理要删的东西（只涉及这台机器自己那一格）。 */
export interface TidyPlan {
  entries: TidyEntry[]
  bytes: number
}

/** 整理远端那一步的结果。 */
export interface SyncTidyResult {
  /** 删掉的重复 / 被取代的包。 */
  removed: number
  /** 顺手清掉的"索引里没有"的包。 */
  orphans: number
  /** 删掉的字节数（索引里记的代次字节数 + 孤儿包的文件大小）。 */
  bytes: number
}

/**
 * 算出「这台机器自己那一格里哪些包是多余的」。
 *
 * 远端是一机一格，同一条会话可能同时存在于几格（A 推过、B 拉下来继续写又推过）。合并视图只挑一份，
 * 其余的包没人再读、却一直占着远端。整理就是各机器删掉自己那一格里的多余副本。
 *
 * 规则（每台机器只清自己那一格，且两台机器算出来的是同一份答案）：
 * - 另一格有一份代次超集的（`local-ahead`）→ 本机这份是被取代的旧副本，删；
 * - 另一格有一份一模一样的 → 只留格子名排序最靠前的那个格子，名字靠后的机器各自删自己那一格；
 * - 两边各自写过（`diverged`）→ 不动，留给用户裁决。
 *
 * 为什么排序用码位比较而不是拼写习惯：`machines` 那份列表就是按 `.sort()` 排的，两处用同一套比较，
 * 两台机器才算出同一个"谁留下"。判断不是对称的就会互相删，最后远端一份都没有。
 *
 * @param remote 读回来的远端库（各机器格的索引都在 `indexes` 里）。
 * @param machineId 这台机器的标识（它那一格的目录名由 `machineDirName()` 算）。
 * @returns 要删的条目与它们的字节数合计；自己那一格还没建时是空的。
 */
export function planTidy(remote: RemoteLibrary, machineId: string): TidyPlan {
  const mine = machineDirName(machineId)
  const index = remote.indexes.get(mine)
  if (index === undefined) return { entries: [], bytes: 0 }
  /** 同一个 id 在别的格子里的副本。 */
  const rivals = new Map<string, Array<{ machine: string; files: FileFingerprint[] }>>()
  for (const [machine, other] of remote.indexes) {
    if (machine === mine) continue
    for (const entry of other.entries) {
      const list = rivals.get(entry.id)
      const item = { machine, files: entry.files }
      if (list === undefined) rivals.set(entry.id, [item])
      else list.push(item)
    }
  }
  const entries: TidyEntry[] = []
  let bytes = 0
  for (const entry of index.entries) {
    const others = rivals.get(entry.id)
    if (others === undefined) continue
    const size = entry.files.reduce((sum, file) => sum + file.bytes, 0)
    /*
     * "被取代"有两种：别的格子那份代次是超集（结构性），或者同代次但更长（日志只追加，更长就是续写
     * 过的）。后者与 `readRemoteLibrary()` 合并两格副本时那条判据同源——两处要认同一件事，否则会出现
     * "合并时挑中它、整理时又觉得自己的更好"这种两边都不删的死角。
     */
    const superseded = others.find(
      (other) =>
        relation(other.files, entry.files) === 'local-ahead' || longerSide(other.files, entry.files) === 'local',
    )
    if (superseded !== undefined) {
      entries.push({ id: entry.id, machine: superseded.machine, reason: 'superseded', bytes: size })
      bytes += size
      continue
    }
    const same = others.filter((other) => relation(entry.files, other.files) === 'identical')
    if (same.length === 0) continue
    const keep = same.map((other) => other.machine).sort()[0] as string
    if (mine < keep) continue
    entries.push({ id: entry.id, machine: keep, reason: 'duplicate', bytes: size })
    bytes += size
  }
  return { entries, bytes }
}

/** 只整理远端（不拉不推）跑出来的结果。 */
export interface TidyOutcome {
  /** 真删了没有（`apply: false` 只是读一遍远端、算一遍账）。 */
  applied: boolean
  /** 账目：`applied: false` 是"将要删的"，`applied: true` 是"实际删掉的"。 */
  tidy: SyncTidyResult
  /** 读远端、写索引、删包时的失败（单条失败不中断整趟）。 */
  problems: string[]
}

/**
 * 只整理远端：删掉自己那一格里多余的包，不拉取、不推送、不动本机任何会话。
 *
 * 与同步落地里那一步（`applyPreparedSync()` 的 `tidy` 分支）共用判据与顺序，区别只有一点：这里不扫
 * 本机库、不算计划——清理不该逼着人先跑一趟完整同步。
 *
 * 顺序照旧是先写索引再删包：中途失败最多留下几个没人引用的包（下一次整理按孤儿清掉），不会留下指向空
 * 文件的条目；索引写失败就一个包都不删。
 *
 * @param deps 远端与同步设置（本机库那几项这条路用不到）。
 * @param options.apply 为 false 只读远端、算账（界面拿它显示"将删 N 个"）。
 * @param options.onProgress 每开始删一个包报一次（段名 `tidy`）。
 * @returns 账目与失败；单条失败只记进 `problems`，不半路放弃。
 */
export async function runTidy(
  deps: SyncDeps,
  options: { apply: boolean; onProgress?: ProgressReporter },
): Promise<TidyOutcome> {
  const problems: string[] = []
  const emit = (event: Omit<ProgressEvent, 'what'>): void => {
    options.onProgress?.(deps.progressWhat === undefined ? event : { ...event, what: deps.progressWhat })
  }
  const remote = await readRemoteLibrary(deps.dav, deps.settings)
  problems.push(...remote.problems)
  const plan = planTidy(remote, deps.settings.machineId)
  const ownDir = machineDirName(deps.settings.machineId)
  const own = remote.indexes.get(ownDir)
  // 已知的包 = 索引里留下的 + 这一趟正要删的（少算后一半，刚删掉的会又被当成孤儿删一遍）。
  let orphans: Array<{ name: string; bytes: number }> = []
  try {
    orphans = await orphanBundles(
      deps.dav,
      deps.settings.machineId,
      new Set([...(own?.entries ?? []).map((entry) => entry.id), ...plan.entries.map((entry) => entry.id)]),
    )
  } catch (error) {
    problems.push(`整理远端：列自己那一格失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const total = plan.entries.length + orphans.length
  const bytes = plan.bytes + orphans.reduce((sum, orphan) => sum + orphan.bytes, 0)
  if (!options.apply) {
    return { applied: false, tidy: { removed: plan.entries.length, orphans: orphans.length, bytes }, problems }
  }
  if (total === 0) return { applied: true, tidy: { removed: 0, orphans: 0, bytes: 0 }, problems }

  // 先把要删的条目从自己那格的索引里摘掉：这一步失败就一个包都不删。
  if (own !== undefined) {
    const drop = new Set(plan.entries.map((entry) => entry.id))
    try {
      await deps.dav.put(
        remoteIndexPath(deps.settings.machineId),
        indexPayload(
          deps,
          own.entries.filter((entry) => !drop.has(entry.id)),
          own.deleted ?? [],
        ),
      )
    } catch (error) {
      problems.push(
        `整理远端：写自己那一格的索引失败，这次一个包都没删：${error instanceof Error ? error.message : String(error)}`,
      )
      return { applied: true, tidy: { removed: 0, orphans: 0, bytes: 0 }, problems }
    }
  }

  let removed = 0
  let orphansRemoved = 0
  let done = 0
  for (const entry of plan.entries) {
    // 没有本机库可查，标题取不到：进度那行小字只能给 id。
    emit({ phase: 'tidy', total, done, id: entry.id })
    try {
      await deps.dav.delete(remoteBundlePath(deps.settings.machineId, entry.id))
      removed += 1
    } catch (error) {
      problems.push(`整理远端：删 ${entry.id} 的旧包失败：${error instanceof Error ? error.message : String(error)}`)
    }
    done += 1
  }
  for (const orphan of orphans) {
    emit({ phase: 'tidy', total, done, id: orphan.name })
    try {
      await deps.dav.delete(`${SYNC_NAMESPACE_DIR}/${ownDir}/${orphan.name}`)
      orphansRemoved += 1
    } catch (error) {
      problems.push(`整理远端：删 ${orphan.name} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    done += 1
  }
  return { applied: true, tidy: { removed, orphans: orphansRemoved, bytes }, problems }
}

/**
 * 预演里报给界面的整理账目：能删几个包、多少字节。
 *
 * 只报数不列清单：界面那一个勾选框只需要"有多少"，真要逐条看的话用 `planTidy()` 自己算一份。
 */
export function tidySummary(remote: RemoteLibrary, machineId: string): { count: number; bytes: number } {
  const plan = planTidy(remote, machineId)
  return { count: plan.entries.length, bytes: plan.bytes }
}

/**
 * 自己那一格里没有索引条目的包（上一次推送或整理中断留下的）。
 *
 * 只报文件名：它们在索引里没有条目，删掉不会让任何机器拉到一个 404。
 */
export async function orphanBundles(
  dav: DavPort,
  machineId: string,
  ids: ReadonlySet<string>,
): Promise<Array<{ name: string; bytes: number }>> {
  const cell = `${SYNC_NAMESPACE_DIR}/${machineDirName(machineId)}`
  let listed
  try {
    listed = await dav.list(cell)
  } catch {
    return []
  }
  const known = new Set([...ids].map((id) => `${encodeSegment(id)}${SYNC_BUNDLE_EXT}`))

  return listed
    .filter((entry) => entry.kind === 'file' && entry.name.endsWith(SYNC_BUNDLE_EXT) && !known.has(entry.name))
    .map((entry) => ({ name: entry.name, bytes: entry.bytes ?? 0 }))
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
    // 共享对象库那一层与机器格同级，不是一台机器——与 `readRemoteLibrary()` 同一条过滤。这里漏掉的话
    // 只要远端有过一个附件对象，「测试连接」就会念成"机器：robot-a、attachments"。
    .filter((entry) => entry.kind === 'collection' && entry.name !== SYNC_ATTACHMENTS_DIR)
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
