// test/version.test.ts — 版本徽标那行字的文法。
//
// 徽标本身（`v0.3.1 · 3c9f1ab`）是标识符，不进字典，所以它的形状只能在源码这一侧钉住：
// 发布构建只有版本号、直接 build 的多一个短 commit、构建时工作区脏的再挂一个 `-dirty`（与
// `git describe` 的写法一致）。判据在 `src/client/logic/version.ts`，这里逐支摆出来。
//
// 另外核一句：提示里那个 commit 与徽标说的是同一件事——脏构建时徽标是 `3c9f1ab-dirty`，提示里
// 也必须是 `3c9f1ab-dirty`，不能一处带后缀一处不带（那会让人以为构建时工作区是干净的）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { versionCommit, versionLabel, versionTag } from '../src/client/logic/version.ts'

test('版本徽标：发布构建只有版本号', () => {
  assert.equal(versionTag('0.3.1'), 'v0.3.1')
  assert.equal(versionLabel('0.3.1', '', false), 'v0.3.1')
})

test('版本徽标：直接 build 挂短 commit，脏工作区再挂 -dirty', () => {
  assert.equal(versionLabel('0.3.1', '3c9f1ab', false), 'v0.3.1 · 3c9f1ab')
  assert.equal(versionLabel('0.3.1', '3c9f1ab', true), 'v0.3.1 · 3c9f1ab-dirty')
  // 预发布版本号原样带上：这里不解析 semver，只把 package.json 那个字符串摆出来。
  assert.equal(versionLabel('0.4.0-rc.1', '3c9f1ab', false), 'v0.4.0-rc.1 · 3c9f1ab')
})

test('版本徽标：提示里的 commit 与徽标同形', () => {
  assert.equal(versionCommit('3c9f1ab', false), '3c9f1ab')
  assert.equal(versionCommit('3c9f1ab', true), '3c9f1ab-dirty')
})
