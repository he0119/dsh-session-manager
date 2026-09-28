// test/manifest.test.mjs — 版本声明自检：同一个 DSH 代次写在三个地方，必须一起动。
//
// 为什么单开一个文件：DSH 把 peer 范围当**装配门**用（宿主 `dsh-app-boot` 的
// `evaluatePluginCompatibility`）。包名以 `@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-` 开头的 peer，
// 只要运行中的那个版本不在范围里，整条 bundle 就不装——插件自己的 `apply` 根本没跑，界面上只是
// "这一页没了"，日志里一行 `skipping profile bundle …`。本包把代次同时写在 `engines.dsh`、
// 两个 DSH peer 与两个同名 `devDependency` 上，而**门只认 peer 那两处**：只升 devDependency
// 会一路绿灯到装进 profile 才现形。
//
// 这里钉两件事：
//   1) 三处声明是同一条范围（漏掉任何一处都不算改完）；
//   2) 那条范围收得下 `node_modules` 里装到的那一代（构建与测试用的就是那一代）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 宿主那道门的判定对象：`@deepseek-ai/dsh` 本身，或以 `@deepseek-ai/dsh-` 开头。 */
const DSH_PEER = /^@deepseek-ai\/dsh(-|$)/

/** 本包要跟着换代的 peer。集合变了要连这条断言一起改——宿主是按这个集合装配的。 */
const DSH_PEERS = ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-tools']

/**
 * 取一条版本范围的**代次**（主次版本），只认第一条 `||` 分支。
 * @param range - 形如 `^0.2.0-rc.1` / `~0.2.0` / `0.2.0` 的范围。
 * @returns 形如 `0.2` 的代次。
 */
function generation(range) {
  const first = String(range).split('||')[0].trim()
  const match = /(\d+)\.(\d+)\.\d+/.exec(first)
  assert.notEqual(match, null, `读不出代次的版本范围：${range}`)
  return `${match[1]}.${match[2]}`
}

/** 装到 `node_modules` 里的那一份的版本号（devDependency 的实到版本）。 */
function installedVersion(name) {
  return JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
}

test('版本声明：engines.dsh 与两个 DSH peer 写同一条范围，devDependency 副本也在同一条上', () => {
  const peers = pkg.peerDependencies ?? {}
  const dev = pkg.devDependencies ?? {}

  assert.deepEqual(
    Object.keys(peers).filter((name) => DSH_PEER.test(name)).sort(),
    [...DSH_PEERS].sort(),
    'DSH peer 的集合与这里写的不一致：宿主按这个集合判装配，改动要连本条断言一起改',
  )

  const ranges = new Set()
  for (const name of DSH_PEERS) {
    assert.equal(dev[name], peers[name], `${name} 的 devDependency 要与 peer 写同一条范围`)
    ranges.add(peers[name])
  }
  assert.equal(ranges.size, 1, '两个 DSH peer 要写同一条范围')
  assert.equal(pkg.engines?.dsh, [...ranges][0], 'engines.dsh 要与 DSH peer 写同一条范围')
})

test('版本声明：peer 范围要收得下装到的那一代（换 minor 线时这条会红）', () => {
  for (const name of DSH_PEERS) {
    const installed = installedVersion(name)
    assert.equal(
      generation(pkg.peerDependencies[name]),
      generation(installed),
      `${name}：装到的是 ${installed}，peer 声明的却是 ${pkg.peerDependencies[name]}`,
    )
  }
})
