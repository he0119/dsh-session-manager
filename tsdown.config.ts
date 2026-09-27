/**
 * 构建配置：沿用官方包的产物形状 —— 源码打成一个 ESM `lib/index.js`（外加 CLI 的 `lib/cli.js`），
 * 所有包依赖保持外部，声明按源码模块输出到 `lib/types/`。
 *
 * 本插件没有 Web Client 端，因此只有 host 与 types 两份配置（参考项目多一份 client，
 * 那份要遵守 DSH 客户端模块系统的经典脚本契约）。
 *
 * 注意 `deps.neverBundle: true`：Cordis、DSH 与普通 npm 依赖都由安装环境解析，
 * 不进产物。这与官方 Host 包的口径一致。
 */
import { readFileSync } from 'node:fs'

import { defineConfig, type UserConfig } from 'tsdown'

const { name: PACKAGE } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

const host: UserConfig = {
  name: `${PACKAGE}/host`,
  // 两个入口：插件本体与离线 CLI（CLI 的 shebang 写在源码首行，产物保留）。
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: false,
  sourcemap: false,
  fixedExtension: false,
  // 两份配置共用 lib/；完整构建由 package.json 的 prebuild 一次性清理，单独重建一端不删另一端。
  clean: false,
  deps: { neverBundle: true },
  outputOptions: {
    entryFileNames: '[name].js',
  },
}

const types: UserConfig = {
  name: `${PACKAGE}/types`,
  entry: ['src/**/*.ts'],
  tsconfig: 'tsconfig.json',
  outDir: 'lib/types',
  root: 'src',
  unbundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  dts: {
    emitDtsOnly: true,
    sourcemap: false,
  },
  sourcemap: false,
  fixedExtension: false,
  clean: false,
  deps: {
    neverBundle: true,
    dts: { neverBundle: true },
  },
}

export default defineConfig([host, types])
