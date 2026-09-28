/**
 * 发布内容自检：把 `package.json` 的 `files` 白名单**真的**过一遍 npm 的打包规则。
 *
 * 这个脚本断言三件在测试里测不到、却只有发布那一刻才会暴露的事：
 *
 * 1. 运行期文件一个都不少（`lib/index.js`、`lib/client.js`、`lib/types/`、`cordis.patch.yml`…）；
 * 2. `main` / `types` / `bin` / `exports` / `dsh.bundle.patch` 指向的每个路径**都在包里**——
 *    入口指着空气是「装进宿主才报错」的那类事故，本地测试全绿也照样发生；
 * 3. `test/`、`src/`、`docs/` 这些不该外泄的目录没有被带进包。
 *
 * 外加一条跨文件不变式：`cordis.patch.yml` 里 insert 的 `name:` 必须等于本包名。
 * 包名带 scope 之后它是引号包起来的字符串，看错一眼就会让插件在 profile 里挂载成
 * 「找不到模块」；这条断言把两个文件钉在一起。
 *
 * ⚠️ 必须在 `build` 之后跑：`lib/` 不进 git，产物不存在时第 1 条就会（正确地）失败。
 *
 * 用 npm 自己的打包器而不是复述 `files` 规则：`files` 的通配、总是包含的文件
 * （`package.json` / `README*` / `LICENSE`）与 `npmignore` 交互都有边角，复述一遍等于
 * 又写一份会和 npm 漂移的实现。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 找到 npm 自己的 JS 入口，用当前 node 直接跑它：不经过 PATH，也不起 shell。
 *
 * 刻意**不读** `npm_execpath`：本仓库用 pnpm 跑脚本，那个变量会指向 pnpm，而
 * `pnpm pack` 的参数与输出都跟 `npm pack` 不是一套。要的就是 npm —— 发布那一步
 * 用的也是它（可信发布与 provenance 是 npm CLI 的能力）。
 */
function resolveNpmCli() {
  const nodeDir = dirname(process.execPath)
  const candidates = [
    // 官方安装包（Windows）：node 目录下的 node_modules/npm
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // nvm / POSIX：<node>/../lib/node_modules/npm
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find(existsSync)
  assert.ok(found, `找不到 npm 的 JS 入口，试过：\n  ${candidates.join('\n  ')}`)
  return found
}

/**
 * 让 npm 把缓存与日志写进一次性临时目录，而不是 `~/.npm`。
 *
 * 两个理由，都不是洁癖：受限环境（本仓库的开发就在 DSH 的文件沙箱里）下 `~/.npm/_logs`
 * 不可写，npm 会因为「日志写不进去」直接非零退出——那时失败的是环境而不是包内容，
 * 断言会指向一个假的原因。顺带也让自检不碰用户真实的 npm 缓存。
 */
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-check-package-'))

let packed
try {
  packed = spawnSync(
    process.execPath,
    // --ignore-scripts：本包没有 prepack/prepare，但万一将来加了，也不该在自检里顺带跑构建。
    [resolveNpmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        npm_config_cache: sandbox,
        npm_config_logs_dir: join(sandbox, '_logs'),
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
        npm_config_audit: 'false',
      },
    },
  )
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
assert.equal(packed.status, 0, `npm pack 失败：\n${packed.stderr || packed.error?.message}`)

const [manifest] = JSON.parse(packed.stdout)
const shipped = new Set(manifest.files.map((file) => file.path))

// 1. 运行期文件。这份清单是「装进宿主之后真的会被读到的文件」，不是 `files` 的复述：
//    `files: ["lib", …]` 允许 lib 少几个文件，而少哪个都会在加载时才炸。
const REQUIRED = [
  'lib/index.js', // 插件入口（dsh.bundle.patch 的 insert 指向的模块）
  'lib/client.js', // Web Client 半边的经典脚本（dsh.client 指向它）
  'lib/types/index.d.ts', // exports["."].types，工具层的类型来源
  'cordis.patch.yml', // profile 里的 bundle patch
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'icon.svg',
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
const entryPaths = new Set([
  ...collectPaths({ main: pkg.main, types: pkg.types, exports: pkg.exports, bin: pkg.bin }),
  ...collectPaths(pkg.dsh ?? {}),
])
for (const path of entryPaths) {
  assert.ok(shipped.has(path), `package.json 指向了包外路径：${path}`)
}

// 2b. 产物内部的相对依赖也必须在包里。tsdown 会把入口用到的代码抽成带哈希的 chunk
//     （如 lib/plan-V3Pci92H.js）——哈希名一变，白名单式断言就失效，所以这里直接读产物里
//     的 import 说明符、按入口所在目录解析（打包清单里的路径是包根相对的），再核对一次。
for (const entry of ['lib/index.js']) {
  const source = readFileSync(join(root, entry), 'utf8')
  for (const [, specifier] of source.matchAll(/(?:from|import\()\s*['"](\.\/[^'"]+)['"]/g)) {
    // posix：npm 的打包清单一律用 `/` 分隔，Windows 上 join 会给出 `\` 而永远对不上。
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
