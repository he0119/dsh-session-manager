/**
 * 长动作的事件流：把宿主那段 SSE 文本翻译成"进度 / 结果 / 失败"三件事。
 *
 * 这份东西原先叫 `syncStream.ts`——那时只有同步走 SSE（见
 * [那篇决策](../../../.agents/notes/implemented/architecture/2026-10-03-sync-progress-streams-over-sse.md)）。
 * 现在**每个按下之后要等一会的动作**都走同一条流（迁移、删除、回滚、导入、归档、扫库），宿主那一侧
 * 也共用了一个 `streamResult()`，所以这里跟着改成通用名字、段名不再收窄成同步那几个。
 *
 * 为什么单独一个文件：这里每一行都是**纯字符串处理**（分帧、解释），没有 fetch 也没有 DOM。客户端
 * 半侧有两份 tsconfig，Host 侧那份**没有 DOM**——那条边界正是为了让"浏览器 API 出现在 Host 代码里"
 * 在类型层面就不成立，所以任何能被 Host 侧测试图引入的客户端文件都必须与 DOM 无关。真正的读流
 * （fetch 与 `response.body`）留在 [api.ts](../api.ts) 里，这里只认文本。
 *
 * 宿主那一侧的生产者见 `src/web.ts` 的 `sendEventStream()` / `streamResult()`；事件形状的鼻祖是
 * `src/sync.ts` 与 `src/types.ts` 的 `ProgressEvent`。
 *
 * @module dsh-session-manager/client/eventStream
 */

/**
 * 一次长动作里**一段**的进度（宿主 `ProgressEvent`，见 src/types.ts）。
 *
 * `done` 是**已经做完**的条数——事件发在开始处理下一条之前，所以正在处理的是第 `done + 1` 条。
 *
 * 段名（`phase`）是跨动作共用的一份词汇：扫库、读日志、打包、备份、改写、搬目录、写入、删除、还原、
 * 归档、落注册表、复核、补检查点，外加同步自己那五段（读远端、认仓库、比对、拉、推）。**每段各有各
 * 的分母**：`total` 是那一段要做的条数，`0` 表示这一段没有分母（一次网络往返、一次注册表落盘），界面
 * 只摆那句话、不画条。
 *
 * 这里不收窄成联合类型：将来宿主多报一段时，界面该按"这一段不认识"处理（退回一句通用的话），
 * 而不是整次动作失败。
 */
export interface ProgressEvent {
  phase: string
  total: number
  done: number
  id?: string
  label?: string
}

/**
 * SSE 的分帧器：喂进**任意切分**的文本块，吐出完整的事件体。
 *
 * 为什么要有状态：一次 `response.body` 的读取边界与事件边界毫无关系，一条事件被拆在两次读取之间是
 * 常态而不是例外（尤其事件体里有中文标题时，UTF-8 的多字节还会跨块）。所以"攒着、够一条才吐"这件
 * 事必须由它做，调用方只管把块喂进来。
 */
export class SseFrames {
  private buffer = ''

  /**
   * 喂一块文本。
   * @returns 这次能切出来的事件体（没有完整的就返回空数组）。
   */
  push(chunk: string): string[] {
    this.buffer += chunk
    // 一条事件以空行收尾；最后一段可能是半条，留着等下一块（这也是"跨块不错位"的全部秘密）。
    const blocks = this.buffer.split(/\r?\n\r?\n/)
    this.buffer = blocks.pop() ?? ''
    return blocks.map(eventData).filter((data): data is string => data !== null)
  }

  /**
   * 流结束了：把最后那段没有空行收尾的也吐出来（宿主正常会补，代理不一定）。
   * @returns 剩下的事件体。
   */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim() === '') return []
    const data = eventData(rest)
    return data === null ? [] : [data]
  }
}

/** 一个事件块里的 `data:` 行；规范允许多行，按换行拼起来才是完整的事件体。没有 `data:` 就是注释/心跳。 */
function eventData(block: string): string | null {
  const fields = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    // `data:` 后面那个空格是分隔符不是内容，只剥一个（多剥会把 payload 里的缩进吃掉）。
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))
  return fields.length === 0 ? null : fields.join('\n')
}

/** 一条事件体解释出来的东西。 */
export type StreamEvent =
  | { kind: 'progress'; progress: ProgressEvent }
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; message: string }

/**
 * 解释一条事件体。
 *
 * @param data 一条 SSE 事件的 `data:` 内容（见 `SseFrames`）。
 * @returns 认识的事件；不认识时 `null`——半条事件（解码边界上被切断）、心跳、以及将来宿主新加的
 *   类型都不该让整次动作失败。
 */
export function interpretStreamEvent(data: string): StreamEvent | null {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null) return null
  const record = event as Record<string, unknown>
  switch (record['type']) {
    case 'progress': {
      const progress = record['progress']
      if (typeof progress !== 'object' || progress === null) return null
      return { kind: 'progress', progress: progress as ProgressEvent }
    }
    case 'result':
      return { kind: 'result', result: record['result'] }
    case 'error':
      // 没带那句话时留空串：调用方按自己那个动作补一句（"同步失败" / "迁移失败"），
      // 而不是让界面上出现一个 "undefined"。
      return { kind: 'error', message: record['error'] === undefined ? '' : String(record['error']) }
    default:
      return null
  }
}
