/**
 * 发布内容自检：把 `package.json` 的 `files` 白名单**真的**过一遍 npm 的打包规则。
 *
 * 这个脚本断言三件在测试里测不到、却只有发布那一刻才会暴露的事：
 *
 * 1. 运行期文件一个都不少（`lib/index.js`、`lib/client.js`、`lib/types/`、`cordis.patch.yml`…）；
 * 2. `main` / `types` / `bin` / `exports` / `dsh.bundle.patch` 指向的每个路径**都在包里**——
 *    入口指着空气是「装进宿主才报错」的那类事故，本地测试全绿也照样发生；通配条目
 *    （`./locale/*.json`）按形状核，至少要匹配到一个真实文件；
 * 3. `test/`、`src/`、`docs/` 这些不该外泄的目录没有被带进包。
 *
 * 外加一条跨文件不变式：`cordis.patch.yml` 里 insert 的 `name:` 必须等于本包名。
 * 包名带 scope 之后它是引号包起来的字符串，看错一眼就会让插件在 profile 里挂载成
 * 「找不到模块」；这条断言把两个文件钉在一起。
 *
 * ⚠️ 必须在 `build` 之后跑：`lib/` 不进 git，产物不存在时第 1 条就会（正确地）失败。
 *
 * 用发布那一步**同一个打包器**（`pnpm pack`）而不是复述 `files` 规则：`files` 的通配、总是包含的
 * 文件（`package.json` / `README*` / `LICENSE`）与忽略文件的交互都有边角，复述一遍等于又写一份会和
 * 打包器漂移的实现。发布用的是 `pnpm publish`，所以判据也取 `pnpm pack`——两者只差最后那一下 PUT。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 找到 pnpm，并给出"怎么跑它"。
 *
 * 优先用 `npm_execpath`：`pnpm run` 会把 pnpm 自己的入口放在这个变量里（corepack 是 `.cjs`，
 * 独立二进制是原生可执行文件），两种都能直接跑，且版本就是这次跑脚本的版本。没有这个变量
 * （例如直接用 `node scripts/check-package.mjs` 跑）时退回 PATH 上的 `pnpm`。
 */
function resolvePnpm() {
  const execpath = process.env.npm_execpath
  if (execpath !== undefined && existsSync(execpath) && basename(execpath).includes('pnpm')) {
    return /\.[cm]?js$/.test(execpath)
      ? { command: process.execPath, args: [execpath], shell: false }
      : { command: execpath, args: [], shell: false }
  }
  // Windows 上 `pnpm` 是 `.cmd`，要经过 shell 才起得来；POSIX 不需要。
  return process.platform === 'win32'
    ? { command: 'pnpm.cmd', args: [], shell: true }
    : { command: 'pnpm', args: [], shell: false }
}

/**
 * 让 pnpm 把缓存与存储写进一次性临时目录，而不是 `~/.cache/pnpm`。
 *
 * 两个理由，都不是洁癖：受限环境（本仓库的开发就在 DSH 的文件沙箱里）下用户缓存目录可能不可写，
 * pnpm 会因为「写不进去」直接非零退出——那时失败的是环境而不是包内容，断言会指向一个假的原因。
 * 顺带也让自检不碰用户真实的缓存。
 */
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-check-package-'))
const pnpm = resolvePnpm()

let packed
try {
  packed = spawnSync(
    pnpm.command,
    // --ignore-scripts：本包没有 prepack/prepare，但万一将来加了，也不该在自检里顺带跑构建。
    [...pnpm.args, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      shell: pnpm.shell,
      env: {
        ...process.env,
        npm_config_cache: sandbox,
        npm_config_store_dir: join(sandbox, 'store'),
        XDG_CACHE_HOME: join(sandbox, 'cache'),
        npm_config_update_notifier: 'false',
      },
    },
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
assert.equal(packed.status, 0, `pnpm pack 失败：\n${packed.stderr || packed.error?.message}`)

// pnpm 的 `--json` 是一层对象（`{ name, version, filename, files }`），npm 是只含一个元素的数组；
// 这里只认 pnpm 那个形状——换打包器时应当改这句，而不是两边都兼容。
const manifest = JSON.parse(packed.stdout)
const shipped = new Set(manifest.files.map((file) => file.path))

// 1. 运行期文件。这份清单是「装进宿主之后真的会被读到的文件」，不是 `files` 的复述：
//    `files: ["lib", …]` 允许 lib 少几个文件，而少哪个都会在加载时才炸。
const REQUIRED = [
  'lib/index.js', // 插件入口（dsh.bundle.patch 的 insert 指向的模块）
  'lib/client.js', // 浏览器半侧的经典脚本（dsh.client 指向它）
  'lib/types/index.d.ts', // exports["."].types，工具层的类型来源
  'cordis.patch.yml', // profile 里的 bundle patch
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'icon.svg',
  // 宿主的插件展示元信息从这两个文件读（`readPluginMeta()`），而 `en.json` 是唯一的发现入口：
  // 少了它，中文标题也一起消失，标题静默回退成包名。
  'locale/en.json',
  'locale/zh.json',
]
for (const path of REQUIRED) {
  assert.ok(shipped.has(path), `包里缺少运行期文件：${path}（跑过 build 了吗？）`)
}

// 2. 入口自洽：package.json 里指向的每个路径都必须真的在包里。
function collectPaths(value, out = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) out.push(value.slice(2))
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPaths(item, out)
  }
  return out
}
/**
 * `./locale/*.json` 这类条目按形状匹配，不当字面路径看。
 *
 * 星号**不是**「这一条免检」：通配入口一条真实文件都匹配不到时，宿主的 locale 解析会静默回退成
 * 包名——正是这条自检要挡的那种"本地全绿、装进去才发现"。
 */
function matchesWildcard(pattern, path) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`).test(path)
}
const entryPaths = new Set([
  ...collectPaths({ main: pkg.main, types: pkg.types, exports: pkg.exports, bin: pkg.bin }),
  ...collectPaths(pkg.dsh ?? {}),
])
for (const path of entryPaths) {
  if (path.includes('*')) {
    assert.ok(
      [...shipped].some((file) => matchesWildcard(path, file)),
      `package.json 的通配入口匹配不到包里任何文件：${path}`,
    )
    continue
  }
  assert.ok(shipped.has(path), `package.json 指向了包外路径：${path}`)
}

// 2b. 产物内部的相对依赖也必须在包里。tsdown 会把入口用到的代码抽成带哈希的 chunk
//     （如 lib/plan-V3Pci92H.js）——哈希名一变，白名单式断言就失效，所以这里直接读产物里
//     的 import 说明符、按入口所在目录解析（打包清单里的路径是包根相对的），再核对一次。
for (const entry of ['lib/index.js']) {
  const source = readFileSync(join(root, entry), 'utf8')
  for (const [, specifier] of source.matchAll(/(?:from|import\()\s*['"](\.\/[^'"]+)['"]/g)) {
    // posix：打包清单一律用 `/` 分隔，Windows 上 join 会给出 `\` 而永远对不上。
    const target = posix.join(posix.dirname(entry), specifier)
    assert.ok(shipped.has(target), `${entry} import 了包外的相对路径：${specifier}（解析为 ${target}）`)
  }
}

// 3. 不该外泄的目录。`files` 白名单正常情况下已经挡住，这里防的是「将来图省事把 files
//    改成通配」——`src/` 与 `test/` 进了 profile 会让安装体积和审查面一起膨胀。
for (const prefix of ['src/', 'test/', 'docs/', 'scripts/', '.github/']) {
  const leaked = [...shipped].filter((path) => path.startsWith(prefix))
  assert.equal(leaked.length, 0, `包里不该出现 ${prefix}：${leaked.join(', ')}`)
}
assert.ok(![...shipped].some((path) => path.startsWith('tsconfig')), '包里不该出现 tsconfig')

// 4. 跨文件不变式：patch 里 insert 的 name 必须就是本包名。
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const inserted = patch.match(/^\s*name:\s*(['"]?)(.+?)\1\s*$/m)
assert.ok(inserted, 'cordis.patch.yml 里没找到 insert 的 name:')
assert.equal(
  inserted[2],
  pkg.name,
  `cordis.patch.yml 里的 name（${inserted[2]}）与 package.json 的包名（${pkg.name}）不一致`,
)

console.log(`包内容自检通过：${shipped.size} 个文件，入口自洽，patch name = ${pkg.name}`)
