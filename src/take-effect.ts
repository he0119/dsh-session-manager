// src/take-effect.ts — 「改完注册表之后让宿主立刻认下这处改动」的共用一步。
//
// 为什么单独一层：本插件有三处会改注册表（迁移、导入、同步拉取），三处都撞上同一件事——磁盘上的
// `workspace.json` 只是**第三份**拷贝。宿主持着内存里那份（它才是权威：`dsh-storage-json` 的单单元
// 契约定死了"写入才改它、绝不从磁盘重读"），还持着一张启动时建的"这条会话住哪儿"的缓存表。文件写对了
// 不等于宿主认了：侧边栏仍按旧归属显示，之后任何一次工作区改动还会拿内存副本把这次写盘盖掉。
//
// 所以这里做的不是"再写一次文件"，而是**把活儿交给宿主自己做**：
//   1. 先让它按磁盘重看一眼（刷新 header 缓存 + 重建活会话索引，跟它启动时做的两步一样）——不先做
//      这一步，下面 `attachSession()`会拿缓存里的旧 cwd 校验，一口回绝；
//   2. 再让它自己改：复用/新建目标工作区 → 把会话挂过去 → 从源侧摘掉 → 源侧空了就删掉。
//      这几件事它自己会写文件、也会通知界面，所以侧边栏不用刷新就变了，进程也不用重启。
//
// **它中途拒绝时还有一件必须做的事**：宿主那一步只要动过手（最迟的一次是 `ensureWorkspace()` 新建
// 工作区），它就会拿内存里那份整份落盘——插件刚写好的 `workspace.json` 当场被盖掉，磁盘上留下的是
// 宿主的旧归属。所以失败之后要把这次算好的注册表**整份写回来**（`restoreRegistry()`），"重启后一致"
// 才是真的：重启后宿主读的是磁盘，文件对了就对了。
//
// **它全盘接受、却顺手抹掉别人的归属时**，成败判据就不够用了：它那一步是拿内存里那份整份落盘的，
// 内存里没有的归属会被一起抹掉（另一台宿主写过的、或上一次写回文件之后的），而它照样一路成功。
// 所以接受之后还要拿计划与盘上那份比一次（`missingMemberships()`），少了就让宿主重新挂一遍
// （`restoreMemberships()`）——它的挂靠会立刻落盘，磁盘与侧边栏因此一起回到这次的结果上，不用重启；
// 它不认的那几条（盘上早就没有这条会话）不硬写回文件，只如实报出来。
//
// 会话 id 全程只被"挂靠 / 摘掉"，既不新建也不改名；已存在的工作区复用自己那条记录、id 不变。
//
// 本模块保持**零 DSH 依赖**：端口由宿主那半侧（`src/tools.ts` 的 `hostRegistryPort()`）探测后注入；
// 写盘只借 `registry.ts` 的原子写，与迁移 / 导入 / 同步用的是同一份。
import { missingMemberships, readRegistry, writeRegistryAtomic } from './registry.ts'
import type {
  EffectMode,
  EffectOutcome,
  HostRegistryPort,
  RegistryChange,
  WorkspaceRegistryState,
} from './types.ts'

/** 编排层要承认的最小形状：一个"这个宿主能不能当场把账改掉"的探测函数。 */
export interface EffectDeps {
  /**
   * 宿主注册表动作的探测（可选）：拿得到就返回一个端口，拿不到就是 undefined——这个宿主只能重启。
   *
   * 每次调用**重新探测**：只有工具的前端、老版本宿主都可能没有这套动作，探测结果不该被缓存。
   */
  hostRegistry?: () => HostRegistryPort | undefined
  /**
   * `workspace.json` 的路径（可选）。**给了才有力挽狂澜的那一手**：宿主没接住那一步之后，
   * 用它把这次算好的注册表整份写回来（见 `restoreRegistry()`）。
   */
  registryPath?: string
}

/** `takeEffectOnHost*()` 的选项。 */
export interface TakeEffectOptions {
  /**
   * 这次改动算出来的注册表**终态**：宿主没接住时用它整份写回文件。
   *
   * 缺席（`null` / undefined）时不做这一手，措辞也如实分岔——不能硬说文件是对的。
   */
  registry?: WorkspaceRegistryState | null
}

/**
 * 宿主没接住之后，把这次算好的注册表整份写回文件。
 * @returns 真的写回去了才 true；没有终态 / 没给路径 / 写盘本身失败都是 false，由措辞如实分岔。
 */
function restoreRegistry(deps: EffectDeps, options: TakeEffectOptions): boolean {
  const registry = options.registry
  if (deps.registryPath === undefined || registry === null || registry === undefined) return false
  try {
    writeRegistryAtomic(deps.registryPath, registry)
    return true
  } catch {
    // 写不回去也不能把已经落地的迁移说成失败：结论里那句"重启前先核对文件"会兜住。
    return false
  }
}

/**
 * 宿主接受之后，把"计划里有、盘上整份没有了"的归属要回来。
 *
 * 宿主那一步是按内存里那份整份落盘的，所以它内存里没有的归属会被一起抹掉——它自己不会发现这件事
 * （对它来说那份就是权威）。插件拿计划（`options.registry`）与盘上那份比一次，少了就让宿主重新挂
 * 一遍：`attachSession()` 会立刻把它那份落盘，磁盘与侧边栏因此一起回到这次的结果上。
 *
 * 它不认的那几条（盘上早就没有这条会话的悬空登记、header 的 cwd 与记录对不上的）**不写回文件**：
 * 写回去只会让它下次落盘再抹一次，而且那本来就不是"归属丢了"，是"宿主早就不认这条登记"。
 * @param port 宿主注册表动作的端口。
 * @param deps 编排依赖（要 `registryPath` 才复核得了）。
 * @param expected 这次算出来的注册表终态；缺席就不复核（不能拿没给的东西当判据）。
 * @returns 认下的与被回绝的会话 id；没得复核（没路径 / 没终态 / 读不到盘）时 undefined。
 */
async function restoreMemberships(
  port: HostRegistryPort,
  deps: EffectDeps,
  expected: WorkspaceRegistryState | null | undefined,
): Promise<{ restored: string[]; unrecognized: string[] } | undefined> {
  if (deps.registryPath === undefined || expected === null || expected === undefined) return undefined
  let missing
  try {
    missing = missingMemberships(expected, readRegistry(deps.registryPath))
  } catch {
    // 盘上那份读不出来时不猜：这是复核的事，由编排层照旧报出来，别在这里悄悄动手。
    return undefined
  }
  if (missing.length === 0) return undefined
  const restored: string[] = []
  const unrecognized: string[] = []
  try {
    // 再让它按磁盘看一眼：它内存里没有的会话，header 缓存里往往也没有，不刷一遍会被它一口回绝。
    await port.refreshIndex()
  } catch {
    // 连刷新都被回绝时不硬来：全部如实报成"没要回来"。
    return { restored: [], unrecognized: missing.map((item) => item.sessionId) }
  }
  for (const item of missing) {
    try {
      const workspaceId = await port.ensureWorkspace(item.path, item.title)
      await port.attachSession(workspaceId, item.sessionId)
      restored.push(item.sessionId)
    } catch {
      unrecognized.push(item.sessionId)
    }
  }
  return { restored, unrecognized }
}

/**
 * 把一串注册表改动交给宿主自己做（调用顺序有讲究，见下面逐条注释）。
 * @param port 宿主注册表动作的端口。
 * @param change 计划算出来的那几条改动。
 * @param options.refreshIndex - 是否先让它重看一眼磁盘（缺省做）。一批改动只在开头做一次——
 *   重看的是磁盘，而这一批的日志早就都改好了，没必要每笔都重扫一遍。
 * @param options.newTargetIds - 同一批里**前面几笔新建**目标工作区时计划预测的 id。新建的目标由宿主
 *   分配 id，计划里那个只是预测；后面几笔的计划把预测值当成"已存在"，于是会与宿主给的 id 不符——
 *   那种不符要放行，它不是"改动了已有工作区的 id"。
 * @returns 宿主实际用的目标工作区 id（新建时由宿主分配）。
 * @throws 宿主拒绝（例如目标工作区 id 与计划不符）时抛错，由调用方如实回报成"仍需重启"。
 */
export async function applyOnHost(
  port: HostRegistryPort,
  change: RegistryChange,
  options: { refreshIndex?: boolean; newTargetIds?: ReadonlySet<string> } = {},
): Promise<string> {
  // ① 先让它重看一眼磁盘：缓存里的 header 还是旧 cwd，直接挂靠会被它挡回来。
  if (options.refreshIndex !== false) await port.refreshIndex()

  // ② 复用或新建目标工作区。已存在时它必须把**同一个** id 还给我们——这条一旦不成立，说明
  //    我们和宿主对这份注册表的理解已经分叉，宁可当场停下报"仍需重启"，也不要悄悄换个 id。
  const targetId = await port.ensureWorkspace(change.targetPath, change.targetTitle)
  const predictedNew = options.newTargetIds?.has(change.targetId) ?? false
  if (!change.createdTarget && !predictedNew && targetId !== change.targetId) {
    throw new Error(`宿主给出的目标工作区 id 与计划不符：${change.targetId} -> ${targetId}`)
  }

  // ③ 挂过去（端口负责追加到末尾，与计划里的顺序一致）。
  for (const sessionId of change.added) await port.attachSession(targetId, sessionId)

  // ④ 从每个源工作区摘掉。
  for (const source of change.movedFrom) {
    for (const sessionId of source.sessionIds) await port.detachSession(source.workspaceId, sessionId)
  }

  // ⑤ 计划里要删的源工作区：确认真的空了才删（拿实际成员数说话，不靠计划推断）。
  for (const source of change.removedSources) {
    if ((await port.members(source.workspaceId)).length === 0) await port.removeWorkspace(source.workspaceId)
  }
  return targetId
}

/**
 * 让宿主当场认下这处改动。
 *
 * 拿不到端口、或宿主中途拒绝，都**如实回报而不抛**——文件已经写好了，这里失败不该把一次成功的
 * 迁移 / 导入说成失败。
 * @param change 这次改动（`null` 或 `unchanged` 表示注册表本来就不用改，那就不必打扰宿主）。
 * @param deps 编排依赖（只看 `hostRegistry` 与 `registryPath`）。
 * @param options 见 `TakeEffectOptions`（算好的注册表终态：宿主没接住时写回文件用）。
 * @returns 三态结论；措辞交给 `describeEffect()`。
 */
export function takeEffectOnHost(
  change: RegistryChange | null,
  deps: EffectDeps,
  options: TakeEffectOptions = {},
): Promise<EffectOutcome> {
  return takeEffectOnHostAll(change === null || change.unchanged ? [] : [change], deps, options)
}

/**
 * 一次落地里的一串改动按顺序交给宿主（同步一次可能拉进来好几条，每条各带一份注册表改动）。
 *
 * 任何一条失败就整体报失败：宿主那边可能只改到一半，文件是写对了的，所以退路仍是"重启后一致"。
 * @param changes 按执行顺序排好的改动（`unchanged` 的会被跳过）。
 * @param deps 编排依赖（只看 `hostRegistry` 与 `registryPath`）。
 * @param options 见 `TakeEffectOptions`。
 * @returns 三态结论；一条都不用改时直接算 `applied`。
 */
export async function takeEffectOnHostAll(
  changes: readonly RegistryChange[],
  deps: EffectDeps,
  options: TakeEffectOptions = {},
): Promise<EffectOutcome> {
  const todo = changes.filter((change) => !change.unchanged)
  if (todo.length === 0) return { kind: 'applied' }
  let port: HostRegistryPort | undefined
  try {
    port = deps.hostRegistry?.()
  } catch (error) {
    return {
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
      registryRestored: restoreRegistry(deps, options),
    }
  }
  if (port === undefined) return { kind: 'unavailable' }
  let targetId: string | undefined
  // 这一批里前面几笔新建的目标：它们的 id 是宿主分配的，计划里那个只是预测（见 `applyOnHost()`）。
  const newTargetIds = new Set<string>()
  try {
    // 整批只重看一次磁盘（见 `applyOnHost()` 的 `refreshIndex`）。
    await port.refreshIndex()
    for (const change of todo) {
      targetId = await applyOnHost(port, change, { refreshIndex: false, newTargetIds })
      if (change.createdTarget) newTargetIds.add(change.targetId)
    }
  } catch (error) {
    // 宿主可能已经写过一次文件（最迟在 `ensureWorkspace()` 新建工作区那一步）：把它盖掉的写回来。
    return {
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
      registryRestored: restoreRegistry(deps, options),
    }
  }
  // 它全盘接受、却拿内存里那份把别人的归属一起抹掉时，上面这条路是察觉不到的（见 `restoreMemberships()`）。
  let memberships: { restored: string[]; unrecognized: string[] } | undefined
  try {
    memberships = await restoreMemberships(port, deps, options.registry)
  } catch {
    // 要回来这一步本身出错不能反过来把已经落地的改动说成失败：这只是一次补偿。
    memberships = undefined
  }
  return {
    kind: 'applied',
    ...(targetId === undefined ? {} : { targetId }),
    ...(memberships === undefined || memberships.restored.length === 0
      ? {}
      : { membershipsRestored: memberships.restored }),
    ...(memberships === undefined || memberships.unrecognized.length === 0
      ? {}
      : { membershipsUnrecognized: memberships.unrecognized }),
  }
}

/**
 * 这次改动"已经怎样"的措辞，工具层与界面层共用这一份。
 * @param outcome 真的改完之后拿到的结果。
 * @returns 一句给人看的结论。
 */
export function describeEffect(outcome: EffectOutcome): string {
  switch (outcome.kind) {
    case 'applied': {
      const restored = outcome.membershipsRestored?.length ?? 0
      const unrecognized = outcome.membershipsUnrecognized?.length ?? 0
      const lines = ['宿主已经自己改完这份注册表（会话只在工作区之间换归属，id 没变），侧边栏这就跟上了，无需重启 DSH。']
      if (restored > 0) {
        // 它那一步是拿内存里那份整份落盘的：内存里没有的归属会被一起抹掉，所以要回来（见 restoreMemberships()）。
        lines.push(
          `复核发现它顺手抹掉了 ${restored} 条别的归属（它内存里本来就没有这些会话），` +
            '已让它重新认下——磁盘与侧边栏都回到这次的结果上。',
        )
      }
      if (unrecognized > 0) {
        lines.push(`另有 ${unrecognized} 条归属宿主不认（盘上已经没有这些会话），没有写回文件。`)
      }
      return lines.join('\n')
    }
    case 'failed':
      // 宿主一旦动过手就会按内存整份落盘：写回来了才敢说"磁盘上就是这次的结果"（见 `restoreRegistry()`）。
      return outcome.registryRestored === true
        ? `宿主没接住这次改动（${outcome.error ?? '原因未知'}）：` +
            '注册表已按这次的结果重新写回磁盘，重启 DSH 后一致；重启前请勿再改任何工作区，' +
            '新建 / 改名 / 归档都会用内存副本把这处改动覆盖掉。'
        : `宿主没接住这次改动（${outcome.error ?? '原因未知'}）：` +
            '仍需重启 DSH 才会生效，但宿主可能已经用它内存里那份覆盖过磁盘——重启前请先核对注册表，' +
            '必要时重跑一次；重启前请勿再改任何工作区。'
    case 'file-only':
      return (
        '注册表已按备份整份写回（工作区 id 原样保留，所以这条路不走宿主那套动作），' +
        '宿主手里那份还是旧的，需重启 DSH 后才会生效。'
      )
    case 'unavailable':
      return (
        '注册表已写入磁盘，但这个宿主没有让插件当场改账的入口（只有工具的前端或老版本），需重启 DSH 后才会生效；' +
        '重启前请勿再改任何工作区，新建 / 改名 / 归档都会用内存副本把这处改动覆盖掉。'
      )
  }
}

/**
 * 计划 / 预演口径：这次改动**执行时**会不会当场生效。
 *
 * 与 `describeEffect()` 分开：那个说的是"已经发生的事"，这个说的是"会发生的事"。
 * @param mode 探测到的生效模式（`src/tools.ts` 的 `effectMode()`）。
 * @returns 一句给人看的结论。
 */
export function describePlannedEffect(mode: EffectMode): string {
  return mode === 'immediate'
    ? '执行时由宿主自己改这份注册表（会话换归属，id 不变），无需重启 DSH。'
    : '执行后需要重启 DSH 才会生效；重启前请勿再改任何工作区。'
}

/**
 * "这次到底怎样生效"：真的改过注册表就认执行结果，没改过才退到探测。
 *
 * 两个入口共用它——否则会一边按探测说"无需重启"、一边执行路径其实没让宿主接住。
 * @param outcome 执行结果里带回的结论；缺席 = 这次没改注册表。
 * @param fallback 没改注册表时的探测结论。
 * @returns 报给调用方 / 界面的生效模式。
 */
export function effectOf(outcome: EffectOutcome | undefined, fallback: EffectMode): EffectMode {
  if (outcome === undefined) return fallback
  return outcome.kind === 'applied' ? 'immediate' : 'restart-required'
}
