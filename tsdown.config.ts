/**
 * 构建配置：Host 端沿用官方包的产物形状 —— 源码打成一个 ESM `lib/index.js`，
 * 所有包依赖保持外部，声明按源码模块输出到 `lib/types/`；Web Client 端另外出一份
 * `lib/client.js`，遵守 DSH 客户端模块系统的经典脚本契约（见下）。
 *
 * 注意 Host 的 `deps.neverBundle: true`：Cordis、DSH 与普通 npm 依赖都由安装环境解析，
 * 不进产物。这与官方 Host 包的口径一致。客户端反过来——它跑在浏览器里，除了平台模块表提供的
 * 那几个基线模块，其余都得内联进产物。
 */
import { readFileSync } from 'node:fs'

import { defineConfig, type UserConfig } from 'tsdown'

const { name: PACKAGE } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

/**
 * 浏览器模块表里由宿主提供、产物里保持 `require(...)` 的模块：只有平台基线。
 *
 * 其余一律内联——客户端模块系统只服务 `<包名>/client.js` 这一条经典脚本，没有旁挂依赖的路由。
 * 本插件刻意不 require 宿主的 UI 原语包（那不是稳定契约，且它一抛异常就会让整个槽位条目变成
 * 崩溃占位），所以这里只有 react 两个入口。
 */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime'] as const

const host: UserConfig = {
  name: `${PACKAGE}/host`,
  // 一个入口：插件本体（离线 CLI 已经删掉，见 docs/internals.md 的「同一份迁移编排，两个入口」）。
  entry: { index: 'src/index.ts' },
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
  // 排除 Web Client 端：它的声明要 React 与 DOM，而这一份是给 Node 侧消费者读的；
  // 带上它还会产出一份引用 `.tsx`（不在产物里）的坏声明。
  entry: ['src/**/*.ts', '!src/client/**'],
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

/**
 * Web Client 端。
 *
 * DSH 的客户端模块系统只认一个**经典脚本**：它用 `window.__ModuleLoader__.load({ id, factory })`
 * 报名，交给工厂一个同步的 `require`（解析平台模块表里的模块）。产物因此是 `format: 'cjs'`
 * 外面套三行——banner 开 `factory`、intro 备好 `module` / `exports`、footer 把 `module.exports`
 * 交回去；工厂返回的那个对象就是本模块的导出面（`inject` 与 `apply`）。
 *
 * 产物落在 `lib/client.js`（+ `.map`），`package.json` 的 `exports["./client"]` 指向它；
 * 宿主按包名服务这份脚本，源映射从 `lib/client.js.map` 读。
 */
const client: UserConfig = {
  name: `${PACKAGE}/client`,
  entry: { client: 'src/client/index.ts' },
  // Host 端的 tsconfig.json 把 src/client 排除在外（它没有 DOM 也没有 JSX），
  // 因此这里必须显式指到 Web Client 端自己的那份，否则 JSX / lib 都会按 Host 端的算。
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  fixedExtension: false,
  // Host 端的 lib/index.js 也在同一个目录里，默认的 clean 会把它一起删掉。
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (specifier) => !(CLIENT_EXTERNALS as readonly string[]).includes(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, types, client])
