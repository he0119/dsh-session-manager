// 「修已经落地的日志路径」那条工具的定义：预演说明、读写计划与落地都在 path-repair.ts 里。
//
// @module dsh-session-manager/operations/path-repair/tool
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { describeWarm, warmCheckpoints } from '../../shared/host/checkpoint-warm.ts'
import { scanAllAsync } from '../../shared/library/discovery.ts'
import type { ResolvedPaths } from '../../shared/plugin-paths.ts'
import type { DecodeAll } from '../../shared/types.ts'
import type { MigrateDeps } from '../migrate/migrate.ts'
import { applyPathRepair, planPathRepair, type PathRepairPlanResult } from './path-repair.ts'

/**
 * 修日志路径的预演说明：扫了多少、哪几条要动、每条改几条事件、从哪个根搬到哪个根。
 *
 * 写给人看的一段：`from` 是推出来的（或调用方给的）源根，跟目标根并排写出来，人一眼就能看出
 * "这条会话原来在别的机器的哪个目录"。
 */
function describePathRepair(plan: PathRepairPlanResult, changing: number): string {
  const head = `扫描 ${plan.scanned.sessions} 条会话（${plan.scanned.files} 份日志）`
  if (plan.sessions.length === 0) return `${head}：没有发现别的机器留下的路径。`
  const lines = [`${head}：${plan.sessions.length} 条需要处理，其中 ${changing} 条可以修。`]
  for (const entry of plan.sessions) {
    const label = entry.title === undefined ? entry.id : `${entry.title}（${entry.id}）`
    if (entry.problem !== undefined) {
      lines.push(`- ${label}：不修，${entry.problem}`)
      continue
    }
    const events = entry.files.reduce((sum, file) => sum + file.rewritten, 0)
    const roots = new Set(entry.files.map((file) => file.from))
    const from = [...roots].join('、')
    lines.push(`- ${label}：改 ${events} 条事件，${from} → ${entry.cwd ?? '(无 cwd)'}`)
  }
  return lines.join('\n')
}

export interface PathRepairToolResult {
  applied: boolean
  /** 这次会改（或已改）的会话 id。 */
  sessions: string[]
  /** 改写的日志份数与事件条数。 */
  files: number
  events: number
  /** 这一趟扫了多少条会话、多少份日志。 */
  scannedSessions: number
  scannedFiles: number
  backupDir?: string
  /** 有路径但这次不动（或宿主正开着）的会话条数。 */
  skipped: number
  summary: string
  problems: string[]
}

/** 这条工具用到的上下文：库位置、两个可选端口与解码器。 */
export interface PathRepairToolContext {
  paths: ResolvedPaths
  /** 只要这两个可选端口：活会话判据与"请宿主补检查点"。 */
  deps: Pick<MigrateDeps, 'liveSessionIds' | 'hostCheckpoints'>
  decodeAll: DecodeAll
}

/** 造出「修日志路径」那条工具的定义。 */
export function pathRepairTool(context: PathRepairToolContext): ToolDefinition {
  const { paths, deps, decodeAll } = context
  return defineTool({
      name: 'repair_session_paths',
      description:
        'Repair session logs whose `working-directory/change` events still point at another machine\'s ' +
        'directory. A session imported from another platform (Windows paths on a Linux host, say) gets its ' +
        'header cwd rewritten to the local directory, but those events keep the old value. The host folds ' +
        'the last one into its working-directory projection, which requires an absolute path on THIS ' +
        'platform, so the whole session fails to project and the chat page cannot load its history. This ' +
        'rewrites only the values that start with the session\'s own root, moving them onto the local root ' +
        '(sub-paths follow, separators normalized); message text, tool arguments and every other byte stay ' +
        'untouched, and values that are already absolute here are history and never touched. ' +
        'Defaults to dry-run: it decodes every session log to find them, so it is slow on a big library — ' +
        'pass sessionIds to scan a few. apply:true takes a byte-level backup, rewrites each log atomically, ' +
        'verifies the result, then asks the host to fold the session again so it opens right away.',
      parameters: {
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: only look at these session ids (default = every session under the library root).',
        },
        from: {
          type: 'string',
          description:
            'Optional: the directory this session lived in on the other machine (its source root). Omitted = ' +
            'derived from the log as the longest prefix whose last segment matches this machine\'s session ' +
            'directory name; give it explicitly when that guess is wrong.',
        },
        apply: { type: 'boolean', description: 'Optional: true rewrites the logs (default false = dry-run).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            applied: { type: 'boolean', required: true },
            sessions: { type: 'array', required: true, items: { type: 'string' } },
            files: { type: 'integer', required: true },
            events: { type: 'integer', required: true },
            scannedSessions: { type: 'integer', required: true },
            scannedFiles: { type: 'integer', required: true },
            backupDir: { type: 'string' },
            skipped: { type: 'integer', required: true },
            summary: { type: 'string', required: true },
            problems: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text' as const, text: (value as PathRepairToolResult).summary },
        ],
      },
      async execute(args): Promise<PathRepairToolResult> {
        const sessions = await scanAllAsync(paths.sessionsRoot, decodeAll)
        const plan = await planPathRepair(sessions, {
          decodeAll,
          ...(args.from === undefined ? {} : { from: args.from }),
          ...(args.sessionIds === undefined ? {} : { ids: args.sessionIds }),
        })
        // 宿主持在内存里的会话不碰：它手上是另一份日志，改盘上那份不会生效，还可能被它写回。
        const live = deps.liveSessionIds?.() ?? new Set<string>()
        for (const entry of plan.sessions) {
          if (entry.problem === undefined && live.has(entry.id)) {
            entry.problem = '宿主持在内存里（这条会话正开着），先关掉它或重启 DSH 再修'
          }
        }
        const changing = plan.sessions.filter((entry) => entry.problem === undefined && entry.files.length > 0)
        const skipped = plan.sessions.length - changing.length
        if (args.apply !== true) {
          return {
            applied: false,
            sessions: changing.map((entry) => entry.id),
            files: changing.reduce((sum, entry) => sum + entry.files.length, 0),
            events: changing.reduce((sum, entry) => sum + entry.files.reduce((n, file) => n + file.rewritten, 0), 0),
            scannedSessions: plan.scanned.sessions,
            scannedFiles: plan.scanned.files,
            skipped,
            summary: describePathRepair(plan, changing.length) + '\n\n（dry-run，未写任何字节；传 apply:true 执行）',
            problems: [...plan.problems, ...plan.sessions.flatMap((entry) => (entry.problem === undefined ? [] : [`${entry.id}：${entry.problem}`]))],
          }
        }
        if (changing.length === 0) {
          return {
            applied: false,
            sessions: [],
            files: 0,
            events: 0,
            scannedSessions: plan.scanned.sessions,
            scannedFiles: plan.scanned.files,
            skipped,
            summary: describePathRepair(plan, 0),
            problems: [...plan.problems, ...plan.sessions.flatMap((entry) => (entry.problem === undefined ? [] : [`${entry.id}：${entry.problem}`]))],
          }
        }
        const outcome = await applyPathRepair(plan.sessions, { decodeAll, backupRoot: paths.backupRoot })
        const warm = await warmCheckpoints(
          changing.map((entry) => entry.id),
          { ...(deps.hostCheckpoints === undefined ? {} : { hostCheckpoints: deps.hostCheckpoints }) },
        )
        const lines = [
          `已改写 ${outcome.files} 份日志、${outcome.events} 条事件（${changing.length} 条会话）。`,
          ...(outcome.backupDir === undefined ? [] : [`备份：${outcome.backupDir}（改写前的逐字节副本）。`]),
          '日志已经是本机路径了，宿主下次读它就是修好的那一份：打开会话即可，不必重启。',
        ]
        const warmLine = describeWarm(warm)
        if (warmLine !== undefined) lines.push(warmLine)
        return {
          applied: true,
          sessions: changing.map((entry) => entry.id),
          files: outcome.files,
          events: outcome.events,
          scannedSessions: plan.scanned.sessions,
          scannedFiles: plan.scanned.files,
          ...(outcome.backupDir === undefined ? {} : { backupDir: outcome.backupDir }),
          skipped,
          summary: lines.join('\n'),
          problems: [
            ...plan.problems,
            ...outcome.problems,
            ...plan.sessions.flatMap((entry) => (entry.problem === undefined ? [] : [`${entry.id}：${entry.problem}`])),
          ],
        }
      },
    })
}
