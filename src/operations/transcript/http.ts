// 「一条会话的完整内容」那条端点：只读、不动宿主内存。
//
// 内容视图翻页与「查看全文」都走这里；日志的解压有缓存（见 log-text-cache.ts），同一条会话连着读
// 几页只解一次。分页与渲染在 transcript.ts，这里只把查询参数翻成它认识的请求。
//
// @module dsh-session-manager/operations/transcript/http
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Handler, WebContext } from '../../web.ts'
import { locateSession } from '../../shared/library/discovery.ts'
import { intParam, sendJson } from '../../shared/http/respond.ts'
import { readTranscript } from './transcript.ts'

export function transcriptHandlers(ctx: WebContext): Record<string, Handler> {
  const { paths, decodeAll, resolveTitle, projection, logs } = ctx

  /**
   * 解析一条会话的内容：把日志折成"能从头读到尾的完整时间线"（见 transcript.ts）。
   *
   * 一次性响应而不是事件流：这是**一次读一份文件**（最大的那份 6 MB 左右，用户点开时才读），没有逐条
   * 进度可报；真正要防的是"整库倒进浏览器"，那件事由分页参数（`from` / `limit`）与核心层每页的字符
   * 上限一起挡住——所以它读的是**最高代次**那一份日志（宿主自己也是这么挑的），一次只解析一页事件。
   *
   * 定位这一条会话用 `locateSession()`，**不扫整库**：整库 1295 条要 1.4 秒量级，而这里只关心一条；
   * 目录名就是 id 的编码，走一遍项目目录找同名目录、只读它那一份 header 就够（实测几毫秒）。内容视图
   * 每翻一页都要发一次这个请求，那一秒多会被乘以页数。
   *
   * 读日志用 `logs`（log-text-cache.ts）：同一份日志连着读好几页时只解压一次；日志变了（大小或
   * 修改时间变了）才重新读。
   *
   * 三处拒绝都在响应体里说清楚：没给 id（400）、会话库里没这条（404）、日志整份读不出来（422，例如
   * header 坏了）。坏行**不算**拒绝——那种行由核心层如实记进 `problems`，其余事件照旧摆出来。
   */
  const transcript = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const id = (url.searchParams.get('id') ?? '').trim()
    if (id === '') {
      sendJson(res, 400, { error: '缺少会话 id（?id=…）' })
      return
    }
    // 标题与 `/state` 同源（`resolveTitle` 先宿主投影缓存、后有界前缀）：内容视图顶上那行标题
    // 该和列表里显示的是同一个，别自己再折一次。投影记录由扫描那条路读一次的那份缓存里取
    // （`projection` 命中时连文件都不读），所以这里不会为一条会话再整份解一次投影文件。
    const session = await locateSession(paths.sessionsRoot, id, decodeAll, { projection, resolveTitle })
    if (session === undefined) {
      sendJson(res, 404, { error: `会话库里没有 ${id}` })
      return
    }
    // 代次日志：`session.v4.jsonl.zstd` 这种文件名里的版本号是格式代次，宿主读的也是最高的那一份
    // （低的那些是历史档）。库里实测 583 个会话目录都只有一份，但按代次挑才是跟宿主一致的做法。
    const file = [...session.files].sort((left, right) => right.version - left.version)[0]
    if (file === undefined) {
      sendJson(res, 422, { error: '这条会话目录里没有日志文件' })
      return
    }
    try {
      // `decodeAll` 是多帧感知的：一份日志的 JSONL 是分帧压的，单帧解不出全貌。这里走缓存那一层，
      // 它内部用的是分块解压（块与块之间让出事件循环），整份解压不会把宿主主线程按死。
      const lines = await logs.linesOf({ path: file.path, compression: file.compression })
      const page = readTranscript(lines, {
        from: intParam(url, 'from'),
        limit: intParam(url, 'limit'),
        maxChars: intParam(url, 'maxChars'),
      })
      sendJson(res, 200, {
        ...page,
        session: {
          id: session.id,
          title: session.title ?? null,
          cwd: session.cwd ?? null,
          createdAt: session.createdAt,
          bytes: file.bytes,
          file: file.name,
          generation: file.version,
          // 这条目录里一共有几代日志：界面上"这就是全部内容"的说法要跟它一致。
          generations: session.files.length,
        },
      })
    } catch (error) {
      sendJson(res, 422, {
        error: `这份日志读不出来：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    'GET /transcript': transcript,
  }
}
