// 同步的**运行时**：把插件配置解析成远端与设置，并造那台自动推送调度器。
//
// 手动那两条路（工具、界面按钮）只要"远端 + 设置"；自动推送还多要一份依赖集合与一个定时器，所以分开造。
// 两处必须一起造的理由写在 `resolveAutoPushRuntime()` 上：调度器与那一轮读的配置、远端、库位置得是
// 同一份，否则会出现"界面上改了 URL，自动推送还在打旧地址"。
//
// @module dsh-session-manager/operations/sync/runtime
import { hostname } from 'node:os'

import {
  DEFAULT_PASSWORD_REF,
  autoPushSection,
  syncSection,
  type AutoConfig,
  type AutoMode,
  type PluginConfigInput,
  type SyncConfig,
} from '../../config.ts'
import { createProjectionReader } from '../../shared/library/projection-cache.ts'
import { decodeAll } from '../../shared/log/log-decode.ts'
import { projectionCacheDir } from '../../shared/paths.ts'
import type { ResolvedPaths } from '../../shared/plugin-paths.ts'
import { createSessionMetaResolver } from '../../shared/visibility.ts'
import {
  attachmentPort,
  hostCheckpointPort,
  hostRegistryPort,
  liveSessionIds,
  optionalService,
} from '../../shared/host/ports.ts'
import { createDavClient, type DavPort } from './dav.ts'
import type { RemoteWriteGate } from './remote-write.ts'
import { createAutoPushTimer, runAutoPush, type AutoPushTimer } from './auto-push.ts'
import type { SyncDeps } from './sync.ts'
import type { SyncSettings } from './settings.ts'

/** 界面要知道的同步配置（只有非敏感字段，没有密码）。 */
export interface SyncInfo {
  url: string
  machineId: string
  /** 映射条数；映射表本身在配置里，界面只报条数。 */
  mappings: number
  /**
   * 自动那一档：开着才有这一项，**没开就是缺席**（不是 `enabled: false`）。
   *
   * `mode` 是"只推"还是"双向"：界面靠它说"自动推送已开：只往远端推"还是"自动同步已开：双向，写完
   * 一轮就对齐"，并决定那枚手动入口叫「立即推送一次」还是「立即同步一次」。什么时候跑由安静窗口决定，
   * 没有"隔多久"这个旋钮。
   */
  autoPush?: { enabled: boolean; mode: AutoMode }
}

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
    // 只有真的开着才报：界面靠这一项决定"自动已开"那句话摆不摆、以及说"只推"还是"双向"，报一个
    // `enabled: false` 会让每个没开自动的人都多读一个字段。
    ...(auto === undefined || !auto.enabled ? {} : { autoPush: { enabled: true, mode: auto.mode } }),
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
 * 与界面同一套规则（[SyncConfigForm](./client/operations/sync/SyncConfigForm.tsx) 把密码写在这个名字下）：
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
  // 于是"开没开"只有一个来源，调度器与那一轮本身读的是同一份值。
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
 * 自动推送的运行时：一份 `SyncDeps` 加一个调度器。
 *
 * 与 `syncRuntime()` 分开而不是改它的返回值：那个函数是**界面与工具**那两条手动路共用的（它们要的
 * 只是"远端 + 设置"），而自动推送多要一份依赖集合与一个定时器——把它塞进同一个返回值，两条手动路就
 * 得各自忽略一半字段。
 *
 * 两处**必须**一起造的理由（也是这个函数存在的全部意义）：调度器与那一轮读的配置、远端、库位置都得
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
  options: { repoLocations?: SyncDeps['repoLocations']; remoteWrite?: RemoteWriteGate } = {},
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
    // 扫本机那一趟把投影记录读一次，空白与活动时间从它取（见 projection-cache.ts）。
    projection: createProjectionReader(projectionCacheDir(paths.registryPath)),
    liveSessionIds: () => liveSessionIds(ctx),
    hostRegistry: () => hostRegistryPort(ctx),
    hostCheckpoints: () => hostCheckpointPort(ctx),
    // 自动推送只推不拉，但**推的包里也没有对象**：对象走远端共享库，所以这条路照样要那个端口
    // （宿主没有附件服务时缺席，整条路退回"只搬日志"）。
    attachments: () => attachmentPort(ctx),
    // 这一趟是只推不拉；`what` 让界面能把后台那条流与用户手点的那条分开（两条可能同时在跑）。
    pushOnly: true,
    progressWhat: 'auto-push',
    // 界面那边造的那份"目录 → 项目身份"缓存：后台每轮都要重新算计划，不能每轮重新问一遍 git。
    ...(options.repoLocations === undefined ? {} : { repoLocations: options.repoLocations }),
  }
  /*
   * 调度器持有"连续失败几次"这份状态（还有"正跑着的那一轮"），所以它**每个宿主只造一个**
   * （`src/index.ts` 造、挂在插件生命周期上），不能每次请求现造。
   */
  let failures = 0
  /** 每个宿主只造一个调度器，所以配置这个读法每次现读（`sync` 是活引用，改完立即生效）。 */
  const auto = (): AutoConfig | undefined => autoPushSection(syncSection(config))
  const timer = createAutoPushTimer({
    clock: { enabled: () => auto()?.enabled === true },
    ...(options.remoteWrite === undefined ? {} : { remoteWrite: options.remoteWrite }),
    run: async (options) => {
      // 每次真跑之前重新解析一次设置：`sync` 是活引用，用户可能刚把 URL 或密码改掉。
      const fresh = await syncRuntime(ctx, config)
      const outcome = await runAutoPush(
        { ...deps, ...(fresh === undefined ? {} : { dav: fresh.dav, settings: fresh.settings }) },
        {
          failures,
          ...(options?.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        },
      )
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
 * 把自动推送接到会话事件上：**本机安静下来之后才推**。这是自动推送唯一的触发源。
 *
 * 为什么不能直接把事件当成"该推了"：`turn/end` 到的时候**日志还没落盘**。宿主的
 * `dsh-session-checkpoint-policy` 只在模型请求、工具派发、agent 步进三处落盘，`turn/end` 不在其中；
 * `turn/end` 的契约原文就写着 "The loop does not await a flush at turn boundaries… consumers that
 * read storage after `turn/end` flush themselves"。而推送读的正是磁盘字节——少了这一步，推送出去的会
 * 是一份**缺最后几步**的半截会话（而且远端会把它当成"本机的最新"，下一轮才补上，中间那一版是错的）。
 *
 * 所以这里 `await sessions.flush(session)` 之后再调 `timer.touched()`。这是宿主点名的用法：
 * `sessions.flush()` 的契约称自己是 "THE flush entry point"，并点名"读存储之前自己冲一下的消费者"
 * 必须走它（不要自己 `ctx.parallel('session/flush', …)`）。
 *
 * `flush` 失败**吞掉**：它只决定"这次读得到多新"，推的活儿本身没错。吞掉的代价是这一次可能推一份略旧
 * 的会话，等这条会话下一轮结束时补上；而把异常抛进事件通道会打断宿主自己的派发，代价大得多。
 *
 * `sessions` 按**可选服务**收（`optionalService()`），不进 `inject`：没有会话服务的 profile（纯工具
 * 那类前端）照旧只有工具，插件不该因为少一个服务就整个起不来。拿不到服务时返回一个空卸载函数——
 * 那时自动推送不会自己跑，只剩界面那枚「立即推送一次」（它在日志里说一句，见 `src/index.ts`）。
 *
 * @param ctx 宿主上下文。
 * @param timer 已经造好的调度器（`resolveAutoPushRuntime()` 的那个）。
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
      /*
       * 每个事件都算"还在活动"，都去把那个安静窗口往后推——这正是"人还在用的时候不许推"的实现：
       * `turn/start`、`step/end`、工具派发、`turn/end` 一连串下来，计时器一直被重置，一轮都推不动。
       */
      if (event?.type !== 'turn/end') {
        // 别的种类只重置计时，不冲盘：`step/end` 一次模型调用就一条，每条都冲一次盘很贵，而且只有
        // "推之前"才需要磁盘上是新的。
        timer.touched()
        return
      }
      const flush = sessions.flush
      if (flush === undefined) {
        timer.touched()
        return
      }
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
