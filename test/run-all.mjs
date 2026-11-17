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
// 另有 .test.mjs：构建产物冒烟需要加载 lib/index.js，用 .mjs 才能避开 tsc 对产物路径的解析。
//
// 测试按操作分目录（`test/{plugin,shared,operations,client}/…`，与 `src/` 对齐），所以这里扫**整棵树**：
// 目录名不是判据，新加一层不该让文件悄悄不跑。`.sandbox/` 是本地调试用的抓取产物，永远不跑。
import { readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 递归收集测试文件，按路径排序（顺序稳定，报错位置才好对照）。 */
function collect(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.sandbox' || entry.name === 'node_modules') continue
      collect(path, out)
    } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs')) {
      out.push(path)
    }
  }
  return out
}

const files = collect(here)

let failed = 0
for (const file of files) {
  const name = relative(here, file)
  try {
    // Windows 绝对路径必须转成 file:// URL 才能动态 import
    await import(pathToFileURL(file).href)
  } catch (error) {
    failed++
    console.error(`\n[runner] 载入 ${name} 失败:`, error?.stack ?? error)
  }
}

if (failed > 0) {
  console.error(`\n[runner] ${failed} 个测试文件载入失败`)
  process.exitCode = 1
}
