// src/scan-cache.ts — 库没变时直接返回上一次的扫描结果（零 DSH 依赖）。
//
// 为什么需要它：`GET /state` 是这一页每次打开、每次刷新都要走的一步，而它每次都要把整个会话库走一遍、
// 读每条会话的日志头、再取每条会话的投影记录。库在一分钟里通常一点没变（用户只是切了个页签回来），
// 这一遍就全是白花。
//
// 判据是**指纹**：这次走目录得到的"有哪些会话目录、每个目录里有哪些日志、每个文件多大、什么时候改的"
// 与上一次一字不差，就直接交上一次的结果。为什么是这几样：
//
//   - `mtimeMs` 是必须的那一枚。实测把一份日志原样写回（字节完全一样），`size` 不变、inode 不变，
//     只有 `mtimeMs` 变了——所以「大小 + inode」不足以当判据。
//   - 目录清单也在指纹里：新增 / 删除一条会话不改任何已有文件的 `mtime`。
//   - 投影缓存文件也在指纹里：标题、空白判据与两枚活动时间是从那些文件读出来的，它们变了结果就得重算。
//     没有它，宿主给一条会话写了新标题之后这里会说"没变"。
//
// 一个绕不开的坑：文件系统的时间戳精度。本机 `mtimeMs` 是亚毫秒，但换成只有一秒精度的文件系统时，
// "同一秒里改两次、大小又一样"这件事指纹看不出来。做法照 git 的 racy 处理：**上一个指纹是在哪一刻取的**
// 也存下来，这次只要有任何文件的 `mtimeMs` 落在那一刻前 `RACY_WINDOW_MS` 以内，就不复用缓存——那种文件
// 有可能在我们上一次取指纹之后又被写过、而时间戳恰好落回同一个刻度，指纹分辨不出来。
//
// 判据用"上一次取指纹的时刻"而不是"现在"：库静止时文件的时间戳早已比那一刻更旧，这条不触发；正在被
// 追加的日志本来每次都会改指纹，重扫是应该的。
//
// 什么时候**不**用这份缓存：迁移计划、同步预演与落地都在动作之前重新扫一遍（那几步马上要动磁盘，值得
// 看最新的），只有 `GET /state` 用它。缓存只影响"看到多新"，不影响任何写盘判断。
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { scanAll, type DiscoveredSession, type ScanOptions } from './discovery.ts'
import { parseSessionLogName } from './paths.ts'
import type { DecodeAll } from './types.ts'

/**
 * 文件的 `mtimeMs` 落在扫描开始前这么久以内时，这次不复用缓存。
 *
 * 一秒是照着"某些文件系统只有一秒精度"定的：同一条会话在这一秒里被写过两次、大小又没变，指纹会看不出
 * 区别。宁可多扫一次，也不要交出旧结果。
 */
const RACY_WINDOW_MS = 1000

/** `scan()` 的选项：在扫描选项之上多要一个"投影缓存目录在哪"。 */
export interface ScanCacheOptions extends ScanOptions {
  /**
   * 宿主投影缓存目录（见 paths.projectionCacheDir）。
   *
   * 它的文件是本插件读出来的标题与空白判据的来源，所以要一起进指纹。缺席 = 这次结果与那些文件无关。
   */
  projectionDir?: string
}

/** 上一次的结果与它对应的指纹。 */
interface Entry {
  /** `root` 与投影缓存目录拼起来的键：配置改了库就不该复用。 */
  readonly key: string
  readonly fingerprint: string
  /** 这份指纹是哪一刻取的（毫秒）：下一次判断"有文件可能被改过而指纹看不出来"要用它。 */
  readonly observedAt: number
  readonly sessions: readonly DiscoveredSession[]
}

/** 一次扫描的入口：库没变就复用上一次的结果。 */
export interface ScanCache {
  /**
   * 扫一遍库（或者直接交出上一次的结果）。
   *
   * @param root 会话库根。
   * @param decodeAll 解码器。
   * @param options 扫描选项；`projectionDir` 参与指纹。
   * @returns 会话数组（按 createdAt 降序，与 `scanAll()` 一致）。命中缓存时返回的是同一批会话对象的
   *   副本数组——调用方别改里面的会话（改了会污染下一份结果）。
   */
  scan(root: string, decodeAll: DecodeAll, options?: ScanCacheOptions): DiscoveredSession[]
}

/** 目录读不动就当它不存在（与 `scanAll()` 同一个口径：坏目录不该让整页打不开）。 */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 是不是目录（读不动按"不是"处理）。 */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 走一遍会话库，收"有哪些项目目录、会话目录、日志文件，以及每个日志的 size 与 mtime"。
 *
 * @param root 会话库根。
 * @param observedAt 上一个指纹是哪一刻取的；`undefined` 表示没有上一次（这次一定会重扫，不必判 racy）。
 * @param out 指纹片段的容器。
 * @returns 有文件的时间戳可能"看不出被改过"时为 true。
 */
function collectLibrary(root: string, observedAt: number | undefined, out: string[]): boolean {
  let racy = false
  for (const projectName of readdirSafe(root)) {
    const projectPath = join(root, projectName)
    if (!isDir(projectPath)) continue
    out.push(`p:${projectName}`)
    for (const dirName of readdirSafe(projectPath)) {
      const sessionPath = join(projectPath, dirName)
      if (!isDir(sessionPath)) continue
      out.push(`s:${projectName}/${dirName}`)
      for (const fileName of readdirSafe(sessionPath)) {
        // 只认日志文件：伴生文件与临时文件不参与扫描结果，也就不该让缓存失效。
        if (parseSessionLogName(fileName) === undefined) continue
        const path = join(sessionPath, fileName)
        let stamp: string
        try {
          const stat = statSync(path)
          stamp = `${stat.size}:${stat.mtimeMs}`
          if (observedAt !== undefined && stat.mtimeMs >= observedAt - RACY_WINDOW_MS) racy = true
        } catch {
          continue
        }
        out.push(`f:${projectName}/${dirName}/${fileName}:${stamp}`)
      }
    }
  }
  return racy
}

/**
 * 走一遍投影缓存目录（一层平铺的文件）。
 *
 * @param dir 缓存目录；缺席时什么都不做。
 * @param observedAt 上一个指纹是哪一刻取的；`undefined` 表示没有上一次。
 * @param out 指纹片段的容器。
 * @returns 有文件的时间戳可能"看不出被改过"时为 true。
 */
function collectProjections(dir: string | undefined, observedAt: number | undefined, out: string[]): boolean {
  if (dir === undefined) return false
  let racy = false
  for (const name of readdirSafe(dir)) {
    let stat
    try {
      stat = statSync(join(dir, name))
    } catch {
      // 读不到的文件不该让整次扫描失败：它已经不在指纹里，下一次也还是不在。
      continue
    }
    out.push(`c:${name}:${stat.size}:${stat.mtimeMs}`)
    if (observedAt !== undefined && stat.mtimeMs >= observedAt - RACY_WINDOW_MS) racy = true
  }
  return racy
}

/**
 * 造一份扫描缓存。
 *
 * 只留**一份**结果：这个插件的配置里只有一个会话库，留一份就够；换成另一种配置（根或投影缓存目录变了）
 * 时键对不上，自然重扫。
 *
 * @returns 扫描入口。
 */
export function createScanCache(): ScanCache {
  let entry: Entry | undefined
  return {
    scan(root, decodeAll, options = {}) {
      const key = `${root}\u0000${options.projectionDir ?? ''}`
      const previous = entry !== undefined && entry.key === key ? entry : undefined
      const observedAt = Date.now()
      const stamps: string[] = []
      // 两段都要走完：`|` 不能短路，否则投影缓存那段的时间戳就白算了。
      const racyLibrary = collectLibrary(root, previous?.observedAt, stamps)
      const racyProjections = collectProjections(options.projectionDir, previous?.observedAt, stamps)
      const fingerprint = stamps.join('\n')
      if (previous !== undefined && previous.fingerprint === fingerprint && !racyLibrary && !racyProjections) {
        return [...previous.sessions]
      }
      const sessions = scanAll(root, decodeAll, options)
      entry = { key, fingerprint, observedAt, sessions }
      return sessions
    },
  }
}
