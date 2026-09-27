// src/execute.ts — 执行一个已构建并被校验通过的计划。
//
// 步骤顺序（每一步都在前一步成功后才有意义，失败即中断并保留现场用于回滚）：
//   1. 备份（注册表 + 全部受影响会话目录 + 待搬产物，字节级）
//   2. 原地改写各日志首帧的 cwd（临时文件 + rename，成功前不动原文件）
//   3. 把会话目录移入目标分桶
//   4. 原子落盘注册表
//   5. 清理空的源分桶
//   6. 搬迁会话产物（可选）
// 事后可用 verifyAppliedPlan() 独立复核。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { applyArtifactMoves } from './artifacts.ts'
import { createBackup } from './journal.ts'
import { projectKey } from './project-key.ts'
import { validateRegistry, writeRegistryAtomic } from './registry.ts'
import { relocateHeaderCwd } from './session-log.ts'
import type { CompressFrame, DecodeAll, RelocationPlan } from './types.ts'
import { encodeRawFrame } from './zstd-frame.ts'

/** `applyPlan()` 的选项。 */
export interface ApplyOptions {
  registryPath: string
  decodeAll: DecodeAll
  backupRoot: string
  /** 首帧压缩器（缺省手写 raw 帧）。 */
  compressFrame?: CompressFrame
  /** 注入时间，便于测试。 */
  now?: Date
}

/** `applyPlan()` 的结果。 */
export interface ApplyResult {
  backupDir: string
  manifestPath: string
  rewritten: number
  moved: number
  artifactsMoved: number
  registryWritten: boolean
  log: string[]
}

/**
 * 执行计划。
 * @throws 计划的 `ok` 不为 true，或中途校验失败时抛错（不产出半成品状态）。
 */
export function applyPlan(plan: RelocationPlan, options: ApplyOptions): ApplyResult {
  const { registryPath, decodeAll, backupRoot, compressFrame = encodeRawFrame, now = new Date() } = options
  if (!plan.ok) throw new Error(`refusing to apply a plan with problems: ${plan.problems.join('; ')}`)
  if (!plan.nextRegistry) throw new Error('plan has no computed registry change')

  const log: string[] = []
  const say = (s: string): void => {
    log.push(s)
  }
  const artifactMoves = plan.artifacts?.moves ?? []

  // 1) 备份（会话目录 + 待搬产物 + 注册表）
  const backup = createBackup({ backupRoot, registryPath, sessions: plan.sessions, artifacts: artifactMoves, now })
  say(`backup -> ${backup.dir}`)

  // 2) 改写日志（原地）
  let rewritten = 0
  for (const s of plan.sessions) {
    for (const f of s.files) {
      const buf = readFileSync(f.path)
      const r = relocateHeaderCwd(buf, { from: s.from, to: s.to, decodeAll, compressFrame })
      if (r.unchanged) {
        say(`unchanged ${f.name} (${s.id})`)
        continue
      }
      const tmp = `${f.path}.dsh-session-manager.tmp`
      writeFileSync(tmp, r.buffer)
      // 落盘前复验：临时文件必须能解出期望文本
      const expectedHeader = decodeAll(r.buffer).split('\n')[0]
      if (decodeAll(readFileSync(tmp)).split('\n')[0] !== expectedHeader) {
        throw new Error(`temp verification failed for ${f.path}`)
      }
      renameSync(tmp, f.path)
      rewritten++
      say(`rewrote ${basename(f.path)} (${s.id}) events=${r.events} firstFrame=${r.firstFrameBytes}B`)
    }
  }

  // 3) 移动会话目录
  let moved = 0
  for (const s of plan.sessions) {
    if (dirname(s.sourceDir) === dirname(s.targetDir)) {
      say(`already in target bucket: ${basename(s.sourceDir)}`)
      continue
    }
    mkdirSync(plan.targetBucket, { recursive: true })
    if (existsSync(s.targetDir)) throw new Error(`target already exists, refusing to overwrite: ${s.targetDir}`)
    renameSync(s.sourceDir, s.targetDir)
    moved++
    say(`moved ${basename(s.sourceDir)} -> ${projectKey(s.to)}`)
  }

  // 4) 注册表
  const check = validateRegistry(plan.nextRegistry)
  if (!check.ok) throw new Error(`refusing to write an invalid registry: ${check.problems.join('; ')}`)
  writeRegistryAtomic(registryPath, plan.nextRegistry)
  say(`registry written (target workspace ${plan.registryChange?.targetId ?? 'n/a'})`)

  // 5) 清理空桶
  if (existsSync(plan.sourceBucket) && readdirSync(plan.sourceBucket).length === 0) {
    rmdirSync(plan.sourceBucket)
    say(`removed empty bucket ${basename(plan.sourceBucket)}`)
  }

  // 6) 会话产物（可选）
  let artifactsMoved = 0
  if (artifactMoves.length > 0) {
    const r = applyArtifactMoves(artifactMoves)
    artifactsMoved = r.moved + r.copies
    say(`moved ${artifactsMoved} session artifacts (${artifactMoves.length} planned)`)
  }

  writeFileSync(join(backup.dir, 'execution.log'), log.join('\n') + '\n')
  return {
    backupDir: backup.dir,
    manifestPath: backup.manifestPath,
    rewritten,
    moved,
    artifactsMoved,
    registryWritten: true,
    log,
  }
}

/**
 * 独立复核：迁移后每个会话都应满足"文件所在分桶 == projectKey(header.cwd)、header.cwd == 目标"。
 * 这是宿主的 corrupt 判据的等价检查。
 */
export function verifyAppliedPlan(
  plan: RelocationPlan,
  options: { decodeAll: DecodeAll },
): { ok: boolean; problems: string[]; checked: number } {
  const { decodeAll } = options
  const problems: string[] = []
  let checked = 0
  for (const s of plan.sessions) {
    if (!existsSync(s.targetDir)) {
      problems.push(`session ${s.id}: target dir missing ${s.targetDir}`)
      continue
    }
    const expectedBucket = projectKey(s.to)
    if (basename(dirname(s.targetDir)) !== expectedBucket) {
      problems.push(`session ${s.id}: target dir bucket ${basename(dirname(s.targetDir))} != ${expectedBucket}`)
    }
    for (const f of s.files) {
      const path = join(s.targetDir, f.name)
      if (!existsSync(path)) {
        problems.push(`session ${s.id}: log missing ${f.name}`)
        continue
      }
      const header = JSON.parse(decodeAll(readFileSync(path)).split('\n')[0] ?? '{}') as {
        id?: string
        cwd?: string
      }
      if (header.cwd !== s.to) problems.push(`session ${s.id}/${f.name}: header cwd ${header.cwd} != ${s.to}`)
      if (header.id !== s.id) problems.push(`session ${s.id}/${f.name}: header id ${header.id}`)
      // 宿主的 corrupt 判据：日志文件所在**分桶**必须等于 projectKey(header.cwd)。
      // 文件的父目录是会话目录，再上一层才是分桶。
      const fileBucket = basename(dirname(dirname(path)))
      if (header.cwd !== undefined && projectKey(header.cwd) !== fileBucket) {
        problems.push(
          `session ${s.id}/${f.name}: dir/header mismatch (bucket ${fileBucket} != ${projectKey(header.cwd)}; host would report corrupt session log)`,
        )
      }
      checked++
    }
  }
  // 产物：目标位必须存在，源位必须已清空
  for (const m of plan.artifacts?.moves ?? []) {
    if (!existsSync(m.targetPath)) problems.push(`artifact missing at target: ${m.targetPath}`)
    if (existsSync(m.sourcePath)) problems.push(`artifact still at source: ${m.sourcePath}`)
  }
  return { ok: problems.length === 0, problems, checked }
}
