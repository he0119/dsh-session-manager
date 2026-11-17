// 「重新生成名称」那条端点：把点名的会话交给宿主的名称服务逐条重算。
//
// 每条会话都要整份解一次日志（实测 6MB ≈1.7 秒）再跑一次模型调用（2～3 秒），勾十条就是半分钟，所以
// 走事件流报进度。两处拒绝在流开始之前回 JSON 带状态码：一条都没勾（400）、这个宿主没有名称服务（409）。
// 子智能体不在这里拒——它不是错误，是"本来就不该动它"，由编排层按条记成跳过。
//
// @module dsh-session-manager/operations/retitle/http
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Handler, WebContext } from '../../web.ts'
import { readJson, sendJson, streamResult } from '../../shared/http/respond.ts'
import { runRetitle } from './retitle.ts'

export function retitleHandlers(ctx: WebContext): Record<string, Handler> {
  const { deps, scanForAction } = ctx

  const retitleSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: unknown
    try {
      body = await readJson(req)
    } catch {
      sendJson(res, 400, { error: '请求体不是合法 JSON' })
      return
    }
    const fields = (body ?? {}) as Record<string, unknown>
    const ids = Array.isArray(fields['sessionIds']) ? fields['sessionIds'].map((id) => String(id)) : []
    if (ids.length === 0) {
      sendJson(res, 400, { error: '请选择至少一个会话（sessionIds）' })
      return
    }
    const port = deps.titleRefresh?.()
    if (port === undefined) {
      // 如实拒绝而不是"逐条报失败"：这是**这个宿主**没有这个能力，与"某条会话算不出来"不是一回事。
      sendJson(res, 409, { error: '这个宿主没有会话名称服务（重新生成名称是它的能力），算不了标题' })
      return
    }
    const all = await scanForAction({ titles: true })
    // `includePinned`：连 `user` 源（用户改过名，或者那条标题本来是脚本 / 导入写下的）也一起重算。
    // 界面**不传**这个字段（默认语义就是"别动用户的名字"），它给一次性清理用——只有显式 `true` 才算。
    const includePinned = fields['includePinned'] === true
    await streamResult(res, async (report) => {
      const result = await runRetitle(
        {
          port,
          // 子智能体由编排层跳过（`origin === 'subagent'`）：勾父会话时它跟着来，但它的标题在侧边栏里
          // 根本看不到，请模型再算一遍纯属白花。
          sessions: all.map((session) => ({
            id: session.id,
            ...(session.title === undefined ? {} : { title: session.title }),
            subagent: session.header.origin === 'subagent',
          })),
        },
        { sessionIds: ids, ...(includePinned ? { includePinned: true } : {}) },
        { onProgress: report },
      )
      return result
    })
  }

  return {
    'POST /retitle': retitleSessions,
  }
}
