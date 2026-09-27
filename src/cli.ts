#!/usr/bin/env node
// src/cli.ts — 离线 CLI：把会话从一个工作区目录迁到另一个。
//
// 与插件（src/index.ts）共用同一套引擎，走的是同一段代码：
// plan（只读）→ apply（备份 + 改写 + 移动 + 注册表）→ verify → rollback。
//
// 注意：离线改注册表后需要**重启 DSH** 才会被承认（宿主进程内持有内存副本）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { decompress } from 'fzstd'

import { readHeaderQuick } from './discovery.ts'
import { applyPlan, verifyAppliedPlan } from './execute.ts'
import { readManifest, rollback } from './journal.ts'
import { buildRelocationPlan, describePlan } from './plan.ts'
import { projectKey } from './project-key.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import type { DecodeAll } from './types.ts'

const decodeAll: DecodeAll = (buf: Uint8Array): string => Buffer.from(decompress(buf)).toString('utf8')

interface Args {
  _: string[]
  session: string[]
  from?: string
  to?: string
  root?: string
  registry?: string
  backup?: string
  yes?: boolean
  json?: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { _: [], session: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    switch (a.slice(2)) {
      case 'session':
        out.session.push(argv[++i] ?? '')
        break
      case 'yes':
        out.yes = true
        break
      case 'json':
        out.json = true
        break
      case 'from':
        out.from = argv[++i]
        break
      case 'to':
        out.to = argv[++i]
        break
      case 'root':
        out.root = argv[++i]
        break
      case 'registry':
        out.registry = argv[++i]
        break
      case 'backup':
        out.backup = argv[++i]
        break
      default:
        // 未知旗标忽略：CLI 的向前兼容优先于严格报错
        break
    }
  }
  return out
}

interface Paths {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
}

function defaults(args: Args): Paths {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return {
    sessionsRoot: args.root ?? join(home, 'sessions'),
    registryPath: args.registry ?? join(home, 'storages', 'workspace.json'),
    backupRoot: args.backup ?? join(home, 'dsh-session-mover-backups'),
  }
}

function fail(msg: string): void {
  console.error(`错误：${msg}`)
  process.exitCode = 1
}

const HELP = `dsh-session-mover — 迁移 DSH 会话到另一个工作区目录

用法：
  dsh-session-mover plan     --from <源目录> --to <目标目录> [--session <id>]... [--json]
  dsh-session-mover apply    --from <源目录> --to <目标目录> [--session <id>]...
  dsh-session-mover verify   --to <目录>
  dsh-session-mover rollback --backup <备份目录>

公共选项：
  --root <sessionsRoot>   会话根目录（缺省 $DSH_HOME/sessions）
  --registry <path>       workspace.json（缺省 $DSH_HOME/storages/workspace.json）
  --backup <dir>          备份根目录（apply 用；rollback 传具体备份目录）

说明：
  * plan 是只读的，不写任何字节。
  * apply 会先做字节级备份，再改写日志首帧、移动会话目录、原子落盘注册表。
  * 离线改注册表后需**重启 DSH** 才会被承认。
`

function cmdPlan(args: Args, d: Paths): void {
  if (!args.from || !args.to) return fail('plan 需要 --from 与 --to')
  const plan = buildRelocationPlan({
    root: d.sessionsRoot,
    registry: readRegistry(d.registryPath),
    from: args.from,
    to: args.to,
    decodeAll,
    sessionIds: args.session.length ? args.session : null,
  })
  if (args.json) {
    const { nextRegistry: _omit, ...rest } = plan
    console.log(JSON.stringify(rest, null, 2))
  } else {
    console.log(describePlan(plan))
    console.log(plan.ok ? '\n计划可用（dry-run，未写任何字节）。' : '\n计划存在问题，不可执行。')
  }
  if (!plan.ok) process.exitCode = 2
}

function cmdApply(args: Args, d: Paths): void {
  if (!args.from || !args.to) return fail('apply 需要 --from 与 --to')
  const plan = buildRelocationPlan({
    root: d.sessionsRoot,
    registry: readRegistry(d.registryPath),
    from: args.from,
    to: args.to,
    decodeAll,
    sessionIds: args.session.length ? args.session : null,
  })
  console.log(describePlan(plan))
  if (!plan.ok) return fail('计划存在问题，拒绝执行')

  const r = applyPlan(plan, { registryPath: d.registryPath, decodeAll, backupRoot: d.backupRoot })
  const v = verifyAppliedPlan(plan, { decodeAll })
  console.log(`\n已改写 ${r.rewritten} 个日志、移动 ${r.moved} 个会话目录`)
  console.log(`备份：${r.backupDir}`)
  console.log(`复核：${v.ok ? '通过' : '失败'}`)
  if (!v.ok) for (const p of v.problems) console.error(`  - ${p}`)
  console.log('\n请重启 DSH 以让注册表变更生效。')
  if (!v.ok) process.exitCode = 1
}

function cmdVerify(args: Args, d: Paths): void {
  if (!args.to) return fail('verify 需要 --to')
  const bucket = join(d.sessionsRoot, projectKey(args.to))
  if (!existsSync(bucket)) return fail(`目标分桶不存在：${bucket}`)
  let checked = 0
  const problems: string[] = []
  for (const dirName of readdirSync(bucket)) {
    const dir = join(bucket, dirName)
    if (!statSync(dir).isDirectory()) continue
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl.zstd')) continue
      const header = readHeaderQuick(readFileSync(join(dir, name)), decodeAll).header
      if (header.cwd !== args.to) problems.push(`${dirName}/${name}: cwd ${header.cwd} != ${args.to}`)
      if (header.cwd !== undefined && projectKey(header.cwd) !== projectKey(args.to)) {
        problems.push(`${dirName}/${name}: 分桶与 header 不一致`)
      }
      checked++
    }
  }
  console.log(`${bucket}\n  检查 ${checked} 个日志文件：${problems.length ? '发现问题' : '通过'}`)
  for (const p of problems) console.error(`  - ${p}`)
  if (problems.length) process.exitCode = 1
}

function cmdRollback(args: Args): void {
  const dir = args.backup
  if (!dir) return fail('rollback 需要 --backup <具体备份目录>')
  if (!existsSync(join(dir, 'manifest.json'))) return fail(`备份目录里没有 manifest.json：${dir}`)
  const { manifest } = readManifest(dir)
  const r = rollback(manifest, { backupDir: dir })
  console.log(`回滚完成：还原 ${r.restoredFiles} 个文件、${r.actions.length} 个动作`)
  console.log(`  会话数：${manifest.sessions.length}；注册表已还原：${r.registryRestored}`)
}

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(HELP)
} else {
  const d = defaults(args)
  // 所有命令都先确认注册表可解析且满足启动不变式，避免在坏状态上做决策
  if (['plan', 'apply'].includes(cmd)) {
    const { ok, problems } = validateRegistry(readRegistry(d.registryPath))
    if (!ok) fail(`注册表不满足启动不变式，拒绝继续：\n  ${problems.join('\n  ')}`)
  }
  if (cmd === 'plan') cmdPlan(args, d)
  else if (cmd === 'apply') cmdApply(args, d)
  else if (cmd === 'verify') cmdVerify(args, d)
  else if (cmd === 'rollback') cmdRollback(args)
  else fail(`未知子命令：${cmd}（可用：plan / apply / verify / rollback）`)
}
