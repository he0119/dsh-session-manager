/**
 * 构建配置：Host 端沿用官方包的产物形状 —— 源码打成一个 ESM `lib/index.js`，
 * 所有包依赖保持外部，声明按源码模块输出到 `lib/types/`；Web Client 端另外出一份
 * `lib/client.js`，遵守 DSH 客户端模块系统的经典脚本契约（见下）。
 *
 * 注意 Host 的 `deps.neverBundle: true`：Cordis、DSH 与普通 npm 依赖都由安装环境解析，
 * 不进产物。这与官方 Host 包的口径一致。客户端反过来——它跑在浏览器里，除了平台模块表提供的
 * 那几个基线模块，其余都得内联进产物。
 *
 * 另外一处只有这里能做的事：把**这个构建是谁**（版本号、直接 build 时的短 commit）在编译期写死进
 * 客户端产物（下面 `define` 的三个标识符），于是页面右下角的徽标不必问宿主、也不必在运行期跑 git。
 * 判据与降级都在 [build-identity.ts](./scripts/build-identity.ts) 里。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig, type UserConfig } from 'tsdown'

import { readBuildIdentity } from './scripts/build-identity.ts'

const { name: PACKAGE } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

/** 这一层构建的自述：发布构建只有版本号，直接 build 另有短 commit（工作区脏再挂 `-dirty`）。 */
const identity = readBuildIdentity(fileURLToPath(new URL('.', import.meta.url)))

/**
 * 浏览器模块表里由宿主提供、产物里保持 `require(...)` 的模块：平台基线。
 *
 * 只有基线模块能这样要——客户端模块系统只服务 `<包名>/client.js` 这一条经典脚本，没有旁挂依赖的
 * 路由，非基线模块得在 `dsh.client.external` 里点名。除了 `react` 两个入口，官方的控件库
 * `@deepseek-ai/dsh-client-ui-primitives` 同样是基线（0.2.0-rc.1 这一代里，官方 62 个 `dsh-client-*`
 * 包有 47 个的产物直接 require 它，没有一个把它写进 `external`），所以它保持外置：内联进去等于把一份 React 组件复制进产物，还会跟
 * 宿主那份的 hooks 语义脱钩。
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

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
  // 构建期常量：源码里这三个标识符不存在（`src/client/build.ts` 里只有 declare），只有产物里有。
  // 只写在客户端那一份配置上——Host 半侧不显示版本，定义了也没人问。
  define: {
    __DSM_VERSION__: JSON.stringify(identity.version),
    __DSM_COMMIT__: JSON.stringify(identity.commit ?? ''),
    __DSM_DIRTY__: identity.dirty ? 'true' : 'false',
  },
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
