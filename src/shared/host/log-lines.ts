// src/shared/host/log-lines.ts — 往宿主 logger 里说一句话的那两个口子。
//
// 为什么单独一层：宿主的 `ctx.logger` 是 Cordis 的服务对象，`info` / `warn` 这些方法要靠**调用时的
// 接收者**才找得到导出器与缓冲。而"先把方法取出来、再调用"会把接收者丢掉：
//
//   const warn = (message) => (logger?.warn ?? logger?.info)?.(message)   // 坏的
//
// `??` 先算出一个函数值，后面那次调用就没有接收者了。Cordis 4.0.4 里这些方法是构造时绑死的箭头函数，
// 怎么调都行；4.1.0 改成了 `this()[type](...)` 的方法，脱离接收者直接抛
// `TypeError: this is not a function`。本包的 peer 范围 `^4.0.4` 收得下 4.1.0，宿主装的就是它，所以
// 这里统一写成成员调用（`logger?.info?.(m)` 与 `logger.warn(m)`），并留一个可注入的口子，让测试用
// "方法依赖 this"的 logger 把这件事钉住。
//
// 两个口子都只收一条字符串：本插件拿它说一句人话，不传结构化字段。

/** 宿主 logger 里这里用得到的两个方法。 */
export interface HostLoggerLike {
  /** 说一句普通的话。 */
  info?: (message: string) => void
  /** 说一句"少了某项能力"或"哪一步没做成"的话。 */
  warn?: (message: string) => void
}

/** 两个"说一句话"的函数。 */
export interface LogLines {
  /** 说一句普通的话。 */
  info: (message: string) => void
  /** 有 `warn` 就用它，没有就退回 `info`；两者都没有就什么都不做。 */
  warn: (message: string) => void
}

/**
 * 把宿主的 logger 收成两个函数，调用时保留接收者。
 *
 * @param logger 宿主的 `ctx.logger`（可能没有）。
 * @returns 两个只会说一句话的函数。
 */
export function logLines(logger?: HostLoggerLike): LogLines {
  return {
    info: (message) => {
      logger?.info?.(message)
    },
    warn: (message) => {
      if (logger?.warn !== undefined) logger.warn(message)
      else logger?.info?.(message)
    },
  }
}
