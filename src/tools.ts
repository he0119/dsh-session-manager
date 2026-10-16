// src/tools.ts — 暴露给模型的 5 个工具。
//
// 设计取向：
//   * 读操作（plan / verify）永不写盘；
//   * 写操作（migrate / rollback / sync）默认 dry-run，必须显式 apply:true；
//   * 每个写操作的返回值都说明"何时生效"——因为注册表改完还得让宿主认（见 take-effect.ts 与
//     hostRegistryPort()：能把活儿交给宿主自己做就即时生效，否则如实说要重启）。
import type { Context } from '@deepseek-ai/cordis'

import {
  DEFAULT_AUTO_PUSH_INTERVAL_MS,
  DEFAULT_PASSWORD_REF,
  autoPushSection,
  syncSection,
  type AutoPushConfig,
  type PluginConfig,
  type PluginConfigInput,
  type SyncConfig,
} from './config.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { createDavClient, type DavPort } from './dav.ts'
import type { AttachmentPort } from './attachments.ts'
import { readHeaderQuick } from './discovery.ts'
import {
  previewMigration,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
} from './migrate.ts'
import { projectKey } from './project-key.ts'
import { projectionCacheDir } from './paths.ts'
import { describeWarm } from './checkpoint-warm.ts'
import { describeEffect, describePlannedEffect, effectOf } from './take-effect.ts'
import {
  createAutoPushTimer,
  runAutoPush,
  runSync,
  type AutoPushOutcome,
  type AutoPushTimer,
  type SyncAttachmentIn,
  type SyncAttachmentOut,
  type SyncPlan,
  type SyncDeps,
  type SyncSettings,
} from './sync.ts'
import type { CheckpointWarmPort, DecodeAll, EffectMode, HostRegistryPort, RetitleOutcome, TitleRefreshOptions, TitleRefreshPort } from './types.ts'
import { createSessionMetaResolver } from './visibility.ts'

/**
 * 平台的 fzstd 解码器（纯 JS、多帧感知）。
 *
 * 导出是为了让 Web 端点那一层用**同一个**解码器实例：`assertMultiFrameAware()` 的探测结论
 * 只应对一份实现成立，两处各挑一个解码器正是当初「只解首帧」那个坑的入口。
 */
import { decompress } from 'fzstd'

export const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

/** 界面要知道的同步配置（只有非敏感字段，没有密码）。 */
export interface SyncInfo {
  url: string
  machineId: string
  /** 映射条数；映射表本身在配置里，界面只报条数。 */
  mappings: number
  /**
   * 自动推送的当前设置；**没开就是缺席**（不是 `enabled: false`）。
   *
   * 界面靠它在卡片头下面补一句"自动推送已开：写完一轮就推，另外每 N 分钟兜底一次"。间隔在这里报出来的理由：它是拍平之后的
   * 真值（抬过下限、填缺省），而界面草稿里那一栏留空时显示的是灰字——灰字要写对，得有人算出这个数。
   */
  autoPush?: { intervalMs: number }
}

/** 解析后的默认路径。 */
export interface ResolvedPaths {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
}

/** DSH 家目录：`$DSH_HOME`，缺席时退到 `~/.dsh`。 */
function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** 默认备份根：`<DSH_HOME>/dsh-session-manager/backups`。 */
function defaultBackupRoot(home: string): string {
  return join(home, 'dsh-session-manager', 'backups')
}

/**
 * 旧版默认备份根：`<DSH_HOME>/dsh-session-manager-backups`（0.3.x 及更早用的那层平铺名字）。
 *
 * 只有 {@link adoptLegacyBackupRoot} 还读它，新代码别再往这里写。
 */
function legacyBackupRoot(home: string): string {
  return join(home, 'dsh-session-manager-backups')
}

/** 从插件配置与 $DSH_HOME 解析默认路径。 */
export function resolvePaths(config: PluginConfigInput = {}): ResolvedPaths {
  const home = dshHome()
  return {
    sessionsRoot: config.sessionsRoot ?? join(home, 'sessions'),
    registryPath: config.registryPath ?? join(home, 'storages', 'workspace.json'),
    backupRoot: config.backupRoot ?? defaultBackupRoot(home),
  }
}

/** 旧默认备份根的一次性搬迁结果。 */
export interface LegacyBackupAdoption {
  /** 旧位置。 */
  from: string
  /** 新位置（搬成功时旧位置已经不在）。 */
  to: string
  /** 搬成功为 true；没搬成时两个路径都不动，`error` 说明原因。 */
  ok: boolean
  error?: string
}

/**
 * 把旧默认备份根整体搬进插件目录。
 *
 * 默认备份根从 `<DSH_HOME>/dsh-session-manager-backups` 改成
 * `<DSH_HOME>/dsh-session-manager/backups`——与 `dsh-config-manager/snapshots` 那种"插件名 / 子目录"
 * 同一形状，别人的 `$DSH_HOME` 根下不再多出一层只属于某个插件的平铺名字。旧备份不能就这么留在原地：
 * 清单只读 `backupRoot` 一个根，而 `src/migrate.ts` 的 `assertBackupDir()` 只认备份根下的路径——留下的
 * 旧备份既列不出来，也没法按路径回滚（等于把已经写好的回退凭据锁在门外）。
 *
 * 三个条件同时成立才动：用户没自己配 `backupRoot`（配了就按他说的来）、旧目录在、新目录不在。整个
 * rename 在同一个 `$DSH_HOME` 下是原子的；搬不动就原样留着并如实报错——备份是回滚的唯一凭据，宁可
 * 不搬，也不能搬一半。
 *
 * @param config 插件配置。
 * @returns 发生了搬迁（或搬迁失败）时的结果；没什么可搬就是 undefined。
 */
export function adoptLegacyBackupRoot(config: PluginConfigInput = {}): LegacyBackupAdoption | undefined {
  if ((config.backupRoot ?? '').trim() !== '') return undefined
  const home = dshHome()
  const from = legacyBackupRoot(home)
  const to = defaultBackupRoot(home)
  if (!existsSync(from) || existsSync(to)) return undefined
  try {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    return { from, to, ok: true }
  } catch (error) {
    return { from, to, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// 迁移与导入都会改注册表，改完都得让宿主认下这处改动；生效模式的类型与措辞在 types.ts / take-effect.ts
// 一处定义，这里只做宿主侧的探测与转发（web.ts 仍从本模块取这个类型，避免调用面来回改）。
export type { EffectMode }

/** 一次同步要用的远端与设置。 */
export interface SyncRuntime {
  settings: SyncSettings
  dav: DavPort
}

/**
 * 界面能看的同步配置（非敏感）。
 * @param config 插件配置（活引用或普通对象）。
 * @returns 配了 `sync.url` 才有返回值。
 */
export function describeSyncConfig(config: PluginConfigInput = {}): SyncInfo | undefined {
  const sync = syncSection(config)
  if (sync === undefined || typeof sync.url !== 'string' || sync.url.trim() === '') return undefined
  const auto = autoPushSection(sync)
  return {
    url: sync.url.trim(),
    machineId: machineIdOf(sync),
    mappings: Object.keys(sync.mapping ?? {}).length,
    // 只有真的开着才报：界面靠这一项决定"自动推送已开"那句话摆不摆，报一个 `enabled: false` 会让
    // 每个没开自动推送的人都多读一个字段。
    ...(auto === undefined || !auto.enabled ? {} : { autoPush: { intervalMs: auto.intervalMs } }),
  }
}

/** 这台机器的标识：配置优先，缺省主机名。 */
function machineIdOf(sync: SyncConfig): string {
  const configured = sync.machineId?.trim()
  return configured === undefined || configured === '' ? hostname() : configured
}

/**
 * 这次同步按哪个引用名取密码：配置里写了就用它，没写（或只有空白）用缺省名。
 *
 * 与界面同一套规则（[SyncConfigForm](../client/SyncConfigForm.tsx) 把密码写在这个名字下）：
 * 用户不填引用名时两边都得算出同一个名字，否则界面存进去的密码这边不会去读。
 * @param sync 同步那一节。
 * @returns 凭据引用名（环境变量名）。
 */
export function passwordRefOf(sync: SyncConfig): string {
  const declared = sync.passwordRef?.trim() ?? ''
  return declared === '' ? DEFAULT_PASSWORD_REF : declared
}

/**
 * 解析一个密码引用。
 *
 * 先问宿主的 credentials 服务（DSH 的口径：配置里放引用，值由服务解析），拿不到再退到
 * `process.env`——没有那个服务的 profile 也能用（往环境变量里放密码）。
 * @param ctx 宿主上下文（探测式读取，缺席不影响）。
 * @param ref 环境变量名。
 * @returns 密码；两边都没有就是 undefined。
 */
async function resolveSecret(ctx: unknown, ref: string): Promise<string | undefined> {
  const credentials = optionalService(ctx, 'credentials') as
    | { resolve?: (reference: string) => Promise<{ value?: unknown } | undefined> }
    | undefined
  try {
    const resolved = await credentials?.resolve?.(ref)
    if (typeof resolved?.value === 'string' && resolved.value !== '') return resolved.value
  } catch {
    // 服务在但解析失败（引用没配、来源冲突）：退到环境变量，而不是让整次同步起不来。
  }
  const fromEnv = process.env[ref]
  return fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
}

/**
 * 造一次同步的运行时。
 * 配置每次都从活引用里现读（见 src/config.ts）：界面上改完 URL 与映射，下一次调用就用新值。
 * @param ctx 宿主上下文（只用来解析密码引用）。
 * @param config 插件配置（活引用或普通对象）。
 * @returns 远端与设置；没配 `sync.url` 时 undefined（界面据此说明"没配置"，工具据此拒掉这次调用）。
 */
export async function syncRuntime(ctx: unknown, config: PluginConfigInput = {}): Promise<SyncRuntime | undefined> {
  const sync = syncSection(config)
  if (sync === undefined || typeof sync.url !== 'string' || sync.url.trim() === '') return undefined
  const password = await resolveSecret(ctx, passwordRefOf(sync))
  // 自动推送那一节跟着设置一起走：`runAutoPush()` 只读 `settings.autoPush`（它自己不去认配置），
  // 于是"开没开 / 多久一次"只有一个来源，节拍器与那一轮本身读的是同一份值。
  const autoPush = autoPushSection(sync)
  const settings: SyncSettings = {
    url: sync.url.trim().replace(/(.)\/+$/, '$1'),
    machineId: machineIdOf(sync),
    mapping: sync.mapping ?? {},
    ...(sync.username === undefined || sync.username === '' ? {} : { username: sync.username }),
    ...(password === undefined ? {} : { password }),
    ...(sync.timeoutMs === undefined ? {} : { timeoutMs: sync.timeoutMs }),
    ...(autoPush === undefined ? {} : { autoPush }),
  }
  return {
    settings,
    dav: createDavClient({
      baseUrl: settings.url,
      ...(settings.username === undefined ? {} : { username: settings.username }),
      ...(settings.password === undefined ? {} : { password: settings.password }),
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
    }),
  }
}

/**
 * 自动推送的运行时：一份 `SyncDeps` 加一个节拍器。
 *
 * 与 `syncRuntime()` 分开而不是改它的返回值：那个函数是**界面与工具**那两条手动路共用的（它们要的
 * 只是"远端 + 设置"），而自动推送多要一份依赖集合与一个定时器——把它塞进同一个返回值，两条手动路就
 * 得各自忽略一半字段。
 *
 * 两处**必须**一起造的理由（也是这个函数存在的全部意义）：节拍器与那一轮读的配置、远端、库位置都得
 * 是同一份。少一处就会出现"界面上改了 URL，自动推送还在打旧地址"这种最难查的不一致。
 *
 * 依赖里那几样可选服务按**探测**收（与 `src/index.ts` 里 web 端点那一套同一个口径）：这个宿主没有
 * 投影缓存 / 工作区注册表时，自动推送照旧跑——它只推不拉，本来就用不到"备份"与"请宿主重折检查点"
 * 那几样（它们挂在"真有东西落到本机"那条路上）。
 *
 * @param ctx 宿主上下文（解析密码引用、探测可选服务）。
 * @param config 插件配置（活引用或普通对象）。
 * @param paths 三个库位置。
 * @param options.runOnRequest 这一次请求要不要真的跑一轮（界面那枚「立即推送一次」）。
 *   默认只**记状态**：`tick()` 在没开自动推送时照样回一句话（用户手点一次不该被开关挡住）。
 * @returns 运行时；没配 `sync.url` 时 undefined。
 */
export async function resolveAutoPushRuntime(
  ctx: unknown,
  config: PluginConfigInput = {},
  paths: ResolvedPaths,
): Promise<{ deps: SyncDeps; timer: AutoPushTimer } | undefined> {
  const runtime = await syncRuntime(ctx, config)
  if (runtime === undefined) return undefined
  const deps: SyncDeps = {
    dav: runtime.dav,
    settings: runtime.settings,
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    sessionMeta: createSessionMetaResolver({ cacheDir: projectionCacheDir(paths.registryPath) }),
    liveSessionIds: () => liveSessionIds(ctx),
    hostRegistry: () => hostRegistryPort(ctx),
    hostCheckpoints: () => hostCheckpointPort(ctx),
    // 自动推送只推不拉，但**推的包里也没有对象**：对象走远端共享库，所以这条路照样要那个端口
    // （宿主没有附件服务时缺席，整条路退回"只搬日志"）。
    attachments: () => attachmentPort(ctx),
    // 这一趟是只推不拉；`what` 让界面能把后台那条流与用户手点的那条分开（两条可能同时在跑）。
    pushOnly: true,
    progressWhat: 'auto-push',
  }
  /*
   * 节拍器持有"上一次真跑"与"连续失败几次"两份状态，所以它**每个宿主只造一个**（`src/index.ts` 造、
   * 挂在插件生命周期上），不能每次请求现造——现造的话间隔闸永远算成"该跑了"，自动推送会变成
   * "每次有人打开页面就跑一轮"。两份状态因此留在这个闭包里。
   */
  let lastRunAt: number | undefined
  let failures = 0
  /** 每个宿主只造一个节拍器，所以配置那三个读法每次现读（`sync` 是活引用，改完立即生效）。 */
  const auto = (): AutoPushConfig | undefined => autoPushSection(syncSection(config))
  const timer = createAutoPushTimer({
    clock: {
      enabled: () => auto()?.enabled === true,
      // 报的是**生效值**：`autoPushSection()` 已经把用户填的那个数抬到下限、缺席就填缺省。
      intervalMs: () => auto()?.intervalMs ?? DEFAULT_AUTO_PUSH_INTERVAL_MS,
    },
    run: async (options) => {
      // 每次真跑之前重新解析一次设置：`sync` 是活引用，用户可能刚把 URL 或间隔改掉。
      const fresh = await syncRuntime(ctx, config)
      const outcome = await runAutoPush(
        { ...deps, ...(fresh === undefined ? {} : { dav: fresh.dav, settings: fresh.settings }) },
        {
          force: options?.force === true,
          ...(lastRunAt === undefined ? {} : { lastRunAt }),
          failures,
          ...(options?.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        },
      )
      if (outcome.ran) lastRunAt = outcome.finishedAt ?? Date.now()
      failures = outcome.failures
      return outcome
    },
  })
  return { deps, timer }
}

/** 宿主 `sessions` 服务里我们用到的那两件（其余一概不声明）。 */
interface HostSessionsService {
  /** 把这条会话缓冲的事件冲进持久存储（宿主契约里的 "THE flush entry point"）。 */
  flush(session: unknown): Promise<boolean>
}

/**
 * 把自动推送接到会话事件上：**本机刚写完一轮就推**（事件层），定时器退成兜底。
 *
 * 为什么不能直接把事件当成"该推了"：`turn/end` 到的时候**日志还没落盘**。宿主的
 * `dsh-session-checkpoint-policy` 只在模型请求、工具派发、agent 步进三处落盘，`turn/end` 不在其中；
 * `turn/end` 的契约原文就写着 "The loop does not await a flush at turn boundaries… consumers that
 * read storage after `turn/end` flush themselves"。而推送读的正是磁盘字节——少了这一步，推上去的会
 * 是一份**缺最后几步**的半截会话（而且远端会把它当成"本机的最新"，下一轮才补上，中间那一版是错的）。
 *
 * 所以这里 `await sessions.flush(session)` 之后再调 `timer.touched()`。这是宿主点名的用法：
 * `sessions.flush()` 的契约称自己是 "THE flush entry point"，并点名"读存储之前自己冲一下的消费者"
 * 必须走它（不要自己 `ctx.parallel('session/flush', …)`）。
 *
 * `flush` 失败**吞掉**：它只决定"这次读得到多新"，推的活儿本身没错。吞掉的代价是这一次可能推一份略旧
 * 的会话，下一轮或兜底的定时器会补上；而把异常抛进事件通道会打断宿主自己的派发，代价大得多。
 *
 * `sessions` 按**可选服务**收（`optionalService()`），不进 `inject`：没有会话服务的 profile（纯工具
 * 那类前端）照旧只有工具，插件不该因为少一个服务就整个起不来。拿不到服务时返回一个空卸载函数——
 * 事件层缺席，兜底的定时器仍然工作。
 *
 * @param ctx 宿主上下文。
 * @param timer 已经造好的节拍器（`resolveAutoPushRuntime()` 的那个）。
 * @param onProblem 冲盘失败时记一笔（宿主日志）；不传就静默。
 * @returns 卸载函数：摘掉监听（卸载时先调它，再 `timer.stop()`）。
 */
export function attachAutoPushToSessions(
  ctx: unknown,
  timer: AutoPushTimer,
  onProblem?: (message: string) => void,
): () => void {
  const sessions = optionalService(ctx, 'sessions') as Partial<HostSessionsService> | undefined
  if (sessions === undefined || typeof sessions.flush !== 'function') return () => {}
  const on = (ctx as { on?: (name: string, listener: (...args: never[]) => void) => unknown } | undefined)?.on
  if (typeof on !== 'function') return () => {}

  const dispose = on.call(
    ctx,
    'session/event',
    ((session: unknown, event: { type?: string } | undefined): void => {
      // 只认 `turn/end`：一轮结束才是"写完了"的边界。`step/end` 太密（一次模型调用一条），
      // `session/created` 则还没有内容可推。
      if (event?.type !== 'turn/end') return
      const flush = sessions.flush
      if (flush === undefined) return
      void (async (): Promise<void> => {
        try {
          await flush.call(sessions, session)
        } catch (error) {
          onProblem?.(`冲盘失败，这一轮按现有内容推：${error instanceof Error ? error.message : String(error)}`)
        }
        timer.touched()
      })()
    }) as (...args: never[]) => void,
  )
  return typeof dispose === 'function' ? (dispose as () => void) : () => {}
}

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
): string {
  const head = `${applied ? '已同步' : '预演'}：拉取 ${plan.pullIds.length} 条、推送 ${plan.pushIds.length} 条（本机 ${plan.localCount} 条，远端 ${plan.remoteCount} 条，来自 ${plan.machines.join('、') || '还没有机器'}）`
  if (!applied) return head
  // 拉取里有多少条是"换掉本机原来那份"值得单独报：旧的进备份了，用户可能想恢复回去。
  const overwrote =
    replaced.length === 0 ? '' : `，其中 ${replaced.length} 条覆盖了本机原来那份（旧的那份已进备份）`
  return `${head}。实际落地：拉取 ${pulled.length} 条、推送 ${pushed.length} 条${overwrote}${describeSyncObjects(attachments)}`
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

/**
 * 探测一个**可选**宿主服务。
 *
 * 必须走 `ctx.get(name)`，**不能**写 `ctx.someService`：Cordis 的 Context 是个 Proxy，服务属性只有
 * 在该 fiber 的 `inject` 里声明过才可读，否则同步抛 `cannot get property "X" without inject`——
 * **即使那个服务确实存在**。可选服务（声明了就会把插件变成硬依赖）因此只能这样读，缺席即
 * `undefined`。
 *
 * 纯对象假 ctx 上两种写法都"能跑"：根 context（fiber 没有 runtime）走的是非严格路径。这条差异
 * 正是本插件曾经在真实 profile 里整个起不来的原因，`test/artifact.test.mjs` 与
 * `test/tools.test.ts` 现在都在真实 fiber 上跑，就是为了让这类错误在测试里就暴露。
 *
 * @param ctx - 宿主上下文（形状未知时按"没有这个服务"处理）。
 * @param name - 服务名。
 * @returns 服务实例，或 undefined。
 */
export function optionalService(ctx: unknown, name: string): unknown {
  const get = (ctx as { get?: (serviceName: string) => unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  try {
    return get.call(ctx, name)
  } catch {
    // 读服务本身失败（旧版 cordis 没有 get、或服务提供方装配中）：按"没有"处理，
    // 这个探测只用来决定"何时生效"的措辞，不该让它把工具调用整个打挂。
    return undefined
  }
}

/**
 * 迁移何时生效：这个宿主能不能当场把注册表改掉。
 *
 * 能（`hostRegistryPort()` 拿得到宿主那套动作）就报 `immediate`——插件把活儿交给宿主自己做；
 * 不能就如实报 `restart-required`，由调用方告诉用户重启。
 * @param ctx 宿主上下文。
 * @returns 生效模式。
 */
export function effectMode(ctx: unknown): EffectMode {
  return hostRegistryPort(ctx) === undefined ? 'restart-required' : 'immediate'
}

/** 宿主的"一个工作区"：只声明我们用得到的那几件。 */
interface HostWorkspaceEntity {
  id: string
  sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
  insertSessionBefore(sessionId: string, beforeSessionId?: string): Promise<unknown>
  detachSession(sessionId: string): Promise<void>
}

/**
 * 宿主的 `workspaceRegistry`：只声明我们用得到的那几件。
 *
 * `replaceHeaderIndex` / `indexLiveSessions` 在宿主的类型面里标着 `private`——那只是它对外不给用的
 * 说法，运行期就是普通原型方法。插件用它们做的正是宿主自己 `[Service.init]()` 在"表里已经有工作区"
 * 时做的那两步：按磁盘重建 header 缓存，再把活着的会话补进索引。
 */
interface HostWorkspaceService {
  create(path: string, title?: string): Promise<{ id: string }>
  get(id: string): unknown
  delete(id: string): Promise<boolean>
  replaceHeaderIndex(headers: readonly unknown[]): Promise<void>
  indexLiveSessions(): Promise<void>
}

/** 宿主的 `sessionPersistence`：只要"现在磁盘上有哪些会话、各自的 header 是什么"。 */
interface HostSessionPersistence {
  list(): Promise<Array<{ header: unknown }>>
}

/**
 * 探测宿主那套"改注册表"的动作，收成一个端口交给核心层。
 *
 * 为什么不自己写文件：宿主内存里那份注册表才是权威（单单元契约：写入才改它，绝不从磁盘重读），
 * 文件改完它不认——侧边栏还是旧归属，之后任何一次工作区改动还会把这次写盘盖掉。宿主那套动作
 * （复用/新建工作区、挂会话、摘会话、删工作区）自己会落盘、也会通知界面，交给它做最省事也最稳。
 *
 * 认形状不认实现：少一件就当"这个宿主没有这套动作"，绝不半套上场。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有这套动作时 undefined。
 */
export function hostRegistryPort(ctx: unknown): HostRegistryPort | undefined {
  const registry = optionalService(ctx, 'workspaceRegistry') as Partial<HostWorkspaceService> | undefined
  const persistence = optionalService(ctx, 'sessionPersistence') as Partial<HostSessionPersistence> | undefined
  if (registry === undefined || persistence === undefined) return undefined
  if (
    typeof registry.create !== 'function' ||
    typeof registry.get !== 'function' ||
    typeof registry.delete !== 'function' ||
    typeof registry.replaceHeaderIndex !== 'function' ||
    typeof registry.indexLiveSessions !== 'function' ||
    typeof persistence.list !== 'function'
  ) {
    return undefined
  }

  const entityOf = (workspaceId: string): HostWorkspaceEntity | undefined => {
    const found = registry.get?.call(registry, workspaceId) as Partial<HostWorkspaceEntity> | undefined
    if (found === undefined || found === null) return undefined
    if (typeof found.attachSession !== 'function' || typeof found.detachSession !== 'function') return undefined
    if (typeof found.insertSessionBefore !== 'function') return undefined
    return found as HostWorkspaceEntity
  }

  const need = (workspaceId: string): HostWorkspaceEntity => {
    const entity = entityOf(workspaceId)
    if (entity === undefined) throw new Error(`宿主里没有工作区 ${workspaceId}`)
    return entity
  }

  return {
    // 跟宿主启动时做的两步一致：先按磁盘重建 header 缓存，再把活着的会话补进索引。
    refreshIndex: async () => {
      const sessions = await persistence.list!.call(persistence)
      await registry.replaceHeaderIndex!.call(registry, sessions.map((s) => s.header))
      await registry.indexLiveSessions!.call(registry)
    },
    ensureWorkspace: async (path, title) => {
      const workspace = (await registry.create!.call(registry, path, title)) as { id: string }
      return workspace.id
    },
    // 挂靠是**前插**，而计划是**追加**：挂完再挪到末尾，顺序才跟预演里看到的一致。
    attachSession: async (workspaceId, sessionId) => {
      const entity = need(workspaceId)
      await entity.attachSession(sessionId)
      await entity.insertSessionBefore(sessionId)
    },
    // 工作区已经不在了也当成功：摘除本来就幂等，真正的一致性由落盘后的复核盯着。
    detachSession: async (workspaceId, sessionId) => {
      await entityOf(workspaceId)?.detachSession(sessionId)
    },
    members: async (workspaceId) => [...(entityOf(workspaceId)?.sessionIds ?? [])],
    removeWorkspace: async (workspaceId) => {
      await registry.delete!.call(registry, workspaceId)
    },
  }
}

/** 宿主的 `sessionQuery`：只要"读一条已存会话的完整日志（不建活会话）"这一件。 */
interface HostSessionQuery {
  readSession(sessionId: string): Promise<{
    session: unknown
    inheritedEventCount: unknown
    events: readonly unknown[]
  }>
}

/** 宿主的 `sessionProjectionCache`：只要"冷读一条并写回检查点"这一件。 */
interface HostProjectionCache {
  coldSnapshot(meta: unknown, inheritedEventCount: unknown, events: readonly unknown[]): unknown
}

/**
 * 探测宿主那套"补齐列表元数据"的服务，收成一个端口交给核心层（见 checkpoint-warm.ts）。
 *
 * 为什么不自己写那份检查点文件：它是折叠的**种子**——`identity`（formatVersion/createdAt/cwd/isSeeded/
 * inheritedEventCount）与每行的 `ver`、`seq` 都归宿主，`ver` 对不上会被它静默丢弃、`seq` 写错会让它跳过
 * 真事件。宿主自己的两个服务正好做这件事：`readSession()` 读完校验，`coldSnapshot()` 折叠并写回。
 *
 * 认形状不认实现：少一件就当"这个宿主没有这套动作"，绝不半套上场。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有这套动作时 undefined。
 */
export function hostCheckpointPort(ctx: unknown): CheckpointWarmPort | undefined {
  const query = optionalService(ctx, 'sessionQuery') as Partial<HostSessionQuery> | undefined
  const cache = optionalService(ctx, 'sessionProjectionCache') as Partial<HostProjectionCache> | undefined
  if (query === undefined || cache === undefined) return undefined
  if (typeof query.readSession !== 'function' || typeof cache.coldSnapshot !== 'function') return undefined

  return {
    warm: async (sessionId) => {
      // 宿主自己那两步：整份日志读完校验（不建活会话）→ 折叠所有投影单元并写回检查点（它自己 fail-soft）。
      const loaded = await query.readSession!.call(query, sessionId)
      cache.coldSnapshot!.call(cache, loaded.session, loaded.inheritedEventCount, loaded.events)
    },
  }
}

/** 宿主的 `sessions` 服务：本端口只用到"取活的 / 准备 / 入册 / 公告 / 冲刷"这五件。 */
interface HostSessionStore {
  get(id: string): unknown
  prepare(id: string, options: unknown): unknown
  enter(session: unknown): () => void
  announce(session: unknown): void
  flush(session: unknown): Promise<unknown>
}

/** 宿主的 `sessionTitle` 服务：读当前标题 + 显式重算（它只认活会话，见 titleRefreshPort()）。 */
interface HostSessionTitle {
  get(session: unknown): { title?: unknown; source?: { kind?: unknown } } | undefined
  refresh(session: unknown): Promise<{ title?: unknown; source?: { kind?: unknown } } | undefined>
}

/**
 * 宿主的 `sessionPersistence`：只要"开一个写句柄"。
 *
 * 这一件是**必须**的，不是可选：会话的 append 只按 id 路由给"已登记写句柄"的那条（见
 * `dsh-session-persistence-jsonl` 的 `install()`：`this.writers.get(session.id)?.enqueueLive(...)`），
 * 没有句柄的话新标题只活在内存里，摘挂之后就没影了——那种"报成功却没落地"比不做更糟。
 */
interface HostSessionPersistence {
  open(id: string, access: 'write'): Promise<{ close(): Promise<void> }>
}

/**
 * 探测宿主"重算一条会话名称"的能力，收成一个端口交给编排层（见 retitle.ts）。
 *
 * 为什么不能只调一次 `sessionTitle.refresh()` 了事：**名称服务只认活会话**
 * （`refresh()` 第一件事就是 `sessions.get(id) !== session` 就抛），而这里是拿整库的 id 逐条重算，
 * 那些会话早就不在宿主内存里了。所以这条端口自己完成一次"临时挂载"：
 *
 *   1. `sessionQuery.readSession()` 把日志整份读完并校验，拿到 header 与全部事件（**不建活会话**，
 *      与 checkpoint-warm 那条路同一个调用）；
 *   2. `sessions.prepare(..., { eventState: 'detached' })` 按宿主自己的重放构造器还原出 Session；
 *   3. `sessionPersistence.open(id, 'write')` 先开写句柄，这样第 5 步 append 的标题事件才会落盘；
 *   4. `sessions.enter()` + `sessions.announce()` —— `enter()` 返回的正是**卸载用的那个 disposer**，
 *      两者是宿主公开成对的挂载原语（`dsh-agent-loop` 的会话创建事务也是这么用的）；
 *   5. `sessionTitle.refresh()` 重算，随后 `sessions.flush()` 把新标题冲进日志；
 *   6. 无论成败，关句柄 + `detach()` 把它摘掉，宿主内存里不留痕迹。
 *
 * 代价是每条会话要整份解一次日志（实测 6MB ≈1.7 秒），所以编排层顺序跑并报进度——**不并发**，那等于
 * 同时挂 N 条会话并发 N 个模型请求。
 *
 * 会话**已经在宿主内存里**（比如用户正开着的这条）时走另一条路：直接用那条活会话重算，不挂不摘、
 * 也不碰写句柄（它归宿主的 agent loop 所有，抢来开第二个会直接抛 AlreadyOwned）。
 *
 * 认形状不认实现：四件里少一件就当"这个宿主没有这套能力"（界面据此禁用按钮并说明原因）。
 *
 * `options.includePinned` 由调用方显式打开时才连 `user` 源（用户改过名 / 脚本或导入写下的）一起重算
 * ——默认跳过，理由见 `TitleRefreshOptions`。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有名称服务 / 读日志 / 持久化里任何一件时 undefined。
 */
export function titleRefreshPort(ctx: unknown): TitleRefreshPort | undefined {
  const store = optionalService(ctx, 'sessions') as Partial<HostSessionStore> | undefined
  const query = optionalService(ctx, 'sessionQuery') as Partial<HostSessionQuery> | undefined
  const titles = optionalService(ctx, 'sessionTitle') as Partial<HostSessionTitle> | undefined
  const persistence = optionalService(ctx, 'sessionPersistence') as Partial<HostSessionPersistence> | undefined
  if (store === undefined || query === undefined || titles === undefined || persistence === undefined) return undefined
  if (
    typeof store.get !== 'function' ||
    typeof store.prepare !== 'function' ||
    typeof store.enter !== 'function' ||
    typeof store.announce !== 'function' ||
    typeof store.flush !== 'function' ||
    typeof query.readSession !== 'function' ||
    typeof titles.get !== 'function' ||
    typeof titles.refresh !== 'function' ||
    typeof persistence.open !== 'function'
  ) {
    return undefined
  }

  /** 把一份标题快照收成"标题 + 来源种类"两样（缺哪个就是哪个不在）。 */
  const normalize = (
    snapshot: { title?: unknown; source?: { kind?: unknown } } | undefined,
  ): { title?: string; kind?: unknown } => ({
    ...(typeof snapshot?.title === 'string' ? { title: snapshot.title } : {}),
    ...(snapshot?.source === undefined ? {} : { kind: snapshot.source.kind }),
  })

  /** 读一条会话当前的标题快照（活会话与临时挂载的会话同一条路）。 */
  const snapshotOf = (session: unknown): { title?: string; kind?: unknown } =>
    normalize(titles.get!.call(titles, session))

  /**
   * 对一条**活会话**做判定与重算。
   *
   * 判定的顺序是刻意的：先看用户有没有手动改过名（`source.kind === 'user'`）——那种标题是用户的，
   * 一次批量动作不该把它抹掉，所以在**发模型请求之前**就返回（`includePinned` 是给一次性清理留的
   * 显式口子，见 `TitleRefreshOptions`）；再看重算之后标题还在不在（没有用户消息的会话连兜底名称都
   * 没有）、provider 有没有真的接过去（没有 provider 时 `refresh()` 只会把兜底名称原样返回，那不是
   * "算过"）。
   */
  const settle = async (session: unknown, options?: TitleRefreshOptions): Promise<RetitleOutcome> => {
    const before = snapshotOf(session)
    if (before.kind === 'user' && options?.includePinned !== true) {
      return { status: 'skipped', reason: 'pinned' }
    }

    let after: { title?: string; kind?: unknown }
    try {
      // `refresh()` 返回的正是它折叠出的最新快照（没有标题时是 undefined），所以不必再读一次。
      // 对 `user` 源的标题它也是那条**显式重算**的路：宿主把"显式 refresh 覆盖掉钉住的标题"当作
      // unpin 的设计意图（自动修订那条路才会见到 user 源就短路），provider 端也只把 **provider** 源
      // 的旧标题当锚点，所以这里一定会重算出一个新标题。
      after = normalize(await titles.refresh!.call(titles, session))
    } catch (error) {
      // 没有路由不是失败：这条会话从来没有过主模型请求（比如从别的工具导进来的），名称 provider
      // （跟随会话主模型那套）因此无从下手。
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('no logged request route')) return { status: 'skipped', reason: 'no-request-route' }
      throw error
    }

    if (after.title === undefined) return { status: 'skipped', reason: 'no-human-message' }
    if (after.kind !== 'provider') return { status: 'skipped', reason: 'no-title-provider' }
    return before.kind === 'provider' && before.title === after.title
      ? { status: 'unchanged', title: after.title }
      : { status: 'retitled', title: after.title }
  }

  return {
    refresh: async (sessionId, options) => {
      const live = store.get!.call(store, sessionId)
      // 已经在内存里：直接用那条活会话重算，不挂不摘也不碰写句柄（它归宿主自己所有）。
      if (live !== undefined) return settle(live, options)

      const loaded = await query.readSession!.call(query, sessionId)
      const session = store.prepare!.call(store, sessionId, {
        seed: loaded.events,
        meta: loaded.session,
        inheritedEventCount: loaded.inheritedEventCount,
        eventState: 'detached',
      })
      const handle = await persistence.open!.call(persistence, sessionId, 'write')
      const detach = store.enter!.call(store, session)
      store.announce!.call(store, session)
      try {
        const outcome = await settle(session, options)
        // 冲一次盘再摘：标题事件是刚 append 的，不冲的话"改了"只存在于内存里。
        await store.flush!.call(store, session)
        return outcome
      } finally {
        // 先关句柄再 detach：写句柄按 id 独占（第二个 open 会抛 AlreadyOwned），漏掉它会让宿主
        // 之后再也打不开这条会话的写路径。close() 自己会把缓冲排干，所以失败路径上的诊断事件也在。
        await handle.close()
        detach()
      }
    },
  }
}

/**
 * 宿主目录选择器的能力种类。
 *
 * 宿主的 `directoryPicker` 是个"能力位"服务：`capability()` 返回带 `kind` 的对象，
 * `native` 那只提供 `pick()`（在**宿主显示器**上弹系统对话框），`browse` 那只提供
 * `list()`/`createDirectory()`（页面内浏览，路径必须宿主自己够得着）。两者互斥——
 * 拿 `native` 的能力去 `list()` 会被宿主拒绝，反之亦然。
 *
 * 界面因此不能假设"选目录"= 弹对话框：它得先知道这个宿主给的是哪一种，再决定
 * 「浏览…」按钮到底干什么。种类由宿主报给界面（`GET /state` 的 `pickerKind`），
 * 而不是让界面去试错——试探在 `native` 宿主上会真的弹出对话框。
 */
export type PickerKind = 'browse' | 'native' | null

/**
 * 宿主附件服务里我们要的那两件（`ctx.attachments`）。
 *
 * 两个方法都是**纯路径计算**：宿主的文档写着"returns provider-local path without reading the
 * object"，对象不存在也给得出路径。本插件因此既能用它在导出侧定位对象，也能用它在导入侧算出"该往
 * 哪儿写"——不必复刻附件库的目录形状（那是宿主的实现细节，换 provider 就变）。
 */
interface HostAttachmentStore {
  imageHostPath?: (ref: { attachmentId: string }) => string
  fileHostPath?: (ref: { attachmentId: string }) => string
}

/**
 * 探测宿主的附件库，收成一个端口交给核心层（见 attachments.ts）。
 *
 * 认形状不认实现：两件少一件就当"这个宿主没有附件服务"（半套上场只会让图片对象落一半）。缺席时核心
 * 层的行为与升级前完全一致——包只带日志，导入只落日志。
 *
 * @param ctx 宿主上下文。
 * @returns 端口；这个宿主没有附件服务时 undefined。
 */
export function attachmentPort(ctx: unknown): AttachmentPort | undefined {
  const store = optionalService(ctx, 'attachments') as HostAttachmentStore | undefined
  const image = store?.imageHostPath
  const file = store?.fileHostPath
  if (typeof image !== 'function' || typeof file !== 'function') return undefined
  return {
    pathOf: (ref) => {
      try {
        // 只交 attachmentId：两个方法都只读它（引用里的媒体类型/尺寸是给别的用途的）。
        return (ref.kind === 'image' ? image : file).call(store, { attachmentId: ref.id })
      } catch {
        // 形状不认（引用不是内容寻址 id、宿主换了 provider）：这一个对象落不了，由调用方如实报出去。
        return undefined
      }
    },
  }
}

/**
 * 读宿主目录选择器的能力种类。
 * @param ctx - 宿主上下文。
 * @returns `browse` / `native`；没有该服务或形状不认时 `null`（界面据此隐藏选择入口）。
 */
export function directoryPickerKind(ctx: unknown): PickerKind {
  const picker = optionalService(ctx, 'directoryPicker') as
    | { capability?: () => { kind?: unknown } }
    | undefined
  try {
    const kind = picker?.capability?.()?.kind
    return kind === 'browse' || kind === 'native' ? kind : null
  } catch {
    // 能力位还没装配好时会抛：按"没有选择器"处理，界面退回到手输路径。
    return null
  }
}
/**
 * 宿主的归档能力（`ctx.workspaceRegistry` 的 `archiveSession` / `unarchiveSession`）。
 *
 * 单独收成一个端口：归档是**宿主的能力**（它一次做完"落盘 + 改内存 + 广播"，侧边栏即时跟着变），
 * 而本插件的界面层只认形状、不读服务。服务不在（`workspaceRegistry` 挂在 Web profile 上）时
 * 端口为 `undefined`，界面据此禁用按钮并说明原因，而不是绕过宿主去写注册表文件。
 */
export interface RegistryOps {
  archive(sessionId: string): Promise<void>
  unarchive(sessionId: string): Promise<void>
}

/**
 * 探测宿主的归档能力。
 * @param ctx - 宿主上下文。
 * @returns 端口；服务不在或形状不认时 `undefined`。
 */
export function archiveOps(ctx: unknown): RegistryOps | undefined {
  const registry = optionalService(ctx, 'workspaceRegistry') as
    | { archiveSession?: unknown; unarchiveSession?: unknown }
    | undefined
  const archive = registry?.archiveSession
  const unarchive = registry?.unarchiveSession
  if (typeof archive !== 'function' || typeof unarchive !== 'function') return undefined
  return {
    archive: (sessionId) => Promise.resolve((archive as (id: string) => unknown).call(registry, sessionId)).then(() => undefined),
    unarchive: (sessionId) =>
      Promise.resolve((unarchive as (id: string) => unknown).call(registry, sessionId)).then(() => undefined),
  }
}

/**
 * 宿主内存里活着的会话 id（`ctx.sessions.list()`）。
 *
 * 删除会拒掉这些会话：宿主手里还有它们的**内存副本与写句柄**，日志被搬走之后它照样会往里写，
 * 于是磁盘上会出现一条"半条会话"。这与宿主自己拒绝归档一条正在跑的会话是同一件事。
 *
 * @param ctx - 宿主上下文。
 * @returns 活着的会话 id；服务不在或形状不认时是空集（＝判断不了，不是"都不活着"）。
 */
export function liveSessionIds(ctx: unknown): ReadonlySet<string> {
  const store = optionalService(ctx, 'sessions') as { list?: unknown } | undefined
  const list = store?.list
  if (typeof list !== 'function') return new Set<string>()
  try {
    const ids = new Set<string>()
    for (const session of (list as () => unknown[]).call(store) ?? []) {
      const id = (session as { id?: unknown } | null)?.id
      if (typeof id === 'string') ids.add(id)
    }
    return ids
  } catch {
    // 列会话不该把"删除"这条路径整个打挂：判断不了就当空集，预演那边也不会谎称它们一定没在跑。
    return new Set<string>()
  }
}


/** 计划类工具的返回值。 */
export interface PlanToolResult {
  ok: boolean
  sessions: number
  /** 其中跟着点名会话一起走的子智能体会话条数（见 plan.ts 的 `cascaded`）。 */
  cascaded: number
  /** 宿主持在内存里、这次不搬的会话条数（见 plan.ts 的 `liveSkipped`）。 */
  liveSkipped: number
  /**
   * 侧边栏不显示（已归档 / 空白 / 父会话不在这批里的子智能体）、这次也不搬的会话条数
   * （见 plan.ts 的 `strandedSources`）：它们留在源工作区的登记里，那块工作区因此不会被删。
   */
  stranded: number
  files: number
  targetProjectDir: string
  summary: string
  takesEffect: EffectMode
  problems: string[]
}

/** 迁移类工具的返回值。 */
export interface MigrateToolResult {
  applied: boolean
  /** 跟着点名会话一起走的子智能体会话条数（见 plan.ts 的 `cascaded`）。 */
  cascaded: number
  /** 宿主持在内存里、这次没搬的会话条数（见 plan.ts 的 `liveSkipped`）。 */
  liveSkipped: number
  /** 侧边栏不显示、这次也没搬的会话条数（见 plan.ts 的 `strandedSources`）。 */
  stranded: number
  rewritten: number
  moved: number
  artifactsMoved: number
  verified: boolean
  backupDir?: string
  takesEffect: EffectMode
  summary: string
  problems: string[]
}

/**
 * 注册 4 个工具。
 * @returns cordis effect disposer 列表（宿主热卸载时逐个调用）。
 */
export function registerTools(ctx: Context, config: PluginConfigInput = {}): Array<() => void> {
  const paths = resolvePaths(config)
  const mode = (): EffectMode => effectMode(ctx)
  // 预演/执行/回滚都走 src/migrate.ts 那一份编排，界面端点用的是同一个 deps 形状——
  // 两个入口（工具 / 界面）因此不会各写一套。
  const deps: MigrateDeps = {
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    // 每次调用重新探测（加载条目会随 profile 的热应用来去），探测不到就是"只能重启"。
    hostRegistry: () => hostRegistryPort(ctx),
    // 迁移改写了 cwd，旧检查点因此对不上：收口时请宿主重折一遍（见 checkpoint-warm.ts）。
    hostCheckpoints: () => hostCheckpointPort(ctx),
    // 宿主持在内存里的会话搬不动（见 plan.ts 的 `BuildPlanOptions.live`）：两个入口都要问同一件事。
    liveSessionIds: () => liveSessionIds(ctx),
  }
  const disposers: Array<() => void> = []

  // ---- 只读：计划 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'plan_session_migration',
        description:
          'Read-only plan for migrating DSH sessions to another workspace directory. The source is the sessions ' +
          'you name in sessionIds (each session comes from its own cwd, so one call can gather sessions out of ' +
          'several directories); there is no source-directory parameter, and the source directories do not have ' +
          'to exist on disk any more. Reports how many ' +
          'sessions and log files would move, the source and target session project directories, the ' +
          'workspace-registry change, and any ' +
          'blocking problem (missing target directory, projectKey collision, occupied target directory, invalid ' +
          'registry). Sessions the host still holds in memory (live) cannot move while it holds them: they are ' +
          'left in place and counted in liveSkipped instead of being migrated. Sessions the sidebar hides ' +
          '(archived, blank, or subagents) cannot be named either: they ' +
          'stay behind, so their source workspace is not removed from the registry — the summary names them and ' +
          'stranded counts them. Subagent sessions always follow ' +
          'their parent: naming a subagent is refused, and naming a ' +
          'parent takes its whole family along. Writes nothing. Call this before migrate_sessions.',
        parameters: {
          sessionIds: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description:
              'The session ids to migrate (required, non-empty). They may come from different directories. ' +
              'Subagent descendants always come along with the session they belong to.',
          },
          to: {
            type: 'string',
            required: true,
            description: 'Target workspace directory (absolute path, must already exist).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              sessions: { type: 'integer', required: true },
              cascaded: { type: 'integer', required: true },
              liveSkipped: { type: 'integer', required: true },
              stranded: { type: 'integer', required: true },
              files: { type: 'integer', required: true },
              targetProjectDir: { type: 'string', required: true },
              summary: { type: 'string', required: true },
              takesEffect: { type: 'string', required: true },
              problems: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: (value as PlanToolResult).summary },
          ],
        },
        async execute(args): Promise<PlanToolResult> {
          const preview = previewMigration(deps, {
            to: args.to,
            sessionIds: args.sessionIds,
          })
          return {
            ok: preview.ok,
            sessions: preview.sessions.length,
            cascaded: preview.cascaded,
            liveSkipped: preview.liveSkipped.length,
            stranded: preview.strandedSources.reduce((n, source) => n + source.members.length, 0),
            files: preview.files,
            targetProjectDir: preview.targetProjectDir,
            summary: preview.summary,
            takesEffect: mode(),
            problems: preview.problems,
          }
        },
      }),
    ),
  )

  // ---- 写：迁移 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'migrate_sessions',
        description:
          'Migrate DSH sessions to another workspace directory: rewrite each session log header cwd (only the first ' +
          'zstd frame; the rest stays byte-identical), move the session directories into the target ' +
          'project directory, and ' +
          're-home the workspace registry (written atomically to disk, then handed to the live host so the ' +
          'change takes effect without a restart; when the host cannot take it, the result says a DSH restart ' +
          'is required and the registry file still holds this run\'s result). The source is the sessions named in ' +
          'sessionIds — each comes from its own cwd, so one call can gather sessions out of several directories, ' +
          'and those source directories do not have to exist on disk any more. Defaults to dry-run; apply:true ' +
          'performs it after taking a byte-level ' +
          'backup. Refuses on any blocking problem. Sessions the host still holds in memory (live) cannot move ' +
          'while it holds them: they are left in place and named in the result, and a migration can therefore ' +
          'move a subset. Sessions the sidebar hides (archived, blank, or subagents) are left behind too — ' +
          'their source workspace therefore stays in the registry, and both ' +
          'the summary and stranded say so. Subagent sessions always follow their parent (naming one is ' +
          'refused; naming a parent takes its whole family along; their registry membership does not change).',
        parameters: {
          sessionIds: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description:
              'The session ids to migrate (required, non-empty; they may come from different directories). ' +
              'Subagent descendants always come along.',
          },
          to: {
            type: 'string',
            required: true,
            description: 'Target workspace directory (absolute path, must already exist).',
          },
          apply: { type: 'boolean', description: 'Optional: true performs the migration (default false = dry-run).' },
          includeArtifacts: {
            type: 'boolean',
            description:
              'Optional: also move files the sessions created (default false). Requires decoding whole logs, so it is slower.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              applied: { type: 'boolean', required: true },
              cascaded: { type: 'integer', required: true },
              liveSkipped: { type: 'integer', required: true },
              stranded: { type: 'integer', required: true },
              rewritten: { type: 'integer', required: true },
              moved: { type: 'integer', required: true },
              artifactsMoved: { type: 'integer', required: true },
              verified: { type: 'boolean', required: true },
              backupDir: { type: 'string' },
              takesEffect: { type: 'string', required: true },
              summary: { type: 'string', required: true },
              problems: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: (value as MigrateToolResult).summary },
          ],
        },
        async execute(args): Promise<MigrateToolResult> {
          const run = await runMigration(
            deps,
            {
              to: args.to,
              sessionIds: args.sessionIds,
              includeArtifacts: args.includeArtifacts === true,
            },
            { apply: args.apply === true },
          )
          const summary = run.applied
            ? run.summary
            : run.preview.ok
              ? `${run.summary}\n\n（dry-run，未写任何字节；传 apply:true 执行）\n${describePlannedEffect(mode())}`
              : run.summary
          return {
            applied: run.applied,
            cascaded: run.preview.cascaded,
            liveSkipped: run.preview.liveSkipped.length,
            stranded: run.preview.strandedSources.reduce((n, source) => n + source.members.length, 0),
            rewritten: run.rewritten,
            moved: run.moved,
            artifactsMoved: run.artifactsMoved,
            verified: run.verified,
            ...(run.backupDir === undefined ? {} : { backupDir: run.backupDir }),
            // 真的改过注册表就认执行结果（run.effect），没改过才退到探测。
            takesEffect: effectOf(run.effect, mode()),
            summary,
            problems: run.applied ? run.problems : run.preview.problems,
          }
        },
      }),
    ),
  )

  // ---- 写：回滚 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'rollback_session_migration',
        description:
          'Undo one migrate_sessions run from its backup directory: move session directories back, restore the ' +
          'original log bytes (reverting the cwd rewrite), move session artifacts back, and restore the workspace ' +
          'registry. Byte-exact.',
        parameters: {
          backupDir: { type: 'string', required: true, description: 'The backupDir returned by migrate_sessions.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              restoredFiles: { type: 'integer', required: true },
              restoredArtifacts: { type: 'integer', required: true },
              sessions: { type: 'integer', required: true },
              registryRestored: { type: 'boolean', required: true },
              takesEffect: { type: 'string', required: true },
              summary: { type: 'string', required: true },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: String((value as { summary: string }).summary) },
          ],
        },
        async execute(args) {
          // 回滚不走宿主那套动作：它要的是"备份里那条记录原样回来"（含被迁移删掉的工作区），
          // 而宿主的新建工作区只会分配新 id —— 宁可整份写回 + 如实报"需要重启"。
          const r = await rollbackMigration({ backupRoot: paths.backupRoot }, { backupDir: args.backupDir })
          return {
            restoredFiles: r.restoredFiles,
            restoredArtifacts: r.restoredArtifacts,
            sessions: r.sessions,
            registryRestored: r.registryRestored,
            takesEffect: effectOf(r.effect, mode()),
            summary:
              `已回滚 ${r.sessions} 个会话、还原 ${r.restoredFiles} 个文件` +
              `${r.restoredArtifacts > 0 ? `、搬回 ${r.restoredArtifacts} 项产物` : ''}并恢复注册表。` +
              (r.effect === undefined ? '' : `\n${describeEffect(r.effect)}`),
          }
        },
      }),
    ),
  )

  // ---- 只读：复核 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'verify_workspace_sessions',
        description:
          'Read-only check that every session log under a directory\'s project directory agrees with its ' +
          'header cwd — the exact ' +
          'condition the host enforces when it reports "corrupt session log". Use after a migration or a manual move.',
        parameters: {
          dir: { type: 'string', required: true, description: 'Workspace directory whose project directory to check.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              checked: { type: 'integer', required: true },
              projectDir: { type: 'string', required: true },
              problems: { type: 'array', required: true, items: { type: 'string' } },
              summary: { type: 'string', required: true },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: String((value as { summary: string }).summary) },
          ],
        },
        async execute(args) {
          const projectDir = join(paths.sessionsRoot, projectKey(args.dir))
          if (!existsSync(projectDir)) throw new Error(`session project directory does not exist: ${projectDir}`)
          const problems: string[] = []
          let checked = 0
          for (const dirName of readdirSync(projectDir)) {
            const dir = join(projectDir, dirName)
            if (!statSync(dir).isDirectory()) continue
            for (const name of readdirSync(dir)) {
              if (!name.endsWith('.jsonl.zstd')) continue
              const header = readHeaderQuick(readFileSync(join(dir, name)), decodeAll).header
              if (header.cwd !== args.dir) problems.push(`${dirName}/${name}: header cwd ${header.cwd} != ${args.dir}`)
              if (header.cwd !== undefined && projectKey(header.cwd) !== projectKey(args.dir)) {
                problems.push(`${dirName}/${name}: project directory does not match header cwd (host would report corrupt session log)`)
              }
              checked++
            }
          }
          return {
            ok: problems.length === 0,
            checked,
            projectDir,
            problems,
            summary: `${projectDir}\n检查 ${checked} 个日志文件：${problems.length ? `发现 ${problems.length} 个问题` : '全部通过'}`,
          }
        },
      }),
    ),
  )

  // ---- WebDAV 同步（默认只预演） ----
  disposers.push(
    ctx.tools.register(
      defineTool({
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
              summary: '没有配置 WebDAV 同步：插件配置里的 sync.url 是空的。',
              problems: ['没有配置 WebDAV 同步（插件配置的 sync.url）'],
            }
          }
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
              // 覆盖本机那份之前要问一句"这条还在跑吗"（与删除同一条理由：宿主手里有它的写句柄）。
              liveSessionIds: () => liveSessionIds(ctx),
              // 拉取会把会话重挂到目标工作区（写注册表），所以整批落地之后同样要把宿主重新接管一遍。
              hostRegistry: () => hostRegistryPort(ctx),
              // 同一处收口：拉取来的会话在本机没有投影检查点，请宿主把列表元数据折出来（见 checkpoint-warm.ts）。
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
            // 只落地那一次报得出这两个数：预演不知道远端共享库里有哪些对象（见 SyncOutcome 的字段说明）。
            attachmentsIn: outcome.attachmentIn?.written ?? 0,
            attachmentsOut: outcome.attachmentOut?.uploaded ?? 0,
            attachmentsMissing: outcome.attachmentOut?.missing ?? 0,
            machines: outcome.plan.machines,
            /*
             * 这次同步要不要重启才被承认：落地按真实结果说，预演按探测说（与界面那条路同一个口径，
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
              describeSync(outcome.plan, outcome.pulled, outcome.replaced, pushedIds, outcome.applied, {
                in: outcome.attachmentIn,
                out: outcome.attachmentOut,
              }),
              describeWarm(outcome.warm),
              // 预演也要把"执行后会怎样"说出来，否则调用方要到落地之后才知道要重启（与迁移工具同一条）。
              outcome.applied || outcome.plan.pullIds.length === 0 ? undefined : describePlannedEffect(mode()),
            ]
              .filter((line): line is string => line !== undefined)
              .join('\n'),
            problems: [...outcome.plan.problems, ...outcome.problems],
          }
        },
      }),
    ),
  )

  return disposers
}
