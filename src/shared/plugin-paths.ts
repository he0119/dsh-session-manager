// 插件自己的目录：DSH 家目录、默认备份根，以及旧默认根的一次性搬迁。
//
// 为什么单独一层：这三个位置是**对外的默认值**（备份清单只读 `backupRoot` 一个根，`assertBackupDir()` 也只认
// 它下面的路径），工具、界面端点与测试必须算同一份；它们又不属于任何一种操作的流程，所以放在 shared 里。
//
// @module dsh-session-manager/shared/plugin-paths
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PluginConfigInput } from '../config.ts'

/** 解析后的默认路径。 */
export interface ResolvedPaths {
  sessionsRoot: string
  registryPath: string
  backupRoot: string
}

/** DSH 家目录：`$DSH_HOME`，缺席时退到 `~/.dsh`。 */
export function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

/** 默认备份根：`<DSH_HOME>/dsh-session-manager/backups`。 */
function defaultBackupRoot(home: string): string {
  return join(home, 'dsh-session-manager', 'backups')
}

/**
 * 旧版默认备份根：`<DSH_HOME>/dsh-session-manager-backups`（0.3.x 及更早用的那层平铺名字）。
 *
 * 只有 {@link adoptLegacyBackupRoot} 还读它，新代码别再往这里写。
 */
function legacyBackupRoot(home: string): string {
  return join(home, 'dsh-session-manager-backups')
}

/** 从插件配置与 $DSH_HOME 解析默认路径。 */
export function resolvePaths(config: PluginConfigInput = {}): ResolvedPaths {
  const home = dshHome()
  return {
    sessionsRoot: config.sessionsRoot ?? join(home, 'sessions'),
    registryPath: config.registryPath ?? join(home, 'storages', 'workspace.json'),
    backupRoot: config.backupRoot ?? defaultBackupRoot(home),
  }
}

/** 旧默认备份根的一次性搬迁结果。 */
export interface LegacyBackupAdoption {
  /** 旧位置。 */
  from: string
  /** 新位置（搬成功时旧位置已经不在）。 */
  to: string
  /** 搬成功为 true；没搬成时两个路径都不动，`error` 说明原因。 */
  ok: boolean
  error?: string
}

/**
 * 把旧默认备份根整体搬进插件目录。
 *
 * 默认备份根从 `<DSH_HOME>/dsh-session-manager-backups` 改成
 * `<DSH_HOME>/dsh-session-manager/backups`——与 `dsh-config-manager/snapshots` 那种"插件名 / 子目录"
 * 同一形状，别人的 `$DSH_HOME` 根下不再多出一层只属于某个插件的平铺名字。旧备份不能就这么留在原地：
 * 清单只读 `backupRoot` 一个根，而 `src/operations/migrate/migrate.ts` 的 `assertBackupDir()` 只认备份根下的路径——留下的
 * 旧备份既列不出来，也没法按路径回滚（等于把已经写好的回退凭据锁在门外）。
 *
 * 三个条件同时成立才动：用户没自己配 `backupRoot`（配了就按他说的来）、旧目录在、新目录不在。整个
 * rename 在同一个 `$DSH_HOME` 下是原子的；搬不动就原样留着并如实报错——备份是回滚的唯一凭据，宁可
 * 不搬，也不能搬一半。
 *
 * @param config 插件配置。
 * @returns 发生了搬迁（或搬迁失败）时的结果；没什么可搬就是 undefined。
 */
export function adoptLegacyBackupRoot(config: PluginConfigInput = {}): LegacyBackupAdoption | undefined {
  if ((config.backupRoot ?? '').trim() !== '') return undefined
  const home = dshHome()
  const from = legacyBackupRoot(home)
  const to = defaultBackupRoot(home)
  if (!existsSync(from) || existsSync(to)) return undefined
  try {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    return { from, to, ok: true }
  } catch (error) {
    return { from, to, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
