// 迁移、回滚与备份清单这三条端点：参数与工具层同一套（都进 runMigration）。
//
// 应用要改注册表、还要请宿主补投影检查点，这两件事都发生在流开始之后，所以进度与"要不要重启"都从
// 事件流里说；只有参数不对这类判定在写头之前回一次性 JSON。
//
// @module dsh-session-manager/operations/migrate/http
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Handler, WebContext } from '../../web.ts'
import { assertTargetCwd } from '../../shared/http/validate.ts'
import { readJson, sendJson, streamResult } from '../../shared/http/respond.ts'
import { effectOf } from '../../shared/host/take-effect.ts'
import {
  assertBackupDir,
  listBackups,
  loadRegistryForWrite,
  rollbackMigration,
  runMigration,
  type MigrateRequest,
} from './migrate.ts'

export function migrationHandlers(ctx: WebContext): Record<string, Handler> {
  const { paths, migrateDeps, panelEmit, takesEffect } = ctx

  const backups = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    sendJson(res, 200, { backupRoot: paths.backupRoot, backups: listBackups(migrateDeps) })
  }

  /** 迁移：`mode=apply` 执行，缺省只预览。参数与工具层同一套（都进 runMigration）。 */
  const migrate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    /*
     * **源就是点名的那些会话**（不带源目录这个参数）：它们可以来自不同的目录，每条会话的源目录是它自己的
     * `cwd`——"把删掉的项目文件夹里那几条迁到重建后的位置"就是点名它们 + 给一个目标目录。所以这里只判
     * "点名了没有"，来源目录还在不在由项目目录（会话日志那一层）那一侧说话。
     */
    const ids = fields['sessionIds']
    if (!Array.isArray(ids) || ids.length === 0) {
      sendJson(res, 400, { error: '缺少要迁移的会话（sessionIds）' })
      return
    }
    let to: string
    try {
      to = assertTargetCwd(fields['to'])
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    // 注册表是迁移的前置条件（要往上面登记新工作区）。它坏了就不该动手，先如实拒掉。
    try {
      loadRegistryForWrite(paths.registryPath)
    } catch (error) {
      sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const request: MigrateRequest = {
      to,
      sessionIds: ids.map((id) => String(id)),
      includeArtifacts: fields['includeArtifacts'] === true,
      ...(typeof fields['title'] === 'string' && fields['title'].trim() !== '' ? { title: fields['title'].trim() } : {}),
    }
    const apply = fields['mode'] === 'apply'
    /*
     * 干活那一段走事件流：迁移应用要备份、改写、搬目录、复核、请宿主补检查点——实测 47 条会话 /
     * 67.5 MB 要 45 秒（其中改写首帧占 45 秒）。计划不 ok 与复核没过**都还是结果**：它们带着
     * 完整的 `preview`，界面要把清单与问题摆出来，所以一样从 `result` 事件回，而不是当成流的错。
     */
    await streamResult(res, async (report) => {
      const run = await runMigration(migrateDeps, request, { apply, onProgress: report })
      // 真搬过（或改写过注册表）就意味着别处看到的清单已经过期了。
      if (apply && (run.moved > 0 || run.rewritten > 0)) {
        panelEmit({ type: 'stale', what: 'state' })
      }
      return {
        mode: apply ? 'apply' : 'plan',
        ok: run.preview.ok && (!apply || run.verified),
        preview: run.preview,
        applied: run.applied,
        rewritten: run.rewritten,
        moved: run.moved,
        artifactsMoved: run.artifactsMoved,
        verified: run.verified,
        ...(run.backupDir === undefined ? {} : { backupDir: run.backupDir }),
        problems: run.problems,
        ...(run.warm === undefined ? {} : { warm: run.warm }),
        // 真的改过注册表就认执行结果，没改过才退到探测（见 take-effect.ts 的 effectOf）。
        takesEffect: effectOf(run.effect, takesEffect()),
        // 复核没过时那句话与原来 500 那次的正文一致（结果形状不变，只是换了种运法）。
        ...(apply && !run.verified ? { error: '迁移后的复核未通过，请查看 problems 并考虑回滚' } : {}),
      }
    })
  }

  /** 回滚：`dryRun` 只回动作清单；只认本插件备份根下的目录（越界一律拒）。 */
  const rollbackBackup = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const backupDir = fields['backupDir']
    try {
      assertBackupDir({ backupRoot: paths.backupRoot }, backupDir)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const dryRun = fields['dryRun'] === true
    // 回滚 = 逐条会话把目录搬回去 + 逐文件字节还原，整库回滚同样是几十秒的活（同迁移），所以它也报进度。
    await streamResult(res, async (report) => {
      const outcome = await rollbackMigration(
        { backupRoot: paths.backupRoot },
        { backupDir: String(backupDir), dryRun, onProgress: report },
      )
      if (!dryRun) panelEmit({ type: 'stale', what: 'state' })
      return {
        mode: dryRun ? 'plan' : 'apply',
        ...outcome,
        takesEffect: effectOf(outcome.effect, takesEffect()),
      }
    })
  }

  return {
    'GET /backups': backups,
    'POST /migrate': migrate,
    'POST /rollback': rollbackBackup,
  }
}
