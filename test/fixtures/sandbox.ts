/**
 * 测试的临时目录：全仓只有一份根，`test/.sandbox/<名字>`（`.gitignore` 里挡掉的正是这个目录）。
 *
 * 为什么不让每个测试文件在自己的目录下建 `.sandbox`：测试按操作分目录之后，那会散出七八个 `.sandbox`；
 * 而它本来就是「这次跑完就该扔」的暂存区——集中在一处，才看得出谁没清干净，也不必在每个目录下各写一条
 * 忽略规则。
 *
 * @module dsh-session-manager/test/sandbox
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 测试会写盘的临时根。 */
export const SANDBOX_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.sandbox')

/** `test/.sandbox/<name>` 的绝对路径；不创建目录，调用方自己 `mkdirSync`。 */
export function sandboxDir(name: string): string {
  return join(SANDBOX_ROOT, name)
}
