// src/tools.ts — 暴露给模型的 4 个工具。
//
// 设计取向：
//   * 读操作（plan / verify）永不写盘；
//   * 写操作（migrate / rollback）默认 dry-run，必须显式 apply:true；
//   * 每个写操作的返回值都说明"何时生效"——因为离线改注册表需要重启 DSH，
//     除非上游提供了 workspaceRegistry.reassignSessions（见 effectMode()）。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readHeaderQuick } from './discovery.ts'
import { applyPlan, verifyAppliedPlan } from './execute.ts'
import { readManifest, rollback } from './journal.ts'
import { buildRelocationPlan, describePlan } from './plan.ts'
import { projectKey } from './project-key.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import type { DecodeAll, WorkspaceRegistryState } from './types.ts'

/** 平台的 fzstd 解码器（纯 JS、多帧感知）。 */
import { decompress } from 'fzstd'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

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
    backupRoot: config.backupRoot ?? join(home, 'dsh-session-mover-backups'),
  }
}

/** 迁移何时生效。 */
export type EffectMode = 'immediate' | 'restart-required'

/**
 * 迁移何时生效：上游若提供 reassignSessions 就能进程内即时生效，
 * 否则离线落盘必须重启 DSH 才会被承认（宿主持有内存副本）。
 */
export function effectMode(ctx: unknown): EffectMode {
  const registry = (ctx as { workspaceRegistry?: { reassignSessions?: unknown } } | undefined)?.workspaceRegistry
  return typeof registry?.reassignSessions === 'function' ? 'immediate' : 'restart-required'
}

const EFFECT_NOTE: Record<EffectMode, string> = {
  immediate: '注册表变更由 workspaceRegistry 直接承接，无需重启。',
  'restart-required':
    '注册表已落盘，但宿主进程内持有内存副本，需重启 DSH 后才会生效；重启前请勿在旧工作区继续新增会话。',
}

function loadRegistry(paths: ResolvedPaths): WorkspaceRegistryState {
  const registry = readRegistry(paths.registryPath)
  const check = validateRegistry(registry)
  if (!check.ok) {
    throw new Error(`workspace 注册表不满足启动不变式，拒绝操作：${check.problems.join('; ')}`)
  }
  return registry
}

/** 计划类工具的返回值。 */
export interface PlanToolResult {
  ok: boolean
  sessions: number
  files: number
  targetBucket: string
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
  const disposers: Array<() => void> = []

  // ---- 只读：计划 ----
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'plan_session_migration',
        description:
          'Read-only plan for migrating DSH sessions from one workspace directory to another. Reports how many ' +
          'sessions and log files would move, the target session bucket, the workspace-ledger change, and any ' +
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
            description: 'Optional: migrate only these session ids (default: every session in the source bucket).',
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
              targetBucket: { type: 'string', required: true },
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
          const plan = buildRelocationPlan({
            root: paths.sessionsRoot,
            registry: loadRegistry(paths),
            from: args.from,
            to: args.to,
            decodeAll,
            sessionIds: args.sessionIds ?? null,
            includeUnowned: args.includeUnowned !== false,
          })
          return {
            ok: plan.ok,
            sessions: plan.sessions.length,
            files: plan.sessions.reduce((n, s) => n + s.files.length, 0),
            targetBucket: plan.targetBucket,
            summary: describePlan(plan),
            takesEffect: mode(),
            problems: plan.problems,
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
          'zstd frame; the rest stays byte-identical), move the session directories into the target bucket, and ' +
          're-home the workspace ledger. Defaults to dry-run; apply:true performs it after taking a byte-level ' +
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
          const plan = buildRelocationPlan({
            root: paths.sessionsRoot,
            registry: loadRegistry(paths),
            from: args.from,
            to: args.to,
            decodeAll,
            sessionIds: args.sessionIds ?? null,
            includeUnowned: args.includeUnowned !== false,
            includeArtifacts: args.includeArtifacts === true,
          })
          if (!plan.ok) {
            return {
              applied: false,
              rewritten: 0,
              moved: 0,
              artifactsMoved: 0,
              verified: false,
              takesEffect: mode(),
              summary: describePlan(plan),
              problems: plan.problems,
            }
          }
          if (args.apply !== true) {
            return {
              applied: false,
              rewritten: 0,
              moved: 0,
              artifactsMoved: 0,
              verified: false,
              takesEffect: mode(),
              summary: `${describePlan(plan)}\n\n（dry-run，未写任何字节；传 apply:true 执行）`,
              problems: [],
            }
          }
          const r = applyPlan(plan, { registryPath: paths.registryPath, decodeAll, backupRoot: paths.backupRoot })
          const v = verifyAppliedPlan(plan, { decodeAll })
          return {
            applied: true,
            rewritten: r.rewritten,
            moved: r.moved,
            artifactsMoved: r.artifactsMoved,
            verified: v.ok,
            backupDir: r.backupDir,
            takesEffect: mode(),
            summary:
              `已迁移 ${plan.sessions.length} 个会话（改写 ${r.rewritten} 个日志、移动 ${r.moved} 个目录` +
              `${r.artifactsMoved > 0 ? `、搬迁 ${r.artifactsMoved} 项产物` : ''}）。\n` +
              `复核：${v.ok ? '通过' : '失败'}。备份：${r.backupDir}\n${EFFECT_NOTE[mode()]}`,
            problems: v.problems,
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
          const manifestPath = join(args.backupDir, 'manifest.json')
          if (!existsSync(manifestPath)) throw new Error(`no manifest.json in ${args.backupDir}`)
          const { manifest } = readManifest(args.backupDir)
          const r = rollback(manifest, { backupDir: args.backupDir })
          return {
            restoredFiles: r.restoredFiles,
            restoredArtifacts: r.restoredArtifacts,
            sessions: manifest.sessions.length,
            registryRestored: r.registryRestored,
            summary:
              `已回滚 ${manifest.sessions.length} 个会话、还原 ${r.restoredFiles} 个文件` +
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
          'Read-only check that every session log in a directory\'s bucket agrees with its header cwd — the exact ' +
          'condition the host enforces when it reports "corrupt session log". Use after a migration or a manual move.',
        parameters: {
          dir: { type: 'string', required: true, description: 'Workspace directory whose session bucket to check.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              checked: { type: 'integer', required: true },
              bucket: { type: 'string', required: true },
              problems: { type: 'array', required: true, items: { type: 'string' } },
              summary: { type: 'string', required: true },
            },
          },
          render: (_args: unknown, value: unknown) => [
            { type: 'text' as const, text: String((value as { summary: string }).summary) },
          ],
        },
        async execute(args) {
          const bucket = join(paths.sessionsRoot, projectKey(args.dir))
          if (!existsSync(bucket)) throw new Error(`session bucket does not exist: ${bucket}`)
          const problems: string[] = []
          let checked = 0
          for (const dirName of readdirSync(bucket)) {
            const dir = join(bucket, dirName)
            if (!statSync(dir).isDirectory()) continue
            for (const name of readdirSync(dir)) {
              if (!name.endsWith('.jsonl.zstd')) continue
              const header = readHeaderQuick(readFileSync(join(dir, name)), decodeAll).header
              if (header.cwd !== args.dir) problems.push(`${dirName}/${name}: header cwd ${header.cwd} != ${args.dir}`)
              if (header.cwd !== undefined && projectKey(header.cwd) !== projectKey(args.dir)) {
                problems.push(`${dirName}/${name}: bucket does not match header cwd (host would report corrupt session log)`)
              }
              checked++
            }
          }
          return {
            ok: problems.length === 0,
            checked,
            bucket,
            problems,
            summary: `${bucket}\n检查 ${checked} 个日志文件：${problems.length ? `发现 ${problems.length} 个问题` : '全部通过'}`,
          }
        },
      }),
    ),
  )

  return disposers
}
