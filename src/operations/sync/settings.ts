// 同步设置的归一：配置里那一节（`SyncConfig`）到运行时认的那一份，以及映射表的拼写归一。
//
// @module dsh-session-manager/operations/sync/settings

import type { AutoConfig } from '../../config.ts'
import { encodeSegment } from '../../shared/paths.ts'
import { machineDirName } from './index.ts'
import { SYNC_ATTACHMENTS_DIR } from './attachments.ts'

/** 解析后的同步设置（配置里的原始形态见 tools.ts 的 `SyncConfig`）。 */
export interface SyncSettings {
  /** 远端资源根（WebDAV 集合）。 */
  url: string
  /** 这台机器的标识（也是它在远端占的那一格的目录名）。 */
  machineId: string
  /** 显式映射：远端 `cwd` → 这台机器上的目录。 */
  mapping: Record<string, string>
  username?: string
  password?: string
  timeoutMs?: number
  /**
   * 自动那一档（关 / 只推 / 双向）。
   *
   * 拍平在 `src/config.ts` 的 `autoPushSection()` 一处，这里是它的解析形态；缺席 = 这个宿主没开
   * （`runAutoPush()` 据此直接报 `skip: 'disabled'`）。**开关与模式**都在这一份里，调度器因此不必自己
   * 去读配置。
   */
  autoPush?: AutoConfig
}

/** 映射表归一化结果。 */
export interface NormalizedMapping {
  mapping: Map<string, string>
  problems: string[]
}

/**
 * 归一化映射表。
 *
 * 归一化只做一件事：去掉结尾分隔符（`/a/b/` 与 `/a/b` 是同一个目录）。**不做**大小写折叠——
 * Windows 上大小写差异由使用者自己对齐，猜错了会把会话落到一个不是他要的目录里。
 * @param raw 配置里的映射表。
 * @returns 归一化后的映射与它的问题（空键、空值、归一化后重复）。
 */
export function normalizeMapping(raw: Record<string, string> | undefined): NormalizedMapping {
  const mapping = new Map<string, string>()
  const problems: string[] = []
  for (const [from, to] of Object.entries(raw ?? {})) {
    const key = String(from).trim().replace(/(.)\/+$/, '$1')
    const value = String(to).trim().replace(/(.)\/+$/, '$1')
    if (key === '') {
      problems.push('同步映射里有一条空的来源路径（远端 cwd）')
      continue
    }
    if (value === '') {
      problems.push(`同步映射 ${key} 的目标是空路径`)
      continue
    }
    if (mapping.has(key)) {
      problems.push(`同步映射里 ${key} 出现了两次（去掉结尾斜杠之后重名）`)
      continue
    }
    mapping.set(key, value)
  }
  return { mapping, problems }
}

/**
 * 这台机器的格子名有没有撞上共享对象库那个保留名。
 *
 * `attachments` 这个名字被共享对象库占了（`SYNC_ATTACHMENTS_DIR`，与机器格同级），而列机器格时只按
 * 目录名筛。一台真的叫 `attachments` 的机器，它那一格会被**所有别的机器**跳过：索引读不到、一条会话都
 * 同步不出去，而它自己那一侧一切正常。静默失败比报错难查得多，所以这里明说一句。
 *
 * 为什么不换个撞不上的名字：机器格名是 `encodeSegment(machineId)` 的结果，字母数字加 `._-~`，任何合法
 * 段名都可能被某台机器的标识算出来，没有"不可能撞上"的保留名可选。改名会掀掉远端已有的布局。
 *
 * @param machineId 配置里的机器标识（缺省主机名）。
 * @returns 撞上了就是一句给人看的问题说明；没撞上 `undefined`。
 */
export function reservedMachineIdProblem(machineId: string): string | undefined {
  if (machineDirName(machineId) !== SYNC_ATTACHMENTS_DIR) return undefined
  return `机器标识不能叫 ${SYNC_ATTACHMENTS_DIR}：这个名字留给远端共享的附件对象库了（改 sync.machineId）`
}
