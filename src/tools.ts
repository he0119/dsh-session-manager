// src/tools.ts — 暴露给模型的 5 个工具。
//
// 设计取向：
//   * 读操作（plan / verify）永不写盘；
//   * 写操作（migrate / rollback / sync）默认 dry-run，必须显式 apply:true；
//   * 每个写操作的返回值都说明"何时生效"——因为绕过宿主直接改注册表可能需要重启 DSH，
//     除非上游提供了 workspaceRegistry.reassignSessions（见 effectMode()）。
import type { Context } from '@deepseek-ai/cordis'

import { DEFAULT_PASSWORD_REF, syncSection, type PluginConfig, type PluginConfigInput, type SyncConfig } from './config.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import { createDavClient, type DavPort } from './dav.ts'
import { readHeaderQuick } from './discovery.ts'
import {
  previewMigration,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
} from './migrate.ts'
import { projectKey } from './project-key.ts'
import { runSync, type SyncPlan, type SyncSettings } from './sync.ts'
import type { DecodeAll } from './types.ts'

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
}

/** 解析后的默认路径。 */
export interface ResolvedPaths {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
}

/** 从插件配置与 $DSH_HOME 解析默认路径。 */
export function resolvePaths(config: PluginConfigInput = {}): ResolvedPaths {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return {
    sessionsRoot: config.sessionsRoot ?? join(home, 'sessions'),
    registryPath: config.registryPath ?? join(home, 'storages', 'workspace.json'),
    backupRoot: config.backupRoot ?? join(home, 'dsh-session-manager-backups'),
  }
}

/** 迁移何时生效。 */
export type EffectMode = 'immediate' | 'restart-required'

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
  return {
    url: sync.url.trim(),
    machineId: machineIdOf(sync),
    mappings: Object.keys(sync.mapping ?? {}).length,
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
  const settings: SyncSettings = {
    url: sync.url.trim().replace(/(.)\/+$/, '$1'),
    machineId: machineIdOf(sync),
    mapping: sync.mapping ?? {},
    ...(sync.username === undefined || sync.username === '' ? {} : { username: sync.username }),
    ...(password === undefined ? {} : { password }),
    ...(sync.timeoutMs === undefined ? {} : { timeoutMs: sync.timeoutMs }),
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

/** 同步工具的返回值。 */
export interface SyncToolResult {
  ok: boolean
  applied: boolean
  pulled: string[]
  pushed: string[]
  /** 什么都没动的那几条与原因（远端领先、分叉、缺映射……）。 */
  notes: string[]
  bytesIn: number
  bytesOut: number
  machines: string[]
  takesEffect: EffectMode
  summary: string
  problems: string[]
}

/**
 * 计划里"没动"的条目（推与拉两侧的 skip）压成一行行说明。
 *
 * `identical`（"远端已经有这一份"）不进来：整库同步时它是最多也最没信息量的一类，几百行"这条不用推"
 * 会把真正要看的那几条淹掉。
 */
function planNotes(plan: SyncPlan): string[] {
  const notes: string[] = []
  for (const entry of plan.pull) {
    if (entry.action === 'skip') notes.push(`不拉 ${entry.id}：${entry.reason ?? ''}`)
  }
  for (const entry of plan.push) {
    if (entry.action === 'skip' && entry.code !== 'identical') notes.push(`不推 ${entry.id}：${entry.reason ?? ''}`)
  }
  return notes
}

/** 一次同步的一句话结论。 */
function describeSync(plan: SyncPlan, pulled: readonly string[], pushed: readonly string[], applied: boolean): string {
  const head = `${applied ? '已同步' : '预演'}：拉 ${plan.pullIds.length} 条、推 ${plan.pushIds.length} 条（本机 ${plan.localCount} 条，远端 ${plan.remoteCount} 条，来自 ${plan.machines.join('、') || '还没有机器'}）`
  if (!applied) return head
  return `${head}。实际落地：拉 ${pulled.length} 条、推 ${pushed.length} 条`
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
 * 迁移何时生效：上游若提供 reassignSessions 就能进程内即时生效，
 * 否则直接落盘必须重启 DSH 才会被承认（宿主持有内存副本）。
 */
export function effectMode(ctx: unknown): EffectMode {
  const registry = optionalService(ctx, 'workspaceRegistry') as { reassignSessions?: unknown } | undefined
  return typeof registry?.reassignSessions === 'function' ? 'immediate' : 'restart-required'
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

const EFFECT_NOTE: Record<EffectMode, string> = {
  immediate: '注册表变更由 workspaceRegistry 直接承接，无需重启。',
  'restart-required':
    '注册表已落盘，但宿主进程内持有内存副本，需重启 DSH 后才会生效；重启前请勿在旧工作区继续新增会话。',
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
  /** 其中跟着点名会话一起走的子代理会话条数（见 plan.ts 的 `cascaded`）。 */
  cascaded: number
  files: number
  targetProjectDir: string
  summary: string
  takesEffect: EffectMode
  problems: string[]
}

/** 迁移类工具的返回值。 */
export interface MigrateToolResult {
  applied: boolean
  /** 跟着点名会话一起走的子代理会话条数（见 plan.ts 的 `cascaded`）。 */
  cascaded: number
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
  }
  const disposers: Array<() => void> = []

  // ---- 只读：计划 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'plan_session_migration',
        description:
          'Read-only plan for migrating DSH sessions from one workspace directory to another. Reports how many ' +
          'sessions and log files would move, the target session project directory, the workspace-registry ' +
          'change, and any ' +
          'blocking problem (missing target directory, projectKey collision, occupied target directory, invalid ' +
          'registry). Subagent sessions always follow their parent: naming a subagent is refused, and naming a ' +
          'parent takes its whole family along. Writes nothing. Call this before migrate_sessions.',
        parameters: {
          from: { type: 'string', required: true, description: 'Source workspace directory (absolute path).' },
          to: {
            type: 'string',
            required: true,
            description: 'Target workspace directory (absolute path, must already exist).',
          },
          sessionIds: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional: migrate only these session ids (default: every session in the source project directory). ' +
              'Subagent descendants always come along with the session they belong to.',
          },
          includeUnowned: {
            type: 'boolean',
            description: 'Optional: also migrate sessions not registered in any workspace (default true).',
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
            from: args.from,
            to: args.to,
            sessionIds: args.sessionIds ?? null,
            includeUnowned: args.includeUnowned !== false,
          })
          return {
            ok: preview.ok,
            sessions: preview.sessions.length,
            cascaded: preview.cascaded,
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
          'Migrate DSH sessions between workspace directories: rewrite each session log header cwd (only the first ' +
          'zstd frame; the rest stays byte-identical), move the session directories into the target ' +
          'project directory, and ' +
          're-home the workspace registry. Defaults to dry-run; apply:true performs it after taking a byte-level ' +
          'backup. Refuses on any blocking problem. Subagent sessions always follow their parent (naming one is ' +
          'refused; naming a parent takes its whole family along; their registry membership does not change). ' +
          'Offline registry writes take effect after a DSH restart unless ' +
          'the host exposes workspaceRegistry.reassignSessions.',
        parameters: {
          from: { type: 'string', required: true, description: 'Source workspace directory (absolute path).' },
          to: {
            type: 'string',
            required: true,
            description: 'Target workspace directory (absolute path, must already exist).',
          },
          sessionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: migrate only these session ids (subagent descendants always come along).',
          },
          includeUnowned: {
            type: 'boolean',
            description: 'Optional: also migrate unregistered sessions (default true).',
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
          const run = runMigration(
            deps,
            {
              from: args.from,
              to: args.to,
              sessionIds: args.sessionIds ?? null,
              includeUnowned: args.includeUnowned !== false,
              includeArtifacts: args.includeArtifacts === true,
            },
            { apply: args.apply === true },
          )
          const summary = run.applied
            ? `${run.summary}\n${EFFECT_NOTE[mode()]}`
            : run.preview.ok
              ? `${run.summary}\n\n（dry-run，未写任何字节；传 apply:true 执行）`
              : run.summary
          return {
            applied: run.applied,
            cascaded: run.preview.cascaded,
            rewritten: run.rewritten,
            moved: run.moved,
            artifactsMoved: run.artifactsMoved,
            verified: run.verified,
            ...(run.backupDir === undefined ? {} : { backupDir: run.backupDir }),
            takesEffect: mode(),
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
              summary: { type: 'string', required: true },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: String((value as { summary: string }).summary) },
          ],
        },
        async execute(args) {
          const r = rollbackMigration({ backupRoot: paths.backupRoot }, { backupDir: args.backupDir })
          return {
            restoredFiles: r.restoredFiles,
            restoredArtifacts: r.restoredArtifacts,
            sessions: r.sessions,
            registryRestored: r.registryRestored,
            summary:
              `已回滚 ${r.sessions} 个会话、还原 ${r.restoredFiles} 个文件` +
              `${r.restoredArtifacts > 0 ? `、搬回 ${r.restoredArtifacts} 项产物` : ''}并恢复注册表。`,
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
          'library). Add-only: a session id that already exists locally is never pulled, a remote copy that is ' +
          'ahead is only reported, and a local copy that is strictly ahead of the remote is re-uploaded. ' +
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
              pushed: { type: 'array', required: true, items: { type: 'string' } },
              notes: { type: 'array', required: true, items: { type: 'string' } },
              bytesIn: { type: 'integer', required: true },
              bytesOut: { type: 'integer', required: true },
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
              pushed: [],
              notes: [],
              bytesIn: 0,
              bytesOut: 0,
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
              decodeAll,
            },
            { apply: args.apply === true },
          )
          const pushedIds = outcome.applied ? outcome.pushed.map((entry) => entry.id) : outcome.plan.pushIds
          return {
            ok: outcome.plan.ok && outcome.problems.length === 0,
            applied: outcome.applied,
            pulled: outcome.applied ? outcome.pulled : outcome.plan.pullIds,
            pushed: pushedIds,
            notes: planNotes(outcome.plan),
            bytesIn: outcome.applied ? outcome.bytesIn : outcome.plan.bytesIn,
            bytesOut: outcome.applied ? outcome.bytesOut : outcome.plan.bytesOut,
            machines: outcome.plan.machines,
            // 只有真的往库里落了会话才谈得上"要不要重启"；纯推送不改本机任何东西。
            takesEffect: outcome.applied && outcome.pulled.length > 0 ? mode() : 'immediate',
            summary: describeSync(outcome.plan, outcome.pulled, pushedIds, outcome.applied),
            problems: [...outcome.plan.problems, ...outcome.problems],
          }
        },
      }),
    ),
  )

  return disposers
}
