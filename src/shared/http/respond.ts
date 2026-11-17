// 界面端点共用的传输层：读请求体、回 JSON / 字节、把长动作跑成 SSE。
//
// 为什么单独一层：这套形状原先只有 `/sync` 有（见
// [同步那篇决策](../../../.agents/notes/implemented/architecture/2026-10-03-sync-progress-streams-over-sse.md)），
// 而"按下到结束之间没有任何反馈"是所有长动作共有的毛病；地基抽在这里之后，各端点只负责"报哪几段"。
//
// 这一层零 DSH 依赖、也不认识任何业务类型：只认 `IncomingMessage` / `ServerResponse` 与一个进度回调。
//
// @module dsh-session-manager/shared/http/respond
import type { IncomingMessage, ServerResponse } from 'node:http'

import { concatBuffersAsync } from '../text-chunks.ts'
import type { ProgressReporter } from '../types.ts'

/** 请求体上限：一个会话包可能有几十 MB，给足；再大的一律拒掉而不是把它读进内存。 */
export const MAX_BODY_BYTES = 512 * 1024 * 1024

/** 一个路由 handler：拿到请求与响应就不用还。 */
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${limit} 字节`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      void concatBuffersAsync(chunks).then(resolve, reject)
    })
    req.on('error', (error: Error) => reject(error))
  })
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function sendBytes(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': String(body.length), 'cache-control': 'no-store', ...headers })
  res.end(body)
}

/**
 * 把响应切成事件流（SSE）。
 *
 * 为什么这里需要流：同步是唯一"按条走网络"的长动作——一次整库同步可能是几百次往返，界面只有一句
 * "同步中…"时，用户没有任何办法判断它在推进还是卡住了。宿主 `webServer` 的路由 handler
 * **owning the full response lifecycle**（`WebRoute.handler` 的契约原文，允许一直握着响应，SSE
 * 就是它举的例子），所以这里可以直接写。
 *
 * `x-accel-buffering: no` 是给反向代理看的：默认它们会攒够一段缓冲才转发，攒着就等于没有进度。
 * 压缩中间件按 `content-type` 前缀判断并从压缩里**豁免** SSE（宿主那一层的 filter 里写死的），
 * 所以这里不必再管 gzip。
 */
export function sendEventStream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/**
 * 写一条 SSE 事件（事件体是一行 JSON，形状为 `{ type, ... }`）。
 *
 * `uncork()` 那一句是**必须有**的，不是保险：`res.write()` 每次都会把 socket 重新 cork 住（实测
 * `writableCorked` 从 0 变 1、`writableLength` 就是这条事件），Node 要等下一次事件循环才把它推给内核。
 * 而报进度的这些循环是**同步**的——读日志、改首帧、搬目录中间一次 `await` 都没有——所以不主动
 * uncork 的话，一整段干完之前一个字节都发不出去，所有事件在结束时一起到，进度条会从"正在准备…"
 * 直接跳到做完（跨进程实测：不 uncork 五条事件全在 1537ms 到达，uncork 之后是 33/330/630/930/1230ms）。
 * 同步那条路本来能走，是因为它每一步都在 await 网络往返，事件循环自然会转。
 *
 * `res.socket` 用可选链：万一响应被中间件包过一层（没有 socket），退化成原来的行为，而不是抛错。
 * 多调用几次 uncork 是无害的（实测不抛错、不影响正文）。
 */
export function sendEvent(res: ServerResponse, event: unknown): void {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.socket?.uncork()
}

/**
 * 把一个长动作跑成事件流：`{type:'progress'}` 每做一条一次、`{type:'result'}` 收尾、`{type:'error'}`
 * 兜底。
 *
 * 为什么是**共用一个**而不是每个端点各写一遍：这套形状原先只有 `/sync` 有（见
 * [同步那篇决策](../.agents/notes/implemented/architecture/2026-10-03-sync-progress-streams-over-sse.md)），
 * 而"按下到结束之间没有任何反馈"是**所有**长动作共有的毛病——迁移应用实测 47 条 / 67.5 MB 要 45 秒
 * （逐条改写首帧占 45 秒），导入应用 250 条 / 70.9 MB 要 19 秒，那些时间里界面只有一个不动的按钮。
 * 地基抽在这里，各端点只负责"报哪几段"。
 *
 * 两段流之外的**判定**（参数不对、这个宿主没这个能力、备份目录越界）仍然在流开始**之前**回一次性
 * JSON 带状态码——那时还没有任何一个字节发出去，用状态码说比用事件说清楚。流一旦开始，HTTP 状态
 * 就已经是 200 了，之后的错只能靠 `{type:'error'}` 说（客户端按 `content-type` 分流）。
 *
 * @param res 响应对象（`webServer` 的路由 handler 拥有完整的响应生命周期，SSE 就是它举的例子）。
 * @param run 真正干活的那一段；`report` 是同步调用、不 await 的上报口（实现里不许抛）。
 */
export async function streamResult(
  res: ServerResponse,
  run: (report: ProgressReporter) => Promise<unknown> | unknown,
): Promise<void> {
  sendEventStream(res)
  try {
    const result = await run((progress) => sendEvent(res, { type: 'progress', progress }))
    sendEvent(res, { type: 'result', result })
  } catch (error) {
    sendEvent(res, { type: 'error', error: error instanceof Error ? error.message : String(error) })
  }
  res.end()
}

/** 读注册表；文件缺失或坏掉都只记为问题，不拦住"列出会话"。 */

export async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const body = await readBody(req, limit)
  return JSON.parse(body.toString('utf8') || '{}')
}

/**
 * 读一个整数查询参数。
 *
 * 缺席或不是整数时返回 `undefined`——那是"调用方没提要求"，该由核心层用它自己的缺省值；**不回落成
 * 0**：`?limit=` 与 `?limit=abc` 都不该被当成"只看一条"。
 */
export function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/** 目标目录必须真实存在：header.cwd 指向一个不存在的目录，导入或迁移出来的会话是坏的。 */
