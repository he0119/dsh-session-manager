/**
 * 这个构建是谁：版本号与（从 git 直接 build 时的）短 commit，由 `tsdown.config.ts` 的 `define`
 * 在编译期写死，判据与降级在 [build-identity.ts](../../scripts/build-identity.ts)。
 *
 * 源码里这三个标识符**不存在**——它们在产物里已经被字面量替换掉，所以只有经过构建的代码才能读它们
 * （`lib/client.js`；`test/client.test.mjs` 按产物核）。写坏这条链只会有一个现象：页面渲染时抛
 * ReferenceError，整页变成崩溃占位。
 *
 * 为什么单独一个模块而不是塞进 [version.ts](./logic/version.ts)：那一份要保持纯，测试要能直接
 * import 它而不经过构建（这里一 import 就会去读那三个标识符）。
 *
 * @module dsh-session-manager/client/build
 */

declare const __DSM_VERSION__: string
declare const __DSM_COMMIT__: string
declare const __DSM_DIRTY__: boolean

/** 构建时 `package.json` 里的版本号。 */
export const PLUGIN_VERSION: string = __DSM_VERSION__

/** 直接 build 的短 commit；发布构建（HEAD 上有标签）与没有 git 的构建是空串。 */
export const PLUGIN_COMMIT: string = __DSM_COMMIT__

/** 构建时工作区有没有未提交的改动。 */
export const PLUGIN_DIRTY: boolean = __DSM_DIRTY__
