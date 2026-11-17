// test/client/operations/manage/client-api-delete.test.ts — 「删除时同时删远端」这一下真的写进了请求体。
//
// 界面上那枚勾选框的默认值、勾/不勾，都靠 `deleteSessions()` 把 `alsoRemote` 带进请求体；漏掉它不会报错，
// 只是"勾了也没删远端"——那种坏法在界面上一模一样，所以在这里钉住。
import assert from 'node:assert/strict'
import test from 'node:test'

import { deleteSessions } from '../../../../src/client/api.ts'

/** 一份能过 `readEventStream()` 的删除响应（事件流：一条 result 收尾）。 */
function deletionStream(): Response {
  const result = {
    mode: 'apply',
    ok: true,
    preview: { ok: true, problems: [], entries: [], files: 0, bytes: 0, backupRoot: '/b' },
    applied: true,
    dirsRemoved: 1,
    removedProjectDirs: [],
    verified: true,
    problems: [],
    summary: '已删除 1 个会话',
  }
  return new Response(`data: ${JSON.stringify({ type: 'result', result })}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

/** 拦下这一下请求，把请求体交出来。 */
async function bodyOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const original = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return deletionStream()
  }) as typeof globalThis.fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
  assert.equal(bodies.length, 1, '一次调用一次请求')
  return bodies[0] as Record<string, unknown>
}

test('勾了「同时删除远端」：请求体带 alsoRemote: true', async () => {
  const body = await bodyOf(() => deleteSessions(['session-a'], 'apply', undefined, true))
  assert.deepEqual(body, { sessionIds: ['session-a'], mode: 'apply', alsoRemote: true })
})

test('没勾：请求体里没有 alsoRemote（老宿主也认这份）', async () => {
  const body = await bodyOf(() => deleteSessions(['session-a'], 'apply'))
  assert.deepEqual(body, { sessionIds: ['session-a'], mode: 'apply' })
})
