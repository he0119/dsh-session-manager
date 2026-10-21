// 面板那条唯一的长连接（`src/client/logic/panelEvents.ts`）。
//
// 为什么单独钉它：这一页现在全靠一条流（清单、落地那一趟、自动推送那一轮、以及"库变了"），而"断了要
// 自己接回来、接回来要重新要一份清单"这类事在界面冒烟里测不到（假 React 不跑副作用、也不会断开）。
// 逻辑收在 store 里，这里就能逐条钉：每条事件落到哪一半、断了怎么等、库变了之后怎么重读、走了之后
// 还连不连。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPanelEvents, type PanelEventsDeps } from '../src/client/logic/panelEvents.ts'
import type { PanelEvent } from '../src/client/api.ts'

/**
 * 一条假的面板流：测试自己往里推事件、自己断。
 *
 * 定时器也由测试拿着（`runTimers()` 手动走一格），这样"等 500ms 再连"不用真等。
 */
function fakeStreams(deps: Partial<PanelEventsDeps> = {}): {
  deps: PanelEventsDeps
  /** 第几次开的流（从 1 开始）；0 = 还没开过。 */
  opened: number
  /** 现在这条流开着没有。 */
  open: boolean
  /** 往现在这条流推一条事件。 */
  push: (event: PanelEvent) => void
  /** 把现在这条流断掉（模拟宿主重启 / 代理掐连接）。 */
  breakIt: () => void
  /** 走完当前排着的定时器（按时间顺序一格一格走）。 */
  runTimers: () => void
  /** 已经排着、还没走的定时器个数。 */
  pendingTimers: () => number
} {
  let onEvent: ((event: PanelEvent) => void) | null = null
  let onEnd: (() => void) | null = null
  let opened = 0
  const timers: Array<() => void> = []
  const deps_: PanelEventsDeps = {
    open: (event: (event: PanelEvent) => void, end: () => void) => {
      opened += 1
      onEvent = event
      onEnd = end
      return () => {
        onEvent = null
        onEnd = null
        end()
      }
    },
    setTimer: (handler: () => void) => {
      timers.push(handler)
      return timers.length
    },
    clearTimer: (handle: unknown) => {
      // 简单起见只清"还没走"的那一格：测试里不依赖精确清哪个。
      const at = Number(handle) - 1
      if (at >= 0 && at < timers.length) timers[at] = () => {}
    },
    ...deps,
  }
  return {
    deps: deps_,
    get opened() {
      return opened
    },
    get open() {
      return onEvent !== null
    },
    push(event: PanelEvent) {
      onEvent?.(event)
    },
    breakIt() {
      const end = onEnd
      onEvent = null
      onEnd = null
      end?.()
    },
    runTimers() {
      while (timers.length > 0) {
        const next = timers.shift()
        next?.()
      }
    },
    pendingTimers: () => timers.length,
  } as never
}

const meta = (sessionsRoot: string): PanelEvent => ({
  type: 'ready',
  meta: { sessionsRoot, registryPath: '/home/u/.dsh/registry.json', pickerKind: 'native', archiveAvailable: true, retitleAvailable: true },
})

test('连上之后：ready 摆上宿主事实，进度进"扫到第几条"，清单落地就把进度收掉', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  assert.equal(streams.opened, 1, 'start() 就是开一条流')
  assert.equal(store.snapshot().connection, 'connecting', '还没握手')

  streams.push(meta('/home/u/.dsh/sessions'))
  const afterReady = store.snapshot()
  assert.equal(afterReady.connection, 'open', '收到 ready 才算连上')
  assert.equal(afterReady.meta?.sessionsRoot, '/home/u/.dsh/sessions')
  assert.equal(afterReady.state, null, '清单还没到')

  streams.push({ type: 'progress', progress: { phase: 'scan', done: 3, total: 10 } })
  assert.deepEqual(store.snapshot().scan, { phase: 'scan', done: 3, total: 10 })

  streams.push({ type: 'snapshot', state: { sessions: [], workspaces: [] } as never })
  const afterSnapshot = store.snapshot()
  assert.deepEqual(afterSnapshot.state, { sessions: [], workspaces: [] } as never)
  assert.equal(afterSnapshot.scan, null, '清单到了就把那条进度收掉')
})

test('两种后台状态各落到自己那一半，互不覆盖', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))

  streams.push({ type: 'sync', applying: { startedAt: 100, progress: null }, last: null })
  streams.push({
    type: 'auto-push',
    running: { startedAt: 200, progress: { phase: 'push', done: 1, total: 2 } },
    last: null,
  })
  assert.deepEqual(store.snapshot().sync.applying, { startedAt: 100, progress: null })
  assert.deepEqual(store.snapshot().autoPush.running, {
    startedAt: 200,
    progress: { phase: 'push', done: 1, total: 2 },
  })

  // 落地那一趟收尾不该动自动推送那一半（反过来也一样）。
  streams.push({ type: 'sync', applying: null, last: { startedAt: 100, finishedAt: 300, ok: true, pulled: 2, pushed: 1 } })
  assert.equal(store.snapshot().sync.applying, null)
  assert.equal(store.snapshot().sync.last?.pulled, 2)
  assert.deepEqual(store.snapshot().autoPush.running?.startedAt, 200)
})

test('流断了：自己等一会儿再接回来，接上之后重新要一份清单', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [], workspaces: [] } as never })
  assert.equal(store.snapshot().connection, 'open')

  streams.breakIt()
  assert.equal(store.snapshot().connection, 'connecting', '断了就说"正在重连"（屏上那份清单先留着）')
  assert.deepEqual(store.snapshot().state, { sessions: [], workspaces: [] } as never, '断的那一刻不清空清单')
  assert.equal(streams.pendingTimers(), 1, '排了一次重连')

  streams.runTimers()
  assert.equal(streams.opened, 2, '重连是再开一条流')
  streams.push(meta('/s'))
  assert.equal(store.snapshot().connection, 'open', '接上了')
})

test('宿主说"库变了"：攒一下，只重连一次', () => {
  let clock = 1_000
  const streams = fakeStreams({ now: () => clock })
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  assert.equal(streams.opened, 1)
  // 连上已经有一会儿了（不是"刚重连过"那种情形，见下面那条用例）。
  clock += 10_000

  // 一次落地会连着改好几处：三条 stale 只该换来一次重连。
  streams.push({ type: 'stale', what: 'state' })
  streams.push({ type: 'stale', what: 'state' })
  streams.push({ type: 'stale', what: 'state' })
  assert.notEqual(store.snapshot().staleAt, null, '留下了痕（测试与排查看得见）')
  assert.equal(streams.opened, 1, '还没到点，先不重连')
  assert.equal(streams.pendingTimers(), 1, '只排了一次')

  streams.runTimers()
  assert.equal(streams.opened, 2, '重连一次，拿新清单')
  // 重连意味着旧的那条要先关掉：现在开着的只有新的那一条。
  assert.equal(streams.open, true)
})

test('刚重连过就收到 stale：不再多扫一遍库（那一趟已经把新清单拿回来了）', () => {
  let clock = 1_000
  const streams = fakeStreams({ now: () => clock })
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [], workspaces: [] } as never })

  // 动作落地之后：这一页自己重连了一次（`reload()`），紧接着面板流上又来一条 `stale`。
  void store.reload()
  assert.equal(streams.opened, 2, '重连一次')
  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [], workspaces: [] } as never })

  streams.push({ type: 'stale', what: 'state' })
  clock += 1_000 // 攒够那 600ms
  streams.runTimers()
  assert.equal(streams.opened, 2, '刚连上过：这条 stale 不再引发第二次重连（不然清单扫两遍）')

  // 隔了一会儿又来一条：那时上一次重连已经旧了，该重读。
  clock += 10_000
  streams.push({ type: 'stale', what: 'state' })
  streams.runTimers()
  assert.equal(streams.opened, 3, '真的过时了才重读')
})

test('页面走了：不重连、不扫库', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  store.stop()

  assert.equal(store.snapshot().connection, 'closed')
  assert.equal(streams.open, false, '断开那条流')
  assert.equal(streams.pendingTimers(), 0, '不排重连')

  streams.runTimers()
  assert.equal(streams.opened, 1, '走了就不再开新连接')

  // 走了之后来的事件（迟到的收尾）不该再改状态。
  const before = store.snapshot()
  streams.push({ type: 'sync', applying: null, last: null })
  assert.deepEqual(store.snapshot(), before)
})

test('refresh()：断开再连一次（手动「刷新」与"库变了"走同一条路）', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [{ id: 'a' }], workspaces: [] } as never })

  store.refresh()
  assert.equal(streams.opened, 2, '换了一条新流')
  const during = store.snapshot()
  assert.deepEqual(during.state, { sessions: [{ id: 'a' }], workspaces: [] } as never, '旧清单先留着')
  assert.equal(during.scan, null, '进度从头算')
  assert.equal(during.connection, 'connecting', '新流还没握手')
})

test('订阅者拿到的是新对象；退订之后不再收到', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  const seen: Array<string> = []
  const unsubscribe = store.subscribe((snapshot) => seen.push(`${snapshot.connection}:${snapshot.state === null ? '-' : 'state'}`))

  store.start()
  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [], workspaces: [] } as never })
  assert.deepEqual(seen, ['connecting:-', 'open:-', 'open:state'])

  unsubscribe()
  streams.push({ type: 'stale', what: 'state' })
  assert.equal(seen.length, 3, '退订之后不再收到')
})

test('reload()：等到新清单才 resolve（上一次那份不算）', async () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [{ id: 'old' }], workspaces: [] } as never })

  const pending = store.reload()
  assert.equal(streams.opened, 2, '重连一次')
  // 上一次那份清单还在：不能因为它就当场 resolve。
  let done = false
  void pending.then(() => {
    done = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(done, false, '等到的是**新**清单，不是上一次留下的那份')

  streams.push(meta('/s'))
  streams.push({ type: 'snapshot', state: { sessions: [{ id: 'new' }], workspaces: [] } as never })
  await pending
  assert.deepEqual(store.snapshot().state?.sessions, [{ id: 'new' }] as never)
})

test('reload()：这一页没连着（还没 start）就立刻 resolve，别吊着调用方', async () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  await store.reload()
  assert.equal(streams.opened, 0, '没 start 就不该开连接')
})

test('重复 start()：只连一条（重渲染不该多开连接）', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  store.start()
  store.start()
  assert.equal(streams.opened, 1)
})

test('扫库失败（宿主发 error 再收尾）：错留在快照里，随后照常重连', () => {
  const streams = fakeStreams()
  const store = createPanelEvents(streams.deps)
  store.start()
  streams.push(meta('/s'))
  streams.push({ type: 'error', error: '读不到注册表' })
  assert.equal(store.snapshot().error, '读不到注册表')

  streams.breakIt()
  streams.runTimers()
  assert.equal(streams.opened, 2, '失败也要接回来（不然这一页永远读不到库）')
  streams.push(meta('/s'))
  assert.equal(store.snapshot().error, null, '连上之后把上一条错清掉')
})
