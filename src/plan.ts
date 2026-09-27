// src/plan.ts — 迁移计划：只读地算出"将会发生什么"，不写任何字节。
//
// 计划是一等产物：apply 只接受一个 plan 对象，rollback 只依赖备份清单。
// 这样 dry-run 与真实执行走的是同一段代码，避免"预览和实做不一致"。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { planArtifactMoves } from './artifacts.ts'
import { bucketOf, scanBucket } from './discovery.ts'
import { projectKey } from './project-key.ts'
import { reHome, validateRegistry } from './registry.ts'
import type { DecodeAll, RelocationPlan, SessionMove, WorkspaceRegistryState } from './types.ts'

/** `buildRelocationPlan()` 的选项。 */
export interface BuildPlanOptions {
  /** 会话根目录（即 `$DSH_HOME/sessions`）。 */
  root: string
  /** 已解析的 workspace 注册表对象。 */
  registry: WorkspaceRegistryState
  /** 源工作区目录（绝对路径）。 */
  from: string
  /** 目标工作区目录（绝对路径，必须已存在）。 */
  to: string
  decodeAll: DecodeAll
  /** 只迁移这些会话；缺省迁移源桶内全部。 */
  sessionIds?: string[] | null
  /** 目标工作区新建时的标题。 */
  title?: string
  /** 是否连带源桶中未登记在册的会话（默认 true）。 */
  includeUnowned?: boolean
  /** 是否同时规划"会话中创建的文件"的搬迁（默认 false；需要全量解码，较慢）。 */
  includeArtifacts?: boolean
}

/**
 * 构建一次迁移计划。
 *
 * `problems` 非空时 `ok` 为 false，且不得执行。
 */
export function buildRelocationPlan(options: BuildPlanOptions): RelocationPlan {
  const {
    root,
    registry,
    from,
    to,
    decodeAll,
    sessionIds = null,
    title,
    includeUnowned = true,
    includeArtifacts = false,
  } = options
  const problems: string[] = []

  if (typeof root !== 'string' || !root) problems.push('root is required (path to the sessions root)')
  if (typeof from !== 'string' || !from) problems.push('from is required (source workspace directory)')
  if (typeof to !== 'string' || !to) problems.push('to is required (target workspace directory)')
  if (problems.length) {
    return {
      ok: false,
      problems,
      from,
      to,
      root,
      sourceBucket: '',
      targetBucket: '',
      sessions: [],
      artifacts: null,
      registryChange: null,
      nextRegistry: null,
    }
  }

  if (from === to) problems.push('from and to are identical — nothing to migrate')

  const regCheck = validateRegistry(registry)
  if (!regCheck.ok) problems.push(...regCheck.problems.map((p) => `registry: ${p}`))

  // 目标目录必须已存在（宿主 workspace 只能拥有真实存在的目录）
  if (!existsSync(to)) problems.push(`target directory does not exist: ${to}`)
  else if (!statSync(to).isDirectory()) problems.push(`target is not a directory: ${to}`)

  const sourceBucket = bucketOf(root, from)
  const targetBucket = bucketOf(root, to)
  if (!existsSync(sourceBucket)) problems.push(`source bucket does not exist: ${sourceBucket}`)

  // 有损目录名的碰撞：源与目标桶若同名，会话日志会混在一起
  if (projectKey(from) === projectKey(to)) {
    problems.push(`projectKey collision: ${from} and ${to} both encode to ${projectKey(from)}`)
  }

  let discovered: ReturnType<typeof scanBucket> = []
  if (existsSync(sourceBucket)) {
    discovered = scanBucket(sourceBucket, decodeAll)
    for (const s of discovered) {
      if (s.cwd !== from) problems.push(`session ${s.id}: header cwd ${s.cwd} != ${from}`)
    }
    if (sessionIds) {
      const known = new Set(discovered.map((s) => s.id))
      for (const id of sessionIds) {
        if (!known.has(id)) problems.push(`session ${id} not found in ${sourceBucket}`)
      }
    }
  }

  const owned = new Set<string>()
  for (const rec of Object.values(registry?.tables?.workspaces ?? {})) {
    for (const sid of rec.sessionIds) owned.add(sid)
  }

  let selected = discovered
  if (sessionIds) selected = discovered.filter((s) => sessionIds.includes(s.id))
  if (!includeUnowned) {
    for (const s of selected) {
      if (!owned.has(s.id)) problems.push(`session ${s.id} is not registered in any workspace (use includeUnowned)`)
    }
  }

  // 目标会话目录不得已被占用
  const targetDirs = new Set<string>()
  const sessions: SessionMove[] = selected.map((s) => {
    const targetDir = join(targetBucket, s.dirName)
    if (existsSync(targetDir)) problems.push(`target session directory already exists: ${targetDir}`)
    if (targetDirs.has(targetDir)) problems.push(`duplicate target directory: ${targetDir}`)
    targetDirs.add(targetDir)
    return {
      id: s.id,
      dirName: s.dirName,
      createdAt: s.createdAt,
      from,
      to,
      alreadyAtTarget: s.cwd === to,
      sourceDir: s.dir,
      targetDir,
      files: s.files,
      registered: owned.has(s.id),
    }
  })

  if (sessions.length === 0 && problems.length === 0) problems.push('no sessions selected for migration')

  // 可选的产物搬迁：需要**全量解码**会话日志（多帧全解），比发现阶段慢得多，
  // 因此只在显式要求时做。
  let artifacts: RelocationPlan['artifacts'] = null
  if (includeArtifacts && sessions.length > 0) {
    const texts = sessions.map((s) => ({
      id: s.id,
      // 多代次（v3 + v4）按代次顺序拼接，与宿主读取口径一致
      text: s.files.map((f) => decodeAll(readFileSync(f.path))).join(''),
    }))
    artifacts = planArtifactMoves({ sessions: texts, fromDir: from, toDir: to })
    for (const p of artifacts.problems) problems.push(p)
  }

  // 注册表变更（纯计算；把问题并入 problems 而不是抛出）
  let registryChange: RelocationPlan['registryChange'] = null
  let nextRegistry: WorkspaceRegistryState | null = null
  if (sessions.length > 0 && regCheck.ok) {
    try {
      // sessions 已按 createdAt 降序（新→旧，与宿主账本显示顺序一致），原样追加
      const result = reHome(registry, { sessionIds: sessions.map((s) => s.id), toPath: to, title })
      nextRegistry = result.registry
      registryChange = result.change
    } catch (error) {
      problems.push(`registry re-home failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    from,
    to,
    root,
    sourceBucket,
    targetBucket,
    sessions,
    artifacts,
    registryChange,
    nextRegistry,
  }
}

/** 人类可读的计划摘要（CLI 与工具返回值共用）。 */
export function describePlan(plan: RelocationPlan): string {
  const lines: string[] = []
  lines.push(`迁移 ${plan.sessions.length} 个会话：`)
  lines.push(`  ${plan.from}`)
  lines.push(`  -> ${plan.to}`)
  const files = plan.sessions.reduce((n, s) => n + s.files.length, 0)
  lines.push(`  日志文件 ${files} 个；目标桶 ${plan.targetBucket}`)
  if (plan.artifacts) {
    lines.push(`  会话产物：待搬 ${plan.artifacts.moves.length} 项、跳过 ${plan.artifacts.skipped.length} 项`)
  }
  if (plan.registryChange) {
    const c = plan.registryChange
    lines.push(
      `  注册表：目标工作区 ${c.targetId}${c.createdTarget ? '（新建，前插）' : '（复用）'}；` +
        `新增归属 ${c.added.length}；摘除自 ${c.movedFrom.length} 个工作区；删除空工作区 ${c.removedSources.length}`,
    )
  }
  if (plan.problems.length) {
    lines.push(`  问题 ${plan.problems.length} 项：`)
    for (const p of plan.problems) lines.push(`    - ${p}`)
  }
  return lines.join('\n')
}
