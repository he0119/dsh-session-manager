// src/migrate.ts — 迁移的宿主侧编排：预演 / 执行 / 回滚 / 备份清单。
//
// 为什么单独一层：同一套动作有**两个入口**（模型工具、设置里的界面）。编排只写一遍，
// 各入口只负责把结果翻译成自己的形状——否则"工具说会这样、界面说会那样"迟早会发生。
// 本模块保持**零 DSH 依赖**（不 import cordis / dsh-tools），因此测试可以直接用它。
//
// 计划仍然是一等产物：预演与执行走同一个 `buildRelocationPlan()`，界面看到的预演结果就是
// 执行时会做的事；回滚只依据备份清单，不认识计划。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { applyPlan, verifyAppliedPlan } from './execute.ts'
import { readManifest, rollback, type BackupManifest, type RollbackResult } from './journal.ts'
import { buildRelocationPlan, describePlan } from './plan.ts'
import { readRegistry, validateRegistry } from './registry.ts'
import type { TitleQuery } from './session-title.ts'
import type { DecodeAll, RelocationPlan, RegistryChange, WorkspaceRegistryState } from './types.ts'

/** 迁移用到的路径与解码器（与 `ResolvedPaths` 同形，但本模块不认识 tools.ts）。 */
export interface MigrateDeps {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
  decodeAll: DecodeAll
  /**
   * 读会话标题（可选）：预演结果里带上它，界面挑会话时按标题认人（见 session-title.ts）。
   * 缺席就不读——工具层只报数量，不需要。
   */
  resolveTitle?: (query: TitleQuery) => string | undefined
}

/** 一次迁移/预演的请求。 */
export interface MigrateRequest {
  /** 源工作区目录（绝对路径）。`unowned` 为 true 时可省略（那时源不是一个目录）。 */
  from?: string
  /** 目标工作区目录（绝对路径，必须已存在）。 */
  to: string
  /**
   * 源取"注册表没认领且有 cwd 的会话"（外壳侧边栏的「未分组」），而不是某个目录。
   * 可以横跨多个项目目录，所以与 `from` 互斥。
   */
  unowned?: boolean
  /** 只迁移这些会话；缺省（null）为源项目目录内全部。 */
  sessionIds?: string[] | null
  /** 目标工作区新建时的标题。 */
  title?: string
  /** 是否连带未登记在册的会话（默认 true）。 */
  includeUnowned?: boolean
  /** 是否同时搬迁会话创建过的文件（默认 false）。 */
  includeArtifacts?: boolean
}

/** 预演里的一条会话。 */
export interface PreviewSession {
  id: string
  /** 折叠出的标题；读不到就没有（见 session-title.ts）。界面靠它认会话，id 退到悬浮提示。 */
  title?: string
  createdAt: number
  registered: boolean
  alreadyAtTarget: boolean
  sourceDir: string
  targetDir: string
  files: number
  bytes: number
}

/** 预演结果：界面与工具读的是同一份。 */
export interface MigrationPreview {
  ok: boolean
  problems: string[]
  /** 源工作区目录；未分组来源时是空串（见 `unowned`）。 */
  from: string
  to: string
  /** 源项目目录；未分组来源时是空串（源不是一个目录）。 */
  sourceProjectDir: string
  targetProjectDir: string
  /** 源是不是那个跨目录的「未分组」（界面据此换一句项目目录说明）。 */
  unowned: boolean
  /** 本次真正会搬动的会话各自所在的源项目目录（去重、排序）——未分组来源下不止一个。 */
  sourceProjectDirs: string[]
  sessions: PreviewSession[]
  files: number
  bytes: number
  artifacts: {
    moves: number
    problems: string[]
    skipped: Array<{ path: string; reason: string; sessionId?: string }>
  } | null
  registryChange: RegistryChange | null
  /** 给人看的整段描述（`describePlan()`）；界面也可以只用上面的结构化字段。 */
  summary: string
}

/** 执行结果。 */
export interface MigrationRun {
  /** 是否真的写了盘（dry-run 或不 ok 都是 false）。 */
  applied: boolean
  preview: MigrationPreview
  rewritten: number
  moved: number
  artifactsMoved: number
  verified: boolean
  backupDir?: string
  /** 复核发现的问题（空数组 = 通过）。 */
  problems: string[]
  summary: string
}

/** 回滚结果。 */
export interface RollbackOutcome extends RollbackResult {
  backupDir: string
  createdAt: string
  sessions: number
  artifacts: number
}

/** 备份清单里的一条（界面的"备份与回滚"列表用）。 */
export interface BackupSummary {
  dir: string
  createdAt: string
  sessions: number
  artifacts: number
  /** 从清单里的会话目录推出来的源/目标（老备份可能没有会话，则为 undefined）。 */
  from?: string
  to?: string
}

/**
 * 读注册表并要求它满足启动不变式。
 *
 * 迁移与回滚都会改注册表，所以这里宁可拒绝，也不在一个已经坏掉的注册表上叠加改动。
 * @throws 注册表读不到或不满足不变式时抛错（带具体问题）。
 */
export function loadRegistryForWrite(registryPath: string): WorkspaceRegistryState {
  const registry = readRegistry(registryPath)
  const check = validateRegistry(registry)
  if (!check.ok) throw new Error(`workspace 注册表不满足启动不变式，拒绝操作：${check.problems.join('; ')}`)
  return registry
}

function previewOf(plan: RelocationPlan): MigrationPreview {
  let files = 0
  let bytes = 0
  const sessions: PreviewSession[] = plan.sessions.map((session) => {
    const sessionBytes = session.files.reduce((sum, file) => sum + file.bytes, 0)
    files += session.files.length
    bytes += sessionBytes
    return {
      id: session.id,
      ...(session.title === undefined ? {} : { title: session.title }),
      createdAt: session.createdAt,
      registered: session.registered,
      alreadyAtTarget: session.alreadyAtTarget,
      sourceDir: session.sourceDir,
      targetDir: session.targetDir,
      files: session.files.length,
      bytes: sessionBytes,
    }
  })
  return {
    ok: plan.ok,
    problems: plan.problems,
    from: plan.from,
    to: plan.to,
    sourceProjectDir: plan.sourceProjectDir,
    targetProjectDir: plan.targetProjectDir,
    unowned: plan.unowned,
    // 未分组来源横跨多个项目目录：把每条会话自己的源项目目录去重报给界面，别让界面拿一个空串去猜。
    sourceProjectDirs: [...new Set(plan.sessions.map((session) => dirname(session.sourceDir)))].sort(),
    sessions,
    files,
    bytes,
    artifacts: plan.artifacts
      ? { moves: plan.artifacts.moves.length, problems: plan.artifacts.problems, skipped: plan.artifacts.skipped }
      : null,
    registryChange: plan.registryChange,
    summary: describePlan(plan),
  }
}

function buildPlan(deps: MigrateDeps, request: MigrateRequest): RelocationPlan {
  return buildRelocationPlan({
    root: deps.sessionsRoot,
    registry: loadRegistryForWrite(deps.registryPath),
    from: request.from ?? '',
    to: request.to,
    decodeAll: deps.decodeAll,
    unowned: request.unowned === true,
    sessionIds: request.sessionIds ?? null,
    title: request.title,
    includeUnowned: request.includeUnowned !== false,
    includeArtifacts: request.includeArtifacts === true,
    ...(deps.resolveTitle === undefined ? {} : { resolveTitle: deps.resolveTitle }),
  })
}

/** 只读预演：算出"将会发生什么"，不写任何字节。 */
export function previewMigration(deps: MigrateDeps, request: MigrateRequest): MigrationPreview {
  return previewOf(buildPlan(deps, request))
}

/**
 * 执行（或只做 dry-run）。
 *
 * `apply: false` 时只返回预演，一个字节都不写——工具层与界面层的"预演"都走这里，
 * 因此不存在"预览一套、实做另一套"。
 */
export function runMigration(deps: MigrateDeps, request: MigrateRequest, options: { apply: boolean }): MigrationRun {
  const plan = buildPlan(deps, request)
  const preview = previewOf(plan)
  if (!plan.ok) {
    return {
      applied: false,
      preview,
      rewritten: 0,
      moved: 0,
      artifactsMoved: 0,
      verified: false,
      problems: plan.problems,
      summary: preview.summary,
    }
  }
  if (!options.apply) {
    return {
      applied: false,
      preview,
      rewritten: 0,
      moved: 0,
      artifactsMoved: 0,
      verified: false,
      problems: [],
      summary: preview.summary,
    }
  }

  const result = applyPlan(plan, {
    registryPath: deps.registryPath,
    decodeAll: deps.decodeAll,
    backupRoot: deps.backupRoot,
  })
  const verified = verifyAppliedPlan(plan, { decodeAll: deps.decodeAll })
  return {
    applied: true,
    preview,
    rewritten: result.rewritten,
    moved: result.moved,
    artifactsMoved: result.artifactsMoved,
    verified: verified.ok,
    backupDir: result.backupDir,
    problems: verified.problems,
    summary:
      `已迁移 ${plan.sessions.length} 个会话（改写 ${result.rewritten} 个日志、移动 ${result.moved} 个目录` +
      `${result.artifactsMoved > 0 ? `、搬迁 ${result.artifactsMoved} 项产物` : ''}）。\n` +
      `复核：${verified.ok ? '通过' : '失败'}。备份：${result.backupDir}`,
  }
}

/**
 * 备份目录必须落在本插件的备份根下。
 *
 * 回滚会按清单里的路径搬目录、写注册表，等于"以清单为准的任意写"。界面能传的字符串不该
 * 换来这种权力，所以只认自己写过的那棵子树——越界一律拒绝，而不是"反正本地可信"。
 */
export function assertBackupDir(deps: Pick<MigrateDeps, 'backupRoot'>, backupDir: unknown): string {
  if (typeof backupDir !== 'string' || backupDir.trim() === '') throw new Error('缺少备份目录（backupDir）')
  const root = resolve(deps.backupRoot)
  const dir = resolve(backupDir.trim())
  const inside = relative(root, dir)
  if (inside === '' || inside.startsWith('..') || resolve(root, inside) !== dir) {
    throw new Error(`备份目录不在本插件的备份根下：${dir}（备份根 ${root}）`)
  }
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`这个目录里没有 manifest.json：${dir}`)
  return dir
}

/** 读一份备份清单（目录先经过越界检查）。 */
export function readBackup(deps: Pick<MigrateDeps, 'backupRoot'>, backupDir: unknown): { dir: string; manifest: BackupManifest } {
  const dir = assertBackupDir(deps, backupDir)
  return { dir, manifest: readManifest(dir).manifest }
}

/**
 * 回滚一次迁移。
 *
 * `dryRun: true` 只回一份动作清单（界面据此让用户先看清再确认），不写任何字节。
 */
export function rollbackMigration(
  deps: Pick<MigrateDeps, 'backupRoot'>,
  request: { backupDir: string; dryRun?: boolean },
): RollbackOutcome {
  const { dir, manifest } = readBackup(deps, request.backupDir)
  const result = rollback(manifest, { backupDir: dir, dryRun: request.dryRun === true })
  return {
    ...result,
    backupDir: dir,
    createdAt: manifest.createdAt,
    sessions: manifest.sessions.length,
    artifacts: (manifest.artifacts ?? []).length,
  }
}

/** 列出备份根下的全部备份（坏掉的目录跳过，不让一条坏清单挡住列表）。 */
export function listBackups(deps: Pick<MigrateDeps, 'backupRoot'>): BackupSummary[] {
  let entries: string[]
  try {
    entries = readdirSync(deps.backupRoot)
  } catch {
    return []
  }
  const out: BackupSummary[] = []
  for (const name of entries) {
    const dir = join(deps.backupRoot, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const { manifest } = readManifest(dir)
      out.push({
        dir,
        createdAt: manifest.createdAt,
        sessions: manifest.sessions.length,
        artifacts: (manifest.artifacts ?? []).length,
        ...(manifest.from === undefined ? {} : { from: manifest.from }),
        ...(manifest.to === undefined ? {} : { to: manifest.to }),
      })
    } catch {
      continue
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  return out
}
