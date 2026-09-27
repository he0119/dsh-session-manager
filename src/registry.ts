// src/registry.ts — workspace 注册表（$DSH_HOME/storages/workspace.json）的校验与重挂。
//
// 宿主的 WorkspaceRegistry 在启动时会校验已存状态，以下任一情况都让**启动直接报错**
// （不是静默降级，所以插件必须自己先守住）：
//   - 两个 workspace 记录 path 相同
//   - 同一个 sessionId 出现在多个 workspace 的账本里
//   - global.workspaceIds 有重复
//   - global.workspaceIds 的集合 != tables.workspaces 的键集合（顺序漂移）
//
// 领域形态（unit=workspace, version=2）：
//   global: { initialized, workspaceIds[], archivedSessionIds[], pendingMutation? }
//   tables: { workspaces: { [id]: { path, title, sessionIds[], createdAt, updatedAt } } }
//
// 注意：宿主进程内持有该注册表的内存副本，离线改写会被之后的宿主写入覆盖，
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
      if (owner !== undefined) problems.push(`session ${sid} is ledgered by both ${owner} and ${id}`)
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
 * 警告：宿主进程内持有内存副本，离线落盘需要重启才会被承认，且可能被覆盖。
 */
export function writeRegistryAtomic(path: string, reg: WorkspaceRegistryState): void {
  const tmp = `${path}.dsh-session-mover.tmp`
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
  /** 原账本变空时是否删除该工作区，默认 true。 */
  removeEmptySources?: boolean
}

/**
 * 把若干会话重新归属到目标目录的工作区（纯函数：返回新对象，不写盘）。
 *
 * 语义：
 *   - 目标目录已有工作区则复用；否则新建记录并**前插**到 durable 顺序
 *     （与宿主 WorkspaceRegistry.create() 的"新工作区前插"一致）。
 *   - 会话从原账本移除；原账本变空时默认删除该工作区记录与顺序项。
 *   - 若会话已在目标账本中，视为幂等跳过，不重复追加。
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
  let createdTarget = false
  for (const [id, rec] of Object.entries(workspaces)) {
    if (rec.path === toPath) {
      targetId = id
      break
    }
  }
  if (targetId === undefined) {
    targetId = newId
    workspaces[targetId] = {
      path: toPath,
      title: title ?? toPath.split(/[\\/]/).filter(Boolean).pop() ?? toPath,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    next.global.workspaceIds.unshift(targetId) // 与宿主 create() 的前插语义一致
    createdTarget = true
  }

  // 从原账本摘除
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
      createdTarget,
      added,
      adoptedFromUnowned,
      movedFrom,
      removedSources,
      unchanged: added.length === 0 && movedFrom.length === 0,
    },
  }
}
