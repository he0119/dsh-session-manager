// src/tools.ts — 暴露给模型的 4 个工具。
//
// 设计取向：
//   * 读操作（plan / verify）永不写盘；
//   * 写操作（migrate / rollback）默认 dry-run，必须显式 apply:true；
//   * 每个写操作的返回值都说明"何时生效"——因为绕过宿主直接改注册表可能需要重启 DSH，
//     除非上游提供了 workspaceRegistry.reassignSessions（见 effectMode()）。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readHeaderQuick } from './discovery.ts'
import {
  previewMigration,
  rollbackMigration,
  runMigration,
  type MigrateDeps,
} from './migrate.ts'
import { projectKey } from './project-key.ts'
import type { DecodeAll } from './types.ts'

/**
 * 平台的 fzstd 解码器（纯 JS、多帧感知）。
 *
 * 导出是为了让 Web 端点那一层用**同一个**解码器实例：`assertMultiFrameAware()` 的探测结论
 * 只应对一份实现成立，两处各挑一个解码器正是当初「只解首帧」那个坑的入口。
 */
import { decompress } from 'fzstd'

export const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

/** 插件配置。 */
export interface PluginConfig {
  sessionsRoot?: string
  registryPath?: string
  backupRoot?: string
}

/** 解析后的默认路径。 */
export interface ResolvedPaths {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
}

/** 从插件配置与 $DSH_HOME 解析默认路径。 */
export function resolvePaths(config: PluginConfig = {}): ResolvedPaths {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return {
    sessionsRoot: config.sessionsRoot ?? join(home, 'sessions'),
    registryPath: config.registryPath ?? join(home, 'storages', 'workspace.json'),
    backupRoot: config.backupRoot ?? join(home, 'dsh-session-manager-backups'),
  }
}

/** 迁移何时生效。 */
export type EffectMode = 'immediate' | 'restart-required'

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


/** 计划类工具的返回值。 */
export interface PlanToolResult {
  ok: boolean
  sessions: number
  files: number
  targetProjectDir: string
  summary: string
  takesEffect: EffectMode
  problems: string[]
}

/** 迁移类工具的返回值。 */
export interface MigrateToolResult {
  applied: boolean
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
export function registerTools(ctx: Context, config: PluginConfig = {}): Array<() => void> {
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
          'registry). Writes nothing. Call this before migrate_sessions.',
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
            description: 'Optional: migrate only these session ids (default: every session in the source project directory).',
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
          'backup. Refuses on any blocking problem. Offline registry writes take effect after a DSH restart unless ' +
          'the host exposes workspaceRegistry.reassignSessions.',
        parameters: {
          from: { type: 'string', required: true, description: 'Source workspace directory (absolute path).' },
          to: {
            type: 'string',
            required: true,
            description: 'Target workspace directory (absolute path, must already exist).',
          },
          sessionIds: { type: 'array', items: { type: 'string' }, description: 'Optional: migrate only these session ids.' },
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

  return disposers
}
