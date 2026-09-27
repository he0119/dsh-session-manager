// test/artifact.test.mjs — 构建产物冒烟。
//
// 其余测试都直接 import `src/*.ts`，因此"源码通过"并不等于"产物能装进宿主"。
// 本文件加载 **lib/index.js**（`package.json` 的 main），补上这一环：
//   1) 插件入口的自描述字段与 cordis.patch.yml / inject 一致
//   2) 能注册出 4 个工具，且 parameters / output.render 形状符合宿主契约
//   3) apply 返回单个卸载函数（Cordis 契约），调用后不抛
//
// 产物不存在时整组跳过（源码开发不必先构建）。
// 设 DSM_SMOKE_WORKSPACE=<一个真实工作区目录> 时，额外让 plan 在该目录上跑一次
// **只读**计划，并断言它确实没写任何字节——这是"产物在真实数据上可用"的证据。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'lib', 'index.js')
const ready = existsSync(entry)
const skip = ready ? false : 'lib/index.js 不存在，先跑 pnpm run build'
const realDataSkip = skip || (process.env.DSM_SMOKE_WORKSPACE ? false : 'set DSM_SMOKE_WORKSPACE to a real workspace dir')

const EXPECTED = [
  'migrate_sessions',
  'plan_session_migration',
  'rollback_session_migration',
  'verify_workspace_sessions',
]

/** 假的 host ctx：捕获注册的工具。 */
function fakeCtx() {
  const defs = []
  return {
    defs,
    ctx: {
      tools: {
        register: (def) => {
          defs.push(def)
          return () => {}
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
  }
}

test('产物冒烟：入口字段符合 cordis 契约', { skip }, async () => {
  const mod = await import(pathToFileURL(entry).href)
  assert.equal(mod.name, 'session-manager', "name 必须与 cordis.patch.yml 的 id 一致")
  assert.deepEqual(mod.inject, ['tools'], '必须 inject tools')
  assert.equal(typeof mod.apply, 'function', '必须导出 apply')
})

test('产物冒烟：注册 4 个工具且 schema 已归一化', { skip }, async () => {
  const { apply } = await import(pathToFileURL(entry).href)
  const { ctx, defs } = fakeCtx()

  const dispose = apply(ctx, {})
  // Cordis 契约：apply 返回**单个**卸载函数（内部再逐个注销工具），不是数组。
  assert.equal(typeof dispose, 'function', 'apply 必须返回卸载函数')

  assert.deepEqual(
    defs.map((d) => d.name).sort(),
    EXPECTED,
    '工具名集合必须与文档一致',
  )
  for (const d of defs) {
    assert.equal(d.parameters.type, 'object', `${d.name} 的 parameters 必须归一化成 object`)
    assert.equal(typeof d.execute, 'function', `${d.name} 必须有 execute`)
    assert.equal(typeof d.output?.render, 'function', `${d.name} 必须有 output.render`)
  }

  dispose() // 不应抛
})

test('产物冒烟：plan 在真实工作区上只读可用', { skip: realDataSkip }, async () => {
  const { apply } = await import(pathToFileURL(entry).href)
  const workspace = process.env.DSM_SMOKE_WORKSPACE
  const { ctx, defs } = fakeCtx()

  // 计划层会用 existsSync(to) 校验目标真实存在，所以造一个工作区内的目标目录。
  const target = join(workspace, '.artifact-smoke-target')
  mkdirSync(target, { recursive: true })
  const dispose = apply(ctx, {})
  try {
    const plan = defs.find((d) => d.name === 'plan_session_migration')
    const res = await plan.execute({ from: workspace, to: target, includeArtifacts: true }, {})

    assert.equal(res.ok, true, `只读计划应当可用，problems=${JSON.stringify(res.problems)}`)
    assert.ok(res.sessions > 0, '真实工作区应当至少发现 1 个会话')

    // 只读的证据：计划声明的目标桶不该被创建（桶名由计划自己算出，不硬编码）。
    assert.equal(existsSync(res.targetBucket), false, 'plan 是只读的，不应创建目标桶')
  } finally {
    dispose()
    rmSync(target, { recursive: true, force: true })
  }
})
