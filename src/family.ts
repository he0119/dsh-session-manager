// src/family.ts — 「子代理跟着父会话走」的唯一一份展开实现（删除与迁移共用）。
//
// 为什么需要它：子会话在外壳侧边栏里**没有自己的位置**——那一行只从父会话日志里的
// `subagent/catalog` 事件长出来（投影 `subagentCatalog`）。父日志一没，子会话的日志还在盘上、
// 却再也没有入口；父会话搬去别的目录而子会话留在原地，族就被拆成两半（父下面照旧挂着它，
// 而它的日志在旧目录里，下一次"清掉旧项目"就会把它一起带走）。所以插件里凡是按会话动手的动作
// 都以**族**为单位：点名一条会话，它的全部后代一起走。
//
// 判据取子会话 header 里的 `parentSession`，而不是父日志里的 catalog 事件：两者在宿主写出来的库里
// 是同一件事（建子会话时两边一起写，见 test/session-log.test.ts），而 header 在发现阶段本来就已经
// 解出来了；读 catalog 要把父日志整份解码（一条 6MB 的日志 1～2 秒，见 discovery.ts 的性能取舍）。
//
// 只**向下**：删父 / 迁父会带上子，不向上牵连父——子代理跟着父走，不是父跟着子走。
import type { DiscoveredSession } from './discovery.ts'

/** 族里的一条：`root` 是用户点名的那条祖先（这次动作的起点）。 */
export interface FamilyMember {
  session: DiscoveredSession
  root: DiscoveredSession
}

/**
 * 点名几条会话 → 整族。
 *
 * 顺序：点名的在前（按传入顺序），随后是各自的后代（按层展开），全局去重。所以"点名的排在最前、
 * 级联带进来的跟在后面"是结构上成立的，界面可以直接照这个顺序画。坏数据里的环（A 的父是 B、
 * B 的父是 A）由 `seen` 兜住，不会转不出来。
 *
 * @param sessions 手上有的全部会话（删除给发现出来的整库；迁移给"源目录那份 ∪ 全库那份"）。
 * @param roots 用户点名的那几条。
 * @returns 展开后的整族；同一条会话只出现一次。
 */
export function familyOf(sessions: readonly DiscoveredSession[], roots: readonly DiscoveredSession[]): FamilyMember[] {
  // 父 id → 它的直接子们（子会话 header 里的 `parentSession` 是这条边唯一的来源）。
  const childrenOf = new Map<string, DiscoveredSession[]>()
  for (const session of sessions) {
    const parent = session.header.parentSession
    if (parent === undefined || parent === '' || parent === session.id) continue
    const siblings = childrenOf.get(parent)
    if (siblings === undefined) childrenOf.set(parent, [session])
    else siblings.push(session)
  }

  const family: FamilyMember[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (seen.has(root.id)) continue
    seen.add(root.id)
    family.push({ session: root, root })
    // 一层一层往下展开：`queue` 里是"已经收进来、还没找过孩子"的那些。
    const queue: DiscoveredSession[] = [root]
    while (queue.length > 0) {
      const parent = queue.shift()
      if (parent === undefined) break
      for (const child of childrenOf.get(parent.id) ?? []) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        queue.push(child)
        family.push({ session: child, root })
      }
    }
  }
  return family
}
