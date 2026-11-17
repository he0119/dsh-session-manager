// src/operations/sync/remote-write.ts — 同一台机器的远端格子，同一时间只让一件事写。
//
// 远端是「一台机器一格包 + 一份 index.json」：手动同步、整理远端、删除时清远端、后台自动推送、
// 模型工具 sync_sessions 都会整份重写这台机器那一格的索引。它们各自在开始前读一次远端，落地时再写；
// 两件事一起跑时，后写的那个拿的是较早读到的快照，会把前一个刚写进去的条目盖掉——轻则丢一条推送，
// 重则把刚留下的删除记录抹掉，下一次同步又把删掉的会话拉回来。
//
// 这把锁是**进程内**的：一个插件实例造一个，五个入口共用。跨进程（桌面版和 Web 版同时跑）挡不住，
// 那一层要靠 WebDAV 的条件写（ETag / If-Match），这里不做：不是所有服务器都支持，先解决同一进程里
// 已经能确认的那一类。
//
// 零 DSH 依赖，可独立测试。

/** 现在拿着写权限的那一件事。 */
export interface RemoteWriteOwner {
  /** 给人看的名字：`同步` / `整理远端` / `删除远端` / `自动推送`。 */
  label: string
  /** 什么时候拿到的（毫秒时间戳），用在"上一轮…还在跑"那句话里。 */
  startedAt: number
}

/** 写远端格子的互斥锁。 */
export interface RemoteWriteGate {
  /**
   * 试着拿写权限。
   * @param label 这件事的名字（出现在占用提示里）。
   * @returns 释放函数；已经有人拿着时返回 `undefined`，调用方据此拒绝或跳过这一轮。
   */
  tryAcquire(label: string): (() => void) | undefined
  /** 现在谁拿着；没人拿着时 `undefined`。 */
  current(): RemoteWriteOwner | undefined
}

/**
 * 造一把互斥锁。
 * @param now 取时刻的办法（测试注入假时钟）。
 */
export function createRemoteWriteGate(now: () => number = Date.now): RemoteWriteGate {
  let owner: (RemoteWriteOwner & { token: object }) | undefined
  return {
    tryAcquire(label: string): (() => void) | undefined {
      if (owner !== undefined) return undefined
      const token = {}
      owner = { label, startedAt: now(), token }
      let released = false
      return (): void => {
        if (released) return
        released = true
        // 只释放自己拿的那一次：万一将来加了"超时夺锁"，旧句柄不能把新持有者放掉。
        if (owner?.token === token) owner = undefined
      }
    },
    current(): RemoteWriteOwner | undefined {
      if (owner === undefined) return undefined
      return { label: owner.label, startedAt: owner.startedAt }
    },
  }
}


export function remoteBusyMessage(owner: RemoteWriteOwner | undefined): string {
  if (owner === undefined) return '另一件事正在写远端，等它结束再试'
  return `上一轮${owner.label}还在跑（${new Date(owner.startedAt).toLocaleTimeString('zh-CN')} 开始），等它结束再试`
}
