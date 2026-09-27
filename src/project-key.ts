// src/project-key.ts — 逐字符复刻宿主 dsh-session-persistence-jsonl 的 projectKey()。
//
// 会话日志的目录名由「header.cwd 的 projectKey」决定，而持久化层在加载时会校验
// 「日志所在目录 == projectKey(header.cwd)」，不一致即抛
// `corrupt session log ... header id and cwd identify ...`（硬失败，非降级）。
// 因此这个编码必须与宿主逐字节一致——任何"差不多的字符串替换"都会让会话不可加载。
//
// 宿主的编码规则（src/index.ts 的 projectKey）：
//   - '/'、'\\'、':' → '-'，且**连续分隔符折叠成一个**（separatorRun 去抖）
//   - [A-Za-z0-9._-] 之外的字符（含 CJK、'~'）→ '~' + 4 位以上大写十六进制码元
//   - 去掉开头所有 '-'
//   - 截断到 251 字符
//   - 包裹为 --<key>--
//
// 已知有损点：分隔符折叠 + 截断。两个不同的 cwd 可能编码出同一个目录名，
// 宿主自己的 realpath 唯一性检查抓不到，见 detectProjectKeyCollision()。

const SAFE = /^[A-Za-z0-9._-]$/

/**
 * 复刻宿主的项目目录键。
 * @param cwd 会话的工作目录（绝对路径）。
 * @returns 形如 `--C-Users-me-proj--` 的目录名。
 * @throws 当 cwd 为空字符串（宿主同样抛错）。
 */
export function projectKey(cwd: string): string {
  const s = String(cwd ?? '')
  if (s.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && SAFE.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** 无 cwd 的会话落在该目录（宿主 projectDir 的 undefined 分支）。 */
export const NO_CWD_DIR = '_no-cwd'

/**
 * 检测一组 cwd 里是否出现"不同 cwd → 同一目录名"的碰撞。
 *
 * 宿主用 realpath 保证 workspace 路径唯一，但目录名编码是有损的，
 * 碰撞会让两个工作区的会话日志挤进同一个目录树。
 *
 * @param cwds 待检测的 cwd 列表。
 * @returns 碰撞列表，无碰撞为空数组。
 */
export function detectProjectKeyCollision(
  cwds: readonly string[],
): Array<{ key: string; cwds: string[] }> {
  const byKey = new Map<string, Set<string>>()
  for (const cwd of cwds) {
    const key = projectKey(cwd)
    let set = byKey.get(key)
    if (!set) {
      set = new Set()
      byKey.set(key, set)
    }
    set.add(String(cwd))
  }
  const out: Array<{ key: string; cwds: string[] }> = []
  for (const [key, set] of byKey) {
    if (set.size > 1) out.push({ key, cwds: [...set] })
  }
  return out
}
