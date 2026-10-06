/**
 * 构建时的自述：产物里那句「这是哪个版本、哪个 commit」从哪来。
 *
 * `lib/` 不进版本库，它是**发布时现场编译**出来的（`prepublishOnly`；CI 里那一步在打标签的那个提交
 * 上跑，见 `.github/workflows/publish.yml`），所以「包在不在 git 仓库里」与「HEAD 是不是标签指向的
 * 提交」两件事就足以区分三种构建，界面上的徽标也只需要这三种：
 *
 * - **发布构建**（HEAD 就是 `v*` 标签指向的提交）→ 只有版本号；
 * - **直接 build**（开发、PR、软链进 profile 的检出）→ 版本号 + 短 commit，工作区脏再挂 `-dirty`；
 * - **没有 git**（从源码包、tarball 或别处的快照编译）→ 只有版本号。
 *
 * 判据写成注入两个端口的纯函数：分支能在测试里逐条摆出来（见 `test/build-identity.test.ts`），
 * 不必真的去动一个 git 仓库。
 *
 * @module scripts/build-identity
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 构建身份：版本号一定有，`commit` 只有「从 git 直接 build」时才有。 */
export interface BuildIdentity {
  version: string
  commit?: string
  dirty: boolean
}

/** `git <args>` 的读取面：命令不在、不是仓库、或这次查询本来就没有结果时返回 `undefined`。 */
export type GitReader = (args: string[]) => string | undefined

/** 判据本体：三步都不花钱，且每一步的结果都由端口给。 */
export function buildIdentity(input: { version: string; git: GitReader }): BuildIdentity {
  const commit = input.git(['rev-parse', '--short', 'HEAD'])
  // 读不到 commit：没有 git，或者这里根本不是仓库——没有"这是哪个提交"可谈。
  if (commit === undefined) return { version: input.version, dirty: false }
  // HEAD 上有标签：发布构建。版本号与标签是同一件事，再挂一个 hash 只是噪音。
  if (input.git(['describe', '--exact-match', '--tags', 'HEAD']) !== undefined) {
    return { version: input.version, dirty: false }
  }
  // `--no-optional-locks`：构建不该因为顺手看一眼工作区而去抢 index.lock。
  const status = input.git(['--no-optional-locks', 'status', '--porcelain']) ?? ''
  return { version: input.version, commit, dirty: status !== '' }
}

/**
 * 在 `root`（插件包根）里读真实 git 与 `package.json`。
 *
 * 失败一律按「读不到」处理并静默降级：构建不该因为这台机器没装 git 或者这是个导出出来的快照而失败。
 */
export function readBuildIdentity(root: string): BuildIdentity {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  const git: GitReader = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return undefined
    }
  }
  return buildIdentity({ version, git })
}
