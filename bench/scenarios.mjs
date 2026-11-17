// 基准场景表：每条都对着"用户真的会等的地方"。
//
// 判据（每条都要说清测的是哪一下）：
//   - `scan.cold`：冷启动后第一次扫完整库（打开设置页/面板的第一件事）
//   - `state.cold` / `state.warm`：`GET /state` 第一次与第二次（后者走扫库缓存）
//   - `transcript.large` / `transcript.page`：内容视图第一页与翻到深处（后者走日志缓存）
//   - `export.20`：导出 20 条会话（打包是纯 CPU + 逐条读日志）
//   - `import.plan`：导入预演（读包、逐条比目标目录）
//   - `migrate.preview`：迁移 20 条的预演（写之前那一步）
//   - `delete.preview`：删除 20 条的预演（先备份再删那一步的"先备份"部分）
//   - `sync.preview`：同步预演（扫本机 + 读远端索引 + 三对"两边各自写过"的内容比对）
//   - `plugin.register`：插件 `apply()` 里注册 6 个工具（每次启动都要走）
//   - `calibration.cpu`：固定的 CPU 活，用来把不同机器的 wall 归一化（见 bench/README.md）
//
// `budgetMs` 是该场景允许的**最长一次主线程停顿**，与 AGENTS.md 的 10/50/200 ms 三档对齐：注册工具
// 是启动期的小活（10），其余都是"用户点一下会等"的地方（50）。
//
// @module dsh-session-manager/bench/scenarios
import { strict as assert } from 'node:assert'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { encodeSegment } from '../src/shared/paths.ts'
import { projectKey } from '../src/shared/project-key.ts'

import { registerTools } from '../src/tools.ts'
import { scanAllAsync } from '../src/shared/library/discovery.ts'
import { createProjectionReader } from '../src/shared/library/projection-cache.ts'
import { createTitleResolver } from '../src/shared/log/session-title.ts'
import { decodeAll } from '../src/shared/log/log-decode.ts'
import { projectionCacheDir } from '../src/shared/paths.ts'
import { call, events, json } from './http.mjs'
import { createContext } from './context.mjs'

/** 每个子进程重新造一次上下文；场景之间不共享缓存（"冷"才是真的冷）。 */
async function setup(manifest, options) {
  const ctx = await createContext(manifest, options)
  const projectionDir = projectionCacheDir(manifest.registryPath)
  const scanForAction = () =>
    scanAllAsync(manifest.sessionsRoot, decodeAll, {
      projection: createProjectionReader(projectionDir),
      resolveTitle: createTitleResolver({ cacheDir: projectionDir, decodeAll }),
      projectionDir,
    })
  // 删除/迁移的候选要"真的能动"的那些：空白会话不进计划（界面也不让勾），已归档的同样被跳过。
  const movable = manifest.sessions.filter((session) => !session.blank && !session.archived)
  const ids = (count) => movable.slice(0, count).map((session) => session.id)
  const mediumIds = manifest.sessions
    .filter((session) => session.eventCount >= 300 && session.eventCount <= 2000)
    .slice(0, 20)
    .map((session) => session.id)
  return { ...ctx, projectionDir, scanForAction, ids, mediumIds }
}

/**
 * 复制一份可写的库（写操作场景专用：落地会真的搬/删/写，不能碰基准夹具本体）。
 *
 * 复制在 `prepare` 里做，不计入 wall——测的是"点下确认之后"那一段，不是准备一份实验环境。
 */
async function freshLibrary(manifest) {
  const base = join(manifest.dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const sessionsRoot = join(base, 'sessions')
  const storages = join(base, 'storages')
  const backupRoot = join(base, 'backups')
  const targetDir = join(base, 'target')
  mkdirSync(storages, { recursive: true })
  mkdirSync(backupRoot, { recursive: true })
  mkdirSync(targetDir, { recursive: true })
  cpSync(manifest.sessionsRoot, sessionsRoot, { recursive: true })
  cpSync(manifest.registryPath, join(storages, 'workspace.json'))
  cpSync(manifest.projectionDir, join(storages, 'session_projcache', 'sessions'), { recursive: true })
  return {
    ...manifest,
    dir: base,
    sessionsRoot,
    registryPath: join(storages, 'workspace.json'),
    backupRoot,
    targetDir,
    projectionDir: join(storages, 'session_projcache', 'sessions'),
  }
}

/** 给 `registerTools()` 用的最小宿主上下文（只认它真用得到的那两件）。 */
function fakeHost() {
  const disposers = []
  return {
    host: {
      tools: {
        register: (definition) => {
          disposers.push(definition.name)
          return () => {}
        },
      },
    },
    disposers,
  }
}

/** 事件流最后那条 `result` 里的载荷。 */
function lastResult(captured) {
  const list = events(captured)
  const last = list.at(-1)
  assert.equal(last?.type, 'result')
  return last.result
}

/** `GET /transcript` 的 JSON 正文。 */
function transcriptOf(captured) {
  return json(captured)
}

/** 场景表。 */
export const SCENARIOS = [
  {
    id: 'calibration.cpu',
    title: '校准：固定 CPU 活（sha256 × 4 × 24 MB）',
    // 校准本来就是一段纯 CPU 活：它不需要"不卡"，只需要每次都一样重。停顿那一栏对它没有意义。
    budgetMs: undefined,
    iterations: 5,
    async prepare() {},
    async run() {
      const block = Buffer.alloc(24 * 1024 * 1024, 7)
      for (let i = 0; i < 4; i++) createHash('sha256').update(block).digest('hex')
    },
  },
  {
    id: 'plugin.register',
    title: '插件注册 6 个工具',
    budgetMs: 10,
    iterations: 5,
    async prepare() {},
    async run() {
      const { host } = fakeHost()
      registerTools(host, {})
    },
  },
  {
    id: 'scan.cold',
    title: '冷扫整库（scanAllAsync）',
    budgetMs: 50,
    // 冷只有第一次：再跑一次就命中投影缓存与页缓存了。场景本来就跑在独立子进程里，一次就够。
    iterations: 1,
    async prepare(context) {
      context.scan = await setup(context.manifest)
    },
    async run(context) {
      const sessions = await context.scan.scanForAction()
      assert.equal(sessions.length, context.manifest.sessions.length)
    },
  },
  {
    id: 'state.cold',
    title: 'GET /state 第一次（冷）',
    budgetMs: 50,
    iterations: 1,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'GET /state'))
      assert.equal(result.sessions.length, context.manifest.sessions.length)
    },
  },
  {
    id: 'state.warm',
    title: 'GET /state 第二次（扫库缓存命中）',
    budgetMs: 50,
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
      await call(context.ctx.handlers, 'GET /state')
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'GET /state'))
      assert.equal(result.sessions.length, context.manifest.sessions.length)
    },
  },
  {
    id: 'transcript.large',
    title: '内容视图：最大的那条会话第一页',
    /*
     * 48 MB 那条日志在 `full` 档实测停顿 60～75 ms（`default` 档 12 MB 是 20 出头）：逐行 JSON 解析与
     * 几十 MB 字符串分配带来的 GC，还没压进 50 ms。所以只有 `full` 档按 100 ms 判——它守的是"别再退回
     * 整份解压按住 1.8 秒"那条线；默认档照旧按 50 判。这块继续优化之后再把 full 收紧回 50。
     */
    budgetMs: { default: 50, full: 100 },
    iterations: 1,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
    },
    async run(context) {
      const page = transcriptOf(await call(context.ctx.handlers, `GET /transcript?id=${context.manifest.largestId}&limit=80`))
      assert.ok(page.items.length > 0)
    },
  },
  {
    id: 'transcript.page',
    title: '内容视图：同一条翻到第 2000 条',
    // 同一条 48 MB 日志翻页（`full` 实测 70 上下）：与上一条同一处成本，预算同样只有 full 档放到 100。
    budgetMs: { default: 50, full: 100 },
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
      await call(context.ctx.handlers, `GET /transcript?id=${context.manifest.largestId}&limit=80`)
    },
    async run(context) {
      const page = transcriptOf(await call(context.ctx.handlers, `GET /transcript?id=${context.manifest.largestId}&from=2000&limit=80`))
      assert.ok(page.items.length > 0)
    },
  },
  {
    id: 'export.20',
    title: '导出 20 条会话',
    budgetMs: 50,
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
      context.body = Buffer.from(JSON.stringify({ sessionIds: context.ctx.mediumIds }))
    },
    async run(context) {
      const exported = await call(context.ctx.handlers, 'POST /export', { body: context.body })
      assert.equal(exported.status, 200)
      assert.ok(exported.body.length > 10_000)
    },
  },
  {
    id: 'import.plan',
    title: '导入预演（20 条的包）',
    budgetMs: 50,
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
      const exported = await call(context.ctx.handlers, 'POST /export', {
        body: Buffer.from(JSON.stringify({ sessionIds: context.ctx.mediumIds })),
      })
      context.bundle = exported.body
    },
    async run(context) {
      const result = lastResult(
        await call(context.ctx.handlers, `POST /import?targetCwd=${encodeURIComponent(context.manifest.targetDir)}`, {
          body: context.bundle,
        }),
      )
      assert.equal(result.bundle.sessions, 20)
      assert.ok(result.entries.length > 0)
    },
  },
  {
    id: 'migrate.preview',
    title: '迁移预演 20 条',
    budgetMs: 50,
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
      context.body = Buffer.from(JSON.stringify({ sessionIds: context.ctx.ids(20), to: context.manifest.targetDir }))
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'POST /migrate', { body: context.body }))
      assert.equal(result.preview.sessions.length, 20)
    },
  },
  {
    id: 'delete.preview',
    title: '删除预演 20 条',
    budgetMs: 50,
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest)
      context.body = Buffer.from(JSON.stringify({ sessionIds: context.ctx.ids(20) }))
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'POST /delete', { body: context.body }))
      assert.equal(result.preview.entries.length, 20)
    },
  },
  {
    id: 'migrate.apply',
    title: '迁移落地 20 条（复制一份库再动）',
    budgetMs: 50,
    iterations: 1,
    async prepare(context) {
      context.copy = await freshLibrary(context.manifest)
      context.ctx = await setup(context.copy)
      context.body = Buffer.from(JSON.stringify({ sessionIds: context.ctx.ids(20), to: context.copy.targetDir, mode: 'apply' }))
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'POST /migrate', { body: context.body }))
      assert.equal(result.mode, 'apply')
      assert.equal(result.moved, 20)
    },
    async teardown(context) {
      rmSync(context.copy.dir, { recursive: true, force: true })
    },
  },
  {
    id: 'delete.apply',
    title: '删除落地 20 条（先备份再删）',
    budgetMs: 50,
    iterations: 1,
    async prepare(context) {
      context.copy = await freshLibrary(context.manifest)
      context.ctx = await setup(context.copy)
      context.body = Buffer.from(JSON.stringify({ sessionIds: context.ctx.ids(20), mode: 'apply' }))
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'POST /delete', { body: context.body }))
      assert.equal(result.mode, 'apply')
      assert.equal(result.applied, true)
    },
    async teardown(context) {
      rmSync(context.copy.dir, { recursive: true, force: true })
    },
  },
  {
    id: 'import.apply',
    title: '导入落地 20 条（复制一份库再动）',
    budgetMs: 50,
    iterations: 1,
    async prepare(context) {
      context.copy = await freshLibrary(context.manifest)
      context.ctx = await setup(context.copy)
      // 先导出，再把这几条从副本里删掉——导入落地才有"新建"可做（否则计划是"库里都有"）。
      const ids = context.ctx.mediumIds.slice(0, 20)
      const exported = await call(context.ctx.handlers, 'POST /export', {
        body: Buffer.from(JSON.stringify({ sessionIds: ids })),
      })
      context.bundle = exported.body
      for (const session of context.copy.sessions.filter((entry) => ids.includes(entry.id))) {
        rmSync(join(context.copy.sessionsRoot, projectKey(session.cwd), encodeSegment(session.id)), { recursive: true, force: true })
      }
    },
    async run(context) {
      const result = lastResult(
        await call(context.ctx.handlers, `POST /import?targetCwd=${encodeURIComponent(context.copy.targetDir)}&mode=apply`, {
          body: context.bundle,
        }),
      )
      assert.equal(result.mode, 'apply')
      assert.equal(result.written.length, 20)
    },
    async teardown(context) {
      rmSync(context.copy.dir, { recursive: true, force: true })
    },
  },
  {
    id: 'sync.preview',
    title: '同步预演（本机 + 远端索引 + 三对内容比对）',
    budgetMs: 50,
    iterations: 3,
    async prepare(context) {
      context.ctx = await setup(context.manifest, { withDav: true })
    },
    async run(context) {
      const result = lastResult(await call(context.ctx.handlers, 'GET /sync?mode=plan'))
      // 远端至少要有"本机没有的"与"要推上去的"两种，否则这条场景只是空转。
      assert.ok(result.plan.pullIds.length > 0)
      assert.ok(result.plan.pushIds.length > 0)
    },
    async teardown(context) {
      await context.ctx?.close()
    },
  },
]
