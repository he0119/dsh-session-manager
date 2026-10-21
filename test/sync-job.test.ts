// 同步任务那一份状态（`src/client/logic/syncJob.ts`）。
//
// 为什么单独钉它：落地这趟现在可以关掉窗口继续跑，所以它的状态必须活过组件卸载——而"活过卸载"这件事
// 在界面冒烟里测不到（假 React 不会卸载、也不会跑副作用）。逻辑收在 store 里，这里就能逐条钉：跑到哪、
// 结束之后结论留多久、谁取走、认领来的那一趟怎么收尾、迟到的进度会不会把状态改回去。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createSyncJob, type SyncJobApply, type SyncJobSnapshot } from '../src/client/logic/syncJob.ts'
import type { ProgressEvent, SyncResponse, SyncRoundStatus } from '../src/client/api.ts'

const progress = (phase: string, done: number, total: number): ProgressEvent => ({ phase, done, total })

/** 一份够界面读的结果（只有用到的那几个字段是认真的）。 */
function result(pulled: number, pushed: number): SyncResponse {
  return {
    mode: 'apply',
    remote: { url: 'https://dav.example.com/dsh', machineId: 'robot-a' },
    plan: {
      ok: true,
      problems: [],
      pull: [],
      push: [],
      pullIds: [],
      pushIds: [],
      bytesIn: 0,
      bytesOut: 0,
      localCount: 0,
      remoteCount: 0,
      machines: [],
    },
    applied: true,
    pulled: Array.from({ length: pulled }, (_, index) => `pulled-${index}`),
    replaced: [],
    pushed: Array.from({ length: pushed }, (_, index) => ({ id: `pushed-${index}`, action: 'upload' as const })),
    bytesIn: 0,
    bytesOut: 0,
    registryWritten: false,
    indexWritten: true,
    problems: [],
    takesEffect: 'immediate',
  } as unknown as SyncResponse
}

const idle: SyncRoundStatus = { applying: null, last: null }

/**
 * 假的"那一路状态"（生产上是面板事件流上 `sync` 那一条）。
 *
 * `watch` 订阅时立刻用**当下那一份**回调一次（真的那一份就是这个口径），之后 `push()` 一次推一条。
 */
function fakeWatch(initial?: SyncRoundStatus): {
  watch: (listener: (status: SyncRoundStatus) => void) => () => void
  push: (status: SyncRoundStatus) => void
} {
  const listeners = new Set<(status: SyncRoundStatus) => void>()
  let latest = initial
  return {
    watch(listener) {
      if (latest !== undefined) listener(latest)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    push(status) {
      latest = status
      for (const listener of [...listeners]) listener(status)
    },
  }
}

/** 等一轮微任务 / 定时器，让 store 里那些 `.then` 落地。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('开一趟：跑着的时候看得到进度，结束后结论留着等界面取走', async () => {
  let emit: ((event: ProgressEvent) => void) | undefined
  let resolveApply: ((value: SyncResponse) => void) | undefined
  const apply: SyncJobApply = (_planId, onProgress) => {
    emit = onProgress
    return new Promise<SyncResponse>((resolve) => {
      resolveApply = resolve
    })
  }
  const job = createSyncJob({ apply, watch: fakeWatch().watch })

  assert.equal(job.snapshot().running, false, '一开始没有活儿在跑')
  assert.equal(job.start({}), true)
  assert.equal(job.snapshot().running, true, '开了之后就是在跑')
  assert.equal(job.snapshot().adopted, false, '这一趟是这一页发起的')

  emit?.(progress('push', 2, 10))
  assert.equal(job.snapshot().progress?.done, 2, '进度事件进了状态')

  resolveApply?.(result(3, 4))
  await settle()
  assert.equal(job.snapshot().running, false, '结果回来之后就不算在跑了')
  assert.equal(job.snapshot().done?.ok, true)
  assert.equal(job.snapshot().done?.result?.pulled.length, 3)

  const taken = job.takeResult()
  assert.equal(taken?.ok, true, '界面取走结论')
  assert.equal(taken?.result?.pushed.length, 4)
  assert.equal(job.snapshot().done, null, '取走即清空：第二个入口不能再把同一件事说一遍')
  assert.equal(job.takeResult(), null)
})

test('已经有一趟在跑时不再开第二趟（两趟落地会互相踩）', async () => {
  let resolveApply: ((value: SyncResponse) => void) | undefined
  let calls = 0
  const apply: SyncJobApply = () => {
    calls += 1
    return new Promise<SyncResponse>((resolve) => {
      resolveApply = resolve
    })
  }
  const job = createSyncJob({ apply, watch: fakeWatch().watch })

  assert.equal(job.start({}), true)
  assert.equal(job.start({}), false, '第二趟被拒')
  assert.equal(calls, 1, '只真发了一次')
  resolveApply?.(result(0, 0))
  await settle()
  assert.equal(job.start({}), true, '上一趟结束之后又能开')
})

test('失败也留一条结论：界面要能说清原因，而不是一片空白', async () => {
  const apply: SyncJobApply = () => Promise.reject(new Error('远端 503'))
  const job = createSyncJob({ apply, watch: fakeWatch().watch })
  job.start({})
  await settle()
  assert.equal(job.snapshot().running, false)
  assert.equal(job.snapshot().done?.ok, false)
  assert.equal(job.snapshot().done?.error, '远端 503')
})

test('迟到的进度不改已经结束的状态', async () => {
  let emit: ((event: ProgressEvent) => void) | undefined
  let resolveApply: ((value: SyncResponse) => void) | undefined
  const apply: SyncJobApply = (_planId, onProgress) => {
    emit = onProgress
    return new Promise<SyncResponse>((resolve) => {
      resolveApply = resolve
    })
  }
  const job = createSyncJob({ apply, watch: fakeWatch().watch })
  job.start({})
  resolveApply?.(result(1, 0))
  await settle()
  emit?.(progress('push', 9, 9))
  assert.equal(job.snapshot().running, false, '已经结束就不该被一条迟到的事件改回"在跑"')
  assert.equal(job.snapshot().progress, null)
})

test('刷新之后认领别处发起的那一趟：跑着就显示，跑完补上条数', async () => {
  const host = fakeWatch()
  const job = createSyncJob({
    // 这一页没有发起过任何一趟：它只听宿主推过来的那一路状态。
    apply: () => Promise.reject(new Error('不该走到这里')),
    watch: host.watch,
  })

  job.refresh()
  // 宿主说"另一趟在跑"（另一个页签点的，或者关掉窗口之后重开的页面）。
  host.push({ applying: { startedAt: 1000, progress: progress('pull', 1, 5) }, last: null })
  assert.equal(job.snapshot().running, true, '宿主说在跑，就是认领到的那一趟')
  assert.equal(job.snapshot().adopted, true, '认领来的那一趟没有逐条进度可听，界面上要分开说')
  assert.equal(job.snapshot().progress?.done, 1)

  // 宿主那边又往前走了一截：进度跟着更新（不用问，是推过来的）。
  host.push({ applying: { startedAt: 1000, progress: progress('pull', 4, 5) }, last: null })
  assert.equal(job.snapshot().progress?.done, 4, '认领来的那一趟靠宿主推过来的那条更新进度')

  // 宿主说跑完了：收尾并补上条数。
  host.push({ applying: null, last: { startedAt: 1000, finishedAt: 2000, ok: true, pulled: 5, pushed: 2 } })
  assert.equal(job.snapshot().running, false, '宿主说跑完了就收尾')
  assert.deepEqual(job.snapshot().done?.adopted, { pulled: 5, pushed: 2 }, '补上条数')
  assert.equal(job.takeResult(), null, '认领来的结论不在这条路上（它没有完整结果）')

  job.dismiss()
  assert.equal(job.snapshot().done, null, '横幅上那枚「关闭」把它清掉')
})

test('接上那一路状态时没有活儿在跑：不会把上一次的旧结论翻出来', async () => {
  const job = createSyncJob({
    apply: () => Promise.reject(new Error('不该走到这里')),
    // 宿主进程里记着"上一次早上跑过"——但这一页从没发起过，也不该在打开时旧事重提。
    watch: fakeWatch({
      applying: null,
      last: { startedAt: 1, finishedAt: 2, ok: true, pulled: 7, pushed: 7 },
    }).watch,
  })
  job.refresh()
  await settle()
  assert.equal(job.snapshot().running, false)
  assert.equal(job.snapshot().done, null, '打开设置不该弹一条上一次同步的旧结论')
})

test('那一路状态一直没说话（面板流没接上）：保持原状，不编结论', async () => {
  const job = createSyncJob({
    apply: () => Promise.reject(new Error('不该走到这里')),
    watch: () => () => {},
  })
  job.refresh()
  await settle()
  assert.equal(job.snapshot().running, false)
  assert.equal(job.snapshot().done, null)
})

test('重复 refresh() 只订一次：面板那条流上不该因为重渲染挂上一堆监听', async () => {
  let subscriptions = 0
  const job = createSyncJob({
    apply: () => Promise.reject(new Error('不该走到这里')),
    watch: () => {
      subscriptions += 1
      return () => {}
    },
  })
  job.refresh()
  job.refresh()
  job.refresh()
  assert.equal(subscriptions, 1)
})
