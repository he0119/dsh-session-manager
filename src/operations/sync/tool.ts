// 「同步」那条工具的定义：模板、结论措辞与没做到的清单。编排在 sync.ts，运行时在 runtime.ts。
//
// @module dsh-session-manager/operations/sync/tool
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { PluginConfigInput } from '../../config.ts'
import { describeWarm } from '../../shared/host/checkpoint-warm.ts'
import {
  attachmentPort,
  hostCheckpointPort,
  hostRegistryPort,
  liveSessionIds,
} from '../../shared/host/ports.ts'
import { describePlannedEffect, effectOf } from '../../shared/host/take-effect.ts'
import { createProjectionReader } from '../../shared/library/projection-cache.ts'
import type { ResolvedPaths } from '../../shared/plugin-paths.ts'
import { projectionCacheDir } from '../../shared/paths.ts'
import type { DecodeAll, EffectMode } from '../../shared/types.ts'
import { createSessionMetaResolver } from '../../shared/visibility.ts'
import type { RemoteWriteGate } from './remote-write.ts'
import { syncRuntime } from './runtime.ts'
import { collectLeftovers, runSync, type SyncLeftover, type SyncPlan } from './sync.ts'
import type { SyncAttachmentIn, SyncAttachmentOut } from './attachments.ts'

/** 同步工具的返回值。 */
export interface SyncToolResult {
  ok: boolean
  applied: boolean
  pulled: string[]
  /** `pulled` 里有多少条是**覆盖本机原来那份**（旧的已进备份）。 */
  replaced: string[]
  pushed: string[]
  /** 什么都没动的那几条与原因（远端领先、分叉、缺映射……），外加跳过的空白会话。 */
  notes: string[]
  bytesIn: number
  bytesOut: number
  /**
   * 附件对象那一段（远端共享库里搬的那些），按**对象**计而不是按引用计。
   *
   * 三个数都是 0 表示"这次没搬对象"或"宿主没有附件服务"——工具结果里不区分这两件事（要区分的是界面，
   * 它读 `SyncOutcome.attachmentIn/Out` 的**缺席**）。
   */
  attachmentsIn: number
  attachmentsOut: number
  /** 本机有引用、对象却不在本机：这次带不上去的个数。 */
  attachmentsMissing: number
  machines: string[]
  takesEffect: EffectMode
  summary: string
  problems: string[]
}

/** 一次没有真正跑起来的同步：`ok` 为 false，计数全空，只带一句原因。 */
function syncToolUnavailable(message: string): SyncToolResult {
  return {
    ok: false,
    applied: false,
    pulled: [],
    replaced: [],
    pushed: [],
    notes: [],
    bytesIn: 0,
    bytesOut: 0,
    attachmentsIn: 0,
    attachmentsOut: 0,
    attachmentsMissing: 0,
    machines: [],
    takesEffect: 'immediate',
    summary: message,
    problems: [message],
  }
}

/**
 * 计划里"没动"的条目（推送与拉取两侧的 skip）压成一行行说明，外加两条**方向相反**的特别说明：
 * 「覆盖本机」是拉取侧里唯一会动本机已有内容的一类（旧的进备份），空白会话则是整类不参与同步。
 *
 * `identical`（"远端已经有这一份"）不进来：整库同步时它是最多也最没信息量的一类，几百行"这条不用推送"
 * 会把真正要看的那几条淹掉。
 */
function planNotes(plan: SyncPlan): string[] {
  const notes: string[] = []
  for (const entry of plan.pull) {
    if (entry.action === 'skip') notes.push(`不拉取 ${entry.id}：${entry.reason ?? ''}`)
    else if (entry.action === 'replace') notes.push(`覆盖本机 ${entry.id}：${entry.reason ?? ''}`)
  }
  for (const entry of plan.push) {
    if (entry.action === 'skip' && entry.code !== 'identical') notes.push(`不推送 ${entry.id}：${entry.reason ?? ''}`)
  }
  if (plan.blank.length > 0) {
    notes.push(`跳过 ${plan.blank.length} 条空白会话（建出来但一轮都没开始过）：${plan.blank.join('、')}`)
  }
  return notes
}

/** 一次同步的一句话结论。 */
function describeSync(
  plan: SyncPlan,
  pulled: readonly string[],
  replaced: readonly string[],
  pushed: readonly string[],
  applied: boolean,
  attachments?: { in?: SyncAttachmentIn; out?: SyncAttachmentOut },
  deleted?: { ids: readonly string[]; bytes: number },
): string {
  const head = `${applied ? '已同步' : '预览'}：拉取 ${plan.pullIds.length} 条、推送 ${plan.pushIds.length} 条（本机 ${plan.localCount} 条，远端 ${plan.remoteCount} 条，来自 ${plan.machines.join('、') || '还没有机器'}）`
  if (!applied) {
    // 预览时把"跟着删"的条数也报出来：确认那一下之后它会真的删（先进备份）。
    return plan.deleted.length === 0
      ? head
      : `${head}。其中 ${plan.deleted.length} 条已在别处删除，确认后会跟着删（先进备份）`
  }
  // 拉取里有多少条是"换掉本机原来那份"值得单独报：旧的进备份了，用户可能想恢复回去。
  const overwrote =
    replaced.length === 0 ? '' : `，其中 ${replaced.length} 条覆盖了本机原来那份（旧的那份已进备份）`
  const followed =
    deleted === undefined || deleted.ids.length === 0
      ? ''
      : `，跟着删掉 ${deleted.ids.length} 条已在别处删除的会话（旧的那份已进备份）`
  return `${head}。实际应用：拉取 ${pulled.length} 条、推送 ${pushed.length} 条${overwrote}${followed}${describeSyncObjects(attachments)}`
}

/**
 * 「没做到」的那几条：一句一条，多的折成"还有 N 条"。
 *
 * 界面上那张「上次同步」的清单是同一份数据（见 `src/operations/sync/sync.ts` 的 `collectLeftovers()`）；工具这边只说
 * 前几条，剩下的说个数——模型不需要读完整张清单，它要的是"有没有事没做完、是哪条"。
 */
function describeLeftovers(leftovers: readonly SyncLeftover[], limit = 5): string | undefined {
  if (leftovers.length === 0) return undefined
  const lines = leftovers.slice(0, limit).map((item) => `- ${item.message}`)
  if (leftovers.length > limit) lines.push(`- 还有 ${leftovers.length - limit} 条没列出来`)
  return `没做到 ${leftovers.length} 条：\n${lines.join('\n')}`
}

/**
 * 附件对象那一段（远端共享库里搬的那些）。
 *
 * 只在真有对象动了（或真有对象没带上）时说：一条会话都没动时多出来的"附件对象 0 个"是噪音。宿主没有
 * 附件服务时两项都缺席，这里自然什么都不说。
 */
function describeSyncObjects(attachments?: { in?: SyncAttachmentIn; out?: SyncAttachmentOut }): string {
  const written = attachments?.in?.written ?? 0
  const uploaded = attachments?.out?.uploaded ?? 0
  const missing = attachments?.out?.missing ?? 0
  const parts: string[] = []
  if (written > 0) parts.push(`取回附件对象 ${written} 个`)
  if (uploaded > 0) parts.push(`上传附件对象 ${uploaded} 个`)
  if (missing > 0) parts.push(`本机缺 ${missing} 个附件对象（这次没带上）`)
  return parts.length === 0 ? '' : `，另${parts.join('、')}`
}

/** 这条工具用到的上下文。 */
export interface SyncToolContext {
  /** 宿主上下文：解析密码引用、探测可选服务。 */
  ctx: unknown
  /** 插件配置（活引用或普通对象）。 */
  config: PluginConfigInput
  /** 会话库、注册表与备份根。 */
  paths: ResolvedPaths
  /** 写远端格子的互斥锁：预览不拿，真应用才拿。 */
  remoteWrite: RemoteWriteGate
  /** 这次调用能看到哪种生效模式。 */
  mode: () => EffectMode
  /** 平台的 fzstd 解码器。 */
  decodeAll: DecodeAll
}

/** 造出「同步」那条工具的定义。 */
export function syncTool(context: SyncToolContext): ToolDefinition {
  const { ctx, config, paths, remoteWrite, mode, decodeAll } = context
  return defineTool({
      name: 'sync_sessions',
      description:
        'Sync DSH sessions with the WebDAV remote configured in this plugin (sync.url): pull the sessions ' +
        'other machines contributed and push the local ones the remote does not have yet. Pulled sessions ' +
        'land through the same import path as the settings page, so each log header cwd is rewritten to the ' +
        'mapped directory of THIS machine (the remote stores portable .dshsess bundles, never a raw session ' +
        'library). When both sides hold the same id, contents and the host-projected last-activity time decide ' +
        'who is newer: identical stays put, a local copy that is strictly ahead is re-uploaded, a remote copy ' +
        'that is ahead or a both-wrote case where the remote is newer backs the local copy up and then replaces ' +
        'it, and a both-wrote case where the local copy is newer is re-uploaded. Blank sessions (created but ' +
        'never started) are neither uploaded nor kept in this machine index. ' +
        'Defaults to dry-run; apply:true performs it. Configure the remote and the cwd mapping in the plugin ' +
        'configuration; without sync.url the call reports that nothing is configured.',
      parameters: {
        apply: {
          type: 'boolean',
          description: 'Optional: true performs the sync (default false = only compute and report the plan).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            applied: { type: 'boolean', required: true },
            pulled: { type: 'array', required: true, items: { type: 'string' } },
            replaced: { type: 'array', required: true, items: { type: 'string' } },
            pushed: { type: 'array', required: true, items: { type: 'string' } },
            notes: { type: 'array', required: true, items: { type: 'string' } },
            bytesIn: { type: 'integer', required: true },
            bytesOut: { type: 'integer', required: true },
            attachmentsIn: { type: 'integer', required: true },
            attachmentsOut: { type: 'integer', required: true },
            attachmentsMissing: { type: 'integer', required: true },
            machines: { type: 'array', required: true, items: { type: 'string' } },
            takesEffect: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            problems: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text' as const, text: String((value as SyncToolResult).summary) },
        ],
      },
      async execute(args): Promise<SyncToolResult> {
        const runtime = await syncRuntime(ctx, config)
        if (runtime === undefined) {
          return syncToolUnavailable('没有配置 WebDAV 同步：插件配置里的 sync.url 是空的。')
        }
        /*
         * 真应用才拿写权限：预览只读远端，与别的写手同时跑不会改任何东西，不需要挡。拿不到时
         * 直接回一句，不排队——排队之后拿旧快照去写，正是这把锁要防的事。
         */
        let release: (() => void) | undefined
        if (args.apply === true) {
          release = remoteWrite.tryAcquire('同步')
          if (release === undefined) {
            const owner = remoteWrite.current()
            const at =
              owner === undefined ? '' : `（${new Date(owner.startedAt).toLocaleTimeString('zh-CN')} 开始）`
            return syncToolUnavailable(`上一轮${owner?.label ?? '同步'}还在跑${at}，这次没有同步。`)
          }
        }
        try {
          const outcome = await runSync(
          {
            dav: runtime.dav,
            settings: runtime.settings,
            sessionsRoot: paths.sessionsRoot,
            registryPath: paths.registryPath,
            backupRoot: paths.backupRoot,
            decodeAll,
            // 空白与最后活动时间读宿主投影缓存（与界面那条路同一个来源，见 visibility.ts）。
            sessionMeta: createSessionMetaResolver({ cacheDir: projectionCacheDir(paths.registryPath) }),
            projection: createProjectionReader(projectionCacheDir(paths.registryPath)),
            // 覆盖本机那份之前要问一句"这条还在跑吗"（与删除同一条理由：宿主手里有它的写句柄）。
            liveSessionIds: () => liveSessionIds(ctx),
            // 拉取会把会话重挂到目标工作区（写注册表），所以整批应用之后同样要把宿主重新接管一遍。
            hostRegistry: () => hostRegistryPort(ctx),
            // 同一处统一处理：拉取来的会话在本机没有投影检查点，请宿主把列表元数据折出来（见 checkpoint-warm.ts）。
            hostCheckpoints: () => hostCheckpointPort(ctx),
            // 附件对象走远端共享库（推送只补远端缺的、拉取只取本机缺的），包本身照旧只有日志。
            attachments: () => attachmentPort(ctx),
          },
          { apply: args.apply === true },
        )
        const pushedIds = outcome.applied ? outcome.pushed.map((entry) => entry.id) : outcome.plan.pushIds
        return {
          ok: outcome.plan.ok && outcome.problems.length === 0,
          applied: outcome.applied,
          pulled: outcome.applied ? outcome.pulled : outcome.plan.pullIds,
          replaced: outcome.applied ? outcome.replaced : [],
          pushed: pushedIds,
          notes: planNotes(outcome.plan),
          bytesIn: outcome.applied ? outcome.bytesIn : outcome.plan.bytesIn,
          bytesOut: outcome.applied ? outcome.bytesOut : outcome.plan.bytesOut,
          // 只应用那一次报得出这两个数：预览不知道远端共享库里有哪些对象（见 SyncOutcome 的字段说明）。
          attachmentsIn: outcome.attachmentIn?.written ?? 0,
          attachmentsOut: outcome.attachmentOut?.uploaded ?? 0,
          attachmentsMissing: outcome.attachmentOut?.missing ?? 0,
          machines: outcome.plan.machines,
          /*
           * 这次同步要不要重启才被承认：应用按真实结果说，预览按探测说（与界面那条路同一个标准，
           * 见 src/web.ts 里的 `syncEffect()`）。两种模式都只在"真有会话要落到本机"时才谈得上生效：
           * 纯推送不改本机任何东西，`restart-required` 在那时会是一句假警告。
           */
          takesEffect: outcome.applied
            ? outcome.pulled.length === 0
              ? 'immediate'
              : effectOf(outcome.effect, mode())
            : outcome.plan.pullIds.length === 0
              ? 'immediate'
              : mode(),
          summary: [
            describeSync(
              outcome.plan,
              outcome.pulled,
              outcome.replaced,
              pushedIds,
              outcome.applied,
              { in: outcome.attachmentIn, out: outcome.attachmentOut },
              outcome.deleted,
            ),
            describeWarm(outcome.warm),
            describeLeftovers(collectLeftovers(outcome)),
            // 预览也要把"执行后会怎样"说出来，否则调用方要到应用之后才知道要重启（与迁移工具同一条）。
            outcome.applied || outcome.plan.pullIds.length === 0 ? undefined : describePlannedEffect(mode()),
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
          problems: [...outcome.plan.problems, ...outcome.problems],
          }
        } finally {
          release?.()
        }
      },
    })
}
