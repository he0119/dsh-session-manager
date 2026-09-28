// src/visibility.ts — 「外壳侧边栏会不会显示这条会话」这一条判据的唯一一份实现（零 DSH 依赖）。
//
// 为什么需要它：本插件的列表（导出、迁移、管理）看的是**磁盘上的会话库**，而侧边栏看的是宿主那份
// 会话列表再过一遍 `sessionVisible()`。两边不一致时，用户会看到"面板说 4 条、侧边栏只显示 1 条"，
// 而没有任何一处能解释差在哪。宿主那一侧一共有三条隐藏理由（按它自己的判据顺序）：
//
//   1. `origin === "subagent"`：子代理会话。它在侧边栏里**不是没有位置**，而是嵌在父会话下面
//      （`subagentCatalog` 那一层），所以不该混进"我的会话"的列表里；
//   2. 空白会话（`sessionListMetadata.blank`）：建出来但一轮都没开始过（日志里只有 seed 事件、
//      没有 `turn/start`）。侧边栏默认不显示它（只有当前正在用的那条临时 New Session 例外）；
//   3. 已归档：`global.archivedSessionIds` 里的那些，默认归档过滤器下不显示。
//
// 三条的**顺序**也是宿主的顺序，所以一条会话同时符合多条时，这里报的是宿主先判的那条——界面上的
// 说明文字因此与用户"它在侧边栏为什么没有"的直觉一致。
//
// 缺失即"看不见"这件事要保守：`blank` 读不到时按 `false` 处理（＝显示），这与宿主自己的冷会话口径
// 一致（`summarizeCold()` 用 `metadata?.blank ?? false`）。反过来假设它空白，就会把一条用户看得见的
// 会话从迁移候选里悄悄拿掉，那是这里最不该犯的错。
import { readProjectionCache, type ProjectionCacheQuery } from './projection-cache.ts'

/** 侧边栏不显示这条会话的原因。 */
export type HiddenReason = 'subagent' | 'blank' | 'archived'

/** 判"看不见"用到的三件事（都缺省 = 都看不见的条件都不成立）。 */
export interface VisibilityFacts {
  /** 日志 header 里的 `origin`（只有子代理会话会写）。 */
  origin?: string
  /** 宿主投影缓存里的 `sessionListMetadata.blank`；`undefined` = 宿主没说。 */
  blank?: boolean
  /** id 是否在注册表的 `global.archivedSessionIds` 里。 */
  archived?: boolean
}

/**
 * 按宿主的判据顺序给出"为什么不显示"。
 * @param facts 三件事。
 * @returns 原因；`undefined` = 侧边栏会显示这条会话。
 */
export function hiddenReason(facts: VisibilityFacts): HiddenReason | undefined {
  if (facts.origin === 'subagent') return 'subagent'
  if (facts.blank === true) return 'blank'
  if (facts.archived === true) return 'archived'
  return undefined
}

/** 一条会话的可见性输入：只需要这几样（`DiscoveredSession` 与界面行都满足）。 */
export interface VisibilitySubject {
  id: string
  createdAt: number
  cwd?: string
  header: { origin?: string }
}

/** `hiddenReasonOf()` 的选项。 */
export interface VisibilityOptions {
  /** 注册表里的归档集；缺省 = 没有任何会话被归档。 */
  archived?: ReadonlySet<string> | readonly string[]
  /** 读"宿主判它空白吗"；缺省 = 这次不判空白（按显示处理）。 */
  resolveBlank?: (query: ProjectionCacheQuery) => boolean | undefined
}

/**
 * 把一条会话与注册表的口径归结成**三件事实**（判据的输入只有这一份，别处不许各拼一份）。
 *
 * @param subject 会话（要 id / createdAt / cwd / header.origin）。
 * @param options 归档集与空白读取器。
 * @returns `origin` / `blank` / `archived` 三个事实。
 */
export function visibilityFacts(subject: VisibilitySubject, options: VisibilityOptions = {}): VisibilityFacts {
  const archived = options.archived
  const isArchived =
    archived === undefined
      ? false
      : Array.isArray(archived)
        ? (archived as readonly string[]).includes(subject.id)
        : (archived as ReadonlySet<string>).has(subject.id)
  return {
    ...(subject.header.origin === undefined ? {} : { origin: subject.header.origin }),
    ...(options.resolveBlank === undefined
      ? {}
      : { blank: options.resolveBlank({ id: subject.id, createdAt: subject.createdAt, cwd: subject.cwd }) }),
    archived: isArchived,
  }
}

/**
 * 给一条会话判"侧边栏会不会显示"。
 *
 * @param subject 会话（要 id / createdAt / cwd / header.origin）。
 * @param options 归档集与空白读取器。
 * @returns 原因；`undefined` = 会显示。
 */
export function hiddenReasonOf(subject: VisibilitySubject, options: VisibilityOptions = {}): HiddenReason | undefined {
  return hiddenReason(visibilityFacts(subject, options))
}

/** 判「未分组」要多知道的一件事：这条会话有没有被某个工作区认领。 */
export interface UngroupedFacts extends VisibilityFacts {
  /** 它的 id 是否在某个工作区记录的 `sessionIds` 里。 */
  owned?: boolean
}

/**
 * 这条会话在外壳侧边栏里是不是落在「未分组」那一组里。
 *
 * 宿主的算法（`dsh-client-ui-workspace` 里造组的那一步）：把每个工作区记录 `sessionIds` 里的 id 收进
 * 一张 `accounted` 表，剩下的那些里再过一遍 `sessionVisible()` —— 通过了才成为「未分组」那一组。
 * 所以「未分组」是**两件事同时成立**：谁都没认领它，**而且**默认视图下侧边栏会显示它。子代理会话
 * 嵌在父会话下面、空白（除当前那条临时 New Session）与已归档默认都不显示，它们因此都不是「未分组」
 * 的成员——哪怕它们同样没在册。
 *
 * 这条判据是「未分组」在本插件里的**唯一**定义：行上那枚标签、会话页那枚筛选芯片、迁移页那个来源
 * 都读它（来源还要额外要求有 `cwd`：那个来源要改写 header，没有 cwd 的会话它搬不动，见 planRows.ts）。
 * 以前这三处各答各的（两处只看 `workspaceId` 缺省），于是子代理行上挂着「未分组」，而侧边栏从来没
 * 把它放进过那一组。
 */
export function isUngrouped(facts: UngroupedFacts): boolean {
  return facts.owned !== true && hiddenReason(facts) === undefined
}

/**
 * 造一个"这条会话宿主判它空白吗"的读取器（读投影缓存；见 projection-cache.ts）。
 *
 * @param options.cacheDir 宿主投影缓存目录；缺席 = 永远返回 `undefined`（不判空白）。
 * @returns 读取器。
 */
export function createBlankResolver(options: { cacheDir?: string }): (query: ProjectionCacheQuery) => boolean | undefined {
  const { cacheDir } = options
  if (cacheDir === undefined) return () => undefined
  return (query) => readProjectionCache(cacheDir, query)?.blank
}
