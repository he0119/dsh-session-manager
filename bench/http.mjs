// 打真实 handler 的最小 req/res 适配器（不起 HTTP 服务）。
//
// 为什么要打 handler 而不是直接调编排：基准要覆盖"界面点一下"这条路的全部形状——读参数、算清单、
// 序列化 JSON、把长动作摊成 SSE。直接调编排会漏掉序列化与组装的开销，也会漏掉那些"先算一份摘要"的
// 重复工作。
//
// @module dsh-session-manager/bench/http
import { EventEmitter } from 'node:events'

/** 造一个只读的请求（GET 用）。 */
export function fakeRequest({ method = 'GET', url = '/', body } = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.url = url
  emitter.destroy = () => {}
  queueMicrotask(() => {
    if (body !== undefined && body.length > 0) emitter.emit('data', body)
    emitter.emit('end')
  })
  return emitter
}

/** 造一个把响应攒进内存的响应对象。 */
export function fakeResponse() {
  const captured = { status: 0, headers: {}, body: Buffer.alloc(0) }
  let headersSent = false
  let ended = false
  const closeHandlers = []
  const push = (chunk) => {
    captured.body = Buffer.concat([captured.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
  }
  const res = {
    get headersSent() {
      return headersSent
    },
    get writableEnded() {
      return ended
    },
    on(event, handler) {
      if (event === 'close') closeHandlers.push(handler)
      return res
    },
    writeHead(status, headers) {
      captured.status = status
      Object.assign(captured.headers, headers ?? {})
      headersSent = true
      return res
    },
    write(chunk) {
      push(chunk)
      return true
    },
    end(chunk) {
      if (chunk !== undefined) push(chunk)
      headersSent = true
      ended = true
    },
  }
  return { res, captured, close: () => closeHandlers.splice(0).forEach((handler) => handler()) }
}

/**
 * 打一条路由。
 * @param handlers `createApiHandlers()` 的返回值。
 * @param key 形如 `GET /state`、`POST /import?targetCwd=…`。
 * @param options.body 请求体。
 * @returns `{ status, headers, body }`（JSON 或 SSE 原文）。
 */
export async function call(handlers, spec, options = {}) {
  const [head, search = ''] = spec.split('?')
  const [method, path] = head.split(' ')
  const handler = handlers[head] ?? handlers[`GET|POST ${path}`]
  if (handler === undefined) throw new Error(`没有这条路由：${spec}`)
  const { res, captured } = fakeResponse()
  const url = search === '' ? path : `${path}?${search}`
  await handler(fakeRequest({ method, url, body: options.body }), res)
  return captured
}

/** 把 SSE 响应拆成事件数组。 */
export function events(captured) {
  return captured.body
    .toString('utf8')
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter((line) => line !== undefined)
    .map((line) => JSON.parse(line.slice('data:'.length).trim()))
}

/** 把一次性响应当 JSON 读。 */
export function json(captured) {
  return JSON.parse(captured.body.toString('utf8'))
}
