// src/plan.ts — 迁移计划：只读地算出"将会发生什么"，不写任何字节。
//
// 计划是一等产物：apply 只接受一个 plan 对象，rollback 只依赖备份清单。
// 这样 dry-run 与真实执行走的是同一段代码，避免"预览和实做不一致"。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { planArtifactMoves } from './artifacts.ts'
import { bucketOf, scanAll, scanBucket } from './discovery.ts'
import { projectKey } from './project-key.ts'
import { reHome, validateRegistry } from './registry.ts'
import type { TitleQuery } from './session-title.ts'
import type { DecodeAll, RelocationPlan, SessionMove, WorkspaceRegistryState } from './types.ts'

/** `buildRelocationPlan()` 的选项。 */
export interface BuildPlanOptions {
  /** 会话根目录（即 `$DSH_HOME/sessions`）。 */
  root: string
  /** 已解析的 workspace 注册表对象。 */
  registry: WorkspaceRegistryState
  /** 源工作区目录（绝对路径）。`unowned` 为 true 时省略（那时源不是一个目录）。 */
  from?: string
  /** 目标工作区目录（绝对路径，必须已存在）。 */
  to: string
  decodeAll: DecodeAll
  /** 只迁移这些会话；缺省迁移源桶内全部。 */
  sessionIds?: string[] | null
  /**
   * 源取"账本没认领且有 `cwd` 的会话"（外壳侧边栏把它们挂在「未分组」下），而不是某个目录。
   *
   * 与 `from` 互斥：一个是目录、一个是"谁都没认领"，同时给就是两种源，谁也说不清用哪个。
   * 这一支可以横跨多个分桶，所以每条会话的源目录各不相同（`sessions[].from`），
   * 计划里的 `from` / `sourceBucket` 因此是空串。
   */
  unowned?: boolean
  /** 目标工作区新建时的标题。 */
  title?: string
  /** 是否连带源桶中未登记在册的会话（默认 true；未分组来源下无意义——那批本来就是未登记）。 */
  includeUnowned?: boolean
  /** 是否同时规划"会话中创建的文件"的搬迁（默认 false；需要全量解码，较慢）。 */
  includeArtifacts?: boolean
  /**
   * 读会话标题（可选）：界面挑会话时按标题认人（见 session-title.ts）。
   *
   * 缺席 = 这次计划不要标题（工具层只报数量，不需要），因此发现阶段一分钱都不多花。
   */
  resolveTitle?: (query: TitleQuery) => string | undefined
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
    to,
    decodeAll,
    sessionIds = null,
    unowned = false,
    title,
    includeUnowned = true,
    includeArtifacts = false,
    resolveTitle,
  } = options
  const from = (options.from ?? '').trim()
  const problems: string[] = []

  if (typeof root !== 'string' || !root) problems.push('root is required (path to the sessions root)')
  if (typeof to !== 'string' || !to) problems.push('to is required (target workspace directory)')
  if (unowned) {
    if (from !== '') problems.push('source is ambiguous: pass either from (a directory) or unowned, not both')
  } else if (from === '') {
    problems.push('from is required (source workspace directory)')
  }
  if (problems.length) {
    return {
      ok: false,
      problems,
      from: unowned ? '' : from,
      to,
      root,
      sourceBucket: '',
      targetBucket: '',
      unowned,
      sessions: [],
      artifacts: null,
      registryChange: null,
      nextRegistry: null,
    }
  }

  if (!unowned && from === to) problems.push('from and to are identical — nothing to migrate')

  const regCheck = validateRegistry(registry)
  if (!regCheck.ok) problems.push(...regCheck.problems.map((p) => `registry: ${p}`))

  // 目标目录必须已存在（宿主 workspace 只能拥有真实存在的目录）
  if (!existsSync(to)) problems.push(`target directory does not exist: ${to}`)
  else if (!statSync(to).isDirectory()) problems.push(`target is not a directory: ${to}`)

  const sourceBucket = unowned ? '' : bucketOf(root, from)
  const targetBucket = bucketOf(root, to)
  if (!unowned && !existsSync(sourceBucket)) problems.push(`source bucket does not exist: ${sourceBucket}`)

  // 有损目录名的碰撞：源与目标桶若同名，会话日志会混在一起
  if (!unowned && projectKey(from) === projectKey(to)) {
    problems.push(`projectKey collision: ${from} and ${to} both encode to ${projectKey(from)}`)
  }

  const owned = new Set<string>()
  for (const rec of Object.values(registry?.tables?.workspaces ?? {})) {
    for (const sid of rec.sessionIds) owned.add(sid)
  }

  let discovered: ReturnType<typeof scanBucket> = []
  if (unowned) {
    // 未分组来源：整个库里"谁都没认领"的那些。没有 `cwd` 的排除在外——`relocateHeaderCwd()`
    // 明确拒绝改写一个没有 cwd 的 header（session-log.ts），所以它们根本搬不进来；
    // 界面上那个来源的条数与这里必须一致，于是界面也按同一条判据圈候选（planRows.unownedSessions）。
    discovered = scanAll(root, decodeAll, resolveTitle === undefined ? {} : { resolveTitle }).filter(
      (s) => !owned.has(s.id) && typeof s.cwd === 'string' && s.cwd !== '',
    )
  } else if (existsSync(sourceBucket)) {
    discovered = scanBucket(sourceBucket, decodeAll, resolveTitle === undefined ? {} : { resolveTitle })
    for (const s of discovered) {
      if (s.cwd !== from) problems.push(`session ${s.id}: header cwd ${s.cwd} != ${from}`)
    }
  }

  if (sessionIds) {
    const known = new Set(discovered.map((s) => s.id))
    for (const id of sessionIds) {
      // 点名的会话不在这次来源的候选里：直接报 problem，不静默少搬（未分组来源下，
      // "在册"或"没有 cwd"的会话就落在这里——它们不是这个来源能覆盖的东西）。
      if (!known.has(id)) {
        problems.push(
          unowned ? `session ${id} is not an unowned session with a cwd` : `session ${id} not found in ${sourceBucket}`,
        )
      }
    }
  }

  let selected = discovered
  if (sessionIds) selected = discovered.filter((s) => sessionIds.includes(s.id))
  if (!unowned && !includeUnowned) {
    for (const s of selected) {
      if (!owned.has(s.id)) problems.push(`session ${s.id} is not registered in any workspace (use includeUnowned)`)
    }
  }

  // 目标会话目录不得已被占用
  const targetDirs = new Set<string>()
  const sessions: SessionMove[] = selected.map((s) => {
    const targetDir = join(targetBucket, s.dirName)
    // 每条会话各自一个源：未分组来源下它们分散在不同的分桶里。
    const sessionFrom = unowned ? (s.cwd as string) : from
    // `cwd` 已经在目标上的会话（未分组来源下很常见：这条没人认领的会话本来就住在那个目录里，
    // 只是没登记在册）不需要搬任何东西——它的"目标目录"就是自己现在的位置，所以"目标已存在"
    // 在这里不是冲突。这一支在单目录来源下够不到（`from === to` 被上面挡了），
    // 未分组来源下它是**收编**这件事的常态：只补一条账本记录。
    const alreadyAtTarget = s.cwd === to
    if (existsSync(targetDir) && !alreadyAtTarget) problems.push(`target session directory already exists: ${targetDir}`)
    if (targetDirs.has(targetDir)) problems.push(`duplicate target directory: ${targetDir}`)
    targetDirs.add(targetDir)
    // 桶名与 header 的 cwd 若已经对不上，说明这条会话落错了桶（宿主会判它 corrupt）——搬过去正好
    // 修好，但桶名相同却是另一个 cwd 时目标桶里会撞车，那种情况在这里挡住。
    if (unowned && !alreadyAtTarget && bucketOf(root, sessionFrom) === targetBucket) {
      problems.push(`session ${s.id}: its bucket collides with the target's (${projectKey(to)})`)
    }
    return {
      id: s.id,
      ...(s.title === undefined ? {} : { title: s.title }),
      dirName: s.dirName,
      createdAt: s.createdAt,
      from: sessionFrom,
      to,
      alreadyAtTarget,
      sourceDir: s.dir,
      targetDir,
      files: s.files,
      registered: owned.has(s.id),
    }
  })

  if (sessions.length === 0 && problems.length === 0) problems.push('no sessions selected for migration')

  // 可选的产物搬迁：需要**全量解码**会话日志（多帧全解），比发现阶段慢得多，
  // 因此只在显式要求时做。未分组来源横跨多个目录时不做：产物定位是"相对于源目录"的
  // （planArtifactMoves 只收一个 fromDir），一次请求里没有哪一个目录当得起这个角色。
  let artifacts: RelocationPlan['artifacts'] = null
  if (includeArtifacts && unowned && sessions.length > 0) {
    problems.push('unowned source cannot relocate session artifacts (it spans several source directories)')
  } else if (includeArtifacts && sessions.length > 0) {
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
    from: unowned ? '' : from,
    to,
    root,
    sourceBucket,
    targetBucket,
    unowned,
    sessions,
    artifacts,
    registryChange,
    nextRegistry,
  }
}

/** 人类可读的计划摘要（工具返回值与预演摘要共用）。 */
export function describePlan(plan: RelocationPlan): string {
  const lines: string[] = []
  lines.push(`迁移 ${plan.sessions.length} 个会话：`)
  // 未分组来源没有"一个源目录"这回事：源桶由每条会话自己的 cwd 定，因此只报涉及的桶数。
  const sourceBuckets = new Set(plan.sessions.map((s) => dirname(s.sourceDir)))
  lines.push(
    plan.unowned
      ? `  （未分组：横跨 ${sourceBuckets.size} 个源分桶）`
      : `  ${plan.from}`,
  )
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
        `新增归属 ${c.added.length}（其中未分组收编 ${c.adoptedFromUnowned.length}）；` +
        `摘除自 ${c.movedFrom.length} 个工作区；删除空工作区 ${c.removedSources.length}`,
    )
  }
  if (plan.problems.length) {
    lines.push(`  问题 ${plan.problems.length} 项：`)
    for (const p of plan.problems) lines.push(`    - ${p}`)
  }
  return lines.join('\n')
}
