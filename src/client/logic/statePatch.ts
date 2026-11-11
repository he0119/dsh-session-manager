/**
 * 一次动作之后就地改清单里的那几条（不等宿主重扫整库）。
 *
 * 为什么要有这一层：动作落地之后，界面原来靠 `reload()` 重连那条面板流、等宿主重新扫一遍整库再把清单
 * 发回来——本机 1423 条会话上那一步实测 0.9～1.1 秒（扫库 + 750 KB 快照 + 重画每一行），而这次动作改了
 * 哪几条，响应里本来就写着。先按响应把这几行改对，用户点完立刻看到结果；那份整库快照照旧在后台取回来
 * 覆盖它，快照到了以快照为准（它是磁盘的真话）。
 *
 * 所有函数都是纯的：改了哪几条就换哪几个对象，其余保持同一个引用（订阅者按引用判"变了没有"，也少些
 * 无谓的重画）；一条都没变时原样返回**同一个** state。
 *
 * @module dsh-session-manager/client/statePatch
 */

import type { SessionSummary, StateResponse } from '../api.ts'

/** 一条要改的会话：新标题（重算名称那条路）。 */
export interface TitlePatch {
  id: string
  title: string
}

/** 一条要改的会话：迁移落地之后它落在哪个目录（`dir` 是会话目录本身）。 */
export interface MovePatch {
  id: string
  dir: string
}

/** 归档 / 取消归档之后改这几条。 */
export function patchArchived(state: StateResponse, ids: readonly string[], archived: boolean): StateResponse {
  if (ids.length === 0) return state
  const wanted = new Set(ids)
  let touched = false
  const sessions = state.sessions.map((session) => {
    if (!wanted.has(session.id)) return session
    if ((session.archived === true) === archived) return session
    touched = true
    const next: SessionSummary = { ...session, archived }
    /*
     * `hidden` 按宿主那条优先级重算（子智能体 > 空白 > 已归档，见 src/visibility.ts 的 `hiddenReason()`）：
     * 归档一条子智能体不会让它从"子智能体"变成"已归档"，取消归档也不会让一条空白会话露出来。
     */
    if (archived) {
      if (session.hidden !== 'subagent' && session.hidden !== 'blank') next.hidden = 'archived'
    } else if (session.hidden === 'archived') {
      delete next.hidden
    }
    return next
  })
  return touched ? { ...state, sessions } : state
}

/** 删除落地之后把这几条从清单里摘掉（级联带走的子智能体也在 `entries` 里）。 */
export function patchRemoved(state: StateResponse, ids: readonly string[]): StateResponse {
  if (ids.length === 0) return state
  const gone = new Set(ids)
  const sessions = state.sessions.filter((session) => !gone.has(session.id))
  if (sessions.length === state.sessions.length) return state
  // 工作区记录里的登记也一起摘掉：那一栏的条数是这张表的长度，留着这几条会多出没有对应的行。
  const workspaces = state.workspaces.map((workspace) => {
    const kept = workspace.sessionIds.filter((id) => !gone.has(id))
    return kept.length === workspace.sessionIds.length ? workspace : { ...workspace, sessionIds: kept }
  })
  return { ...state, sessions, workspaces }
}

/** 重算名称之后把新标题写回清单（`unchanged` 那几条本来就没变，不必传）。 */
export function patchTitles(state: StateResponse, entries: readonly TitlePatch[]): StateResponse {
  if (entries.length === 0) return state
  const byId = new Map(entries.map((entry) => [entry.id, entry.title]))
  let touched = false
  const sessions = state.sessions.map((session) => {
    const title = byId.get(session.id)
    if (title === undefined || session.title === title) return session
    touched = true
    return { ...session, title }
  })
  return touched ? { ...state, sessions } : state
}

/**
 * 迁移落地之后把这几个会话挪到目标目录（分组跟着换）。
 *
 * `to` 是这次迁移的目标目录（`preview.to`）。没有 cwd 的会话（落 `_no-cwd` 项目目录）只换 `dir`，不给它
 * 补一个 cwd——那会让它在列表里凭空多出一个"项目目录"。
 */
export function patchMoved(
  state: StateResponse,
  moves: readonly MovePatch[],
  to: string,
): StateResponse {
  if (moves.length === 0) return state
  const byId = new Map(moves.map((move) => [move.id, move.dir]))
  let touched = false
  const sessions = state.sessions.map((session) => {
    const dir = byId.get(session.id)
    if (dir === undefined || dir === session.dir) return session
    touched = true
    const next: SessionSummary = { ...session, dir }
    if (session.cwd !== undefined) {
      next.cwd = to
      // 目标目录一定是工作区（宿主那条计划保证），挪进去之后它就不再是「未分组」。
      next.ungrouped = false
    }
    return next
  })
  return touched ? { ...state, sessions } : state
}
