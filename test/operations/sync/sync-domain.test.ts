// test/operations/sync/sync-domain.test.ts — 领域那一步：开得起来就读写，开不起来就退回"不记录"。
//
// 为什么值得单独钉：存储是**可选**的。宿主没挂 storage、或者 `@deepseek-ai/dsh-storage-domain` 这个
// 模块在安装形态里解析不到，插件都还得照常工作（同步、备份、迁移是核心功能），只是页头那枚状态答不了
// "上次成没成"。所以这里用假模块 + 假领域测三条路：模块能取到时开领域、读写、搬旧记录；取不到时返回
// undefined；打开中途失败也只是 undefined，绝不抛。
//
// 这里刻意不 import 真实 `@deepseek-ai/dsh-storage-domain`，也不起宿主：那两件事的失败模式（模块解析、
// 后端路由）由安装环境决定，测试要能独立判定。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  openSyncRunStore,
  SYNC_DOMAIN_NAME,
  SYNC_DOMAIN_VERSION,
  type SyncDomainContext,
  type SyncDomainFacility,
  type SyncDomainModule,
} from '../../../src/operations/sync/sync-domain.ts'
import {
  migratedSyncStatePath,
  SYNC_RUN_KEY,
  syncRunRecordSchema,
  syncStatePath,
  type StoredSyncRun,
  type SyncRunRecord,
  type SyncRunTable,
} from '../../../src/operations/sync/sync-state.ts'

/** 领域层交给插件的那个表形状，内存版。 */
class MemoryTable implements SyncRunTable {
  readonly records = new Map<string, StoredSyncRun>()
  /** 让下一次 `put` 失败（模拟后端写不进去）。 */
  failNextPut?: Error

  get(key: typeof SYNC_RUN_KEY): StoredSyncRun {
    return this.records.get(key)
  }

  async put(key: typeof SYNC_RUN_KEY, value: StoredSyncRun): Promise<void> {
    if (this.failNextPut !== undefined) {
      const error = this.failNextPut
      this.failNextPut = undefined
      throw error
    }
    this.records.set(key, value)
  }
}

/** 假 `ctx`：只提供 effect，卸载时执行登记过的释放函数。 */
function fakeContext(): { ctx: SyncDomainContext; dispose: () => void; labels: string[] } {
  const disposers: Array<() => void> = []
  const labels: string[] = []
  return {
    ctx: {
      effect: (dispose: () => () => void, label: string) => {
        labels.push(label)
        disposers.push(dispose())
      },
    },
    dispose: () => {
      for (const close of disposers) close()
    },
    labels,
  }
}

/** 假 `ctx.storageDomain`：只实现 open（真实设施的那一半），并记下开关次数。 */
function fakeFacility(
  table: SyncRunTable,
  counts: { opened: number; closed: number },
  specSeen?: { value?: unknown },
): SyncDomainFacility {
  return {
    open: async (spec: unknown) => {
      counts.opened++
      if (specSeen !== undefined) specSeen.value = spec
      return {
        table: () => table,
        close: async () => {
          counts.closed++
        },
      }
    },
  } as unknown as SyncDomainFacility
}

interface CapturedSpec {
  name?: unknown
  version?: unknown
  layout?: unknown
  tables?: Record<string, { valueSchema?: unknown }>
}

/**
 * 假 `@deepseek-ai/dsh-storage-domain`：只留真实模块里我们用到的两个导出。
 *
 * `defineDomain` 照原样把 spec 交回来（真实实现还顺带核名字与版本，那部分由安装后的真实模块在运行
 * 时核），`domainTable` 只记下 schema——测试要确认的正是"规格长这样"。
 */
function fakeDomainModule(captured: CapturedSpec): SyncDomainModule {
  return {
    defineDomain: ((spec: unknown) => {
      Object.assign(captured, spec as CapturedSpec)
      return spec
    }) as unknown as SyncDomainModule['defineDomain'],
    domainTable: ((schema: unknown) => ({ valueSchema: schema })) as unknown as SyncDomainModule['domainTable'],
  }
}

/** 临时 `$DSH_HOME`，跑完删干净。 */
function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsm-sync-domain-'))
  return fn(home).finally(() => {
    rmSync(home, { recursive: true, force: true })
  })
}

/** 旧版 `state.json`。 */
function writeLegacy(home: string, content: unknown): void {
  mkdirSync(join(home, 'dsh-session-manager'), { recursive: true })
  writeFileSync(syncStatePath(home), JSON.stringify(content))
}

const sample: SyncRunRecord = { at: '2026-11-12T12:00:00.000Z', ok: true, pulled: 3, pushed: 2 }

/** 等一轮微任务：写是不 await 的，读之前让它落地。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('模块解析不到时退回「不记录」：不抛、只说一句', async () => {
  await withHome(async (home) => {
    const notes: string[] = []
    const { ctx } = fakeContext()
    const store = await openSyncRunStore({
      storageDomain: fakeFacility(new MemoryTable(), { opened: 0, closed: 0 }),
      ctx,
      home,
      warn: (message) => notes.push(message),
      loadDomainModule: async () => {
        throw new Error("Cannot find module '@deepseek-ai/dsh-storage-domain'")
      },
    })

    assert.equal(store, undefined, '拿不到模块 = 没有存储')
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /没有存储可用/)
    assert.match(notes[0] ?? '', /Cannot find module/)
  })
})

test('领域打不开（宿主没配后端等）也只退回「不记录」', async () => {
  await withHome(async (home) => {
    const notes: string[] = []
    const { ctx } = fakeContext()
    const store = await openSyncRunStore({
      storageDomain: {
        open: async () => {
          throw new Error("backend 'json' routed for domain 'session_manager' has no kv facet")
        },
      } as unknown as SyncDomainFacility,
      ctx,
      home,
      warn: (message) => notes.push(message),
      loadDomainModule: async () => fakeDomainModule({}),
    })

    assert.equal(store, undefined)
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /no kv facet/)
  })
})

test('领域的规格：session_manager / 版本 1 / single 布局 / 一张 sync_runs 表，schema 就是记录那条', async () => {
  await withHome(async (home) => {
    const captured: CapturedSpec = {}
    const counts = { opened: 0, closed: 0 }
    const { ctx } = fakeContext()
    await openSyncRunStore({
      storageDomain: fakeFacility(new MemoryTable(), counts),
      ctx,
      home,
      warn: () => {},
      loadDomainModule: async () => fakeDomainModule(captured),
    })

    assert.equal(captured.name, SYNC_DOMAIN_NAME)
    assert.equal(captured.name, 'session_manager')
    assert.equal(captured.version, SYNC_DOMAIN_VERSION)
    assert.equal(captured.version, 1)
    assert.equal(captured.layout, 'single')
    assert.deepEqual(Object.keys(captured.tables ?? {}), ['sync_runs'])
    assert.equal(captured.tables?.['sync_runs']?.valueSchema, syncRunRecordSchema, '表里存的就是这条 schema')
    assert.equal(counts.opened, 1)
  })
})

test('读写走那张表：写下去立刻读得回来，读不懂的记录读成没有', async () => {
  await withHome(async (home) => {
    const table = new MemoryTable()
    const { ctx } = fakeContext()
    const store = await openSyncRunStore({
      storageDomain: fakeFacility(table, { opened: 0, closed: 0 }),
      ctx,
      home,
      warn: () => {},
      loadDomainModule: async () => fakeDomainModule({}),
    })
    assert.ok(store !== undefined)

    assert.equal(store.read(), undefined, '还没写过')
    store.write(sample)
    await settle()
    assert.deepEqual(store.read(), sample)
    assert.deepEqual(table.records.get(SYNC_RUN_KEY), sample, '落在键 last 上')

    // 存着的记录形状不对（上一层 schema 已把它规整成 undefined）：读成没有，不抛。
    table.records.set(SYNC_RUN_KEY, undefined)
    assert.equal(store.read(), undefined)
  })
})

test('写失败静默：不抛、也不冒未处理的拒绝', async () => {
  await withHome(async (home) => {
    const table = new MemoryTable()
    table.failNextPut = new Error('backend is down')
    const { ctx } = fakeContext()
    const store = await openSyncRunStore({
      storageDomain: fakeFacility(table, { opened: 0, closed: 0 }),
      ctx,
      home,
      warn: () => {},
      loadDomainModule: async () => fakeDomainModule({}),
    })
    assert.ok(store !== undefined)

    assert.doesNotThrow(() => store.write(sample))
    await settle()
    assert.equal(store.read(), undefined, '没写进去就是没有')
  })
})

test('首次打开时把旧 state.json 搬进领域并改名，第二次打开什么都不做', async () => {
  await withHome(async (home) => {
    writeLegacy(home, { sync: sample })
    const table = new MemoryTable()
    const counts = { opened: 0, closed: 0 }
    const notes: string[] = []
    const first = fakeContext()

    const store = await openSyncRunStore({
      storageDomain: fakeFacility(table, counts),
      ctx: first.ctx,
      home,
      warn: (message) => notes.push(message),
      loadDomainModule: async () => fakeDomainModule({}),
    })
    assert.ok(store !== undefined)

    assert.deepEqual(store.read(), sample, '旧文件里那条已经读得到')
    assert.equal(existsSync(syncStatePath(home)), false, '旧文件改过名了')
    assert.equal(existsSync(migratedSyncStatePath(home)), true)
    assert.equal(notes.length, 1)
    assert.match(notes[0] ?? '', /state\.json\.migrated/)
  })
})

test('领域句柄挂在 ctx.effect 上：卸载时关掉它', async () => {
  await withHome(async (home) => {
    const counts = { opened: 0, closed: 0 }
    const { ctx, dispose, labels } = fakeContext()
    await openSyncRunStore({
      storageDomain: fakeFacility(new MemoryTable(), counts),
      ctx,
      home,
      warn: () => {},
      loadDomainModule: async () => fakeDomainModule({}),
    })

    assert.equal(counts.closed, 0, '还开着')
    assert.equal(labels.length, 1)
    dispose()
    assert.equal(counts.closed, 1, '卸载时关掉')
  })
})
