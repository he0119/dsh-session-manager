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

/**
 * 这份备份是哪一类操作留下的。
 *
 * `migrate`：会话从 A 目录搬到 B 目录（备份里那份是"原状"，回滚 = 搬回去 + 还原字节）。
 * `delete`：会话被删掉（备份里那份是**唯一一份**，回滚 = 把它搬回原位）。
 *
 * 两者的差别不是文案：`delete` 的会话记录里 `targetDir` 指向备份目录内的那份副本，于是回滚的第一步
 * （"把目标搬回源"）恰好就是"把备份里的整个会话目录搬回去"；而字节还原那一步要因此容忍"备份里的
 * 文件已经不在了"（它刚被搬走）。老备份没有这个字段，按 `migrate` 处理。
 */
export type BackupKind = 'migrate' | 'delete'

/** 备份清单。 */
export interface BackupManifest {
  version: number
  createdAt: string
  registryPath: string
  registryBackup: string
  /** 这次备份是哪一类操作留下的（老备份没有这个字段 = 迁移）。 */
  kind?: BackupKind
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
  /**
   * 计划中的会话（需含 sourceDir / files）。
   *
   * `targetDir` 只有迁移才需要：删除没有"目标目录"，那时它由本函数填成备份目录内那份副本的路径
   * （见 `BackupKind`）。
   */
  sessions: ReadonlyArray<Pick<SessionMove, 'id' | 'sourceDir' | 'files'> & { targetDir?: string }>
  /** 计划搬迁的会话产物。 */
  artifacts?: ReadonlyArray<Pick<BackupArtifactEntry, 'sourcePath' | 'targetPath' | 'isDir'>>
  /** 这次备份属于哪一类操作（缺省 `migrate`）。 */
  kind?: BackupKind
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
  const { backupRoot, registryPath, sessions, artifacts = [], kind = 'migrate', from, to, now = new Date() } = options
  const dir = join(backupRoot, stampName(now))
  mkdirSync(join(dir, 'sessions'), { recursive: true })

  const registryBackup = join(dir, 'registry.json')
  cpSync(registryPath, registryBackup)

  const entries: BackupSessionEntry[] = []
  for (const s of sessions) {
    const projectDirName = basename(dirname(s.sourceDir))
    const dest = join(dir, 'sessions', projectDirName, basename(s.sourceDir))
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(s.sourceDir, dest, { recursive: true })
    entries.push({
      id: s.id,
      dirName: basename(s.sourceDir),
      sourceDir: s.sourceDir,
      // 删除：备份里那份副本就是"回滚时搬回去的那一份"，所以目标目录记它。
      targetDir: kind === 'delete' ? dest : (s.targetDir ?? s.sourceDir),
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
    kind,
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
 * 顺序有意为之（宿主可能没在跑，中间态不该长时间停在"注册表指向新位置、日志还在旧位置"）：
 *   1. 目录搬回原位（此时文件内容仍是改写后的）
 *   2. 用备份逐文件字节还原（撤销 cwd 改写）
 *   3. 会话产物搬回
 *   4. 还原注册表
 *
 * 「删除」备份（`kind === 'delete'`）复用同一条路，语义是"把备份里那一份搬回原位"：第 1 步就是
 * 整个会话目录的还原（见 `BackupKind`），第 2 步因此可能发现备份里那份已经不在了（刚被第 1 步搬走），
 * 第 4 步按删除的语义跳过。
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
    //
    // 「源目录 == 目标目录」的会话要**跳过这一步**：迁移时它一个字节都没挪（`cwd` 本来就在目标上——
    // 未分组来源下这是常态：那条没人认领的会话本来就住在那个目录里，只是没登记在册，迁移只补了
    // 一条注册表记录）。照搬回去等于"先删掉自己、再把自己改名到自己"，`rmSync` 之后 `renameSync`
    // 必然 ENOENT——丢的是**唯一一份**会话目录。字节还原照做（内容相同，等于一次无害的复写）。
    if (existsSync(s.targetDir) && s.targetDir !== s.sourceDir) {
      const sourceProjectDir = dirname(s.sourceDir)
      if (!dryRun) mkdirSync(sourceProjectDir, { recursive: true })
      actions.push(`move back: ${s.targetDir} -> ${s.sourceDir}`)
      if (!dryRun) {
        if (existsSync(s.sourceDir)) rmSync(s.sourceDir, { recursive: true, force: true })
        renameSync(s.targetDir, s.sourceDir)
      }
    }
    // 2) 字节还原
    for (const name of s.files) {
      // 清单不再存项目目录名（它就是 `sourceDir` 的父目录名），老备份里那个字段直接忽略。
      const from = join(backupDir, 'sessions', basename(dirname(s.sourceDir)), s.dirName, name)
      const to = join(s.sourceDir, name)
      if (!existsSync(from)) {
        // 「删除」备份的恢复路径：第 1 步已经把备份里那整个会话目录搬回原位（它的 `targetDir` 就是
        // 备份内那份副本），于是 `from` 随之不存在——但字节已经在 `to` 上了，这不是"备份坏了"。
        // 只有两边都没有才是真的缺文件，照旧抛错。
        if (existsSync(to)) {
          actions.push(`bytes already in place: ${to}`)
          restoredFiles++
          continue
        }
        throw new Error(`backup file missing: ${from}`)
      }
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

  // 3.5) 空掉的目标项目目录顺手删掉：apply 在源项目目录空了时会删（execute.ts 第 5 步），回滚不对称地做
  // 就会在会话根下留下一个空目录。只删**确认为空**的目录。
  const emptied = new Set(manifest.sessions.map((s) => dirname(s.targetDir)))
  for (const projectDir of emptied) {
    if (!existsSync(projectDir)) continue
    try {
      if (readdirSync(projectDir).length > 0) continue
    } catch {
      continue
    }
    actions.push(`remove empty project directory: ${projectDir}`)
    if (!dryRun) rmdirSync(projectDir)
  }

  // 4) 注册表
  //
  // 「删除」备份恢复**不还原注册表**：删除从头到尾没碰过它（会话的登记、归档、置顶都原地留着），
  // 而备份里的那份快照是删除那一刻的——照搬回去会把"删除之后用户做的其它变更"一起抹掉。
  let registryRestored = false
  if (manifest.kind === 'delete') {
    actions.push(`registry untouched: delete backup (${manifest.registryPath})`)
  } else if (manifest.registryBackup && existsSync(manifest.registryBackup)) {
    actions.push(`restore registry: ${manifest.registryPath}`)
    if (!dryRun) cpSync(manifest.registryBackup, manifest.registryPath)
    registryRestored = true
  }

  return { actions, restoredFiles, restoredArtifacts, registryRestored, dryRun }
}
