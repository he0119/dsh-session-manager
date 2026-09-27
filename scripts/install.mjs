#!/usr/bin/env node
// scripts/install.mjs — 把本插件装进一个 DSH profile。
//
// 默认 **dry-run**：只打印将要做的改动，一个字节都不写。加 --apply 才落盘。
//
// DSH 的 profile 组合方式（见 profiles/<name>/cordis.yml 的注释）：
//   cordis.yml 本身是空的 []，实际由三部分叠加：
//     1. package.json 的 dsh.profile.bundles —— 每个 bundle 贡献自己的 cordis.patch.yml
//     2. profile 自己的 cordis.patch.yml      —— id 定向的配置覆盖
//     3. --patch 叠加层
// 所以"装插件"= 把包放进 node_modules + 把包名加进 dsh.profile.bundles。
//
// 注意：改完必须**重启 DSH** 才会加载。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_NAME = 'dsh-session-mover'
const HERE = dirname(dirname(fileURLToPath(import.meta.url))) // 仓库根

function parse(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
  }
  return out
}

const args = parse(process.argv.slice(2))
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = resolve(
  args.profile || process.env.DSH_PROFILE_DIR || join(home, 'profiles', process.env.DSH_PROFILE || 'desktop'),
)
const pkgPath = join(profileDir, 'package.json')
const target = join(profileDir, 'node_modules', PKG_NAME)

if (!existsSync(pkgPath)) {
  console.error(`找不到 profile 的 package.json：${pkgPath}`)
  console.error('可用 --profile <dir> 显式指定，或设置 DSH_PROFILE_DIR。')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
pkg.dependencies ??= {}

const changes = []
if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) {
  pkg.dsh.profile.bundles.push(PKG_NAME)
  changes.push(`dsh.profile.bundles += "${PKG_NAME}"`)
}
const depSpec = `file:${HERE.replace(/\\/g, '/')}`
if (pkg.dependencies[PKG_NAME] !== depSpec) {
  pkg.dependencies[PKG_NAME] = depSpec
  changes.push(`dependencies["${PKG_NAME}"] = "${depSpec}"`)
}
if (!existsSync(target)) changes.push(`复制包 -> ${target}`)

console.log(`profile: ${profileDir}`)
console.log(`源包：   ${HERE}`)
console.log(changes.length ? `将要执行：\n  - ${changes.join('\n  - ')}` : '已经是装好的状态，无需改动。')

if (!args.apply) {
  console.log('\n（dry-run，未写任何字节；加 --apply 执行）')
  process.exit(0)
}

if (changes.length === 0) process.exit(0)

// 备份 package.json（改配置前留一手）
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${pkgPath}.bak-${stamp}`
cpSync(pkgPath, backup)
console.log(`已备份: ${backup}`)

// 复制包（排除开发期目录，避免把测试沙箱与 node_modules 带进去）
mkdirSync(dirname(target), { recursive: true })
cpSync(HERE, target, {
  recursive: true,
  filter: (src) => {
    const name = basename(src)
    if (name === 'node_modules' || name === '.sandbox' || name === '.git') return false
    return true
  },
})
console.log(`已复制到: ${target}`)

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`已更新: ${pkgPath}`)
console.log('\n下一步：重启 DSH，然后确认 4 个工具出现在工具列表里：')
console.log('  plan_session_migration / migrate_sessions / rollback_session_migration / verify_workspace_sessions')
