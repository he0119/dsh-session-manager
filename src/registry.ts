// src/registry.ts — workspace 注册表（$DSH_HOME/storages/workspace.json）的校验与重挂。
//
// 宿主的 WorkspaceRegistry 在启动时会校验已存状态，以下任一情况都让**启动直接报错**
// （不是静默降级，所以插件必须自己先守住）：
//   - 两个 workspace 记录 path 相同
//   - 同一个 sessionId 出现在多个 workspace 的注册表里
//   - global.workspaceIds 有重复
//   - global.workspaceIds 的集合 != tables.workspaces 的键集合（顺序漂移）
//
// 领域形态（unit=workspace, version=2）：
//   global: { initialized, workspaceIds[], archivedSessionIds[], pendingMutation? }
//   tables: { workspaces: { [id]: { path, title, sessionIds[], createdAt, updatedAt } } }
//
// 注意：宿主进程内持有该注册表的内存副本，绕过它直接改写文件会被之后的宿主写入覆盖，
// 因此落盘后需要重启生效；能在进程内走 ctx.workspaceRegistry 时不要用本模块落盘。
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import type { RegistryChange, WorkspaceRecord, WorkspaceRegistryState } from './types.ts'

/** 校验结果。 */
export interface ValidationResult {
  ok: boolean
  problems: string[]
}

/**
 * 校验注册表是否满足启动不变式。
 * @param reg 解析后的注册表对象。
 * @returns problems 每项为一句可读诊断。
 */
export function validateRegistry(reg: unknown): ValidationResult {
  const problems: string[] = []
  if (typeof reg !== 'object' || reg === null) return { ok: false, problems: ['registry is not an object'] }

  const r = reg as Partial<WorkspaceRegistryState>
  const global = r.global
  const workspaces = r.tables?.workspaces
  if (typeof global !== 'object' || global === null) problems.push('missing global state')
  if (typeof workspaces !== 'object' || workspaces === null) problems.push('missing tables.workspaces')
  if (problems.length) return { ok: false, problems }

  const g = global as WorkspaceRegistryState['global']
  const table = workspaces as Record<string, WorkspaceRecord>

  if (!Array.isArray(g.workspaceIds)) problems.push('global.workspaceIds is not an array')
  if (!Array.isArray(g.archivedSessionIds ?? [])) problems.push('global.archivedSessionIds is not an array')

  const keys = Object.keys(table)
  const ids = Array.isArray(g.workspaceIds) ? g.workspaceIds : []

  // 1) workspaceIds 无重复
  const seenIds = new Set<string>()
  for (const id of ids) {
    if (seenIds.has(id)) problems.push(`global.workspaceIds contains duplicate id ${id}`)
    seenIds.add(id)
  }

  // 2) workspaceIds 集合 == 表键集合
  for (const id of ids) if (!keys.includes(id)) problems.push(`global.workspaceIds references absent record ${id}`)
  for (const key of keys) {
    if (!ids.includes(key)) problems.push(`table record ${key} is absent from global.workspaceIds (order drift)`)
  }

  // 3) 记录结构 + path 唯一
  const byPath = new Map<string, string>()
  for (const [id, rec] of Object.entries(table)) {
    if (typeof rec !== 'object' || rec === null) {
      problems.push(`record ${id} is not an object`)
      continue
    }
    if (typeof rec.path !== 'string' || rec.path.length === 0) problems.push(`record ${id} has no path`)
    if (!Array.isArray(rec.sessionIds)) problems.push(`record ${id} has no sessionIds array`)
    if (typeof rec.path === 'string' && rec.path.length > 0) {
      const owner = byPath.get(rec.path)
      if (owner !== undefined) problems.push(`duplicate workspace path ${rec.path} (${owner} and ${id})`)
      else byPath.set(rec.path, id)
    }
  }

  // 4) 一个 sessionId 只能属于一个 workspace
  const bySession = new Map<string, string>()
  for (const [id, rec] of Object.entries(table)) {
    const sessionIds = Array.isArray(rec?.sessionIds) ? rec.sessionIds : []
    for (const sid of sessionIds) {
      const owner = bySession.get(sid)
      if (owner !== undefined) problems.push(`session ${sid} is accounted by both ${owner} and ${id}`)
      else bySession.set(sid, id)
    }
  }

  return { ok: problems.length === 0, problems }
}

/** 读取注册表。 */
export function readRegistry(path: string): WorkspaceRegistryState {
  return JSON.parse(readFileSync(path, 'utf8')) as WorkspaceRegistryState
}

/**
 * 原子落盘（临时文件 + rename），保持宿主的 2 空格缩进与结尾换行。
 *
 * 警告：宿主进程内持有内存副本，绕过它直接落盘需要重启才会被承认，且可能被覆盖。
 */
export function writeRegistryAtomic(path: string, reg: WorkspaceRegistryState): void {
  const tmp = `${path}.dsh-session-manager.tmp`
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n')
  renameSync(tmp, path)
}

/** `reHome()` 的选项。 */
export interface ReHomeOptions {
  /** 要重挂的会话 id（按期望的显示顺序）。 */
  sessionIds: string[]
  /** 目标目录的绝对路径。 */
  toPath: string
  /** 新建工作区时的显示标题（缺省取路径最后一段）。 */
  title?: string
  /** 时间戳（ISO 字符串），便于测试注入。 */
  now?: string
  /** 新建工作区 id（便于测试注入）。 */
  newId?: string
  /** 原注册表变空时是否删除该工作区，默认 true。 */
  removeEmptySources?: boolean
}

/**
 * 把若干会话重新归属到目标目录的工作区（纯函数：返回新对象，不写盘）。
 *
 * 语义：
 *   - 目标目录已有工作区则复用；否则新建记录并**前插**到 durable 顺序
 *     （与宿主 WorkspaceRegistry.create() 的"新工作区前插"一致）。
 *   - 会话从原注册表移除；原注册表变空时默认删除该工作区记录与顺序项。
 *   - 若会话已在目标注册表中，视为幂等跳过，不重复追加。
 *
 * @throws 传入的注册表已违反启动不变式，或结果会违反时抛错。
 */
export function reHome(
  reg: WorkspaceRegistryState,
  options: ReHomeOptions,
): { registry: WorkspaceRegistryState; change: RegistryChange } {
  const {
    sessionIds,
    toPath,
    title,
    now = new Date().toISOString(),
    newId = randomUUID(),
    removeEmptySources = true,
  } = options

  if (typeof toPath !== 'string' || toPath.length === 0) throw new Error('reHome requires toPath')
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new Error('reHome requires a non-empty sessionIds array')
  }

  const before = validateRegistry(reg)
  if (!before.ok) throw new Error(`refusing to re-home on an invalid registry: ${before.problems.join('; ')}`)

  const next = structuredClone(reg)
  const workspaces = next.tables.workspaces

  // 迁移**前**就有归属的会话集合（用于区分"从别处搬来"与"本来无归属、现在被归组"）
  const ownedBefore = new Set<string>()
  for (const rec of Object.values(reg.tables.workspaces)) {
    for (const sid of rec.sessionIds) ownedBefore.add(sid)
  }

  // 目标工作区（复用或新建）
  let targetId: string | undefined
  let targetTitle = ''
  let createdTarget = false
  for (const [id, rec] of Object.entries(workspaces)) {
    if (rec.path === toPath) {
      targetId = id
      targetTitle = rec.title
      break
    }
  }
  if (targetId === undefined) {
    targetId = newId
    targetTitle = title ?? defaultTitle(toPath)
    workspaces[targetId] = {
      path: toPath,
      title: targetTitle,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    next.global.workspaceIds.unshift(targetId) // 与宿主 create() 的前插语义一致
    createdTarget = true
  }

  // 从原注册表摘除
  const movedFrom: RegistryChange['movedFrom'] = []
  const removedSources: RegistryChange['removedSources'] = []
  for (const [id, rec] of Object.entries(workspaces)) {
    if (id === targetId) continue
    const had = rec.sessionIds.filter((sid) => sessionIds.includes(sid))
    if (had.length === 0) continue
    rec.sessionIds = rec.sessionIds.filter((sid) => !sessionIds.includes(sid))
    rec.updatedAt = now
    movedFrom.push({ workspaceId: id, path: rec.path, sessionIds: had })
    if (removeEmptySources && rec.sessionIds.length === 0) {
      delete workspaces[id]
      next.global.workspaceIds = next.global.workspaceIds.filter((x) => x !== id)
      removedSources.push({ workspaceId: id, path: rec.path })
    }
  }

  // 追加到目标（保持传入顺序；已在目标中的视为幂等）
  const target = workspaces[targetId]
  if (!target) throw new Error(`internal error: target workspace ${targetId} vanished`)
  const toAdd = sessionIds.filter((sid) => !target.sessionIds.includes(sid))
  target.sessionIds = [...target.sessionIds, ...toAdd]
  target.updatedAt = now

  const added = toAdd
  const adoptedFromUnowned = toAdd.filter((sid) => !ownedBefore.has(sid))

  const after = validateRegistry(next)
  if (!after.ok) throw new Error(`re-home would produce an invalid registry: ${after.problems.join('; ')}`)

  return {
    registry: next,
    change: {
      targetId,
      targetPath: toPath,
      targetTitle,
      createdTarget,
      added,
      adoptedFromUnowned,
      movedFrom,
      removedSources,
      unchanged: added.length === 0 && movedFrom.length === 0,
    },
  }
}

/** 新建工作区时的缺省标题（与宿主 `create()` 的"取路径最后一段"一致）。 */
function defaultTitle(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** 注册表复核结果。 */
export interface RegistryVerification {
  ok: boolean
  problems: string[]
}

/** 一份注册表里出现过的全部会话 id。 */
function sessionIdsOf(reg: WorkspaceRegistryState): Set<string> {
  const out = new Set<string>()
  for (const rec of Object.values(reg.tables.workspaces)) for (const sid of rec.sessionIds) out.add(sid)
  return out
}

/**
 * 复核一次注册表改动：**会话 id 不新增（除计划带来的）、不丢失；已存在的工作区 id 与路径不变**。
 *
 * 这三条是"活体落盘由宿主代劳"之后唯一还需要插件自己盯的东西：宿主分配 id 的地方只有"新建工作区"
 * 一处，其余一律复用。复核失败不改变磁盘（文件已经写好），只把问题报出去。
 */
export function verifyRegistryChange(
  before: WorkspaceRegistryState,
  after: WorkspaceRegistryState,
  change: RegistryChange,
): RegistryVerification {
  const problems: string[] = []
  const valid = validateRegistry(after)
  if (!valid.ok) problems.push(...valid.problems.map((p) => `落盘后的注册表不合法：${p}`))

  // 工作区：已存在的（不在 removedSources 里、也不是目标）必须**同一个 id、同一条路径**还在
  const removedIds = new Set(change.removedSources.map((s) => s.workspaceId))
  const afterByPath = new Map(Object.entries(after.tables.workspaces).map(([id, rec]) => [rec.path, { id, rec }]))
  for (const [id, rec] of Object.entries(before.tables.workspaces)) {
    if (rec.path === change.targetPath) continue
    if (removedIds.has(id)) {
      if (after.tables.workspaces[id] !== undefined) problems.push(`工作区 ${id} 计划里要删，却还在`)
      continue
    }
    const now = afterByPath.get(rec.path)
    if (now === undefined) problems.push(`工作区 ${rec.path} 计划里要留，却没了`)
    else if (now.id !== id) problems.push(`工作区 ${rec.path} 的 id 变了：${id} -> ${now.id}`)
  }

  // 目标：只多不少，且多出来的正是计划里那批
  const target = afterByPath.get(change.targetPath)
  if (target === undefined) problems.push(`目标工作区 ${change.targetPath} 不在落盘结果里`)
  else {
    const had = new Set(beforeByPath(before, change.targetPath)?.sessionIds ?? [])
    const want = new Set([...had, ...change.added])
    const got = new Set(target.rec.sessionIds)
    for (const sid of want) if (!got.has(sid)) problems.push(`会话 ${sid} 没进目标工作区`)
    for (const sid of got) if (!want.has(sid)) problems.push(`目标工作区里多了计划外的会话 ${sid}`)
  }

  // 工作区集合：只允许"少掉计划要删的、多出计划要建的目标"
  const beforePaths = new Set(Object.values(before.tables.workspaces).map((r) => r.path))
  const afterPaths = new Set(Object.values(after.tables.workspaces).map((r) => r.path))
  for (const path of beforePaths) {
    if (path === change.targetPath) continue
    const removed = change.removedSources.some((s) => before.tables.workspaces[s.workspaceId]?.path === path)
    if (!removed && !afterPaths.has(path)) problems.push(`工作区 ${path} 凭空消失了`)
  }
  for (const path of afterPaths) {
    if (beforePaths.has(path) || path === change.targetPath) continue
    problems.push(`冒出一个计划外的工作区 ${path}`)
  }

  // 会话：id 集合只许"按计划"变大，绝不许变小（改名 / 丢失都会在这里露出来）
  const beforeSessions = sessionIdsOf(before)
  const afterSessions = sessionIdsOf(after)
  const allowedNew = new Set(change.added)
  for (const sid of beforeSessions) if (!afterSessions.has(sid)) problems.push(`会话 ${sid} 在落盘结果里没了（id 不该变）`)
  for (const sid of afterSessions) {
    if (!beforeSessions.has(sid) && !allowedNew.has(sid)) problems.push(`落盘结果里多了计划外的会话 ${sid}`)
  }

  return { ok: problems.length === 0, problems }
}

/** 某条路径在注册表里的记录（缺省 = 还没有这条工作区）。 */
function beforeByPath(reg: WorkspaceRegistryState, path: string): WorkspaceRecord | undefined {
  return Object.values(reg.tables.workspaces).find((rec) => rec.path === path)
}

/** 计划里记着、落盘结果里整份都没有的一条归属（见 `missingMemberships()`）。 */
export interface MissingMembership {
  /** 这条会话在计划里属于哪个目录的工作区。 */
  path: string
  /** 那个工作区在计划里的标题（宿主连记录都没有时靠它新建）。 */
  title: string
  /** 会话 id。 */
  sessionId: string
}

/**
 * 计划里该有、落盘结果里**整份都没有**的归属。
 *
 * 宿主自己那一步是按内存里那份整份落盘的，于是它内存里没有的归属会被一起抹掉——这跟"计划里删掉了
 * 一条"在文件上长得一模一样，所以判据只能是"计划里有、盘上没了"。
 *
 * 按目录（而不是工作区 id）比：新建的工作区由宿主分配 id，计划里那个只是预测值，拿 id 比会把一次
 * 正常的新建全判成丢归属（见 `EffectOutcome.targetId`）。
 *
 * 只认"整份都没有"：会话被挪到**别的工作区**下不算这一条（那属于复核报出来的问题，不该由这里悄悄
 * 改挂），盘上被宿主清掉的悬空登记也不在这里——它们本来就不该有归属。
 */
export function missingMemberships(
  expected: WorkspaceRegistryState,
  actual: WorkspaceRegistryState,
): MissingMembership[] {
  const owned = new Set<string>()
  for (const record of Object.values(actual.tables.workspaces)) for (const id of record.sessionIds) owned.add(id)
  const missing: MissingMembership[] = []
  for (const record of Object.values(expected.tables.workspaces)) {
    for (const sessionId of record.sessionIds) {
      if (!owned.has(sessionId)) missing.push({ path: record.path, title: record.title, sessionId })
    }
  }
  return missing
}
