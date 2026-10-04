// src/canonical-path.ts — 落地目录的规范拼写。
//
// 宿主的 workspace 注册表把 `path` 存成 `fs.realpath` 归一之后的样子，会话的成员资格也拿 header 的
// `cwd` 过同一个 realpath 再按**字符串相等**比（`@deepseek-ai/dsh-workspace` 的 `realpathNormalize`
// 与 header 索引）。所以同一个目录的**另一种拼写**在宿主眼里是另一个目录：拿它去建工作区会多出一条
// 谁也不认的记录，而那条记录登记的那些会话因为比对不上而被滤掉——界面上就是一个点了没有内容的工作区。
//
// 这种拼写有一个很具体的来源：Windows 上 `git rev-parse --show-toplevel` 返回 `C:/…`（正斜杠），
// 而宿主存的是 `C:\…`；手输的路径也可能带结尾分隔符、`..` 段或大小写不一致。
//
// 这一层只做一件事：把要落地的目录换成宿主会存的那个字符串。目录不存在或读不动时**原样返回**——
// 那几种情况本来就该由调用方按原来的拼写报"目标目录不存在"，而不是在这里变成一个空串。
import { realpathSync, statSync } from 'node:fs'

/**
 * 把目录归一成宿主认得的拼写。
 *
 * 用 `fs.realpathSync.native`（libuv 那只）而不是 `fs.realpathSync`：非 native 那只在 Windows 上**不解析
 * 大小写**（实测把 `C:\USERS\…` 原样返回），而宿主用的 `fs/promises.realpath` 会解析（同一个输入返回
 * `C:\Users\…`）。两边不一致时"同一个目录的两种写法"就还是会在注册表里变成两条记录，"与宿主逐字一致"
 * 正是这里的全部意义。
 */
export type DirCanonicalizer = (path: string) => string

/**
 * 目录的规范拼写。
 * @param path 候选目录（可以是另一种拼写，也可以根本不存在）。
 * @returns 规范拼写；空串原样返回（`fs.realpathSync('')` 会把它解成**进程当前目录**，而空串在这条路上
 *   是"没有 cwd 的会话用不到目标目录"那个契约值，绝不能在这里变成一个真实的目录）；解析不出来
 *   （不存在、无权限）时同样返回原值。
 */
export function canonicalDir(path: string): string {
  if (path === '') return path
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * 目录的规范拼写，而且它**必须解析得出来**；解析不出来（不存在、解析到的东西不是目录、没权限）
 * 返回 `undefined`。
 *
 * 与 `canonicalDir()` 的差别只在失败那一支：那一支要给调用方留原拼写去报"目标目录不存在"（或按原样
 * 落进注册表），这一支把"解析不出来"本身当成结论。宿主的 workspace 注册表建会话成员索引时用的就是
 * 这一支（`@deepseek-ai/dsh-workspace` 的 `indexHeader()`：`realpath` 之后还要 `stat().isDirectory()`），
 * 于是"登记过、但目录已经改名或删掉"的会话在宿主眼里**没人认领**——它落进外壳侧边栏的「未分组」
 * （判据的用法见 src/accounting.ts）。
 *
 * @param path 候选目录（可以是另一种拼写，也可以根本不存在）。
 * @returns 规范拼写；空串与解析不出来的都返回 `undefined`。
 */
export function canonicalDirIfExists(path: string): string | undefined {
  if (path === '') return undefined
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return undefined
  }
  try {
    return statSync(real).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}
