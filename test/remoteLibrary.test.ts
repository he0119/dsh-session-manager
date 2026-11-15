// test/remoteLibrary.test.ts — 右栏那行「远端」背后的那一份地图。
//
// 这一层的两条规矩容易写坏、坏了又不报错：**一次刷新只读一次**（挂载与状态变化连着触发两下时不该发
// 两个请求，否则每开一次页面就往 NAS 上打两遍），以及**翻新时不闪**（已经读到过的那份在下一份回来
// 之前仍然是最接近真相的东西，不该先变回"正在读"）。
import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteLibraryResult } from '../src/client/api.ts'
import { createRemoteLibrary } from '../src/client/logic/remoteLibrary.ts'

/** 一份读到的结果。 */
const ready = (at = 100): RemoteLibraryResult => ({
  kind: 'ready',
  data: {
    at,
    machines: ['robot-a'],
    sessions: {
      'session-a': [{ machine: 'robot-a', path: 'dsh-session-manager/robot-a/session-a.dshsess', bytes: 12 }],
    },
    problems: [],
  },
})

/**
 * 手动控制的读法：每次调用都挂起，用例决定什么时候回、回什么。
 *
 * @returns 读法、还没回的那几次（`pending`），以及对它们逐个放行 / 打回的办法。
 */
function manualRead() {
  const queue: Array<{ resolve: (value: RemoteLibraryResult) => void; reject: (error: unknown) => void }> = []
  return {
    read: (): Promise<RemoteLibraryResult> =>
      new Promise<RemoteLibraryResult>((resolve, reject) => {
        queue.push({ resolve, reject })
      }),
    pending: () => queue.length,
    resolveNext: (value: RemoteLibraryResult): void => {
      const next = queue.shift()
      assert.ok(next !== undefined, '没有挂着的那一次读了')
      next.resolve(value)
    },
    rejectNext: (error: unknown): void => {
      const next = queue.shift()
      assert.ok(next !== undefined, '没有挂着的那一次读了')
      next.reject(error)
    },
  }
}

test('读到了就整份留在这份地图里（查表用 Map）', async () => {
  const source = manualRead()
  const store = createRemoteLibrary({ read: source.read })
  const pending = store.load()
  assert.equal(store.snapshot().status, 'loading', '读之前说一句"正在读"')
  source.resolveNext(ready())
  await pending
  const state = store.snapshot()
  assert.equal(state.status, 'ready')
  if (state.status !== 'ready') return
  assert.deepEqual(state.machines, ['robot-a'])
  assert.deepEqual(state.sessions.get('session-a'), [
    { machine: 'robot-a', path: 'dsh-session-manager/robot-a/session-a.dshsess', bytes: 12 },
  ])
  assert.deepEqual(state.problems, [])
})

test('一次刷新只读一次：连着 load 两下只发一个请求', async () => {
  const source = manualRead()
  const store = createRemoteLibrary({ read: source.read })
  const first = store.load()
  const second = store.load()
  assert.equal(source.pending(), 1, '第二下复用正在读的那一次')
  source.resolveNext(ready())
  await Promise.all([first, second])
  assert.equal(store.snapshot().status, 'ready')
})

test('翻新时不闪：已经有读到的那份时，下一趟读着仍然给旧的那份', async () => {
  const source = manualRead()
  const store = createRemoteLibrary({ read: source.read })
  const first = store.load()
  source.resolveNext(ready(100))
  await first

  const again = store.load()
  const during = store.snapshot()
  assert.equal(during.status, 'ready', '读着的时候不回到 loading')
  if (during.status === 'ready') assert.equal(during.at, 100, '手里这份还是上一次读到的')
  source.resolveNext(ready(200))
  await again
  const after = store.snapshot()
  if (after.status === 'ready') assert.equal(after.at, 200, '新的那份到了才换')
})

test('没配同步：整份地图不画（不是"读不到"）', async () => {
  const store = createRemoteLibrary({ read: async () => ({ kind: 'off' }) })
  await store.load()
  assert.equal(store.snapshot().status, 'off')
})

test('宿主回了错：把原话带上', async () => {
  const store = createRemoteLibrary({ read: async () => ({ kind: 'failed', error: '读远端索引失败：401' }) })
  await store.load()
  assert.deepEqual(store.snapshot(), { status: 'failed', error: '读远端索引失败：401' })
})

test('网络层直接挂掉（fetch 抛错）：与宿主回错同一句话交代', async () => {
  const store = createRemoteLibrary({
    read: async () => {
      throw new Error('fetch failed')
    },
  })
  await store.load()
  assert.deepEqual(store.snapshot(), { status: 'failed', error: 'fetch failed' })
})

test('订阅收到每一次变化，退订之后不再收到', async () => {
  const store = createRemoteLibrary({ read: async () => ready() })
  const seen: string[] = []
  const unsubscribe = store.subscribe((state) => seen.push(state.status))
  await store.load()
  unsubscribe()
  await store.load()
  assert.deepEqual(seen, ['loading', 'ready'], '订阅之后那一次是 loading，读完是 ready；退订之后不再收')
})
