// 界面要的「会话行 / 工作区行」怎么从发现结果与注册表折出来。
//
// 为什么单独一层：导出、归档、迁移、`/state` 与面板流都读同一份行形状，各自抄一遍迟早分叉——而分叉
// 的表现是"面板说 4 条、侧边栏显示 1 条"这类对不上的账。判据本身在 accounting.ts 与 visibility.ts，
// 这里只负责把它们拼成界面直接能渲染的那几栏。
//
// @module dsh-session-manager/shared/http/view
import { canonicalDirIfExists } from '../canonical-path.ts'
import { familyOf, loneSubagents } from '../family.ts'
import type { DiscoveredSession } from '../library/discovery.ts'
import type { TitleQuery } from '../log/session-title.ts'
import { readRegistry, validateRegistry } from '../registry.ts'
import type { WorkspaceRegistryState } from '../types.ts'
import { hiddenReason, isUngrouped, type HiddenReason } from '../visibility.ts'

export interface SessionSummary {
  id: string
  /** 折叠出的标题；读不到时界面退回显示 id（见 session-title.ts）。 */
  title?: string
  cwd?: string
  createdAt: number
  dir: string
  /** 外壳侧边栏会把它放进「未分组」那一组（判据见 visibility.ts 的 `isUngrouped()` 与 accounting.ts 的「认领」）。 */
  ungrouped: boolean
  bytes: number
  files: Array<{ name: string; bytes: number }>
  /** 外壳侧边栏不显示这条会话的原因（缺省 = 会显示，见 visibility.ts）。 */
  hidden?: HiddenReason
  /** 是否在注册表的归档集里（管理页据此决定按钮写「归档」还是「取消归档」）。 */
  archived: boolean
  /** 宿主判它"一轮都没开始过"（见 visibility.ts）；缓存缺席时按 `false` 处理，与宿主的冷会话标准一致。 */
  blank: boolean
  /** 日志 header 里的 `origin`（只有子智能体会话会写）。 */
  origin?: string
  /**
   * 日志 header 里的 `parentSession`：这条子智能体会话挂在哪条会话下面。
   *
   * 界面据此把子智能体缩进到父会话的下一级（见 client/groups.ts 的 `nestSessions()`）。判据与删除/迁移的
   * 级联展开是同一个字段——列表里看到的父子关系与"删/搬会带上谁"因此不会各说各话。
   */
  parentSession?: string
  /** 宿主内存里活着（删除会拒它）。 */
  live: boolean
}

/** 界面要展示的一个工作区。 */
export interface WorkspaceSummary {
  id: string
  path: string
  title: string
  /** 宿主报给界面的那一份成员（**认领**的那些，见 accounting.ts），不是注册表里的登记原样。 */
  sessionIds: string[]
  /**
   * 这个目录在盘上还在不在（解析得出来、而且是个目录，判据用 `canonicalDirIfExists()`）。
   *
   * 注册表里的登记不保证盘上还有：项目文件夹被删掉、目录改了名之后，那条登记照旧在，"这块工作区
   * 是搬空了还是人没了"因此不能只看注册表。界面拿它做一件事——把目标候选里**已经不存在的那些**
   * 标出来（见 `planRows.directoryTargetRows` 与 `CandidatePanel`）：不标的话，候选列表里
   * "盘上还在的"与"只剩一条登记的"长得一模一样，点下去只会撞上 `assertTargetCwd()` 那句
   * 「目标工作区目录不存在」。
   */
  exists: boolean
}

/** 读请求体。 */

export function loadRegistry(
  path: string,
): { registry: WorkspaceRegistryState | null; problems: string[] } {
  try {
    const registry = readRegistry(path)
    const check = validateRegistry(registry)
    return { registry, problems: check.ok ? [] : check.problems.map((problem) => `注册表：${problem}`) }
  } catch (error) {
    return {
      registry: null,
      problems: [`读不到注册表 ${path}：${error instanceof Error ? error.message : String(error)}`],
    }
  }
}

/**
 * 这次点名的会话里有没有"单独的子智能体"（父会话还在库里、又不会被一起带上），有就给出拒绝文案。
 *
 * 子智能体跟着父会话走（见 family.ts）：单独归档 / 导出它，要么在父会话的 `subagent/catalog` 里留下
 * 一条指着不存在会话的条目，要么打出一个父会话不在里面的包。所以这几条路都直接拒，并指名该点谁。
 * 删除那条路在自己的编排里做同一件事（文案在 remove.ts，多一条父会话名称）。
 */
export function loneSubagentError(
  all: readonly DiscoveredSession[],
  ids: readonly string[],
  resolveTitle?: (query: TitleQuery) => string | undefined,
): string | undefined {
  const byId = new Map(all.map((session) => [session.id, session]))
  const lone = loneSubagents(all, new Set(ids))
  if (lone.length === 0) return undefined
  return lone
    .map((item) => {
      const parent = byId.get(item.parentId)
      // 拒绝这条路上才去读父会话的标题（整库带标题扫一遍要 1.7s，见 discovery.ts 的取舍）：
      // 只有一条会话、而且只在这条罕见的错误分支上读。
      const title =
        parent === undefined
          ? undefined
          : (resolveTitle?.({
              id: parent.id,
              createdAt: parent.createdAt,
              ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
              files: parent.files.map((file) => ({ path: file.path, version: file.version })),
            }) ?? parent.title)
      const owner = title === undefined || title.trim() === '' ? item.parentId : `${title.trim()}（${item.parentId}）`
      return `session ${item.id} 是子智能体会话（它跟着父会话走）：请改点名它的父会话 ${owner}`
    })
    .join('；')
}

/**
 * 点名的那批 id → 实际要动手的那批：点名的在前，随后是各自跟来的子智能体（`familyOf()`）。
 *
 * 库里找不到的 id 原样留着（调用方照旧逐条报"不在库里"，不静默少做一件事）。
 */
export function withSubagents(all: readonly DiscoveredSession[], ids: readonly string[]): string[] {
  const byId = new Map(all.map((session) => [session.id, session]))
  const known = new Set(byId.keys())
  const roots = ids.flatMap((id) => {
    const session = byId.get(id)
    return session === undefined ? [] : [session]
  })
  const expanded = familyOf(all, roots).map(({ session }) => session.id)
  return [...ids.filter((id) => !known.has(id)), ...expanded]
}

/**
 * 把发现结果与注册表对起来，得到界面要的行。
 *
 * `ungrouped` = 这条会话在外壳侧边栏里落在「未分组」那一组里（判据与理由见 visibility.ts 的
 * `isUngrouped()`）。行上的标签、会话页那枚筛选标签、迁移页那个来源都读它——**不再**发"有没有工作区
 * 认领"这个中间事实：以前那三处各自拿它去推「未分组」，于是子智能体/空白/已归档这些侧边栏根本不放进
 * 那一组的会话也被标成了「未分组」。
 *
 * "有没有主"那一半读的是 `accounted`（`accounting.ts` 算好的**认领**，不是注册表里的登记原样）：
 * 目录改名 / 删掉之后登记还在、会话却已经不算任何工作区的成员，外壳那边正是这么算的。
 *
 * `hidden` 是外壳侧边栏"会不会显示这条会话"的判据结果（见 visibility.ts）：三份列表各自要看的东西
 * 不同——导出照单全收、迁移只收侧边栏看得见的、管理页要把看不见的原因标出来——所以这里一次算清，
 * 三处都读同一个字段，避免"面板说 4 条、侧边栏显示 1 条"这种对不上的账。
 */
export function summarizeSessions(
  sessions: readonly DiscoveredSession[],
  options: {
    /** 会话 id → 认领它的工作区 id（`accountedOwners()`）。 */
    accounted: ReadonlyMap<string, string>
    archived: ReadonlySet<string>
    resolveBlank?: (query: { id: string; createdAt: number; cwd?: string }) => boolean | undefined
    live: ReadonlySet<string>
  },
): SessionSummary[] {
  return sessions.map((session) => {
    // 扫描时已经读过那条投影记录（`session.meta`）就直接取，不再按缓存目录读第二遍；只在调用方显式
    // 注入了读取器时才走它（测试用它钉"读不到空白"的边界）。
    const blank =
      options.resolveBlank === undefined
        ? session.meta?.blank === true
        : options.resolveBlank({ id: session.id, createdAt: session.createdAt, cwd: session.cwd }) === true
    const archived = options.archived.has(session.id)
    const facts = {
      ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
      // 记录里没有这一条（读不到）时不写 `blank`，与"宿主没说"同一标准（见 visibility.ts）。
      ...(session.meta?.blank === undefined && options.resolveBlank === undefined ? {} : { blank }),
      archived,
    }
    const hidden = hiddenReason(facts)
    return {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      cwd: session.cwd,
      createdAt: session.createdAt,
      dir: session.dir,
      ungrouped: isUngrouped({ ...facts, owned: options.accounted.has(session.id) }),
      bytes: session.files.reduce((sum, file) => sum + file.bytes, 0),
      files: session.files.map((file) => ({ name: file.name, bytes: file.bytes })),
      archived,
      blank,
      ...(session.header.origin === undefined ? {} : { origin: session.header.origin }),
      ...(session.header.parentSession === undefined
        ? {}
        : { parentSession: session.header.parentSession }),
      live: options.live.has(session.id),
      ...(hidden === undefined ? {} : { hidden }),
    }
  })
}

/**
 * 界面要的工作区：`sessionIds` 报**认领**的那些（登记里 cwd 已经对不上的不算成员），与宿主发给渲染层
 * 的那一份同源（见 accounting.ts）——工作区那一行的条数与外壳那一组里的会话因此不会各说各话。
 */
export function summarizeWorkspaces(
  registry: WorkspaceRegistryState | null,
  accounted: ReadonlyMap<string, string>,
): WorkspaceSummary[] {
  return (registry?.global.workspaceIds ?? []).flatMap((id) => {
    const record = registry?.tables.workspaces[id]
    if (!record) return []
    return [
      {
        id,
        path: record.path,
        title: record.title,
        sessionIds: record.sessionIds.filter((sessionId) => accounted.get(sessionId) === id),
        // 一次 stat（不存在时是一次失败的 realpath），工作区一多也只是十几下；它挡的是"点了一行必然
        // 报错的候选"。
        exists: canonicalDirIfExists(record.path) !== undefined,
      },
    ]
  })
}

/** 读 JSON 请求体；迁移/回滚这类请求很小，给 1 MiB 上限就够（大文件走 readBody 的默认上限）。 */
