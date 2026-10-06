// test/build-identity.test.ts — 构建身份（版本号 / 短 commit）的四种输入。
//
// 这段判据决定**界面右下角那枚徽标**在四种机器上各说什么，而它们的差别只在 git 那里：发布构建
// （HEAD 就是 `v*` 标签指向的提交）不该挂 hash，直接从 git build 的该挂，构建时工作区脏还要挂
// `-dirty`，没有 git 的（源码包、快照、机器上没装 git）只剩版本号。
//
// 两个端口都是注入的，所以四种输入能在这里逐条摆出来；真实 git 只由一个用例碰一次（在一座没有
// 仓库的临时目录里取版本号），那一支无论这台机器有没有 git 都该得到同一个结论。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildIdentity, readBuildIdentity, type GitReader } from '../scripts/build-identity.ts'

/** 判据会下发的三条命令，按顺序。 */
const REV_PARSE = ['rev-parse', '--short', 'HEAD']
const DESCRIBE = ['describe', '--exact-match', '--tags', 'HEAD']
const STATUS = ['--no-optional-locks', 'status', '--porcelain']

/** 按命令逐条回答的假 git；没列出的命令返回 undefined（= 命令失败 / 这次查询没有结果）。 */
function fakeGit(answers: Record<string, string>): { git: GitReader; calls: string[] } {
  const calls: string[] = []
  const git: GitReader = (args) => {
    calls.push(args.join(' '))
    return answers[args.join(' ')]
  }
  return { git, calls }
}

test('构建身份：没有 git 时只报版本号', () => {
  const { git, calls } = fakeGit({})
  assert.deepEqual(buildIdentity({ version: '0.3.1', git }), { version: '0.3.1', dirty: false })
  // 第一步读不到 commit 就该停：后面的标签查询与工作区检查都没有意义。
  assert.deepEqual(calls, [REV_PARSE.join(' ')])
})

test('构建身份：HEAD 上有标签 = 发布构建，不挂 hash', () => {
  const { git, calls } = fakeGit({ [REV_PARSE.join(' ')]: '0b8c452', [DESCRIBE.join(' ')]: 'v0.3.1' })
  assert.deepEqual(buildIdentity({ version: '0.3.1', git }), { version: '0.3.1', dirty: false })
  // 版本号与标签是同一件事，脏不脏都不该出现在发布产物里——于是这一步之后不再问工作区。
  assert.deepEqual(calls, [REV_PARSE.join(' '), DESCRIBE.join(' ')])
})

test('构建身份：直接 build 挂短 commit，工作区脏再挂 -dirty', () => {
  const clean = fakeGit({ [REV_PARSE.join(' ')]: '0b8c452', [STATUS.join(' ')]: '' })
  assert.deepEqual(buildIdentity({ version: '0.3.1', git: clean.git }), {
    version: '0.3.1',
    commit: '0b8c452',
    dirty: false,
  })
  // 顺序也是判据的一部分：标签查询必须在工作区检查之前（发布构建根本不该问工作区），而工作区那一步
  // 要带 `--no-optional-locks`——构建顺手看一眼工作区不该去抢 index.lock。
  assert.deepEqual(clean.calls, [REV_PARSE.join(' '), DESCRIBE.join(' '), STATUS.join(' ')])

  const dirty = fakeGit({ [REV_PARSE.join(' ')]: '0b8c452', [STATUS.join(' ')]: ' M src/web.ts' })
  assert.deepEqual(buildIdentity({ version: '0.3.1', git: dirty.git }), {
    version: '0.3.1',
    commit: '0b8c452',
    dirty: true,
  })
})

test('构建身份：问不出工作区状态时不猜脏（宁可少挂一个后缀）', () => {
  // 工作区那一步失败（半路出错、权限不够）与"工作区是干净的"都落到空串这一支。
  const { git } = fakeGit({ [REV_PARSE.join(' ')]: '0b8c452' })
  assert.deepEqual(buildIdentity({ version: '0.3.1', git }), {
    version: '0.3.1',
    commit: '0b8c452',
    dirty: false,
  })
})

test('构建身份：真实读取面在一座没有仓库的目录里降级成"只有版本号"', () => {
  // 这一条走真的 execFileSync：临时目录不是 git 仓库，`rev-parse` 必然失败（无论这台机器有没有装
  // git），于是身份只剩 package.json 里的版本号——正是从源码包 / tarball 里编译出来的那种产物。
  const dir = mkdtempSync(join(tmpdir(), 'dsm-identity-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }))
    assert.deepEqual(readBuildIdentity(dir), { version: '9.9.9', dirty: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
