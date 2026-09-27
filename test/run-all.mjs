// test/run-all.mjs — 进程内测试 runner。
//
// 为什么不用 `node --test`：DSH 的 Windows 沙箱禁止子进程通过命名管道捕获输出，
// 而 `node --test` 会为**每个测试文件** spawn 一个子进程（piped stdio），
// 于是必然 EPERM（spawn EPERM），与测试内容无关。
//
// 本 runner 在**同一进程**内依次 import 各测试文件：node:test 在直接运行该模块时
// 同样会注册并执行用例，只是不再经过子进程隔离。
// 代价：某个文件抛错会影响同进程的其它文件，因此这里对每个文件单独 try/catch 汇总。
//
// 测试文件是 .ts，靠 node 自带的类型擦除运行（与参考项目同一做法）。
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()

let failed = 0
for (const f of files) {
  try {
    // Windows 绝对路径必须转成 file:// URL 才能动态 import
    await import(pathToFileURL(join(here, f)).href)
  } catch (error) {
    failed++
    console.error(`\n[runner] 载入 ${f} 失败:`, error?.stack ?? error)
  }
}

if (failed > 0) {
  console.error(`\n[runner] ${failed} 个测试文件载入失败`)
  process.exitCode = 1
}
