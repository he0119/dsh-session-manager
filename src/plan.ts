// src/plan.ts — 迁移计划：只读地算出"将会发生什么"，不写任何字节。
//
// 计划是一等产物：apply 只接受一个 plan 对象，rollback 只依赖备份清单。
// 这样 dry-run 与真实执行走的是同一段代码，避免"预览和实做不一致"。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { accountedOwners } from './accounting.ts'
import { planArtifactMoves } from './artifacts.ts'
import { canonicalDir } from './canonical-path.ts'
import { projectDirOf, scanAll, scanProjectDir, type DiscoveredSession } from './discovery.ts'
import { familyOf } from './family.ts'
import { projectKey } from './project-key.ts'
import { reHome, validateRegistry } from './registry.ts'
import type { TitleQuery } from './session-title.ts'
import type { DecodeAll, ProgressReporter, RelocationPlan, SessionMove, WorkspaceRegistryState } from './types.ts'
import { hiddenReasonOf, type HiddenReason } from './visibility.ts'

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
  /** 只迁移这些会话；缺省迁移源项目目录内全部。 */
  sessionIds?: string[] | null
  /**
   * 源取"外壳侧边栏「未分组」那一组里有 `cwd` 的会话"（判据见 `visibility.ts` 的 `isUngrouped()`），
   * 而不是某个目录；`cwd` 那一条是这个来源自己的限制（改写 header 需要它）。
   *
   * 与 `from` 互斥：一个是目录、一个是"谁都没认领"，同时给就是两种源，谁也说不清用哪个。
   * 这一支可以横跨多个项目目录，所以每条会话的源目录各不相同（`sessions[].from`），
   * 计划里的 `from` / `sourceProjectDir` 因此是空串。
   */
  unowned?: boolean
  /** 目标工作区新建时的标题。 */
  title?: string
  /** 是否连带源项目目录中未分组的会话（默认 true；未分组来源下无意义——那批本来就没在册）。 */
  includeUnowned?: boolean
  /** 是否同时规划"会话中创建的文件"的搬迁（默认 false；需要全量解码，较慢）。 */
  includeArtifacts?: boolean
  /**
   * 读会话标题（可选）：界面挑会话时按标题认人（见 session-title.ts）。
   *
   * 缺席 = 这次计划不要标题（工具层只报数量，不需要），因此发现阶段一分钱都不多花。
   */
  resolveTitle?: (query: TitleQuery) => string | undefined
  /**
   * 读"宿主判这条会话空白吗"（可选，见 visibility.ts）。
   *
   * 缺席 = 这次不判空白（按"显示"处理）。**有它才会**把空白会话排除在候选之外，理由见下面
   * `hiddenOf()` 的说明：这一层的候选必须与外壳侧边栏显示的那些对齐。
   */
  resolveBlank?: (query: { id: string; createdAt: number; cwd?: string }) => boolean | undefined
  /**
   * 发现阶段的进度（可选）。
   *
   * 只报**源那一遍**扫描：目录来源下它是"扫这个项目目录"，未分组来源下它是"扫整个库"——两者都是
   * 用户等的第一步，分母也只有一个。后面为展开子智能体族而扫的第二遍（不带标题）不报：它没有第二个
   * 分母可分，硬报会让界面上的条跳回 0（那正是 `ProgressEvent` 一句"各有各的分母"的意思）。
   */
  onProgress?: ProgressReporter
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
    decodeAll,
    sessionIds = null,
    unowned = false,
    title,
    includeUnowned = true,
    includeArtifacts = false,
    resolveTitle,
    resolveBlank,
    onProgress,
  } = options
  const from = (options.from ?? '').trim()
  const problems: string[] = []

  if (typeof root !== 'string' || !root) problems.push('root is required (path to the sessions root)')
  if (typeof options.to !== 'string' || !options.to) problems.push('to is required (target workspace directory)')
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
      to: options.to,
      root,
      sourceProjectDir: '',
      targetProjectDir: '',
      unowned,
      sessions: [],
      cascaded: 0,
      artifacts: null,
      registryChange: null,
      nextRegistry: null,
    }
  }

  /*
   * 目标目录换成宿主存的那个拼写（见 canonical-path.ts）：`path` 进注册表、`cwd` 进 header，两者都要是
   * 宿主会存的那个字符串——手输的结尾分隔符、`..` 段、正斜杠、大小写不一致都算另一种拼写。
   * **源那一侧不归一**：它是注册表的现状，下面那条"会话 header 的 cwd 必须等于源"的检查要按它的原样比。
   */
  const to = canonicalDir(options.to)
  const sameDirectory = from !== '' && canonicalDir(from) === to

  if (!unowned && sameDirectory) problems.push('from and to are identical — nothing to migrate')

  const regCheck = validateRegistry(registry)
  if (!regCheck.ok) problems.push(...regCheck.problems.map((p) => `registry: ${p}`))

  // 目标目录必须已存在（宿主 workspace 只能拥有真实存在的目录）
  if (!existsSync(to)) problems.push(`target directory does not exist: ${to}`)
  else if (!statSync(to).isDirectory()) problems.push(`target is not a directory: ${to}`)

  const sourceProjectDir = unowned ? '' : projectDirOf(root, from)
  const targetProjectDir = projectDirOf(root, to)
  if (!unowned && !existsSync(sourceProjectDir)) problems.push(`source project directory does not exist: ${sourceProjectDir}`)

  // 有损目录名的碰撞：源与目标项目目录若同名，会话日志会混在一起。同一个目录的**两种拼写**不是碰撞
  // （上面那条 'identical' 已经在说它了）：那时 projectKey 相同，但两个 cwd 指的是同一处。
  if (!unowned && !sameDirectory && projectKey(from) === projectKey(to)) {
    problems.push(`projectKey collision: ${from} and ${to} both encode to ${projectKey(from)}`)
  }

  /*
   * 「在册」与「被认领」是两件事（判据与理由见 accounting.ts）：注册表里登记过、但它的目录已经改名或
   * 删掉的会话，宿主那边**不算**任何工作区的成员——外壳侧边栏把它放进「未分组」。下面每一处"这条有没有
   * 主"的判断都读被认领的那一份，否则插件会把一条外壳说没人认领的会话当成"已在册"（迁移页那个来源
   * 因此永远是 0 条，而侧边栏那一组里明明摆着会话）。
   *
   * 这一份先按**源**扫出来的那批算（未分组来源那一支马上要用），级联带进来的后代在下面按全库重算一次。
   */
  let owned = new Set<string>()
  const ownedOf = (sessions: readonly DiscoveredSession[]): Set<string> =>
    new Set(accountedOwners(registry, sessions).keys())

  // 侧边栏看不见的那三类（子智能体 / 空白 / 已归档）不进候选：迁移列表的范围必须与"用户在外壳里
  // 看得见的那批"对齐，否则面板报的条数与侧边栏不一致，而这个来源里也没有任何东西能解释差额
  // （判据与理由都在 visibility.ts）。要搬一条已归档的会话，先去「会话」页取消归档。
  const archived = new Set<string>(registry?.global?.archivedSessionIds ?? [])
  const hiddenOf = (session: DiscoveredSession): HiddenReason | undefined =>
    hiddenReasonOf(session, {
      archived,
      ...(resolveBlank === undefined ? {} : { resolveBlank }),
    })
  /** 源里**因为侧边栏不显示**而没进候选的会话：点名点到它们时，问题说明要比"找不到"准确得多。 */
  const hiddenInSource = new Map<string, HiddenReason>()
  const splitHidden = (all: DiscoveredSession[]): DiscoveredSession[] =>
    all.filter((session) => {
      const reason = hiddenOf(session)
      if (reason === undefined) return true
      hiddenInSource.set(session.id, reason)
      return false
    })

  const scanOptions = {
    ...(resolveTitle === undefined ? {} : { resolveTitle }),
    ...(onProgress === undefined
      ? {}
      : { onProgress: (done: number, total: number) => onProgress({ phase: 'scan', done, total }) }),
  }
  // 源目录扫出来的那一份（含侧边栏看不见的：它们不进候选，但选中一条父会话时要把它们当中
  // "属于这条父会话的子智能体"找出来）。
  let sourceScanned: DiscoveredSession[] = []
  let discovered: DiscoveredSession[] = []
  if (unowned) {
    // 未分组来源：整个库里落在外壳侧边栏「未分组」那一组里的会话——`!owned` **且** 侧边栏会显示它
    // （两件事的合取就是 `visibility.ts` 的 `isUngrouped()`，也正是下面的 `!owned` + `splitHidden`）。
    // 没有 `cwd` 的还排除在外：`relocateHeaderCwd()` 明确拒绝改写一个没有 cwd 的 header（session-log.ts），
    // 所以它们根本搬不进来——那是这个来源自己的**能力**限制，不是「未分组」的定义（侧边栏那一组里有它们）。
    // 界面上那个来源的条数与这里必须一致，于是界面读的是宿主发来的同一个结论（planRows.unownedSessions）。
    sourceScanned = scanAll(root, decodeAll, scanOptions)
    owned = ownedOf(sourceScanned)
    discovered = splitHidden(
      sourceScanned.filter((s) => !owned.has(s.id) && typeof s.cwd === 'string' && s.cwd !== ''),
    )
  } else if (existsSync(sourceProjectDir)) {
    sourceScanned = scanProjectDir(sourceProjectDir, decodeAll, scanOptions)
    owned = ownedOf(sourceScanned)
    discovered = splitHidden(sourceScanned)
    for (const s of discovered) {
      if (s.cwd !== from) problems.push(`session ${s.id}: header cwd ${s.cwd} != ${from}`)
    }
  }

  if (sessionIds) {
    const known = new Set(discovered.map((s) => s.id))
    // 点名点到一条隐藏的会话时，子智能体那类要说清"该点名的是谁"——查的是源目录那一份。
    const sourceById = new Map(sourceScanned.map((session) => [session.id, session]))
    for (const id of sessionIds) {
      // 点名的会话不在这次来源的候选里：直接报 problem，不静默少搬（未分组来源下，
      // "在册"或"没有 cwd"的会话就落在这里——它们不是这个来源能覆盖的东西）。
      if (known.has(id)) continue
      const reason = hiddenInSource.get(id)
      if (reason !== undefined) {
        // 子智能体是"跟着父会话走"的那一类（见 family.ts）：点名它自己不会把它搬走（那是向上的
        // 牵连），该点名的是它的父会话——所以这句话要给出下一步，而不只是"我不搬它"。
        const parent = sourceById.get(id)?.header.parentSession
        problems.push(
          reason === 'subagent' && parent !== undefined
            ? `session ${id} is a subagent session (it follows its parent) — migrate its parent ${parent} instead`
            : `session ${id} is hidden from the host sidebar (${reason}) — migration does not take it`,
        )
        continue
      }
      problems.push(
        unowned ? `session ${id} is not an unowned session with a cwd` : `session ${id} not found in ${sourceProjectDir}`,
      )
    }
  }

  let selected = discovered
  if (sessionIds) selected = discovered.filter((s) => sessionIds.includes(s.id))
  if (!unowned && !includeUnowned) {
    for (const s of selected) {
      if (!owned.has(s.id)) problems.push(`session ${s.id} is not accounted by any workspace (use includeUnowned)`)
    }
  }

  // **子智能体跟着父会话走**：选中的每条会话都把它的全部后代一起带走（判据与顺序见 family.ts）。
  //
  // 找后代要扫全库：子会话的日志落在它自己 cwd 的项目目录里，而那个 cwd 未必还是父会话现在的 cwd
  // （父会话被单独迁走过一次，孩子就留在旧目录里了）——只扫源项目目录会漏掉那些，正是要修的那种
  // "族被拆成两半"。这一遍**不读标题**：全库带标题扫一遍实测 1.7s（本机 41 条），而这一遍只用来看
  // 父子关系；源目录里那份带着标题，合并时优先取它，于是跨目录的后代没有标题（预演卡片不逐条画
  // `sessions`，标题只在候选列表里用，那份来自 /state，见 migrate.ts 的 previewOf）。
  const library = unowned ? sourceScanned : scanAll(root, decodeAll)
  const merged = new Map<string, DiscoveredSession>()
  for (const session of library) merged.set(session.id, session)
  for (const session of sourceScanned) merged.set(session.id, session)
  // 级联带进来的后代可能住在别的项目目录里（上一段的理由）：认领要按这份合并后的全量重算，否则一条
  // 在别处有主的后代会被判成"从来没在册"，迁移时就不给它改挂（见下面 `registered`）。
  owned = ownedOf([...merged.values()])
  const family = familyOf([...merged.values()], selected)
  const selectedIds = new Set(selected.map((s) => s.id))

  // 目标会话目录不得已被占用
  const targetDirs = new Set<string>()
  const sessions: SessionMove[] = []
  for (const { session: s, root: familyRoot } of family) {
    // 级联带进来的（用户没点名的那几条）要说清出处：预演里会因此多出没勾过的会话。
    const via = selectedIds.has(s.id)
      ? undefined
      : { id: familyRoot.id, ...(familyRoot.title === undefined ? {} : { title: familyRoot.title }) }
    const owner = via === undefined ? '' : ` (subagent, follows ${via.title ?? via.id})`
    const targetDir = join(targetProjectDir, s.dirName)
    // 每条会话各自一个源：未分组来源下它们分散在不同项目目录里；目录来源下**级联带进来的后代**
    // 也可能不在源目录里（见上面扫全库那段），它的源只能是自己的 cwd。
    const sessionFrom = unowned || via !== undefined ? s.cwd : from
    if (sessionFrom === undefined || sessionFrom === '') {
      // 没有 cwd 就没法改写 header、也没法定位项目目录（relocateHeaderCwd 明确拒绝）。
      problems.push(`session ${s.id}${owner} has no cwd to rewrite — migration cannot take it`)
      continue
    }
    // `cwd` 已经在目标上的会话（未分组来源下很常见：这条没人认领的会话本来就住在那个目录里，
    // 只是没登记在册）不需要搬任何东西——它的"目标目录"就是自己现在的位置，所以"目标已存在"
    // 在这里不是冲突。这一支在单目录来源下够不到（`from === to` 被上面挡了），
    // 未分组来源下它是**收编**这件事的常态：只补一条注册表记录。
    // 同一个目录的另一种拼写同样算"已经在目标上"：那一支要做的只是把 header 的拼写改对。
    const alreadyAtTarget = sessionFrom === to || canonicalDir(sessionFrom) === to
    if (existsSync(targetDir) && !alreadyAtTarget) problems.push(`target session directory already exists: ${targetDir}`)
    if (targetDirs.has(targetDir)) problems.push(`duplicate target directory: ${targetDir}`)
    targetDirs.add(targetDir)
    // 项目目录名与 header 的 cwd 若已经对不上，说明这条会话落错了项目目录（宿主会判它 corrupt）——搬过去正好
    // 修好，但项目目录名相同却是另一个 cwd 时目标项目目录里会撞车，那种情况在这里挡住。
    if ((unowned || via !== undefined) && !alreadyAtTarget && projectDirOf(root, sessionFrom) === targetProjectDir) {
      problems.push(`session ${s.id}${owner}: its project directory collides with the target's (${projectKey(to)})`)
    }
    sessions.push({
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
      ...(via === undefined ? {} : { via }),
    })
  }

  if (sessions.length === 0 && problems.length === 0) problems.push('no sessions selected for migration')

  // 可选的产物搬迁：需要**全量解码**会话日志（多帧全解），比发现阶段慢得多，
  // 因此只在显式要求时做。未分组来源横跨多个目录时不做：产物定位是"相对于源目录"的
  // （planArtifactMoves 只收一个 fromDir），一次请求里没有哪一个目录当得起这个角色。
  let artifacts: RelocationPlan['artifacts'] = null
  if (includeArtifacts && unowned && sessions.length > 0) {
    problems.push('unowned source cannot relocate session artifacts (it spans several source directories)')
  } else if (includeArtifacts && sessions.length > 0) {
    const texts: Array<{ id: string; text: string }> = []
    for (const [index, s] of sessions.entries()) {
      // 产物定位要**全量解码**每份日志（多帧全解），比发现阶段贵得多：这一段同样值得一条进度。
      onProgress?.({ phase: 'read', total: sessions.length, done: index, id: s.id, label: s.title ?? s.id })
      texts.push({
        id: s.id,
        // 多代次（v3 + v4）按代次顺序拼接，与宿主读取口径一致
        text: s.files.map((f) => decodeAll(readFileSync(f.path))).join(''),
      })
    }
    artifacts = planArtifactMoves({ sessions: texts, fromDir: from, toDir: to })
    for (const p of artifacts.problems) problems.push(p)
  }

  // 注册表变更（纯计算；把问题并入 problems 而不是抛出）
  let registryChange: RelocationPlan['registryChange'] = null
  let nextRegistry: WorkspaceRegistryState | null = null
  if (sessions.length > 0 && regCheck.ok) {
    try {
      // **成员资格不因为跟着走而改变**：点名的那些照旧全部重挂（未分组的会被"收编"，与以前一致），
      // 而级联带进来的后代只有在**本来就在册**时才一起改挂——子智能体通常从来没在册过（宿主自己也不把
      // 它算进工作区成员），给它们凭空补一条登记只会让注册表里多出宿主不认的成员。
      // 排序：宿主注册表里的顺序是"新→旧"，而级联展开会打断这个顺序（父后面跟着它的孩子），
      // 所以这里按每条会话自己的 createdAt 排回来；只点名时与原来的顺序完全一致。
      const registryIds = sessions
        .filter((session) => session.via === undefined || session.registered)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((session) => session.id)
      const result = reHome(registry, { sessionIds: registryIds, toPath: to, title })
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
    sourceProjectDir,
    targetProjectDir,
    unowned,
    sessions,
    cascaded: sessions.filter((s) => s.via !== undefined).length,
    artifacts,
    registryChange,
    nextRegistry,
  }
}

/** 人类可读的计划摘要（工具返回值与预演摘要共用）。 */
export function describePlan(plan: RelocationPlan): string {
  const lines: string[] = []
  lines.push(`迁移 ${plan.sessions.length} 个会话：`)
  // 未分组来源没有"一个源目录"这回事：源项目目录由每条会话自己的 cwd 定，因此只报涉及的项目目录数。
  const sourceProjectDirs = new Set(plan.sessions.map((s) => dirname(s.sourceDir)))
  lines.push(
    plan.unowned
      ? `  （未分组：横跨 ${sourceProjectDirs.size} 个源项目目录）`
      : `  ${plan.from}`,
  )
  lines.push(`  -> ${plan.to}`)
  const files = plan.sessions.reduce((n, s) => n + s.files.length, 0)
  lines.push(`  日志文件 ${files} 个；目标项目目录 ${plan.targetProjectDir}`)
  if (plan.cascaded > 0) {
    lines.push(`  其中 ${plan.cascaded} 条是子智能体会话（跟着点名的父会话一起搬，成员资格不变）`)
  }
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
