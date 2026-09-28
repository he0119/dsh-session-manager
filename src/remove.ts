// src/remove.ts — 删除会话的宿主侧编排：预演 / 执行 / （恢复走 journal 的回滚）。
//
// 为什么"删除"要先备份：宿主**没有**删除会话的能力（`dsh-session-persistence` 的 seam 里没有删除
// 接口，见 docs/internals.md），所以这件事只能由本插件动文件系统。一旦自己动手，"删错了"就没有
// 第二道防线了——所以这里把删除做成"先按迁移那套备份，再删"，恢复因此复用「备份与回滚」那条路
// （`journal.rollback()`，见那边的 `BackupKind`），而不需要再造一套回收站。
//
// **注册表一个字节都不动**（登记、归档、置顶都原地留着），这是刻意的：
//   - 宿主自己就把"登记了但日志不在"当作正常状态（`Workspace.sessionIds` 的取值按 header 索引过滤，
//     列会话时未知 id 直接跳过），所以删完不会留下任何"坏"状态；
//   - 反过来，恢复备份时那条会话的登记、归档状态**自动**回到原样，不必再补写一次注册表，
//     也就不会在恢复时把用户之后做的注册表改动覆盖掉。
//
// 与迁移共用同一套预演/确认口径：`plan` 只读、`apply` 才写盘，且计划里 `ok` 不为 true 就拒绝执行。
//
// **子代理跟着父会话走**：点名一条会话，它的**全部后代**（沿 header 的 `parentSession` 找下去）一起删，
// 因为子会话在外壳侧边栏里只挂在父会话的 `subagentCatalog` 下——父的日志一没了，子会话就再没有别的
// 入口，留在盘上只会变成"本插件看得见、侧边栏看不见"的隐形残留。反向（只删子、留着父）不拦，只在
// 预演里点明父会话下面会留一个点不开的条目：孤儿要收拾，而"这条子代理我就是要删掉"也是正当需求。
import { existsSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import { scanAll, type DiscoveredSession } from './discovery.ts'
import { createBackup } from './journal.ts'
import type { TitleQuery } from './session-title.ts'
import type { DecodeAll, SessionLogFile } from './types.ts'

/** 删除用到的路径、解码器与探测口（与 `MigrateDeps` 同形，本模块同样不认识 tools.ts）。 */
export interface RemoveDeps {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
  decodeAll: DecodeAll
  /** 读会话标题（可选，界面按标题认人）。 */
  resolveTitle?: (query: TitleQuery) => string | undefined
  /**
   * 宿主报告"内存里活着"的会话 id（可选，见 `src/index.ts` 的 `liveSessionIds`）。
   *
   * 活着的会话**拒绝删除**：宿主手里有它的内存副本与写句柄，日志被搬走之后它还会继续写、
   * 还会被列在会话列表里（`dsh-session-persistence-jsonl` 的写路径按会话目录定位）。这跟宿主
   * 自己归档一条正在跑的会话会被拒绝是同一件事。
   *
   * 缺席 = 无法判断，按"都不活着"处理（删之前的预演会如实说明这件事）。
   */
  liveSessionIds?: () => ReadonlySet<string>
  /** 注入时间，便于测试。 */
  now?: Date
}

/** 一次删除（或预演）的请求。 */
export interface RemoveRequest {
  /** 要删的会话 id（非空）。 */
  sessionIds: readonly string[]
}

/** 预演里的一条会话。 */
export interface RemoveEntry {
  id: string
  title?: string
  createdAt: number
  /** 会话目录（会被整个删掉）。 */
  dir: string
  files: SessionLogFile[]
  bytes: number
  /** 宿主内存里活着（这些会被预演挡下）。 */
  live: boolean
  /** 日志 header 里的 `origin`（子代理会话写 `subagent`；界面据此挂标签）。 */
  origin?: string
  /**
   * 这条是**级联**带进来的：`via` 是用户点名、把它牵进来的那条祖先会话。
   *
   * 点名的那几条自己没有这个字段——哪怕它同时又是别人的后代（"点名"比"顺带"更该被说出来）。
   */
  via?: { id: string; title?: string }
  /**
   * 这条是子代理，而它的父会话还在库里、又不在这次删除里。
   *
   * 子会话在外壳侧边栏里只挂在父会话的 `subagentCatalog` 下（见 visibility.ts），所以只删子、
   * 留着父，父下面会留下一个点不开的条目。这是**提示而不是拦截**：父会话已经不在库里的孤儿没有
   * 这个问题，而"这条子代理我就是要单独删掉"也是正当需求。
   */
  keptParent?: { id: string; title?: string }
}

/** 删除计划：界面看到的预演结果就是执行时会做的事。 */
export interface RemovalPlan {
  ok: boolean
  problems: string[]
  entries: RemoveEntry[]
  files: number
  bytes: number
  /** 级联带进来的条数（点名之外、跟着父会话一起删的子代理后代）。 */
  cascaded: number
  /** 备份会落在哪（执行时是真实目录；预演时是按当前时间算出来的那一个）。 */
  backupRoot: string
}

/** 执行结果。 */
export interface RemovalRun {
  /** 是否真的删了（dry-run 或计划不 ok 都是 false）。 */
  applied: boolean
  plan: RemovalPlan
  /** 删除后独立复核发现的问题（空数组 = 通过）。 */
  problems: string[]
  verified: boolean
  backupDir?: string
  dirsRemoved: number
  /** 被顺手清掉的空项目目录。 */
  removedProjectDirs: string[]
  summary: string
}

/** 把发现出来的会话按 id 建索引。 */
function indexById(sessions: readonly DiscoveredSession[]): Map<string, DiscoveredSession> {
  const byId = new Map<string, DiscoveredSession>()
  for (const session of sessions) byId.set(session.id, session)
  return byId
}

/** 一条被点名的会话与它牵连出来的后代：`root` 是点名的那一条。 */
interface FamilyMember {
  session: DiscoveredSession
  root: DiscoveredSession
}

/**
 * 点名几条会话 → 要一起删的**整族**。
 *
 * 顺序：点名的在前（按请求顺序），随后是各自的后代（按层展开），全局去重。这是**向下**的
 * （删父会话就把子代理带走），不向上牵连父——子代理跟着父走，不是父跟着子走。
 *
 * 判据取子会话 header 里的 `parentSession`，而不是父日志里的 `subagent/catalog` 事件：两者在宿主
 * 写出来的库里是同一件事（建子会话时两边一起写，见 session-log.ts 的测试），而 header 在发现阶段
 * 本来就已经解出来了；读 catalog 要把父日志整份解码（一条 6MB 的日志 1～2 秒，见 discovery.ts）。
 *
 * 环（坏数据里 A 的父是 B、B 的父是 A）由 `seen` 兜住，不会转不出来。
 *
 * @param sessions 发现出来的全部会话。
 * @param byId 它们的 id 索引。
 * @param ids 用户点名的会话 id（可含不存在的）。
 * @returns 展开后的整族；点名但不在库里的 id 不出现在这里（由调用方报 problem）。
 */
function familyOf(
  sessions: readonly DiscoveredSession[],
  byId: ReadonlyMap<string, DiscoveredSession>,
  ids: readonly string[],
): FamilyMember[] {
  const childrenOf = new Map<string, DiscoveredSession[]>()
  for (const session of sessions) {
    const parent = session.header.parentSession
    if (parent === undefined || parent === '' || parent === session.id) continue
    const siblings = childrenOf.get(parent)
    if (siblings === undefined) childrenOf.set(parent, [session])
    else siblings.push(session)
  }

  const family: FamilyMember[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const root = byId.get(id)
    if (root === undefined || seen.has(root.id)) continue
    seen.add(root.id)
    family.push({ session: root, root })
    // 一层一层往下展开：`queue` 里是"已经收进来、还没找过孩子"的那些。
    const queue: DiscoveredSession[] = [root]
    while (queue.length > 0) {
      const parent = queue.shift()
      if (parent === undefined) break
      for (const child of childrenOf.get(parent.id) ?? []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        queue.push(child)
        family.push({ session: child, root })
      }
    }
  }
  return family
}

/**
 * 算出"删这些会话会发生什么"，不写任何字节。
 *
 * 请求里的每条会话都会先把**整族**（它自己 + 全部子代理后代）展开进计划，见 `familyOf()`。
 *
 * @param deps 路径与探测口。
 * @param request 要删的会话 id。
 * @returns 计划；`problems` 非空时 `ok` 为 false，执行阶段会拒绝。
 */
export function planRemoval(deps: RemoveDeps, request: RemoveRequest): RemovalPlan {
  const problems: string[] = []
  const ids = [...new Set((request.sessionIds ?? []).map((id) => String(id)))]
  if (ids.length === 0) problems.push('缺少要删除的会话（sessionIds）')

  const live = deps.liveSessionIds?.() ?? new Set<string>()
  let discovered: DiscoveredSession[] = []
  try {
    discovered = scanAll(deps.sessionsRoot, deps.decodeAll, deps.resolveTitle === undefined ? {} : { resolveTitle: deps.resolveTitle })
  } catch (error) {
    problems.push(`扫描会话库失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const byId = indexById(discovered)
  const named = new Set(ids)

  // 点名但不在库里的：照旧逐条报，不静默跳过（那些 id 也就展开不出什么后代来）。
  for (const id of ids) {
    if (!byId.has(id)) problems.push(`session ${id} 不在库里（可能已经被删掉了）`)
  }

  const entries: RemoveEntry[] = []
  /** 每条收进来的会话，它的父会话 id（没有父链接就不进这张表）。 */
  const parentOf = new Map<string, string>()
  for (const { session, root } of familyOf(discovered, byId, ids)) {
    const id = session.id
    // 点名的那些不说"跟着谁"——那是用户自己的选择；只有级联带进来的才说明出处。
    const via = named.has(id)
      ? undefined
      : { id: root.id, ...(root.title === undefined ? {} : { title: root.title }) }
    const owner = via === undefined ? '' : `（子代理，跟着 ${via.title ?? via.id} 一起删）`
    const isLive = live.has(id)
    if (isLive) {
      // 只报问题、不进条目：活着的会话不该出现在"要删的东西"里，否则界面会把它列成一个待删项。
      // 后代的"活着"同样挡下整个计划——它是这次要删的整族的一部分，宿主还在往里写。
      problems.push(`session ${id} 还在宿主内存里活着（运行中或已打开），先关掉它再删${owner}`)
      continue
    }
    if (!existsSync(session.dir)) {
      problems.push(`session ${id} 的目录已经不在了：${session.dir}${owner}`)
      continue
    }
    const parentSession = session.header.parentSession
    if (parentSession !== undefined) parentOf.set(id, parentSession)
    entries.push({
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      createdAt: session.createdAt,
      dir: session.dir,
      files: session.files,
      bytes: session.files.reduce((sum, file) => sum + file.bytes, 0),
      live: isLive,
      ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
      ...(via === undefined ? {} : { via }),
    })
  }

  // 删了子、留着父：父会话侧边栏里那一行会点不开（catalog 里还记着这个孩子）。父已经不在库里的
  // 孤儿没有这一条——它没有 catalog 会指过来。
  const planned = new Set(entries.map((entry) => entry.id))
  for (const entry of entries) {
    const parentId = parentOf.get(entry.id)
    if (parentId === undefined || planned.has(parentId)) continue
    const parent = byId.get(parentId)
    if (parent === undefined) continue
    entry.keptParent = { id: parent.id, ...(parent.title === undefined ? {} : { title: parent.title }) }
  }

  const files = entries.reduce((sum, entry) => sum + entry.files.length, 0)
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const cascaded = entries.filter((entry) => entry.via !== undefined).length
  if (entries.length === 0 && problems.length === 0) problems.push('没有可删除的会话')
  return { ok: problems.length === 0, problems, entries, files, bytes, cascaded, backupRoot: deps.backupRoot }
}

/**
 * 执行（或只做 dry-run）删除。
 *
 * `apply: false` 时只返回预演，一个字节都不写——界面上的「预演删除」与「确认删除」走的是同一个
 * 计划函数，因此不存在"预览一套、实做另一套"。
 *
 * @param deps 路径与探测口。
 * @param request 要删的会话 id。
 * @param options.apply 是否真的写盘。
 * @returns 执行结果；计划不 ok 时 `applied` 为 false 且原样带回 `problems`。
 */
export function runRemoval(deps: RemoveDeps, request: RemoveRequest, options: { apply: boolean }): RemovalRun {
  const plan = planRemoval(deps, request)
  const empty = { plan, problems: plan.problems, verified: false, dirsRemoved: 0, removedProjectDirs: [] }
  if (!plan.ok) return { applied: false, ...empty, summary: `未执行：${plan.problems.join('；')}` }
  /** 整族一起删时把"多出来的那几条"说清楚，否则预演清单里会冒出用户没勾过的会话。 */
  const cascadeNote =
    plan.cascaded === 0 ? '' : ` 其中 ${plan.cascaded} 条是子代理会话，跟着点名的会话一起删。`
  if (!options.apply) {
    return {
      applied: false,
      ...empty,
      problems: [],
      summary: `将删除 ${plan.entries.length} 个会话（${plan.files} 个日志文件、${plan.bytes} 字节），先备份再删。${cascadeNote}`,
    }
  }

  // 1) 备份（整份会话目录 + 注册表快照）。备份是唯一一份可以恢复的副本，删之前必须成功。
  const backup = createBackup({
    backupRoot: deps.backupRoot,
    registryPath: deps.registryPath,
    // 删除没有"目标目录"：清单里每条会话的 targetDir 由 createBackup 填成备份内那份副本。
    sessions: plan.entries.map((entry) => ({ id: entry.id, sourceDir: entry.dir, files: entry.files })),
    kind: 'delete',
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })

  // 2) 删会话目录
  for (const entry of plan.entries) {
    rmSync(entry.dir, { recursive: true, force: true })
  }

  // 3) 顺手清掉空掉的项目目录（迁移那条路也这么做）。只删**确认为空**的目录：同一项目目录下
  //    还有别的会话时它不为空，自然跳过。
  const projectDirs = [...new Set(plan.entries.map((entry) => dirname(entry.dir)))]
  const removedProjectDirs: string[] = []
  for (const projectDir of projectDirs) {
    if (!existsSync(projectDir)) continue
    try {
      if (!statSync(projectDir).isDirectory()) continue
      if (readdirSync(projectDir).length > 0) continue
    } catch {
      continue
    }
    rmdirSync(projectDir)
    removedProjectDirs.push(projectDir)
  }

  // 4) 独立复核：删掉的东西真的不在了、备份里那份真的在。
  const problems: string[] = []
  for (const entry of plan.entries) {
    if (existsSync(entry.dir)) problems.push(`session ${entry.id}: 目录还在 ${entry.dir}`)
    const backed = backup.manifest.sessions.find((s) => s.id === entry.id)
    if (backed === undefined || !existsSync(backed.targetDir)) {
      problems.push(`session ${entry.id}: 备份里没有这一份（${backed?.targetDir ?? backup.dir}）`)
    }
  }
  const verified = problems.length === 0
  return {
    applied: true,
    plan,
    problems,
    verified,
    backupDir: backup.dir,
    dirsRemoved: plan.entries.length,
    removedProjectDirs,
    summary:
      `已删除 ${plan.entries.length} 个会话（${plan.files} 个日志文件、${plan.bytes} 字节）。${cascadeNote}\n` +
      `复核：${verified ? '通过' : '失败'}。备份：${backup.dir}（可在「备份与回滚」里恢复）`,
  }
}
