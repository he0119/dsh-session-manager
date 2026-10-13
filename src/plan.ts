// src/plan.ts — 迁移计划：只读地算出"将会发生什么"，不写任何字节。
//
// 计划是一等产物：apply 只接受一个 plan 对象，rollback 只依赖备份清单。
// 这样 dry-run 与真实执行走的是同一段代码，避免"预览和实做不一致"。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { accountedOwners } from './accounting.ts'
import { planArtifactMoves } from './artifacts.ts'
import { canonicalDir } from './canonical-path.ts'
import { projectDirOf, scanAll, type DiscoveredSession } from './discovery.ts'
import { familyOf } from './family.ts'
import { projectKey } from './project-key.ts'
import { reHome, validateRegistry } from './registry.ts'
import type { TitleQuery } from './session-title.ts'
import type {
  DecodeAll,
  LiveSkip,
  ProgressReporter,
  RelocationPlan,
  SessionMove,
  StrandedMember,
  StrandedReason,
  StrandedSource,
  WorkspaceRegistryState,
} from './types.ts'
import { hiddenReasonOf, type HiddenReason } from './visibility.ts'

/**
 * `buildRelocationPlan()` 的选项。
 *
 * **没有"源目录"这个参数**：源就是 `sessionIds` 点名的那些会话，每条会话的源目录是它自己的 `cwd`。
 * 于是"把删掉的项目文件夹里那几条迁到重建后的位置"就是：点名它们 + 给一个目标目录。
 */
export interface BuildPlanOptions {
  /** 会话根目录（即 `$DSH_HOME/sessions`）。 */
  root: string
  /** 已解析的 workspace 注册表对象。 */
  registry: WorkspaceRegistryState
  /**
   * 要迁移的会话 id（**必填、非空**）。它们可以来自不同的目录：每条会话各自的源目录是它的 `cwd`，
   * 一个目标装下全部。空数组/缺省 = 没点名，计划如实报 `sessionIds is required`。
   */
  sessionIds?: readonly string[] | null
  /** 目标工作区目录（绝对路径，必须已存在）。 */
  to: string
  decodeAll: DecodeAll
  /** 目标工作区新建时的标题。 */
  title?: string
  /** 是否同时规划"会话中创建的文件"的搬迁（默认 false；需要全量解码，较慢）。 */
  includeArtifacts?: boolean
  /**
   * 读会话名称（可选）：界面挑会话时按标题认人（见 session-title.ts）。
   *
   * 缺席 = 这次计划不要标题（工具层只报数量，不需要），因此发现阶段一分钱都不多花。
   */
  resolveTitle?: (query: TitleQuery) => string | undefined
  /**
   * 读"宿主判这条会话空白吗"（可选，见 visibility.ts）。
   *
   * 缺席 = 这次不判空白（按"显示"处理）。**有它才会**把空白会话从可迁移的那批里排掉，理由见下面
   * `hiddenOf()` 的说明：这一层收的必须与外壳侧边栏显示的那些对齐。
   */
  resolveBlank?: (query: { id: string; createdAt: number; cwd?: string }) => boolean | undefined
  /**
   * 宿主持在内存里的会话 id（可选，见 `visibility.ts` 之外的这一条：`liveSessionIds()`）。
   *
   * 这一批**不能搬**，理由两条都是硬的：① 宿主改归属时会拿内存里那份 header 校验 `cwd`，而那条会话的
   * 内存 header 还是旧路径（磁盘上早改好了也没用），挂靠一定被回绝；② 宿主手里还有它的写句柄，日志被
   * 搬走之后它照样往旧路径写。所以它们被排除在候选之外、留在原目录、归属不变，只是**如实报出来**
   * （`RelocationPlan.liveSkipped`）。
   *
   * 缺席 = 这次不判（只有工具的前端 / 老版本宿主）。
   */
  live?: ReadonlySet<string>
  /**
   * 发现阶段的进度（可选）。
   *
   * 只报**这一遍**扫描（整库：点名的那几条可能散在任意项目目录里）：它是用户等的第一步，分母也只有
   * 一个。为展开子智能体族要用的那份父子关系就在同一次扫描里，不再有第二遍（`ProgressEvent` 一句
   * "各有各的分母"）。
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
    title,
    includeArtifacts = false,
    resolveTitle,
    resolveBlank,
    live = new Set<string>(),
    onProgress,
  } = options
  const problems: string[] = []

  if (typeof root !== 'string' || !root) problems.push('root is required (path to the sessions root)')
  if (typeof options.to !== 'string' || !options.to) problems.push('to is required (target workspace directory)')
  // 点名的会话：去重、去掉空白项，保持点名顺序（预演与备份都按这个顺序读）。
  const requested = Array.isArray(options.sessionIds)
    ? [...new Set(options.sessionIds.filter((id): id is string => typeof id === 'string' && id !== ''))]
    : []
  if (requested.length === 0) problems.push('sessionIds is required (the sessions to migrate)')
  if (problems.length) {
    return {
      ok: false,
      problems,
      sessionIds: requested,
      to: options.to,
      root,
      sourceProjectDirs: [],
      targetProjectDir: '',
      sessions: [],
      liveSkipped: [],
      strandedSources: [],
      cascaded: 0,
      artifacts: null,
      registryChange: null,
      nextRegistry: null,
    }
  }

  /*
   * 目标目录换成宿主存的那个拼写（见 canonical-path.ts）：`path` 进注册表、`cwd` 进 header，两者都要是
   * 宿主会存的那个字符串——手输的结尾分隔符、`..` 段、正斜杠、大小写不一致都算另一种拼写。
   * **源那一侧不归一**：它是注册表的现状，逐条比对要靠它的原样。
   */
  const to = canonicalDir(options.to)

  const regCheck = validateRegistry(registry)
  if (!regCheck.ok) problems.push(...regCheck.problems.map((p) => `registry: ${p}`))

  // 目标目录必须已存在（宿主 workspace 只能拥有真实存在的目录）
  if (!existsSync(to)) problems.push(`target directory does not exist: ${to}`)
  else if (!statSync(to).isDirectory()) problems.push(`target is not a directory: ${to}`)

  const targetProjectDir = projectDirOf(root, to)

  // 侧边栏看不见的那三类（子智能体 / 空白 / 已归档）搬不走：点名点到它们时报一条问题说明，而不是
  // 静默少搬（判据与理由都在 visibility.ts）。要搬一条已归档的会话，先去「会话」页取消归档。
  const archived = new Set<string>(registry?.global?.archivedSessionIds ?? [])
  const hiddenOf = (session: DiscoveredSession): HiddenReason | undefined =>
    hiddenReasonOf(session, {
      archived,
      ...(resolveBlank === undefined ? {} : { resolveBlank }),
    })
  /** 整库里**因为侧边栏不显示**而搬不走的会话：点名点到它们时，问题说明要比"找不到"准确得多。 */
  const hiddenInLibrary = new Map<string, HiddenReason>()
  const splitHidden = (all: DiscoveredSession[]): DiscoveredSession[] =>
    all.filter((session) => {
      const reason = hiddenOf(session)
      if (reason === undefined) return true
      hiddenInLibrary.set(session.id, reason)
      return false
    })

  /*
   * 宿主持在内存里的那批（`live`）与侧边栏看不见的那三类一样，搬不走——但**理由不同**，处置也不同：
   * 那三类是"用户在外壳里看不见、要搬先去会话页处理"，这一批是"宿主正攥着它，这次搬不动"，等它放手
   * （重启 DSH）之后还能再迁一次。所以不能只把它们从可搬的那批里滤掉：`liveSkipped` 要一路报到预演、
   * 工具返回值与界面上，否则用户看到的就是"勾了 22 条、搬走 9 条"而没有任何解释。
   *
   * 名单里的来源有两处：点名的那几条里活着的（下面 `splitLive`）、以及它们的后代里活着的（`noteLive`）
   * ——后者同样不能搬，不然族会被拆成两半还说不清为什么。
   */
  const liveSkipped = new Map<string, LiveSkip>()
  const noteLive = (session: DiscoveredSession): void => {
    liveSkipped.set(session.id, {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      createdAt: session.createdAt,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    })
  }
  const splitLive = (all: DiscoveredSession[]): DiscoveredSession[] =>
    all.filter((session) => {
      if (!live.has(session.id)) return true
      noteLive(session)
      return false
    })

  const scanOptions = {
    ...(resolveTitle === undefined ? {} : { resolveTitle }),
    ...(onProgress === undefined
      ? {}
      : { onProgress: (done: number, total: number) => onProgress({ phase: 'scan', done, total }) }),
  }
  /*
   * **一遍整库扫描**：点名的会话可能散在任意项目目录里（勾选跨目录就是常态），父子关系与认领也都在
   * 同一份上算——不再有"源目录那一遍 + 为查族扫的第二遍"。这一遍不带标题的话就是纯 header 扫描，
   * 带标题时与 `/state` 同一份开销（见 web.ts 的说明）。
   */
  const library = scanAll(root, decodeAll, scanOptions)
  const discovered = splitLive(splitHidden(library))
  const byId = new Map(library.map((session) => [session.id, session]))

  // 点名的那几条：不在可搬的那批里就逐条报问题（隐藏 / 宿主攥着 / 根本没有这条），不静默少搬。
  const known = new Set(discovered.map((session) => session.id))
  const requestedIds = new Set(requested)
  for (const id of requested) {
    if (known.has(id)) continue
    const reason = hiddenInLibrary.get(id)
    if (reason !== undefined) {
      // 子智能体是"跟着父会话走"的那一类（见 family.ts）：点名它自己不会把它搬走（那是向上的
      // 牵连），该点名的是它的父会话——所以这句话要给出下一步，而不只是"我不搬它"。
      const parent = byId.get(id)?.header.parentSession
      problems.push(
        reason === 'subagent' && parent !== undefined
          ? `session ${id} is a subagent session (it follows its parent) — migrate its parent ${parent} instead`
          : `session ${id} is hidden from the host sidebar (${reason}) — migration does not take it`,
      )
      continue
    }
    /*
     * 点名的会话宿主持着：这次搬不动（理由见 `BuildPlanOptions.live`），但**不算问题**——它已经进了
     * `liveSkipped`，预演、工具返回值与界面都会说清"少搬了这几条、重启 DSH 之后再迁"。
     *
     * 与隐藏的那三类不同：宿主放手之后它就是能搬的（重启即可），所以这里不拦下整份计划；而界面那一侧
     * 也会把这类行置灰（`/state` 报得出每条的 live），正常路径上勾不到它。
     */
    if (liveSkipped.has(id)) continue
    problems.push(`session ${id} not found in the session library`)
  }

  const selected = discovered.filter((session) => requestedIds.has(session.id))
  /*
   * 「在册」与「被认领」是两件事（判据与理由见 accounting.ts）：注册表里登记过、但它的目录已经改名或
   * 删掉的会话，宿主那边**不算**任何工作区的成员——外壳侧边栏把它放进「未分组」（那只是标签）。下面
   * 每一处"这条有没有主"的判断都读被认领的那一份：`registered` 与"哪些登记已经悬空"。按整库算一次，
   * 级联带进来的后代在别处有主时也一起算进去。
   */
  const owned = new Set(accountedOwners(registry, library).keys())

  // **子智能体跟着父会话走**：点名的每条会话都把它的全部后代一起带走（判据与顺序见 family.ts）。
  // 全库那一份已经在手上，不需要再扫一遍。
  const family = familyOf(library, selected)
  const selectedIds = new Set(selected.map((s) => s.id))

  // 目标会话目录不得已被占用
  const targetDirs = new Set<string>()
  const sessions: SessionMove[] = []
  for (const { session: s, root: familyRoot } of family) {
    // 级联带来的后代里活着的那些同样搬不动（见上面 `noteLive`）：跳过它、记下来、往下走。
    // 其余的照搬——一条活着的后代不该把整个族拦下（它自己那次重启后再迁就是）。
    if (live.has(s.id)) {
      noteLive(s)
      continue
    }
    // 级联带进来的（用户没点名的那几条）要说清出处：预演里会因此多出没勾过的会话。
    const via = selectedIds.has(s.id)
      ? undefined
      : { id: familyRoot.id, ...(familyRoot.title === undefined ? {} : { title: familyRoot.title }) }
    const owner = via === undefined ? '' : ` (subagent, follows ${via.title ?? via.id})`
    const targetDir = join(targetProjectDir, s.dirName)
    // **每条会话的源就是它自己的 cwd**：点名的那几条按它们各自所在目录算，级联带进来的后代也一样
    // （后代的 cwd 未必还是父会话现在的 cwd，见上面扫全库那一段）。
    const sessionFrom = s.cwd
    if (sessionFrom === undefined || sessionFrom === '') {
      // 没有 cwd 就没法改写 header、也没法定位项目目录（relocateHeaderCwd 明确拒绝）。
      problems.push(`session ${s.id}${owner} has no cwd to rewrite — migration cannot take it`)
      continue
    }
    // `cwd` 已经在目标上的会话不需要搬任何东西——它的"目标目录"就是自己现在的位置，所以"目标已存在"
    // 在这里不是冲突。够得到它的是三种情形：勾选里本来就混了目标目录的会话（跨目录勾选）、级联带进来
    // 的后代、以及"同一个目录的另一种拼写"（那时只是把 header 的拼写改对）。
    const alreadyAtTarget = sessionFrom === to || canonicalDir(sessionFrom) === to
    if (existsSync(targetDir) && !alreadyAtTarget) problems.push(`target session directory already exists: ${targetDir}`)
    if (targetDirs.has(targetDir)) problems.push(`duplicate target directory: ${targetDir}`)
    targetDirs.add(targetDir)
    // 项目目录名与 header 的 cwd 若已经对不上，说明这条会话落错了项目目录（宿主会判它 corrupt）——搬过去正好
    // 修好，但项目目录名相同却是另一个 cwd 时目标项目目录里会撞车，那种情况在这里挡住。
    if (!alreadyAtTarget && projectDirOf(root, sessionFrom) === targetProjectDir) {
      problems.push(
        `session ${s.id}${owner}: projectKey collision with the target (${projectKey(to)}) — ` +
          "its project directory would mix with the target's",
      )
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

  if (sessions.length === 0 && problems.length === 0) {
    // 一条都没剩、而且原因是"全被宿主持着"：说清这一点，别让用户拿"没选中会话"去查勾选。
    problems.push(
      liveSkipped.size > 0
        ? `every ticked session is live in the host (${liveSkipped.size}) — restart DSH, then migrate them`
        : 'no sessions selected for migration',
    )
  } else if (sessions.length > 0 && sessions.every((s) => s.alreadyAtTarget && s.sourceDir === s.targetDir)) {
    /*
     * 点名的每一条都已经住在目标目录里（目标就是它们现在这个目录）：目录不用搬、header 也不用改，
     * 这一次没有东西可搬。报出来而不是走一遍空流程——那会留下一个什么都没做的备份，还会把注册表
     * 重写一遍。**只在这条判据真的成立时才报**：另一种拼写（`canonicalDir` 相等但字符串不同）与
     * "级联的后代本来就住在目标里"都不是空流程，前者要改 header 的拼写、后者要改归属。
     */
    problems.push('every ticked session already lives in the target directory — nothing to migrate')
  }

  /*
   * 可选的产物搬迁：需要**全量解码**会话日志（多帧全解），比发现阶段慢得多，因此只在显式要求时做。
   *
   * 产物在日志里是**相对会话自己的 cwd** 记的（`planArtifactMoves()` 把 `fromDir` 当那个基准读
   * `extractArtifactsFromLog({ cwd })`），而勾选可以跨目录：所以这里按"每条会话自己的源目录"分组、
   * 每组各规划一次再拼起来。拿一个目录当唯一基准的话，别的来源目录里那几条的产物会按错误的 cwd
   * 解释（相对路径被拼到别人家去），这一层正是要修掉它。
   */
  let artifacts: RelocationPlan['artifacts'] = null
  if (includeArtifacts && sessions.length > 0) {
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
    const byFromDir = new Map<string, Array<{ id: string; text: string }>>()
    for (const [index, move] of sessions.entries()) {
      const group = byFromDir.get(move.from) ?? []
      group.push(texts[index]!)
      byFromDir.set(move.from, group)
    }
    const merged: NonNullable<RelocationPlan['artifacts']> = { moves: [], problems: [], skipped: [] }
    // 按来源目录排序再算：跨目录勾选时"先算哪一组"不该由勾选顺序决定（越界问题清单要可比）。
    for (const fromDir of [...byFromDir.keys()].sort()) {
      const result = planArtifactMoves({ sessions: byFromDir.get(fromDir)!, fromDir, toDir: to })
      merged.moves.push(...result.moves)
      merged.problems.push(...result.problems)
      merged.skipped.push(...result.skipped)
    }
    artifacts = merged
    for (const p of merged.problems) problems.push(p)
  }

  /*
   * 登记了、宿主却不认的会话 id（盘上已经没有这条会话，或 header 的 cwd 归一之后对不上记录的 `path`）。
   *
   * 判"源工作区被搬空了吗"不能拿它们当筹码：宿主自己就是按"认领"算成员的（见 accounting.ts），
   * 侧边栏早就把它们当不存在；只看登记数组的话，这些悬空登记会把那条工作区记录永远钉住。
   * `owned` 按**整库**算的那一份就是这里要读的。
   */
  const accountedIds = new Set(owned.keys())
  const staleSessionIds = new Set<string>()
  for (const record of Object.values(registry.tables.workspaces)) {
    for (const sid of record.sessionIds) if (!accountedIds.has(sid)) staleSessionIds.add(sid)
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
      const result = reHome(registry, { sessionIds: registryIds, toPath: to, title, staleSessionIds })
      nextRegistry = result.registry
      registryChange = result.change
    } catch (error) {
      problems.push(`registry re-home failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 搬完还剩人的源工作区：留下的都是**侧边栏不显示**的会话（宿主认的成员，判据见 visibility.ts），
  // 这次搬不走、那块记录也就删不掉。理由必须跟着预演与结果一起报出去（见 describeStranded()）。
  const strandedSources: StrandedSource[] = []
  if (registryChange !== null && nextRegistry !== null) {
    const removed = new Set(registryChange.removedSources.map((source) => source.workspaceId))
    for (const moved of registryChange.movedFrom) {
      if (removed.has(moved.workspaceId)) continue
      const record = nextRegistry.tables.workspaces[moved.workspaceId]
      if (record === undefined) continue
      const members: StrandedMember[] = []
      for (const sid of record.sessionIds) {
        const session = byId.get(sid)
        const reason = session === undefined ? undefined : hiddenOf(session)
        // 没被点名、可见的那几条是"用户自己挑的子集"，不在这里报——这一段说的是"搬不走的"。
        // 宿主持着的那些由 liveSkipped 单独报账。
        if (reason === undefined) continue
        members.push({ id: sid, ...(session?.title === undefined ? {} : { title: session.title }), reason })
      }
      if (members.length > 0) {
        strandedSources.push({ workspaceId: moved.workspaceId, path: record.path, title: record.title, members })
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    sessionIds: requested,
    to,
    root,
    sourceProjectDirs: [...new Set(sessions.map((s) => dirname(s.sourceDir)))].sort(),
    targetProjectDir,
    sessions,
    liveSkipped: [...liveSkipped.values()],
    strandedSources,
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
  // 源可能有几处（勾选跨目录时就是这样）：逐条列出项目目录，不写"多个来源"这种含糊话。
  lines.push(`  来源项目目录：${plan.sourceProjectDirs.join('、')}`)
  lines.push(`  -> ${plan.to}`)
  const files = plan.sessions.reduce((n, s) => n + s.files.length, 0)
  lines.push(`  日志文件 ${files} 个；目标项目目录 ${plan.targetProjectDir}`)
  if (plan.cascaded > 0) {
    lines.push(`  其中 ${plan.cascaded} 条是子智能体会话（跟着点名的父会话一起搬，成员资格不变）`)
  }
  if (plan.liveSkipped.length > 0) {
    // 少搬就说少搬：逐条点名，用户才知道是哪几条、下一次该迁谁（只有重启 DSH 才能让宿主放手）。
    lines.push(
      `  另有 ${plan.liveSkipped.length} 条会话宿主持在内存里（还活着），这次不搬：` +
        plan.liveSkipped.map((s) => s.id).join('、'),
    )
    lines.push('    它们留在原目录、归属不变；重启 DSH 之后再迁一次即可。')
  }
  lines.push(...describeStranded(plan.strandedSources))
  if (plan.artifacts) {
    lines.push(`  会话产物：待搬 ${plan.artifacts.moves.length} 项、跳过 ${plan.artifacts.skipped.length} 项`)
  }
  if (plan.registryChange) {
    const c = plan.registryChange
    const staleCount = c.droppedStale.reduce((n, entry) => n + entry.sessionIds.length, 0)
    lines.push(
      `  注册表：目标工作区 ${c.targetId}${c.createdTarget ? '（新建，前插）' : '（复用）'}；` +
        `新增归属 ${c.added.length}（其中未分组收编 ${c.adoptedFromUnowned.length}）；` +
        `摘除自 ${c.movedFrom.length} 个工作区；删除空工作区 ${c.removedSources.length}` +
        `${staleCount > 0 ? `；顺带清掉 ${staleCount} 条宿主不认的悬空登记` : ''}`,
    )
  }
  if (plan.problems.length) {
    lines.push(`  问题 ${plan.problems.length} 项：`)
    for (const p of plan.problems) lines.push(`    - ${p}`)
  }
  return lines.join('\n')
}

/** `describeStranded()` 里三种理由的称呼与顺序（与 visibility.ts 的判据顺序一致）。 */
const STRANDED_LABELS: ReadonlyArray<readonly [StrandedReason, string]> = [
  ['subagent', '子智能体'],
  ['blank', '空白'],
  ['archived', '已归档'],
]

/**
 * 源工作区"搬完还剩人"那两行的措辞。
 *
 * 为什么两行都得说：留下的那几条**不在**这次的清单里（它们侧边栏不显示，见 visibility.ts），
 * 而不说清楚，用户看到的就是"全部迁完了，怎么还有一块空工作区"——预留一个"少搬了但没人提"的坑，
 * 与 `liveSkipped` 那句是同一个口径。
 *
 * @param sources 见 `RelocationPlan.strandedSources`。
 * @returns 摘要里要追加的行（空数组 = 每块源工作区都搬空了）。
 */
export function describeStranded(sources: readonly StrandedSource[]): string[] {
  const members = sources.flatMap((source) => source.members)
  if (members.length === 0) return []
  const reasons = STRANDED_LABELS.map(([reason, label]) => ({
    label,
    count: members.filter((member) => member.reason === reason).length,
  }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.label} ${item.count}`)
    .join('、')
  return [
    `  另有 ${members.length} 条会话侧边栏不显示（${reasons}），这次不搬：${members.map((member) => member.id).join('、')}`,
    `    它们留在 ${sources.map((source) => source.path).join('、')}，那几块工作区因此不会被删——` +
      '要清掉它们：已归档的先去「会话」页取消归档、空白的删掉、子智能体连着它的父会话一起迁，然后再迁一次。',
  ]
}
