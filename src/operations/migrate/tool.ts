// 迁移那四个工具的**定义**：只读计划、落地、回滚、复核。
//
// schema 与措辞跟着编排走：计划字段改了，工具的返回形状与计划本身在同一个文件夹里，不会一处改完另一处
// 忘掉。注册、开关与顺序留在 src/tools.ts。
//
// @module dsh-session-manager/operations/migrate/tool
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { describeEffect, describePlannedEffect, effectOf } from '../../shared/host/take-effect.ts'
import { readLogHeader } from '../../shared/library/discovery.ts'
import type { ResolvedPaths } from '../../shared/plugin-paths.ts'
import { projectKey } from '../../shared/project-key.ts'
import type { DecodeAll, EffectMode } from '../../shared/types.ts'
import { previewMigration, rollbackMigration, runMigration, type MigrateDeps } from './migrate.ts'

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
 * 按插件配置里 `tools` 一节的开关注册工具（6 个全开时就是 6 个）。
 * @param options.remoteWrite 写远端格子的互斥锁；生产由 `src/index.ts` 造一份交给界面、工具与
 *   自动推送共用。缺席时自己造一把（只测工具时够用）。
 * @returns cordis effect disposer 列表（宿主热卸载时逐个调用）。

/** 四个定义共用的上下文（`src/tools.ts` 造一次）。 */
export interface MigrationToolContext {
  /** 会话库、注册表与备份根。 */
  paths: ResolvedPaths
  /** 迁移编排的依赖（与界面端点同一份形状）。 */
  deps: MigrateDeps
  /** 这次调用能看到哪种生效模式。 */
  mode: () => EffectMode
  /** 平台的 fzstd 解码器（复核那条工具读 header 用）。 */
  decodeAll: DecodeAll
}

/** 造出迁移那四个工具的定义；开关、顺序与卸载由 `src/tools.ts` 管。 */
export function migrationTools(context: MigrationToolContext): {
  plan: ToolDefinition
  migrate: ToolDefinition
  rollback: ToolDefinition
  verify: ToolDefinition
} {
  const { paths, deps, mode, decodeAll } = context
  return {
    plan: defineTool({
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
        const preview = await previewMigration(deps, {
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
    migrate: defineTool({
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
    rollback: defineTool({
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
    verify: defineTool({
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
            // 只读前缀：这条工具以前把整份日志读进来，只为了第一行 header；大项目里会连续读几百 MB。
            const { header } = readLogHeader(join(dir, name), decodeAll)
            if (header.cwd !== args.dir) problems.push(`${dirName}/${name}: header cwd ${header.cwd} != ${args.dir}`)
            if (header.cwd !== undefined && projectKey(header.cwd) !== projectKey(args.dir)) {
              problems.push(`${dirName}/${name}: project directory does not match header cwd (host would report corrupt session log)`)
            }
            checked++
            // 一个项目可能有几百条；每 32 条让出一轮，别让一次校验把宿主按住。
            if (checked % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
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
  }
}
