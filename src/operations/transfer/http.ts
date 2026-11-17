// 导入导出这两条端点：读完一个包 / 打出一个包，中间按事件流报进度。
//
// 边界都在宿主这一侧：包必须自校验通过、冲突只跳过不覆盖、目标目录必须真实存在。编排（打包、预览、
// 应用）在 transfer.ts，这里只负责 HTTP 形状：读参数、翻成那边认识的请求、把结果按 JSON 或事件流回给
// 界面。
//
// @module dsh-session-manager/operations/transfer/http
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Handler, WebContext } from '../../web.ts'
import { assertTargetCwd } from '../../shared/http/validate.ts'
import { loadRegistry, loneSubagentError, withSubagents } from '../../shared/http/view.ts'
import { readBody, sendBytes, sendJson, streamResult } from '../../shared/http/respond.ts'
import { describeWarm, warmCheckpoints } from '../../shared/host/checkpoint-warm.ts'
import { describeEffect, effectOf, takeEffectOnHost } from '../../shared/host/take-effect.ts'
import { applyImport, buildBundleAsync, bundleTitlesAsync, planImport, readBundleAsync, type BundleSourceInfo, type ImportOptions, type ImportPlan } from './transfer.ts'

export function transferHandlers(ctx: WebContext): Record<string, Handler> {
  const { deps, paths, decodeAll, now, resolveTitle, scanForAction, attachmentPort, liveSessionIds, hostRegistry, hostCheckpoints, panelEmit, takesEffect } = ctx

function fileName(count: number, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  return `dsh-sessions-${count}-${stamp}.dshsess`
}

  const exportSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req)
    let wanted: unknown
    try {
      wanted = JSON.parse(body.toString('utf8') || '{}')
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const ids = (wanted as { sessionIds?: unknown }).sessionIds
    if (!Array.isArray(ids) || ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }

    const all = await scanForAction()
    const byId = new Map(all.map((session) => [session.id, session]))
    const named: string[] = ids.map((id) => String(id))
    const missing = named.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      sendJson(res, 404, { error: `这些会话不在库里：${missing.join(', ')}` })
      return
    }
    // 子智能体不单独打包：它跟着父会话进包，否则包里那条 catalog 会指向一个包内不存在的会话。
    const lone = loneSubagentError(all, named, resolveTitle)
    if (lone !== undefined) {
      sendJson(res, 400, { error: lone })
      return
    }

    const sources = withSubagents(all, named).map((id) => {
      const session = byId.get(id)!
      return { id: session.id, cwd: session.cwd, createdAt: session.createdAt, dir: session.dir, files: session.files }
    })
    const at = now()
    const source: BundleSourceInfo = { sessionsRoot: paths.sessionsRoot, pluginVersion: deps.pluginVersion }
    /*
     * 附件对象跟着包走：日志里只有引用，字节在宿主的附件库里。库里没有的那几个照样报出来
     * ——用户需要知道"这次有几张图没能带走"，而不是等到了另一台机器上才发现图挂了。
     * 一个都没带成时包是 v1（见 transfer.ts 的 buildBundle），这几枚响应头仍然如实报数。
     */
    const port = attachmentPort()
    let packed: { packed: number; bytes: number; missing: number } = { packed: 0, bytes: 0, missing: 0 }
    const bundle = await buildBundleAsync(sources, {
      now: at.toISOString(),
      source,
      ...(port === undefined
        ? {}
        : {
            attachments: {
              port,
              decodeAll,
              onReport: (report) => {
                packed = { packed: report.packed, bytes: report.bytes, missing: report.missing.length }
              },
            },
          }),
    })
    const bytes = sources.reduce((sum, item) => sum + item.files.reduce((s, file) => s + file.bytes, 0), 0)
    sendBytes(res, 200, bundle, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${fileName(sources.length, at)}"`,
      // 包里到底几条 / 多少字节：界面那句"已导出 N 条"要说的是**包里的**，勾一条父会话时它比勾选数多
      'x-dsh-session-count': String(sources.length),
      'x-dsh-session-bytes': String(bytes),
      // 附件那两枚：带走了几个对象、有多少字节；`-missing` 是本机附件库里找不到的那几个（日志里有引用、
      // 对象不在，包带不走），界面据此提醒一句而不是假装没事。
      'x-dsh-attachment-count': String(packed.packed),
      'x-dsh-attachment-bytes': String(packed.bytes),
      'x-dsh-attachment-missing': String(packed.missing),
    })
  }

  const importSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const apply = url.searchParams.get('mode') === 'apply'

    const bytes = await readBody(req)
    if (bytes.length === 0) {
      sendJson(res, 400, { error: '请求体为空：请上传一个 .dshsess 文件' })
      return
    }

    let bundle
    try {
      bundle = await readBundleAsync(bytes)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    let targetCwd: string
    try {
      targetCwd = assertTargetCwd(url.searchParams.get('targetCwd'))
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }

    const { registry, problems } = loadRegistry(paths.registryPath)
    const options: ImportOptions = {
      root: paths.sessionsRoot,
      targetCwd,
      registry: registry ?? undefined,
      registryPath: paths.registryPath,
      // 预览的每条会话要显示标题：包里的日志已经整份在内存里，折叠一次比再读盘便宜
      // （见 transfer.bundleTitle）。
      decodeAll,
      // 附件库里那些对象的去处在宿主手里（见 ApiDeps.attachments）；没有这个接口时计划里那几条一律
      // 报 unavailable，包里的日志照旧导进去。
      attachments: attachmentPort(),
    }

    /*
     * 计划与应用都走事件流：包本身的字节是**请求体**（上传那一段宿主报不了，那是浏览器与网络的事），
     * 但收到之后还有几段长的——预览要逐条读包里的日志折标题（实测 250 条 / 70.9 MB 约 1.7 秒）、数
     * 一遍包里的附件对象在不在本机，应用要逐条写入磁盘并改写首帧 cwd（同一条包实测 18.9 秒）。这几段原来
     * 界面上只有一句「导入中…」。
     */
    await streamResult(res, async (report) => {
      // 计划算不出来（包坏了、注册表重挂失败…）：抛出去就是 `error` 事件，界面照原话报——与原来
      // 那次 500 的正文是同一条消息。
      /*
       * 标题先异步折一遍（每几条让出一次）：250 条 / 70.9 MB 的包实测 1.7 秒，原来整段都在主线程里。
       * `planImport()` 拿到这份表就不再逐条解压，只做它自己的目录检查与注册表计算。
       */
      const titles = await bundleTitlesAsync(bundle, decodeAll, { onProgress: report })
      const plan: ImportPlan = planImport(bundle, { ...options, titles, onProgress: report })

      const payload = {
        mode: apply ? 'apply' : 'plan',
        bundle: { createdAt: bundle.createdAt, source: bundle.source, sessions: bundle.sessions.length },
        problems: [...problems, ...plan.problems],
        entries: plan.entries,
        created: plan.created,
        rehomed: plan.rehomed,
        bytes: plan.bytes,
        attachments: plan.attachments,
        attachmentAdds: plan.attachmentAdds,
        attachmentBytes: plan.attachmentBytes,
        registryChange: plan.registryChange,
      }

      if (!apply) return { ...payload, ok: plan.ok }
      /*
       * 一件都不会发生时不必走应用：会话都在库里，包里的附件对象本机也一个不缺。**只缺附件**那种
       * （日志早就导过、图是挂的）要放行——那正是这次要修的那个现状，应用那一步会把缺的对象补上，
       * 一个日志字节都不覆盖。
       */
      if (plan.created.length === 0 && plan.attachmentAdds === 0) {
        return { ...payload, ok: false, error: '没有可导入的内容：会话都已在库里，包里的附件对象本机也都有' }
      }

      try {
        const outcome = await applyImport(bundle, plan, { ...options, decodeAll, onProgress: report })
        // 导入会改注册表（把会话挂进目标工作区），与迁移是同一条语义：改完就把活儿交给宿主自己做，
        // 而不是把"重启 DSH 最稳妥"留给用户。注册表这次没动时（没有要挂的 / 读不到注册表）没有这一步。
        // 注册表终态一并交过去：宿主没接住时它会用内存副本盖掉这次写入磁盘，那时得靠这份终态写回来
        // （见 take-effect.ts 的 `restoreRegistry()`）。
        const effect = outcome.registryWritten
          ? await takeEffectOnHost(
              plan.registryChange,
              { hostRegistry, registryPath: paths.registryPath },
              { registry: plan.nextRegistry },
            )
          : undefined
        /*
         * 导进来的会话从没在本机活过，宿主的投影检查点里没有它们：侧边栏会显示"未命名"、时间退回
         * createdAt，直到被点开一次。这里请宿主自己冷读一遍补上（逐条兜住失败，不影响应用结论，
         * 见 checkpoint-warm.ts）。
         */
        const warm = await warmCheckpoints(outcome.written, { hostCheckpoints }, report)
        // 会话真落到本机了：别的页面（以及本页的清单）得重读一次。
        if (outcome.written.length > 0) panelEmit({ type: 'stale', what: 'state' })
        return {
          ...payload,
          ok: true,
          written: outcome.written,
          writtenBytes: outcome.bytes,
          attachmentWritten: outcome.attachmentWritten,
          attachmentPresent: outcome.attachmentPresent,
          attachmentWrittenBytes: outcome.attachmentBytes,
          attachmentProblems: outcome.attachmentProblems,
          registryWritten: outcome.registryWritten,
          takesEffect: effectOf(effect, takesEffect()),
          ...(outcome.written.length === 0 ? {} : { warm }),
          note: [
            effect === undefined
              ? '会话已写入磁盘（这次没有改注册表）：宿主重新扫描后就会出现在侧边栏，不需要重启。'
              : describeEffect(effect),
            describeWarm(warm),
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        }
      } catch (error) {
        // 写入磁盘写到一半失败：正文里那份**计划**照样带回去（界面把冲突与原因摆在弹窗里），
        // 与原来 500 那次的正文同一个形状。
        return { ...payload, ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  return {
    'POST /export': exportSessions,
    'POST /import': importSessions,
  }
}
