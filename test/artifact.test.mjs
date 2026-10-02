// test/artifact.test.mjs — 构建产物冒烟。
//
// 其余测试都直接 import `src/*.ts`，因此"源码通过"并不等于"产物能装进宿主"。
// 本文件加载 **lib/index.js**（`package.json` 的 main），补上这一环：
//   1) 插件入口的自描述字段与 cordis.patch.yml / inject 一致
//   2) 能注册出 5 个工具，且 parameters / output.render 形状符合宿主契约
//   3) apply 返回单个卸载函数（Cordis 契约），卸载后路由与工具都摘掉
//
// **为什么这里用真实 Cordis，而不是一个纯对象假装 ctx**：Cordis 的 Context 是 Proxy，服务属性
// 只有在当前 fiber 的 `inject` 里声明过才可读，否则**同步抛** `cannot get property "X" without
// inject`——即使那个服务确实存在。纯对象上 `ctx.webServer` 读得到，于是"假对象全绿、装进 profile
// 整个插件起不来"（web-dev profile 的日志就是 `cannot get property "webServer" without inject`）。
// 本文件因此按宿主的加载方式跑：`new Context()` + `ctx.provide(...)` + `ctx.plugin(...)` 一个
// 声明了 `inject` 的 fiber，再 `await fiber.await()`——apply 里任何"越权读服务"都会在这里抛。
//
// 产物不存在时整组跳过（源码开发不必先构建）。
// 设 DSM_SMOKE_WORKSPACE=<一个真实工作区目录> 时，额外让 plan 在该目录上跑一次
// **只读**计划，并断言它确实没写任何字节——这是"产物在真实数据上可用"的证据。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'lib', 'index.js')
const ready = existsSync(entry)
const skip = ready ? false : 'lib/index.js 不存在，先跑 pnpm run build'
const realDataSkip = skip || (process.env.DSM_SMOKE_WORKSPACE ? false : 'set DSM_SMOKE_WORKSPACE to a real workspace dir')

const EXPECTED = [
  'migrate_sessions',
  'plan_session_migration',
  'rollback_session_migration',
  'sync_sessions',
  'verify_workspace_sessions',
]

/** 轮询等待一个条件成立（Cordis 的 fiber 激活是异步的：provide 之后要等它 settled）。 */
async function waitFor(check, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`等待超时：${label}`)
}

/**
 * 由一个**兄弟** fiber 提供服务。
 *
 * "兄弟"这件事是刻意的，不是随手写的：从根 context 上 `provide` 的服务，会在 Context 代理
 * "往上找父 fiber"的那条回退路径里被读到，于是越权的属性读法（`ctx.webServer`）也能蒙对。
 * 真实 profile 里 webServer 由 `dsh-host-webserver` 这个**兄弟**条目提供，那种写法必抛
 * `cannot get property "webServer" without inject`——本文件要复现的正是这个布局。
 */
async function startSibling(host, service, value) {
  const fiber = host.plugin({
    name: `fixture:${service}`,
    inject: [],
    apply: (ctx) => {
      ctx.provide(service, value)
    },
  })
  await fiber.await()
  return fiber
}

/**
 * 按宿主的方式加载插件：真实 Cordis、真实 fiber、真实服务（各由兄弟条目提供）。
 * @param options.withWebServer - 是否在插件起来**之前**就提供 webServer。
 */
async function loadPlugin({ withWebServer = true } = {}) {
  const host = new Context()
  const defs = []
  const routes = []
  const removed = []
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {
        removed.push(route.path)
      }
    },
  }
  await startSibling(host, 'tools', {
    register: (def) => {
      defs.push(def)
      return () => {}
    },
  })
  if (withWebServer) await startSibling(host, 'webServer', webServer)

  const { apply, inject, name } = await import(pathToFileURL(entry).href)
  const fiber = host.plugin({ name, inject, apply: (child) => apply(child, {}) })
  await fiber.await()

  return {
    defs,
    routes,
    removed,
    fiber,
    /** webServer 迟到（由另一个 bundle 提供，顺序不保证）。 */
    async provideWebServer() {
      await startSibling(host, 'webServer', webServer)
      await waitFor(() => routes.length > 0, 'webServer 到位后端点补挂')
    },
    /** 按 Cordis 契约卸载：路由挂在子 fiber 上，随父 fiber 一起走。 */
    dispose: () => fiber.dispose(),
  }
}

test('产物冒烟：入口字段符合 cordis 契约', { skip }, async () => {
  const mod = await import(pathToFileURL(entry).href)
  assert.equal(mod.name, 'session-manager', "name 必须与 cordis.patch.yml 的 id 一致")
  assert.deepEqual(mod.inject, ['tools'], '必须 inject tools')
  assert.equal(typeof mod.apply, 'function', '必须导出 apply')
})

test('产物冒烟：在真实 Cordis fiber 里注册 5 个工具且 schema 已归一化', { skip }, async () => {
  const { defs, dispose } = await loadPlugin()

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

  await dispose()
})

test('产物冒烟：宿主提供 webServer 时挂上九条界面路由，卸载时摘掉', { skip }, async () => {
  const { routes, removed, dispose } = await loadPlugin()
  await waitFor(() => routes.length > 0, '插件激活后端点上挂')

  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path}`),
    [
      'exact /dsh-session-manager/api/state',
      'exact /dsh-session-manager/api/export',
      'exact /dsh-session-manager/api/import',
      'exact /dsh-session-manager/api/sync',
      'exact /dsh-session-manager/api/backups',
      'exact /dsh-session-manager/api/migrate',
      'exact /dsh-session-manager/api/rollback',
      'exact /dsh-session-manager/api/delete',
      'exact /dsh-session-manager/api/archive',
    ],
    '界面端点必须都在本插件命名空间下，且是精确路由',
  )
  for (const route of routes) assert.equal(typeof route.handler, 'function')

  await dispose()
  assert.deepEqual(removed.sort(), routes.map((route) => route.path).sort(), '卸载必须摘掉每条路由')
})

test('产物冒烟：没有 webServer 的 profile 也能起来（只有工具）', { skip }, async () => {
  const { defs, routes, dispose } = await loadPlugin({ withWebServer: false })

  assert.equal(defs.length, 5, '没有 webServer 时工具照旧注册')
  assert.deepEqual(routes, [], '没有 webServer 时不挂端点')
  await dispose()
})

test('产物冒烟：webServer 晚到也能补挂端点（子 fiber 等它）', { skip }, async () => {
  const plugin = await loadPlugin({ withWebServer: false })
  assert.deepEqual(plugin.routes, [], '先起来时没有端点')

  await plugin.provideWebServer()
  assert.equal(plugin.routes.length, 9, 'webServer 到位后端点必须补挂上')
  assert.equal(plugin.defs.length, 5, '补挂端点不该重复注册工具')

  await plugin.dispose()
  assert.equal(plugin.removed.length, 9, '卸载仍然摘干净')
})

test('产物冒烟：plan 在真实工作区上只读可用', { skip: realDataSkip }, async () => {
  const workspace = process.env.DSM_SMOKE_WORKSPACE
  const { defs, dispose } = await loadPlugin()

  // 计划层会用 existsSync(to) 校验目标真实存在，所以造一个工作区内的目标目录。
  const target = join(workspace, '.artifact-smoke-target')
  mkdirSync(target, { recursive: true })
  try {
    const plan = defs.find((d) => d.name === 'plan_session_migration')
    const res = await plan.execute({ from: workspace, to: target, includeArtifacts: true }, {})

    assert.equal(res.ok, true, `只读计划应当可用，problems=${JSON.stringify(res.problems)}`)
    assert.ok(res.sessions > 0, '真实工作区应当至少发现 1 个会话')
    // 这条同时钉住"可选服务探测"：effectMode 走 ctx.get，在真实 fiber 上不抛。
    assert.equal(res.takesEffect, 'restart-required')

    // 只读的证据：计划声明的目标项目目录不该被创建（项目目录名由计划自己算出，不硬编码）。
    assert.equal(existsSync(res.targetProjectDir), false, 'plan 是只读的，不应创建目标项目目录')
  } finally {
    await dispose()
    rmSync(target, { recursive: true, force: true })
  }
})
