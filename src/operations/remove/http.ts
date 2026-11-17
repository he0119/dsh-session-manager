// 删除与归档这两条端点：都只改本机的会话目录与注册表，改完广播一条"库变了"。
//
// 删除不碰注册表（登记与归档状态原样还在），所以恢复走的是备份与回滚那一份清单；归档只改注册表的
// 归档集，然后把改动交给宿主认下（`takesEffect` 说的就是它）。
//
// @module dsh-session-manager/operations/remove/http
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Handler, WebContext } from '../../web.ts'
import { loneSubagentError, withSubagents } from '../../shared/http/view.ts'
import { readJson, sendJson, streamResult } from '../../shared/http/respond.ts'
import { removeRemoteCopies } from '../sync/sync.ts'
import { remoteBusyMessage } from '../sync/remote-write.ts'
import { runRemoval, type RemoveDeps, type RemovalRun } from './remove.ts'

export function removeHandlers(ctx: WebContext): Record<string, Handler> {
  const { deps, paths, decodeAll, resolveTitle, projection, liveSessionIds, scanForAction, remoteWrite, takesEffect } = ctx

  const removeDeps: RemoveDeps = {
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    resolveTitle,
    projection,
    liveSessionIds,
    // 勾了「同时删除远端」时走这条：删自己那一格里的包、留下删除记录（见 sync.ts 的
    // `removeRemoteCopies()`）。没配同步时这口子也照着给，那句"这次删不了远端"由 `deps.sync?.()` 缺席
    // 时原样报出来——比"静默只删本机"诚实。
    remoteRemove: async (ids) => {
      const runtime = await deps.sync?.()
      if (runtime === undefined) {
        return {
          removed: 0,
          bytes: 0,
          others: [],
          problems: ['这个宿主没有配置 WebDAV 同步，远端什么都没删（下次同步可能又拉回来）'],
        }
      }
      /*
       * 本机已经删完了，这一步只清远端；拿不到写权限就如实报"远端这次没删"，不排队等。
       * 排队会拿着删除之前读到的索引去写，反而可能把别人刚写的条目盖掉。
       */
      const release = remoteWrite.tryAcquire('删除远端')
      if (release === undefined) {
        return {
          removed: 0,
          bytes: 0,
          others: [],
          problems: [`${remoteBusyMessage(remoteWrite.current())}，远端这次没有删`],
        }
      }
      try {
        return await removeRemoteCopies(
          { dav: runtime.dav, settings: runtime.settings, ...(deps.now === undefined ? {} : { now: deps.now }) },
          ids,
        )
      } finally {
        release()
      }
    },
  }

  /**
   * 删除会话：`mode=apply` 才真删（**先备份再删**），缺省只预览。
   *
   * 恢复不在这里：删掉的那份就在本插件备份根下，走「备份与回滚」那份清单（见 journal.ts 的
   * `BackupKind`）。删除**不碰注册表**，所以恢复之后登记与归档状态原样还在（见 src/operations/remove/remove.ts）。
   */
  const deleteSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const ids = fields['sessionIds']
    if (!Array.isArray(ids) || ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }
    const apply = fields['mode'] === 'apply'
    /** 同时删远端（缺省 false；界面在配了同步时默认勾上）。只在真删那一步才动远端。 */
    const alsoRemote = fields['alsoRemote'] === true
    // 删除应用要**先按字节备份整份会话目录**再删，整库删除同样是几十秒的活（与迁移同量级），
    // 所以它也走事件流：`scan`（重算计划）、`backup`、`remove`、`verify`（勾了也走 `remote` 那一步）。
    await streamResult(res, async (report) => {
      const run: RemovalRun = await runRemoval(
        removeDeps,
        { sessionIds: ids.map((id) => String(id)), ...(alsoRemote ? { alsoRemote: true } : {}) },
        { apply, onProgress: report },
      )
      return {
        mode: apply ? 'apply' : 'plan',
        ok: run.plan.ok && (!apply || run.verified),
        /** 「将会删掉什么」的那份计划（预览与执行同源）。 */
        preview: run.plan,
        applied: run.applied,
        dirsRemoved: run.dirsRemoved,
        removedProjectDirs: run.removedProjectDirs,
        verified: run.verified,
        ...(run.backupDir === undefined ? {} : { backupDir: run.backupDir }),
        ...(run.remote === undefined ? {} : { remote: run.remote }),
        problems: run.plan.ok ? run.problems : run.plan.problems,
        summary: run.summary,
        // 复核没过时那句话与原来 500 那次的正文一致（计划不 ok 时 `applied` 本来就是 false，
        // 界面读的是 `preview`，与 409 那次一样）。
        ...(apply && run.plan.ok && !run.verified
          ? { error: '删除后的复核未通过，请查看 problems 并从备份恢复' }
          : {}),
      }
    })
  }

  /**
   * 归档 / 取消归档所选会话（`archived: false` 即取消归档）。
   *
   * 走宿主的 `workspaceRegistry`：它一次做完"写入磁盘 + 改内存 + 广播"，侧边栏即时跟着变，所以这里
   * 如实回报 `immediate`。一条失败不影响其余（逐条收集失败原因）——把每条的状态原样告诉界面，
   * 比"整体失败、什么都不说"更有用。
   */
  const archiveSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(fields['sessionIds']) ? fields['sessionIds'].map((id) => String(id)) : []
    if (ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }
    const archived = fields['archived'] !== false
    // 子智能体不单独动：勾父会话时它跟着一起归档 / 取消归档（族是一个单位，见 family.ts）。
    const all = await scanForAction()
    const lone = loneSubagentError(all, ids, resolveTitle)
    if (lone !== undefined) {
      sendJson(res, 400, { error: lone })
      return
    }
    const targets = [...new Set(withSubagents(all, ids))]
    const ops = deps.registryOps?.()
    if (ops === undefined) {
      // 非 Web profile 没有这个服务：如实拒绝，而不是写一遍注册表文件（写文件绕过宿主的内存副本，
      // 既可能被覆盖，也要等重启才被承认——那不是"归档"，是给宿主埋雷）。
      sendJson(res, 409, { error: '这个宿主没有 workspaceRegistry 服务（归档是它的能力），改不了归档状态' })
      return
    }
    const done: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    // 逐条走宿主的注册表动作（每条一次写入磁盘 + 广播），勾一整页会话时这一段是可感知的，所以它报进度。
    await streamResult(res, async (report) => {
      for (const [index, id] of targets.entries()) {
        report({ phase: 'archive', total: targets.length, done: index, id })
        try {
          if (archived) await ops.archive(id)
          else await ops.unarchive(id)
          done.push(id)
        } catch (error) {
          failed.push({ id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return {
        ok: failed.length === 0,
        archived: done,
        failed,
        takesEffect: 'immediate',
      }
    })
  }

  return {
    'POST /delete': deleteSessions,
    'POST /archive': archiveSessions,
  }
}
