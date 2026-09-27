// src/journal.ts — 字节级备份与回滚。
//
// 备份是**执行前**的快照，也是回滚的唯一依据：manifest 记录每个会话的原目录、
// 目标目录与日志文件，回滚 = 目录搬回 + 文件字节还原 + 注册表还原。
// 因为备份发生在改写之前，所以它同时是"原状"与"回滚源"，无需第二份副本。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { SessionMove } from './types.ts'

const MANIFEST = 'manifest.json'

/** 时间戳目录名（Windows 文件名安全）。 */
export function stampName(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** 备份清单里的一条会话记录。 */
export interface BackupSessionEntry {
  id: string
  dirName: string
  sourceBucket: string
  sourceDir: string
  targetDir: string
  files: string[]
}

/** 备份清单里的一条产物记录。 */
export interface BackupArtifactEntry {
  sourcePath: string
  targetPath: string
  isDir: boolean
  backupPath: string
}

/** 备份清单。 */
export interface BackupManifest {
  version: number
  createdAt: string
  registryPath: string
  registryBackup: string
  /** 这次迁移的源/目标工作区目录（后加的字段，老备份没有）。 */
  from?: string
  to?: string
  sessions: BackupSessionEntry[]
  artifacts: BackupArtifactEntry[]
}

/** `createBackup()` 的选项。 */
export interface CreateBackupOptions {
  /** 备份根目录（会创建）。 */
  backupRoot: string
  /** workspace.json 路径。 */
  registryPath: string
  /** 计划中的会话（需含 sourceDir / targetDir / files）。 */
  sessions: ReadonlyArray<Pick<SessionMove, 'id' | 'sourceDir' | 'targetDir' | 'files'>>
  /** 计划搬迁的会话产物。 */
  artifacts?: ReadonlyArray<Pick<BackupArtifactEntry, 'sourcePath' | 'targetPath' | 'isDir'>>
  /** 本次迁移的源工作区目录，写进清单便于界面展示。 */
  from?: string
  /** 本次迁移的目标工作区目录，写进清单便于界面展示。 */
  to?: string
  /** 注入时间，便于测试。 */
  now?: Date
}

/**
 * 为一次执行建立备份。
 */
export function createBackup(options: CreateBackupOptions): {
  dir: string
  manifestPath: string
  manifest: BackupManifest
} {
  const { backupRoot, registryPath, sessions, artifacts = [], from, to, now = new Date() } = options
  const dir = join(backupRoot, stampName(now))
  mkdirSync(join(dir, 'sessions'), { recursive: true })

  const registryBackup = join(dir, 'registry.json')
  cpSync(registryPath, registryBackup)

  const entries: BackupSessionEntry[] = []
  for (const s of sessions) {
    const bucketName = basename(dirname(s.sourceDir))
    const dest = join(dir, 'sessions', bucketName, basename(s.sourceDir))
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(s.sourceDir, dest, { recursive: true })
    entries.push({
      id: s.id,
      dirName: basename(s.sourceDir),
      sourceBucket: bucketName,
      sourceDir: s.sourceDir,
      targetDir: s.targetDir,
      files: s.files.map((f) => f.name),
    })
  }

  // 产物备份：逐个复制到 backup/artifacts/<n>/，清单记录原位与目标位
  const artifactEntries: BackupArtifactEntry[] = []
  for (let i = 0; i < artifacts.length; i++) {
    const a = artifacts[i]
    if (!a) continue
    const backupPath = join(dir, 'artifacts', String(i), basename(a.sourcePath))
    mkdirSync(dirname(backupPath), { recursive: true })
    if (existsSync(a.sourcePath)) cpSync(a.sourcePath, backupPath, { recursive: true })
    artifactEntries.push({ sourcePath: a.sourcePath, targetPath: a.targetPath, isDir: !!a.isDir, backupPath })
  }

  const manifest: BackupManifest = {
    version: 1,
    createdAt: now.toISOString(),
    registryPath,
    registryBackup,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    sessions: entries,
    artifacts: artifactEntries,
  }
  const manifestPath = join(dir, MANIFEST)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { dir, manifestPath, manifest }
}

/** 读取一份备份清单。 */
export function readManifest(dir: string): { manifest: BackupManifest; manifestPath: string } {
  const manifestPath = join(dir, MANIFEST)
  return { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest, manifestPath }
}

/** 回滚结果。 */
export interface RollbackResult {
  actions: string[]
  restoredFiles: number
  restoredArtifacts: number
  registryRestored: boolean
  dryRun: boolean
}

/**
 * 回滚一次执行。
 *
 * 顺序有意为之（离线场景下不应留下"注册表指向新位置、日志还在旧位置"的中间态过长）：
 *   1. 目录搬回原位（此时文件内容仍是改写后的）
 *   2. 用备份逐文件字节还原（撤销 cwd 改写）
 *   3. 会话产物搬回
 *   4. 还原注册表
 */
export function rollback(
  manifest: BackupManifest,
  options: { backupDir: string; dryRun?: boolean },
): RollbackResult {
  const { backupDir, dryRun = false } = options
  if (!backupDir) throw new Error('rollback requires backupDir')
  const actions: string[] = []
  let restoredFiles = 0

  for (const s of manifest.sessions) {
    // 1) 目录搬回
    if (existsSync(s.targetDir)) {
      const sourceBucketDir = dirname(s.sourceDir)
      if (!dryRun) mkdirSync(sourceBucketDir, { recursive: true })
      actions.push(`move back: ${s.targetDir} -> ${s.sourceDir}`)
      if (!dryRun) {
        if (existsSync(s.sourceDir)) rmSync(s.sourceDir, { recursive: true, force: true })
        renameSync(s.targetDir, s.sourceDir)
      }
    }
    // 2) 字节还原
    for (const name of s.files) {
      const from = join(backupDir, 'sessions', s.sourceBucket, s.dirName, name)
      const to = join(s.sourceDir, name)
      if (!existsSync(from)) throw new Error(`backup file missing: ${from}`)
      actions.push(`restore bytes: ${to}`)
      if (!dryRun) cpSync(from, to)
      restoredFiles++
    }
  }

  // 3) 会话产物搬回
  let restoredArtifacts = 0
  for (const a of manifest.artifacts ?? []) {
    if (existsSync(a.targetPath)) {
      actions.push(`move artifact back: ${a.targetPath} -> ${a.sourcePath}`)
      if (!dryRun) {
        mkdirSync(dirname(a.sourcePath), { recursive: true })
        if (existsSync(a.sourcePath)) rmSync(a.sourcePath, { recursive: true, force: true })
        renameSync(a.targetPath, a.sourcePath)
      }
      restoredArtifacts++
    } else if (a.backupPath && existsSync(a.backupPath)) {
      actions.push(`restore artifact from backup: ${a.sourcePath}`)
      if (!dryRun) {
        mkdirSync(dirname(a.sourcePath), { recursive: true })
        cpSync(a.backupPath, a.sourcePath, { recursive: true })
      }
      restoredArtifacts++
    }
  }

  // 3.5) 空掉的目标桶顺手删掉：apply 在源桶空了时会删（execute.ts 第 5 步），回滚不对称地做
  // 就会在会话根下留下一个空目录。只删**确认为空**的目录。
  const emptied = new Set(manifest.sessions.map((s) => dirname(s.targetDir)))
  for (const bucket of emptied) {
    if (!existsSync(bucket)) continue
    try {
      if (readdirSync(bucket).length > 0) continue
    } catch {
      continue
    }
    actions.push(`remove empty bucket: ${bucket}`)
    if (!dryRun) rmdirSync(bucket)
  }

  // 4) 注册表
  if (manifest.registryBackup && existsSync(manifest.registryBackup)) {
    actions.push(`restore registry: ${manifest.registryPath}`)
    if (!dryRun) cpSync(manifest.registryBackup, manifest.registryPath)
  }

  return { actions, restoredFiles, restoredArtifacts, registryRestored: true, dryRun }
}
