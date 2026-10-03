// 同步事件流的分帧与解释（src/client/syncStream.ts）。
//
// 这一层是"进度条能不能动"的全部要害：一次 `response.body` 读取的边界与事件边界毫无关系，一条事件
// 被拆在两次读取之间是常态，中文标题还会让 UTF-8 的多字节跨块。解析写得糙一点，表现就是进度停在
// 第 0 条、或者整次同步报一个莫名其妙的解析错误。
//
// 分帧与解释放在一个与 DOM 无关的文件里，正是为了能这样直接测（Host 侧那份 tsconfig 没有 DOM，见
// src/client/syncStream.ts 顶上的说明）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { SseFrames, interpretSyncEvent } from '../src/client/syncStream.ts'

/** 一次喂完所有块，收集事件体（多块 = 模拟一次读取只拿到半条）。 */
function collect(chunks: string[]): string[] {
  const frames = new SseFrames()
  const out: string[] = []
  for (const chunk of chunks) out.push(...frames.push(chunk))
  out.push(...frames.flush())
  return out
}

test('SseFrames：一条事件被拆在两次读取之间也拼得回来', () => {
  assert.deepEqual(collect(['data: {"a":1}\n\ndata: {"b"', ':2}\n\n']), ['{"a":1}', '{"b":2}'])
  // 极端切法：每次只喂一个字符（真实世界里这就是 TCP 分段）。
  const oneByOne = [...'data: {"a":1}\n\ndata: {"b":2}\n\n']
  assert.deepEqual(collect(oneByOne), ['{"a":1}', '{"b":2}'])
})

test('SseFrames：一次读取里有多条事件时全部吐出来', () => {
  assert.deepEqual(collect(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n']), ['{"a":1}', '{"b":2}', '{"c":3}'])
})

test('SseFrames：CRLF 分隔与注释行（心跳）都不算事件', () => {
  // 宿主先发一行 `: connected`（那是服务器自己的心跳），它没有 `data:`，不能变成一个空事件。
  assert.deepEqual(collect([': connected\r\n\r\ndata: {"a":1}\r\n\r\n']), ['{"a":1}'])
})

test('SseFrames：多条 data 行按规范拼成一条事件（带换行）', () => {
  assert.deepEqual(collect(['data: {"a":\ndata: 1}\n\n']), ['{"a":\n1}'])
  // 分隔符那**一个**空格要被剥掉，payload 自己的缩进不能被吃掉（所以这里剩一个前导空格）。
  assert.deepEqual(collect(['data:  {"a": 1}\n\n']), [' {"a": 1}'])
})

test('SseFrames：流结束时最后一段没被空行收尾的也要吐出来', () => {
  assert.deepEqual(collect(['data: {"a":1}\n\ndata: {"b":2}']), ['{"a":1}', '{"b":2}'])
  // 只有空白（或者什么都没有）时不算一条事件。
  assert.deepEqual(collect(['\n\n', '']), [])
})

test('interpretSyncEvent：三种事件各解释成什么', () => {
  assert.deepEqual(interpretSyncEvent('{"type":"progress","progress":{"phase":"push","total":84,"done":12,"id":"s-1","label":"一"}}'), {
    kind: 'progress',
    progress: { phase: 'push', total: 84, done: 12, id: 's-1', label: '一' },
  })
  // 算计划那三段没有 id / label（不是"正在处理某一条"），解释器照原样传过去，界面按 phase 说话。
  assert.deepEqual(interpretSyncEvent('{"type":"progress","progress":{"phase":"scan","total":85,"done":42}}'), {
    kind: 'progress',
    progress: { phase: 'scan', total: 85, done: 42 },
  })
  assert.deepEqual(interpretSyncEvent('{"type":"progress","progress":{"phase":"compare","total":12,"done":7}}'), {
    kind: 'progress',
    progress: { phase: 'compare', total: 12, done: 7 },
  })
  const result = interpretSyncEvent('{"type":"result","result":{"mode":"apply","applied":true}}')
  assert.equal(result?.kind, 'result')
  assert.deepEqual(result?.kind === 'result' ? result.result : null, { mode: 'apply', applied: true })
  assert.deepEqual(interpretSyncEvent('{"type":"error","error":"写远端索引失败：磁盘满"}'), {
    kind: 'error',
    message: '写远端索引失败：磁盘满',
  })
  // 只说 type 没带那句话时也要有一句人能读的，不能是 "undefined"。
  assert.deepEqual(interpretSyncEvent('{"type":"error"}'), { kind: 'error', message: '同步失败' })
})

test('interpretSyncEvent：认不出来的一律返回 null（不让它毁掉整次同步）', () => {
  assert.equal(interpretSyncEvent('{"type":"progress"'), null, '半条 JSON：跳过它，后面的进度照旧')
  assert.equal(interpretSyncEvent('null'), null)
  assert.equal(interpretSyncEvent('"就一句话"'), null)
  assert.equal(interpretSyncEvent('{"type":"progress"}'), null, 'type 对了但没有 progress 体')
  assert.equal(interpretSyncEvent('{"type":"future-thing"}'), null, '将来宿主新加的类型')
})
