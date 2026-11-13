// src/path-repair.ts — 把已经落地的会话日志里"跟着会话根搬"的路径改成本机路径。
//
// 为什么需要它：日志从另一台机器（另一种系统）搬过来时，header 的 cwd 会被改写成本机路径（库目录名与
// 它绑死，不改写落不下来），而 `working-directory/change` 里那些值原样留着。宿主拿最后那个值当会话的
// 当前工作目录，并要求它在本机是绝对路径——别的系统的写法不成立，投影失败，**整条会话读不出来**
// （界面报"历史加载失败"）。判据与取舍见 self-root-path.ts 与 .agents/notes 里那篇笔记。
//
// 导入/同步落地那条路已经顺手改写了（transfer.ts）。这个模块修的是**已经躺在本机**的那些：
// 先算计划（只读，改哪几条、从哪个根搬到哪个根、哪些搬不了），再落地（备份、逐文件原子替换、修完复验）。
//
// 与迁移的区别：迁移搬目录 + 改 header；这里**不动任何目录**，只改那几行事件里的路径值。
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { DiscoveredSession } from './discovery.ts'
import { SELF_ROOT_PATH_FIELDS, SELF_ROOT_PATH_MARKERS } from './self-root-path.ts'
import { relocateSessionPaths, relocateSessionPathsText } from './session-log.ts'
import { stampName } from './journal.ts'
import type { CompressFrame, DecodeAll, ProgressReporter } from './types.ts'

/** 一条日志的修复计划（只读算出来的，落地时照着它做）。 */
export interface PathRepairFilePlan {
  name: string
  path: string
  compression: string | null
  /** 事件里的路径原来住在哪儿（源根）。 */
  from: string
  /** 要换成哪儿（目标根 = header 的 cwd）。 */
  to: string
  /** 会改写多少条事件。 */
  rewritten: number
  /** 原值 → 新值。 */
  mappings: Array<{ from: string; to: string }>
  /** 落在源根之外、因此映射不上的取值（原样保留）。 */
  unmapped: string[]
}

/** 一条会话的修复计划。 */
export interface PathRepairSessionPlan {
  id: string
  /** 会话目录（一个字节都不动，报告里用来说明是哪一条）。 */
  dir: string
  cwd?: string
  title?: string
  files: PathRepairFilePlan[]
  /** 这条这次不修（有就是原因，面向用户）。 */
  problem?: string
}

/** 预演结果。 */
export interface PathRepairPlanResult {
  /** 需要动的会话（有可改的日志，或有改不了的取值需要交代）。 */
  sessions: PathRepairSessionPlan[]
  /** 扫过的会话与日志条数（报告里说明这一趟翻了多少东西）。 */
  scanned: { sessions: number; files: number }
  /** 整趟层面上的问题（某个会话目录读不动之类）。 */
  problems: string[]
}

/** `planPathRepair()` 的选项。 */
export interface PathRepairOptions {
  decodeAll: DecodeAll
  /** 源根；只给一条会话时才知道它原来在哪儿。缺省按"末段与会话根同名"从日志里推。 */
  from?: string
  /** 只看这几条会话（缺省 = 传进来的全看）。 */
  ids?: readonly string[]
  /** 逐条会话报一次（`phase: 'scan'`）。 */
  onProgress?: ProgressReporter
}

/** 日志正文里出现过的、跟着会话根搬的取值（只读，按出现顺序去重）。 */
function selfRootValues(text: string): string[] {
  const values: string[] = []
  for (const line of text.split('\n')) {
    if (!SELF_ROOT_PATH_MARKERS.some((marker) => line.includes(marker))) continue
    let event: { type?: unknown; data?: Record<string, unknown> | null }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    const fields = typeof event.type === 'string' ? SELF_ROOT_PATH_FIELDS.get(event.type) : undefined
    if (fields === undefined || event.data === null || typeof event.data !== 'object') continue
    for (const field of fields) {
      const value = event.data[field]
      if (typeof value === 'string' && value !== '' && !values.includes(value)) values.push(value)
    }
  }
  return values
}

/** 按分隔符切段（与 self-root-path.ts 同一口径，这里只需要"末段"）。 */
function segments(value: string): string[] {
  return value.split(/[\\/]+/).filter((segment) => segment !== '')
}

/**
 * 从日志里出现过的那串路径推出源根：取"末段与本机会话根同名"的最长前缀。
 *
 * 为什么这么推：另一台机器上的同一条会话通常还在同一个目录名下（`…\homelab` ↔ `…/homelab`），而事件里
 * 除了会话根本身，还常有它底下的工作树路径（`…\homelab\.agents\worktrees\fix\x`）。取最长的同名前缀
 * 正好落在"会话根"那一层。
 *
 * 预演会把推出来的映射原样打出来，人看一眼就知道对不对；推不出来（改了目录名、盘符对不上）时让调用方
 * 用 `from` 明确给一个。
 *
 * @param values 日志里出现过的、跟着会话根搬的取值。
 * @param target 这台机器上的会话根（header 的 cwd）。
 * @returns 源根；推不出来时返回 `undefined`。
 */
export function deriveSourceRoot(values: readonly string[], target: string): string | undefined {
  const targetBase = segments(target).at(-1)
  if (targetBase === undefined) return undefined
  let best: { root: string; depth: number } | undefined
  for (const value of values) {
    const parts = segments(value)
    const separator = value.includes('\\') && !value.includes('/') ? '\\' : '/'
    for (let depth = 1; depth <= parts.length; depth++) {
      if (parts[depth - 1] !== targetBase) continue
      const root = parts.slice(0, depth).join(separator)
      if (best === undefined || depth > best.depth) best = { root, depth }
    }
  }
  return best?.root
}

/**
 * 算一份修复计划（只读：一个字节都不写）。
 *
 * 判据：这条日志里有没有「在这台机器上不是绝对路径」的工作目录取值（`working-directory/change` 的 `cwd`）。
 * 有才能推源根、才需要改写；推不出源根、或有取值落在源根之外时，这条会话记成不修并说明原因——
 * 半修等于没修（宿主照样读不出来），不如让人先看清。
 *
 * @param sessions 扫出来的会话（`discovery.ts` 的形状）。
 * @param options 解码器、可选的源根与要看的会话。
 * @returns 计划（只含需要动的会话）与这一趟扫了多少。
 */
export function planPathRepair(
  sessions: readonly DiscoveredSession[],
  options: PathRepairOptions,
): PathRepairPlanResult {
  const { decodeAll } = options
  const wanted = options.ids === undefined ? undefined : new Set(options.ids)
  const plans: PathRepairSessionPlan[] = []
  const problems: string[] = []
  let scannedFiles = 0
  let scanned = 0
  for (const session of sessions) {
    if (wanted !== undefined && !wanted.has(session.id)) continue
    scanned++
    options.onProgress?.({ phase: 'scan', total: sessions.length, done: scanned - 1, id: session.id, label: session.title ?? session.id })
    const to = session.cwd
    if (to === undefined) {
      // 没有 cwd 的会话落在 `_no-cwd` 项目目录里，宿主对它本来就不做这套校验。
      continue
    }
    const files: PathRepairFilePlan[] = []
    const fileProblems: string[] = []
    for (const file of session.files) {
      scannedFiles++
      let text: string
      try {
        text = decodeAll(readFileSync(file.path))
      } catch (error) {
        fileProblems.push(`${file.name} 读不出来：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      // "本机不认的"才需要搬：本机就合法的路径属于历史事实（与 session-log.ts 的 `accept` 同一口径）。
      const values = selfRootValues(text).filter((value) => !isAbsolute(value))
      if (values.length === 0) continue
      const from = options.from ?? deriveSourceRoot(values, to)
      if (from === undefined) {
        fileProblems.push(`${file.name} 里有一台别的机器写的路径，但推不出它原来在哪个目录（用 from 指定）`)
        continue
      }
      const preview = relocateSessionPathsText(text, { from, to })
      if (preview.rewritten === 0 && preview.unmapped.length === 0) continue
      files.push({
        name: file.name,
        path: file.path,
        compression: file.compression,
        from,
        to,
        rewritten: preview.rewritten,
        mappings: preview.mappings,
        unmapped: preview.unmapped,
      })
    }
    if (files.length === 0 && fileProblems.length === 0) continue
    const unmapped = files.flatMap((file) => file.unmapped)
    const problem = fileProblems.length > 0
      ? fileProblems.join('；')
      : unmapped.length > 0
        ? `有 ${unmapped.length} 个路径不在源根底下，改不了：${unmapped.slice(0, 3).join('、')}${unmapped.length > 3 ? ' 等' : ''}`
        : undefined
    plans.push({
      id: session.id,
      dir: session.dir,
      ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
      ...(session.title === undefined ? {} : { title: session.title }),
      files,
      ...(problem === undefined ? {} : { problem }),
    })
  }
  return { sessions: plans, scanned: { sessions: scanned, files: scannedFiles }, problems }
}

/** `applyPathRepair()` 的选项。 */
export interface PathRepairApplyOptions {
  decodeAll: DecodeAll
  /** 备份根目录；给了就把每份要改的日志逐字节复制到 `<backupRoot>/path-repair-<时间戳>/` 下。 */
  backupRoot?: string
  /** 帧压缩器（缺省手写 raw 帧）。 */
  compressFrame?: CompressFrame
  /** 注入时间，便于测试。 */
  now?: Date
  onProgress?: ProgressReporter
}

/** 落地结果。 */
export interface PathRepairOutcome {
  /** 备份目录（没备份就没有）。 */
  backupDir?: string
  /** 改写了多少份日志、多少条事件。 */
  files: number
  events: number
  /** 逐条问题（写盘失败、修完复验不过…）。 */
  problems: string[]
}

/**
 * 落地一份修复计划：备份 → 逐文件原子替换 → 复验。
 *
 * 复验是"修完之后再算一遍"：改写后的日志再走一次同样的规划，必须**一条都不用改**（不再有本机不认的
 * 路径、也没有映射不上的取值）。这一条不过就抛错——临时文件还没 rename，原文件一个字节没动。
 *
 * @param plans 预演出来的计划（`problem` 非空的会话会被跳过）。
 * @param options 解码器、可选的备份根与进度。
 * @returns 改了几份日志、几条事件，以及逐条问题。
 * @throws 备份之后任何一份日志改写失败时抛错（此前已改完的文件保留，问题在 `problems` 里交代）。
 */
export function applyPathRepair(
  plans: readonly PathRepairSessionPlan[],
  options: PathRepairApplyOptions,
): PathRepairOutcome {
  const { decodeAll, compressFrame, now = new Date(), backupRoot, onProgress } = options
  const affected = plans.filter((plan) => plan.problem === undefined && plan.files.length > 0)
  const problems: string[] = []
  let backupDir: string | undefined
  if (backupRoot !== undefined && affected.length > 0) {
    backupDir = join(backupRoot, `path-repair-${stampName(now)}`)
    for (const plan of affected) {
      const destination = join(backupDir, 'sessions', basename(dirname(plan.dir)), basename(plan.dir))
      mkdirSync(dirname(destination), { recursive: true })
      cpSync(plan.dir, destination, { recursive: true })
    }
    writeFileSync(
      join(backupDir, 'repair.json'),
      JSON.stringify(
        {
          kind: 'path-repair',
          createdAt: now.toISOString(),
          sessions: affected.map((plan) => ({
            id: plan.id,
            dir: plan.dir,
            files: plan.files.map((file) => ({ name: file.name, from: file.from, to: file.to, events: file.rewritten })),
          })),
          note: '每份会话目录都是改写前的逐字节副本；要撤回就把 sessions/ 下那一份复制回原位置。',
        },
        null,
        2,
      ) + '\n',
    )
  }

  let files = 0
  let events = 0
  const total = affected.reduce((sum, plan) => sum + plan.files.length, 0)
  let done = 0
  for (const plan of affected) {
    for (const file of plan.files) {
      onProgress?.({ phase: 'rewrite', total, done, id: plan.id, label: plan.title ?? plan.id })
      done++
      const buf = readFileSync(file.path)
      const result = relocateSessionPaths(buf, {
        from: file.from,
        to: file.to,
        decodeAll,
        ...(compressFrame === undefined ? {} : { compressFrame }),
      })
      if (result.unchanged) continue
      const tmp = `${file.path}.dsh-session-manager.tmp`
      writeFileSync(tmp, result.buffer)
      // 复验：落盘前那一份必须能解出来，且再规划一遍一条都不用改。
      const written = decodeAll(readFileSync(tmp))
      const again = relocateSessionPathsText(written, { from: file.from, to: file.to })
      if (again.rewritten !== 0 || again.unmapped.length > 0 || again.nextHeader.cwd !== file.to) {
        throw new Error(`repair verification failed for ${file.path}: still needs ${again.rewritten} rewrite(s)`)
      }
      renameSync(tmp, file.path)
      files++
      events += result.rewritten
    }
  }
  return { ...(backupDir === undefined ? {} : { backupDir }), files, events, problems }
}
