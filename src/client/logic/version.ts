/**
 * 版本徽标的文本规则：发布构建是 `v0.3.1`，从 git 直接 build 的是 `v0.3.1 · 3c9f1ab`，构建时工作区
 * 有未提交改动再挂 `-dirty`。
 *
 * 单独一个**纯**模块，是为了让这条规则能不经构建就被钉住（`test/version.test.ts`）：那三个构建期
 * 常量只有产物里才有，读它们的模块见 [build.ts](../build.ts)。
 *
 * @module dsh-session-manager/client/version
 */

/** 版本号本身：`v0.3.1`。 */
export function versionTag(version: string): string {
  return `v${version}`
}

/**
 * 短 commit：脏构建把 `-dirty` 一起带上（与 `git describe` 的写法一致）。
 *
 * 徽标与悬浮提示共用它，于是两处说的是同一件事——不会出现徽标 `3c9f1ab-dirty` 而提示里只有
 * `3c9f1ab` 那种"看着像干净构建"的错位。
 */
export function versionCommit(commit: string, dirty: boolean): string {
  return dirty ? `${commit}-dirty` : commit
}

/**
 * 徽标上的那行字。`commit` 为空串就是发布构建（或没有 git 的构建），只报版本号。
 *
 * 空串而不是 `undefined`：构建期常量只能是一个字符串（`tsdown.config.ts` 的 `define`），
 * 于是"有没有 commit"在这里就是"是不是空串"，中间不再多一层可选值。
 */
export function versionLabel(version: string, commit: string, dirty: boolean): string {
  if (commit === '') return versionTag(version)
  return `${versionTag(version)} · ${versionCommit(commit, dirty)}`
}
