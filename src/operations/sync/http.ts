// 同步那四条端点（预览与落地、自动推送、比两份日志、列远端格子），以及面板要读的"上一趟落地"。
//
// 为什么整组放在这里：这四条共用一份**每次服务实例只有一份**的预演缓存与落地闸——预演算出的计划要
// 被下一次确认消费掉，两趟落地同时跑会互相踩。这份状态与端点因此必须待在一起，不能一半留在 web.ts 的
// 闭包里、另一半搬走。
//
// @module dsh-session-manager/operations/sync/http

import { readFile, stat } from 'node:fs/promises'
import { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type { Handler, WebContext } from '../../web.ts'
import { readJson, sendEvent, sendEventStream, sendJson, streamResult } from '../../shared/http/respond.ts'
import { effectOf } from '../../shared/host/take-effect.ts'
import { locateSession } from '../../shared/library/discovery.ts'
import { decodeLogTextChunked } from '../../shared/log/log-decode.ts'
import { splitLinesAsync } from '../../shared/text-chunks.ts'
import type { EffectMode } from '../../shared/types.ts'
import { collectLeftovers, plannedOutcome, prepareSync, replanPrepared, runSync, syncPrepared, type SyncDecision, type SyncLeftover, type SyncOutcome, type SyncPrepared, type SyncProgress } from './sync.ts'
import type { AutoPushOutcome } from './auto-push.ts'
import type { SyncInfo } from './runtime.ts'
import { diffSessionLogs } from './session-diff.ts'
import { entryBytes, readBundleAsync } from '../transfer/transfer.ts'
import { readTranscriptAsync } from '../transcript/transcript.ts'
import { readRemoteLibrary, remoteBundlePath, remotePlacements } from './index.ts'
import { runTidy, testSyncConnection, tidySummary } from './tidy.ts'
import { remoteBusyMessage } from './remote-write.ts'

/** 面板要读的那两份状态：正在跑的一趟、上一趟的结论。 */
export function autoPushLastPayload(outcome: AutoPushOutcome | undefined): Record<string, unknown> | null {
  if (outcome === undefined) return null
  return {
    ran: outcome.ran,
    ...(outcome.skip === undefined ? {} : { skip: outcome.skip }),
    failures: outcome.failures,
    ...(outcome.problem === undefined ? {} : { problem: outcome.problem }),
    ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }),
    ...(outcome.finishedAt === undefined ? {} : { finishedAt: outcome.finishedAt }),
    // 两个计数都容错：这一份是"上一轮的账"，宿主与界面的形状对不上时宁可少说一句，也不该让整条
    // 长连接因为一个空数组字段崩掉（认领来的那一轮只有计数，没有完整结果）。
    pushedCount: outcome.outcome?.pushed?.length ?? 0,
    // 双向那一档才有拉取：横幅上那句"拉取 N 条、推送 M 条"读的就是这两个计数。
    pulledCount: outcome.outcome?.pulled?.length ?? 0,
    bytesOut: outcome.outcome?.bytesOut ?? 0,
    ...(outcome.outcome?.attachmentOut === undefined ? {} : { attachmentOut: outcome.outcome.attachmentOut }),
    problems: outcome.outcome?.problems ?? [],
  }
}

export interface ApplyStatus {
  applying: Record<string, unknown> | null
  last: {
    startedAt: number
    finishedAt: number
    ok: boolean
    pulled: number
    pushed: number
    error?: string
    leftovers?: SyncLeftover[]
  } | null
}

export interface SyncHandlers {
  handlers: Record<string, Handler>
  /** 面板流开头与之后每条事件都要带的那两份状态。 */
  applyStatus: () => ApplyStatus
}

export function syncHandlers(ctx: WebContext): SyncHandlers {
  const {
    deps, paths, decodeAll, now, remoteWrite, resolveTitle, sessionMeta, projection,
    liveSessionIds, hostRegistry, hostCheckpoints, attachmentPort, panelEmit, takesEffect,
  } = ctx

  let preview: { id: string; value: SyncPrepared; decisionsKey: string } | null = null
  let previewSeq = 0
  let applying: { startedAt: number; progress: SyncProgress | null } | null = null
  let lastApply: ApplyStatus['last'] = null

  function autoPushPayload(
    outcome: AutoPushOutcome,
    info: SyncInfo | undefined,
    /** 这一轮可能改本机（双向那一档）时，宿主接不接得住注册表改动；只推那一档根本不问。 */
    fallbackEffect: EffectMode,
  ): Record<string, unknown> {
    const base = {
      mode: 'auto-push' as const,
      remote: { url: info?.url ?? '', machineId: info?.machineId ?? '' },
      ran: outcome.ran,
      ...(outcome.skip === undefined ? {} : { skip: outcome.skip }),
      failures: outcome.failures,
      ...(outcome.problem === undefined ? {} : { problem: outcome.problem }),
      ...(outcome.startedAt === undefined ? {} : { startedAt: outcome.startedAt }),
      ...(outcome.finishedAt === undefined ? {} : { finishedAt: outcome.finishedAt }),
    }
    const applied = outcome.outcome
    if (applied === undefined) return base
  return {
    ...base,
    plan: applied.plan,
    pulled: applied.pulled,
    replaced: applied.replaced,
    pushed: applied.pushed,
    bytesIn: applied.bytesIn,
    bytesOut: applied.bytesOut,
    registryWritten: applied.registryWritten,
    indexWritten: applied.indexWritten,
    problems: applied.problems,
    ...(applied.planSource === undefined ? {} : { planSource: applied.planSource }),
    /*
     * 只推那一档**永远不会**需要重启：它不改本机任何会话，注册表一个字节都没动——所以调用方传进来的
     * `fallbackEffect` 在那条路上是 `immediate`（写死它而不是问宿主：那个探测问的是"宿主能不能接住
     * 这次的注册表改动"，而这次根本没有那种改动，探出来的只会是一句假警告）。双向那一档真的会写注册
     * 表，于是由 `effectOf()` 按这次的结论说话。
     */
    takesEffect: effectOf(applied.effect, fallbackEffect),
  }
}

  /** 落地那一趟的当前状态（`null` = 没在跑）。面板流开头那条与之后每条事件都带它。 */
  const applyingPayload = (): Record<string, unknown> | null =>
    applying === null ? null : { startedAt: applying.startedAt, progress: applying.progress }

  /** 把裁决表折成一个稳定串：确认那次据此判断"还是预演时那组选择吗"。 */
  const decisionsKeyOf = (decisions: ReadonlyMap<string, SyncDecision> | undefined): string => {
    if (decisions === undefined || decisions.size === 0) return ''
    return [...decisions]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, decision]) => `${id}\u0000${decision}`)
      .join('\n')
  }

  /**
   * WebDAV 同步：`?mode=apply` 才真跑（拉取 + 推送），`?mode=test` 只探一次连通性，缺省只预演（读远端，
   * 什么都不写）。
   *
   * 两次调用是一件事：预演算出来的计划与它的输入留在 `preview` 里、响应带回一个 `planId`，确认那次
   * 带着它回来就照着那份数据落地（见 `SyncPrepared`）——用户按下确认到第一条拉取之间因此不必把同一份
   * 计划重算一遍。
   *
   * 拉取来的会话走的是**导入那条编排**（`planImport/applyImport`），所以这里与
   * 导入端点同一套边界：包必须自校验通过、同 id 只跳过、`_no-cwd` 直接落项目目录。
   */
  const syncSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const mode = url.searchParams.get('mode')
    const apply = mode === 'apply'
    /*
     * 确认那次体里带着预演给的 `planId`（见下面 `preview` 那段）。**体要在别的 await 之前读完**：请求体
     * 是一条流，先去做别的事再回来读，等于让它在这段时间里一直挂着（测试里的假请求更是早就把 `end`
     * 发完了——等回来接的时候已经没人在听，读的那一头就永远等下去）。
     */
    let planId: string | undefined
    let decisions: Map<string, SyncDecision> | undefined
    /** 落地这次要不要顺手整理自己那一格（预演那次不算它——整理会删远端的东西）。 */
    let tidy = false
    if (req.method === 'POST') {
      try {
        const body = (await readJson(req)) as { planId?: unknown; decisions?: unknown; tidy?: unknown } | null
        if (typeof body?.planId === 'string' && body.planId !== '') planId = body.planId
        if (body?.tidy === true) tidy = true
        // 裁决表：只认这三种值，别的键/值当没写——界面与工具都可能把旧数据递回来。
        if (body?.decisions !== null && typeof body?.decisions === 'object' && !Array.isArray(body.decisions)) {
          const picked = new Map<string, SyncDecision>()
          for (const [id, value] of Object.entries(body.decisions)) {
            if (value === 'keep-local' || value === 'keep-remote' || value === 'keep-both') picked.set(id, value)
          }
          if (picked.size > 0) decisions = picked
        }
      } catch {
        // 体不是 JSON：按"没有预演那份"处理——这条路上体只用来指认缓存与裁决，读不出来就不用它们。
      }
    }
    const runtime = await deps.sync?.()
    if (runtime === undefined) {
      sendJson(res, 409, { error: '这个宿主没有配置 WebDAV 同步（插件配置里的 sync.url 是空的）' })
      return
    }
    if (mode === 'test') {
      // 只读探一次：判定在 sync.ts，这里补上"这次有没有带凭据"两个事实——界面据此把 401 分成
      // "没配上密码"与"服务器不认这套"，那两句的处置完全不同。
      try {
        const result = await testSyncConnection(runtime.dav)
        sendJson(res, 200, {
          mode: 'test',
          remote: { url: runtime.settings.url, machineId: runtime.settings.machineId },
          ...result,
          username: runtime.settings.username ?? null,
          hasPassword: runtime.settings.password !== undefined,
        })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const syncDeps = {
      dav: runtime.dav,
      settings: runtime.settings,
      sessionsRoot: paths.sessionsRoot,
      registryPath: paths.registryPath,
      backupRoot: paths.backupRoot,
      decodeAll,
      resolveTitle,
      sessionMeta,
      // 扫本机那一趟读一次的投影记录（空白与两枚活动时间从它取，见 sync.ts 的 `SyncDeps.projection`）。
      projection,
      // 项目身份那份 git 缓存（入口注入的那一份，见 `ApiDeps.repoLocations`）。
      ...(deps.repoLocations === undefined ? {} : { repoLocations: deps.repoLocations }),
      // 覆盖本机那份之前要问一句"这条还在跑吗"（与删除同一条理由：宿主手里有它的写句柄）。
      liveSessionIds,
      // 拉取会把会话挂到目标工作区（改注册表）：整批落地之后由编排层收口交给宿主一次。
      hostRegistry,
      // 拉取来的会话在本机没有投影检查点：同一次收口里请宿主把列表元数据折出来（见 checkpoint-warm.ts）。
      hostCheckpoints,
      // 附件对象走远端共享库（`dsh-session-manager/attachments/…`）：推送时只补远端缺的、拉取时只取
      // 本机缺的，包本身照旧只有日志。宿主没有附件服务时端口缺席，这条路静默降级（见 sync.ts）。
      attachments: attachmentPort,
      ...(deps.pluginVersion === undefined ? {} : { pluginVersion: deps.pluginVersion }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }
    /**
     * 这次同步要不要重启才被承认。
     *
     * 落地那次按**真实结果**说（见 take-effect.ts 的 `effectOf()`）；预演那次按探测说——"要不要重启"
     * 得在按下确认**之前**就摆出来，事后才说等于没提醒（与迁移预演同一套口径）。
     *
     * 两种模式都只在"真有会话要落到本机"时才谈得上生效：纯推送不改本机任何东西，此时
     * `restart-required` 是一句假警告。
     */
    const syncEffect = (outcome: SyncOutcome): EffectMode => {
      if (outcome.applied) {
        return outcome.pulled.length === 0 ? 'immediate' : effectOf(outcome.effect, takesEffect())
      }
      return outcome.plan.pullIds.length === 0 ? 'immediate' : takesEffect()
    }
    /** 预演与落地回同一份形状的结果，界面两条路都用同一套解析。 */
    const payloadOf = (outcome: SyncOutcome): Record<string, unknown> => ({
      mode: apply ? 'apply' : 'plan',
      remote: { url: runtime.settings.url, machineId: runtime.settings.machineId },
      ...outcome,
      problems: [...outcome.plan.problems, ...outcome.problems],
      leftovers: collectLeftovers(outcome),
      takesEffect: syncEffect(outcome),
    })

    /*
     * 预演与落地都走事件流：`{type:'progress'}` 每做一条一次、`{type:'result'}` 收尾、`{type:'error'}`
     * 兜底。预演也要进度——它得先扫本机（每条会话读头、折标题）、再读远端索引、最后逐条比对内容，
     * 冷启动时这几秒里界面原来只有一句"预演中…"；落地那边同样受益，按下确认后到第一条拉取完成之间
     * 报的是重读远端索引那一条（照预演那份走时）。
     *
     * 流一旦开始，HTTP 状态就已经发出去了（200），所以这一段的错误只能靠事件说——客户端按
     * `content-type` 区分"流"与"一次性 JSON"（没配置同步那类错发生在写头之前，仍然是 JSON +
     * 409/500）。
     */
    /*
     * 只整理远端：`?mode=tidy`，GET 只算账（读远端、不写），POST 真删。
     *
     * 与落地分开是因为它不碰本机任何东西：不扫库、不拉不推、不写注册表。所以它既不需要预演缓存
     * （没有 planId），也没有"要不要重启"那一套；只需要跟落地同一道闸——两边都写自己那一格的索引，
     * 同时跑会互相踩。进度照旧走事件流：一次整理可能几百个包、几十秒。
     */
    if (mode === 'tidy') {
      const tidyApply = req.method === 'POST'
      if (tidyApply && applying !== null) {
        sendJson(res, 409, {
          error: `上一轮同步还在跑（${new Date(applying.startedAt).toLocaleTimeString('zh-CN')} 开始），等它结束再试`,
        })
        return
      }
      /*
       * 整理与落地写的是同一份索引：拿不到写权限就不开始，避免用旧快照盖掉别人刚写进去的条目。
       * 预演（GET）只读远端，不拿锁。
       */
      const release = tidyApply ? remoteWrite.tryAcquire('整理远端') : undefined
      if (tidyApply && release === undefined) {
        sendJson(res, 409, { error: remoteBusyMessage(remoteWrite.current()) })
        return
      }
      try {
        await streamResult(res, async (report) => {
          const outcome = await runTidy(syncDeps, { apply: tidyApply, onProgress: report })
          return {
            mode: tidyApply ? 'apply' : 'plan',
            remote: { url: runtime.settings.url, machineId: runtime.settings.machineId },
            ...outcome,
          }
        })
      } finally {
        release?.()
      }
      return
    }

    /*
     * 一趟落地还没跑完就不再开第二趟。
     *
     * 这道闸挡的是"关掉窗口继续跑"带来的新情况：那趟现在比发起它的页面活得久，用户可能刷新之后、或者
     * 在另一个页签里再点一次。两趟一起跑会互相踩（同一份预演缓存、同一个远端、同一条本机日志），
     * 所以第二趟在这里就被拒——一次性 JSON + 409，发生在写响应头之前，界面能照实说清是"还在跑"。
     */
    if (apply && applying !== null) {
      sendJson(res, 409, {
        error: `上一轮同步还在跑（${new Date(applying.startedAt).toLocaleTimeString('zh-CN')} 开始），等它结束再试`,
      })
      return
    }
    /*
     * 落地要写自己那一格的索引与包，先拿写权限：自动推送、整理远端、删除远端、模型工具可能正拿着。
     * 预演（!apply）只读，不拿锁。
     */
    const releaseRemote = apply ? remoteWrite.tryAcquire('同步') : undefined
    if (apply && releaseRemote === undefined) {
      sendJson(res, 409, { error: remoteBusyMessage(remoteWrite.current()) })
      return
    }
    sendEventStream(res)
    const startedAt = Date.now()
    if (apply) {
      applying = { startedAt, progress: null }
      panelEmit({ type: 'sync', applying: applyingPayload(), last: lastApply })
    }
    try {
      const onProgress = (progress: SyncProgress): void => {
        // 给"没在听这条流的人"留一份最新进度（刷新之后进来的页面读它）。
        if (apply && applying !== null) applying.progress = progress
        sendEvent(res, { type: 'progress', progress })
        // 面板那条流上的页面看的就是这一条：它们不会去听这条响应（那是发起者自己的）。
        if (apply) panelEmit({ type: 'sync', applying: applyingPayload(), last: lastApply })
      }
      if (!apply) {
        /*
         * 预演：算一份计划，并且把那一次算出来的输入留在 `preview` 里（见 `SyncPrepared`）。
         *
         * `planId` 就是这个格子的号码：确认那次带着它回来，对得上就**照着这份数据落地**，不再把同一
         * 份计划重算一次（用户按下确认到第一条拉取之间原来要等的那几秒就是它）。
         */
        /*
         * 带着上一次的 `planId` 回来、只换了裁决（用户点「以本机为准 / 以远端为准」）：计划只该重算
         * 那一层——扫本机、读远端索引、问 git、算指纹这些输入都还在那份预演里（见 `replanPrepared()`）。
         * 几十毫秒，而不是把整条同步流程再走一遍。
         */
        const reused = preview !== null && planId !== undefined && preview.id === planId ? preview : undefined
        let planned: SyncPrepared
        let id: string
        if (reused !== undefined) {
          planned = replanPrepared(reused.value, syncDeps, decisions)
          id = reused.id
        } else {
          planned = await prepareSync(syncDeps, {
            onProgress,
            ...(decisions === undefined ? {} : { decisions }),
          })
          previewSeq += 1
          id = `${previewSeq}-${Math.random().toString(36).slice(2, 8)}`
        }
        preview = { id, value: planned, decisionsKey: decisionsKeyOf(decisions) }
        sendEvent(res, {
          type: 'result',
          result: {
            ...payloadOf(plannedOutcome(planned)),
            planId: id,
            // 预演里也报一次"整理能删多少"：界面据此决定那个勾选框摆不摆、写多少个包。它只是账目，
            // 真删的条件与判据在落地那次由 `planTidy()` 按当时的远端索引重算一遍。
            tidy: tidySummary(planned.remote, runtime.settings.machineId),
          },
        })
      } else {
        /*
         * 落地：体里带着预演给的 `planId` 时优先照着那份数据走（见 sync.ts 的 `syncPrepared()`——它会先
         * 验一遍那份数据还作不作数，变了就从零重算）。对不上（宿主重启过、又一次预演把它换掉了、旧
         * 客户端没带 id）就照旧从零算一遍；结果里的 `planSource` 说清这次走的哪条路。
         */
        const candidate = preview !== null && planId !== undefined && preview.id === planId ? preview : undefined
        // 裁决是预演输入的一部分：同一份 planId 但选择变了，就不能拿旧计划落地。
        const cached = candidate !== undefined && candidate.decisionsKey === decisionsKeyOf(decisions) ? candidate.value : undefined
        // 消费掉：一份预演只够落地一次（第二次带着同一个 id 回来就重算一遍）。
        if (candidate !== undefined) preview = null
        const outcome: SyncOutcome =
          cached !== undefined
            ? await syncPrepared(syncDeps, cached, {
                onProgress,
                ...(decisions === undefined ? {} : { decisions }),
                ...(tidy ? { tidy: true } : {}),
              })
            : decisions !== undefined
              ? {
                  ...(await runSync(syncDeps, {
                    apply: true,
                    onProgress,
                    decisions,
                    ...(tidy ? { tidy: true } : {}),
                  })),
                  ...(planId === undefined
                    ? {}
                    : {
                        planSource: {
                          kind: 'recomputed' as const,
                          reason: '预演那份的裁决与这次不一致（或那份已经不在宿主手里了），按这次的选择重算',
                        },
                      }),
                }
              : planId === undefined
                ? await runSync(syncDeps, { apply: true, onProgress, ...(tidy ? { tidy: true } : {}) })
                : {
                    ...(await runSync(syncDeps, { apply: true, onProgress, ...(tidy ? { tidy: true } : {}) })),
                    planSource: {
                      kind: 'recomputed',
                      reason: '预演那份已经不在宿主手里了（宿主重启过，或又一次预演把它换掉了）',
                    },
                  }
        lastApply = {
          startedAt,
          finishedAt: Date.now(),
          ok: true,
          pulled: outcome.pulled.length,
          pushed: outcome.pushed.length,
          leftovers: collectLeftovers(outcome),
        }
        // 同一份结论写进磁盘：进程重启之后页头那枚状态还答得出"上次同步在什么时候、拉了几条"。
        deps.syncRun?.write({
          at: (deps.now?.() ?? new Date()).toISOString(),
          ok: true,
          pulled: outcome.pulled.length,
          pushed: outcome.pushed.length,
          // 跑完了但有几条没做到、或者改动要重启才生效：这两种都不是"一切太平"，页头那枚点据此变黄。
          problems: outcome.problems,
          // 点名版：哪条会话、为什么（见 `collectLeftovers()`）。窗口关掉之后，"上次同步"那张清单靠它。
          leftovers: collectLeftovers(outcome),
          takesEffect: effectOf(outcome.effect, takesEffect()),
        })
        applying = null
        panelEmit({ type: 'sync', applying: null, last: lastApply })
        // 拉取会把会话落到本机：别的页面（以及这个页面的清单）都得重读一次。
        if (outcome.pulled.length > 0 || outcome.replaced.length > 0) panelEmit({ type: 'stale', what: 'state' })
        sendEvent(res, { type: 'result', result: payloadOf(outcome) })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (apply) {
        // 失败也留一条：刷新之后进来的页面要能说"刚才那一趟没成、原因是这个"，而不是一片空白。
        applying = null
        lastApply = { startedAt, finishedAt: Date.now(), ok: false, pulled: 0, pushed: 0, error: message }
        deps.syncRun?.write({
          at: (deps.now?.() ?? new Date()).toISOString(),
          ok: false,
          pulled: 0,
          pushed: 0,
          error: message,
        })
        panelEmit({ type: 'sync', applying: null, last: lastApply })
      }
      sendEvent(res, { type: 'error', error: message })
    } finally {
      releaseRemote?.()
    }
    res.end()
  }

  /**
   * 自动推送：`GET /auto-push` 当场跑一轮（**只推不拉**），边跑边报进度。
   *
   * 为什么只有一个方向、没有 `mode=apply` 那种分岔：自动推送这条路**没有确认那一步**——它不改本机
   * 任何东西（见 [sync.ts](./operations/sync/sync.ts) 的 `runAutoPush()`），所以"预演"与"落地"在它这里本来就是同一件
   * 事。界面上那枚「立即推送一次」点下去就是真跑，进度画在页面横幅上。
   *
   * 点下去就是真跑，没有"距上次才过了几秒"这种闸——自动推送现在只在写完一轮之后自己跑，这条是让人
   * 手点一次（见 [那篇决策](../.agents/notes/implemented/simplification/2026-10-21-auto-push-only-after-a-turn.md)）。
   *
   * 流已经开始的错只能靠事件说（那时 HTTP 状态早就是 200 了）；没配同步 / 没有调度器这两件事发生在
   * 写头之前，仍然是 JSON + 409。
   */
  const autoPushNow = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const timer = await deps.autoPush?.()
    if (timer === undefined) {
      sendJson(res, 409, {
        error: '这个宿主没有自动推送的调度器（没有配置 WebDAV 同步，或它启动失败）',
      })
      return
    }
    sendEventStream(res)
    try {
      const onProgress = (progress: SyncProgress): void => sendEvent(res, { type: 'progress', progress })
      const outcome = await timer.tick({ onProgress })
      sendEvent(res, {
        type: 'result',
        result: autoPushPayload(
          outcome,
          deps.syncInfo?.(),
          // 只推那一档不会动本机，因此不吃"要不要重启"那一问；双向那一档按宿主能力说话。
          deps.syncInfo?.()?.autoPush?.mode === 'sync' ? takesEffect() : 'immediate',
        ),
      })
    } catch (error) {
      sendEvent(res, { type: 'error', error: error instanceof Error ? error.message : String(error) })
    }
    res.end()
  }

  /**
   * 重新生成名称：把点名的会话交给宿主的名称服务逐条重算（见 retitle.ts 与 tools.ts 的端口）。
   *
   * 走事件流：每条会话都要整份解一次日志（实测 6MB ≈1.7 秒）再跑一次模型调用（2～3 秒），勾十条就是
   * 半分钟——那段时间界面只有一句不动的按钮，所以这一段照归档那套报进度。
   *
   * 两处**拒绝**在流开始之前回 JSON 带状态码（那时还没有字节发出去）：一条会话都没勾（400）、
   * 这个宿主没有名称服务（409，"点了也没反应"的按钮比禁用更糟，两者都要能说清原因）。
   * 子智能体不在这里拒——它不是错误，是"本来就不该动它"，由编排层按条记成跳过。
   */
  /**
   * 比两份日志：本机这一份，与**远端某台机器**上同一个 id 的那一份。
   *
   * 这是同步里"同一个 id 两边各自写过"（计划里的 `diverged`）那条路的只读出口：那个判定只说得出
   * "两边不一样"，说不出"哪儿不一样、谁多了什么"，而删哪边、留哪边只能由人决定。所以这里把两份日志都
   * 读出来交给 `diffSessionLogs()` 算一份差异，**一个字节都不写**：不落盘本机、不改远端。
   *
   * 远端那一份得先下来：包在 `dsh-session-manager/<机器>/<id>.dshsess`，拉取时取的就是同一个对象，
   * 所以这一步走网络、按条下（日志平均几百 KB，最大几 MB）。取哪台机器由调用方指名（界面从计划里
   * 已经知道 `machine` 是谁）；没指名就用远端索引里这个 id 记的那一台。
   *
   * 拒绝都在响应体里说清是哪一步、哪一边：没给 id（400）、没配同步（409）、本机库里没有这条（404）、
   * 远端索引 / 包 / 日志取不到或读不出来（502 / 404 / 422）。**坏行不算拒绝**：它由核心层如实记进
   * `problems`，条数照报。
   */
  const syncDiff = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = (url.searchParams.get('id') ?? '').trim()
    if (id === '') {
      sendJson(res, 400, { error: '缺少会话 id（?id=…）' })
      return
    }
    const runtime = await deps.sync?.()
    if (runtime === undefined) {
      sendJson(res, 409, { error: '这个宿主没有配置 WebDAV 同步（插件配置里的 sync.url 是空的）' })
      return
    }
    // 与内容视图同一口径：按 id 直接找（不扫整库），标题也走同一份投影记录。
    const session = await locateSession(paths.sessionsRoot, id, decodeAll, { projection, resolveTitle })
    if (session === undefined) {
      sendJson(res, 404, { error: `会话库里没有 ${id}` })
      return
    }
    // 与内容视图同一口径：读宿主也读的那一份（最高代次）。
    const file = [...session.files].sort((left, right) => right.version - left.version)[0]
    if (file === undefined) {
      sendJson(res, 422, { error: '这条会话目录里没有日志文件' })
      return
    }
    let remote: Awaited<ReturnType<typeof readRemoteLibrary>>
    try {
      remote = await readRemoteLibrary(runtime.dav, runtime.settings)
    } catch (error) {
      sendJson(res, 502, { error: `读远端索引失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    const entry = remote.entries.get(id)
    if (entry === undefined) {
      sendJson(res, 404, { error: `远端索引里没有 ${id}` })
      return
    }
    const wanted = (url.searchParams.get('machine') ?? '').trim()
    if (wanted !== '' && entry.machine !== wanted) {
      sendJson(res, 409, { error: `远端这一份是 ${entry.machine} 的，不是 ${wanted} 的` })
      return
    }
    let bundleBytes: Buffer
    try {
      bundleBytes = await runtime.dav.get(remoteBundlePath(entry.machine, id))
    } catch (error) {
      sendJson(res, 502, { error: `取 ${entry.machine} 那份失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let remoteLines: string[]
    let remoteLogBytes: number
    try {
      const bundle = await readBundleAsync(bundleBytes)
      const bundled = bundle.sessions.find((item) => item.id === id)
      if (bundled === undefined) {
        sendJson(res, 404, { error: `远端包里没有 ${id}（清单与索引对不上）` })
        return
      }
      const remoteFile = [...bundled.files].sort((left, right) => right.version - left.version)[0]
      if (remoteFile === undefined) {
        sendJson(res, 422, { error: '远端那份包里没有日志文件' })
        return
      }
      const bytes = entryBytes(bundle, remoteFile)
      // 分块解压、块间让出：这条会话可能几十 MB，整份解会把宿主按住一两秒（差异页是点一下就要等的地方）。
      remoteLines = await splitLinesAsync(await decodeLogTextChunked(bytes, remoteFile.compression))
      remoteLogBytes = bytes.byteLength
    } catch (error) {
      sendJson(res, 422, { error: `远端那份读不出来：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let localLines: string[]
    try {
      localLines = await splitLinesAsync(await decodeLogTextChunked(await readFile(file.path), file.compression))
    } catch (error) {
      sendJson(res, 422, { error: `本机那份读不出来：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    // 坏行条数交给解析器记账（`limit` 只影响条目，`problemCount` 是整份的账）；header 坏了就直说哪一边。
    // 坏行条数要在整份日志上数（几十 MB 的那种也有）：走分块版本，别把主线程按住。
    const problemsOf = async (lines: readonly string[], label: string): Promise<number> => {
      try {
        return (await readTranscriptAsync(lines, { limit: 1, maxChars: 1 })).problemCount
      } catch (error) {
        throw new Error(`${label}那份读不出来：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const diff = diffSessionLogs(localLines, remoteLines, {
        localBytes: (await stat(file.path)).size,
        remoteBytes: remoteLogBytes,
        localProblems: await problemsOf(localLines, '本机'),
        remoteProblems: await problemsOf(remoteLines, '远端'),
      })
      sendJson(res, 200, {
        id,
        machine: entry.machine,
        localFile: basename(file.path),
        // 下这一个包花了多少字节：界面上那句"看差异"背后真的发生了多少流量，说清楚。
        bundleBytes: bundleBytes.byteLength,
        diff,
      })
    } catch (error) {
      sendJson(res, 422, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * 「这些会话在远端哪儿」：一遍读齐所有机器格子里的位置，界面一次刷新只问这一回。
   *
   * 为什么不并进 `/state`：那一份是"扫本机"的结果，页头与清单都等它；远端是另一台机器上的东西，
   * 读不到（NAS 关着、密码过期）时不该把本机的清单一起拖住。所以另开一条，界面拿到新清单之后顺手问
   * 一次，读到就整份缓存在页面这一层（见 `src/client/operations/sync/remoteLibrary.ts`）。
   *
   * 一次给全部而不是按会话问：右栏选中一条会话时要立刻有答案，按会话现问会让每次点选都等一次网络。
   * 便宜是因为读的只是每台机器那份 `index.json`，不是包本身。
   */
  const remoteLibrary = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const runtime = await deps.sync?.()
    if (runtime === undefined) {
      sendJson(res, 409, { error: '这个宿主没有配置 WebDAV 同步（插件配置里的 sync.url 是空的）' })
      return
    }
    let remote: Awaited<ReturnType<typeof readRemoteLibrary>>
    try {
      remote = await readRemoteLibrary(runtime.dav, runtime.settings)
    } catch (error) {
      sendJson(res, 502, { error: `读远端索引失败：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    sendJson(res, 200, remotePlacements(remote, (deps.now?.() ?? new Date()).getTime()))
  }

  return {
    handlers: {
      'GET|POST /sync': syncSessions,
      'GET /auto-push': autoPushNow,
      'GET /sync-diff': syncDiff,
      'GET /remote': remoteLibrary,
    },
    applyStatus: () => ({ applying: applyingPayload(), last: lastApply }),
  }
}
