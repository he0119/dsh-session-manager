// test/retitle.test.ts — 「重新生成名称」的编排：谁被跳过、谁被重算、失败怎么报。
//
// 这个动作的**顺序与分类**是它的全部价值：宿主那一侧每一件（整份读日志、临时挂载、发模型请求）都很贵，
// 而"该不该动它"的判断如果错一边，代价是用户的名字被覆盖（pinned 被当成普通会话）或者白花一次模型
// 调用（子智能体被当成普通会话）。所以这里逐条钉死：子智能体与不在库里的不碰宿主、被跳过的照原话说、
// 一条失败不拖累其余、去重与顺序稳定。
import assert from 'node:assert/strict'
import test from 'node:test'

import { runRetitle, type RetitleDeps } from '../src/retitle.ts'
import type { ProgressEvent, RetitleOutcome, TitleRefreshPort } from '../src/types.ts'

/** 一个假端口：按 id 给结果，并把调用顺序记下来。 */
function fakePort(
  answer: (id: string) => RetitleOutcome | Promise<RetitleOutcome>,
  seen: string[] = [],
): TitleRefreshPort {
  return {
    refresh: async (id) => {
      seen.push(id)
      return answer(id)
    },
  }
}

const SESSIONS = [
  { id: 'session-a', title: '兜底名称' },
  { id: 'session-pinned', title: '我自己改的名字' },
  { id: 'session-child', title: '子会话', subagent: true },
]

test('runRetitle：子智能体与不在库里的都不碰宿主，其余按顺序交给端口', async () => {
  const seen: string[] = []
  const events: ProgressEvent[] = []
  const deps: RetitleDeps = {
    sessions: SESSIONS,
    port: fakePort((id) => ({ status: 'retitled', title: `新 ${id}` }), seen),
  }

  const result = await runRetitle(
    deps,
    { sessionIds: ['session-a', 'session-child', 'session-gone', 'session-pinned'] },
    { onProgress: (event) => events.push(event) },
  )

  // 宿主只被问到该问的：子智能体（标题看不见）与不在库里的（刚被别处删了）都不该惊动它。
  // 注意这一条**不判 pinned**：那是端口的事（它手里才有标题的来源），假端口对两条都说"重算好了"。
  assert.deepEqual(seen, ['session-a', 'session-pinned'])
  assert.deepEqual(result.retitled, [
    { id: 'session-a', title: '新 session-a' },
    { id: 'session-pinned', title: '新 session-pinned' },
  ])
  assert.deepEqual(result.skipped, [
    { id: 'session-child', reason: 'subagent' },
    { id: 'session-gone', reason: 'not-found' },
  ])
  assert.deepEqual(result.failed, [])
  assert.equal(result.ok, true, '跳过不是失败：一次都没跳过才算干净，但跳过不影响 ok')

  // 进度是"处理这一条之前"发的：done 是已经做完的条数，label 用库里的标题称呼它。
  assert.deepEqual(events, [
    { phase: 'retitle', total: 4, done: 0, id: 'session-a', label: '兜底名称' },
    { phase: 'retitle', total: 4, done: 1, id: 'session-child', label: '子会话' },
    { phase: 'retitle', total: 4, done: 2, id: 'session-gone' },
    { phase: 'retitle', total: 4, done: 3, id: 'session-pinned', label: '我自己改的名字' },
  ])
})

test('runRetitle：端口抛错记成这一条的失败，其余照常算完', async () => {
  const result = await runRetitle(
    {
      sessions: SESSIONS,
      port: fakePort((id) => {
        if (id === 'session-pinned') throw new Error('session-title-llm: 请求超时')
        return { status: 'unchanged', title: '算过了但没变' }
      }),
    },
    { sessionIds: ['session-a', 'session-pinned'] },
  )

  assert.equal(result.ok, false, '有失败项时 ok 必须是 false')
  assert.deepEqual(result.failed, [{ id: 'session-pinned', error: 'session-title-llm: 请求超时' }])
  assert.deepEqual(result.unchanged, [{ id: 'session-a', title: '算过了但没变' }])
  assert.deepEqual(result.retitled, [], '没变的那条不该被算进"改了"')
})

test('runRetitle：端口报成 failed 的与抛出来的说法一致（都进 failed 清单）', async () => {
  const result = await runRetitle(
    {
      sessions: SESSIONS,
      port: fakePort((id) =>
        id === 'session-a'
          ? { status: 'failed', error: '输入超过 65536 字节' }
          : { status: 'skipped', reason: 'pinned' },
      ),
    },
    { sessionIds: ['session-a', 'session-pinned'] },
  )

  assert.deepEqual(result.failed, [{ id: 'session-a', error: '输入超过 65536 字节' }])
  assert.deepEqual(result.skipped, [{ id: 'session-pinned', reason: 'pinned' }])
})

test('runRetitle：重复的 id 只算一次，且顺序按第一次出现', async () => {
  const seen: string[] = []
  const result = await runRetitle(
    { sessions: SESSIONS, port: fakePort(() => ({ status: 'retitled', title: '新' }), seen) },
    { sessionIds: ['session-pinned', 'session-a', 'session-pinned', 'session-a'] },
  )

  assert.deepEqual(seen, ['session-pinned', 'session-a'])
  assert.deepEqual(
    result.retitled.map((entry) => entry.id),
    ['session-pinned', 'session-a'],
  )
})

test('runRetitle：这个宿主没有名称服务时，每条都如实记成跳过而不是抛错', async () => {
  const result = await runRetitle(
    { sessions: SESSIONS, port: undefined },
    { sessionIds: ['session-a', 'session-pinned'] },
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.skipped, [
    { id: 'session-a', reason: 'no-title-provider' },
    { id: 'session-pinned', reason: 'no-title-provider' },
  ])
})

test('runRetitle：一条都没点名时什么都不做（端点在那之前已经拒了空清单）', async () => {
  const seen: string[] = []
  const result = await runRetitle(
    { sessions: SESSIONS, port: fakePort(() => ({ status: 'retitled', title: '新' }), seen) },
    { sessionIds: [] },
  )

  assert.deepEqual(seen, [])
  assert.deepEqual(result, { ok: true, retitled: [], unchanged: [], skipped: [], failed: [] })
})

test('runRetitle：includePinned 逐次原样交给端口（默认是明确的 false，不是"没带"）', async () => {
  /** 端口那侧只看得到"要不要连 `user` 源一起算"，所以它必须逐次收到编排层的决定。 */
  const given: Array<{ includePinned?: boolean } | undefined> = []
  const port: TitleRefreshPort = {
    refresh: async (_id, options) => {
      given.push(options)
      return { status: 'retitled', title: '新' }
    },
  }

  await runRetitle({ sessions: SESSIONS, port }, { sessionIds: ['session-a'] })
  await runRetitle({ sessions: SESSIONS, port }, { sessionIds: ['session-a'], includePinned: true })
  await runRetitle({ sessions: SESSIONS, port }, { sessionIds: ['session-a'], includePinned: false })

  assert.deepEqual(given, [
    { includePinned: false },
    { includePinned: true },
    { includePinned: false },
  ])
})
