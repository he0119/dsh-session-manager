// src/family.ts — 「子智能体跟着父会话走」的唯一一份展开实现（删除与迁移共用）。
//
// 为什么需要它：子会话在外壳侧边栏里**没有自己的位置**——那一行只从父会话日志里的
// `subagent/catalog` 事件长出来（投影 `subagentCatalog`）。父日志一没，子会话的日志还在盘上、
// 却再也没有入口；父会话搬去别的目录而子会话留在原地，族就被拆成两半（父下面照旧挂着它，
// 而它的日志在旧目录里，下一次"清掉旧项目"就会把它一起带走）。所以插件里凡是按会话动手的动作
// 都以**族**为单位：点名一条会话，它的子智能体一起走。
//
// 判据取子会话 header 里的 `parentSession` + `origin`，而不是父日志里的 catalog 事件：header 在发现
// 阶段本来就已经解出来了，读 catalog 要把父日志整份解码（一条 6MB 的日志 1～2 秒，见 discovery.ts
// 的性能取舍）。
//
// **只有子智能体跟着父走**：`parentSession` 有两种来源，另一种是**分叉**（`sessions.fork()`）——源会话
// "已完成轮次"的事件被拷进分叉自己的日志（`isSeeded: true`、`inheritedEventCount` 记着继承到哪），
// 此后它是一份自洽的普通会话：父删掉、搬走，它照旧能打开能继续，宿主也照旧按普通会话投递它。分叉的
// 特征是没有 `origin`（子智能体才有 `origin: "subagent"`），宿主自己也这么判：往父链上走的那处
// （dsh-api-session-controller 的 underArchivedSession）遇到非子智能体的边就停。
//
// 只**向下**：删父 / 迁父会带上子智能体，不向上牵连父——子智能体跟着父走，不是父跟着子走。
import type { DiscoveredSession } from './discovery.ts'

/** 族里的一条：`root` 是用户点名的那条祖先（这次动作的起点）。 */
export interface FamilyMember {
  session: DiscoveredSession
  root: DiscoveredSession
}

/**
 * 找出"被单独点名的子智能体"：`parentSession` 指向的父会话**还在库里**、又不在这次点名的集合里。
 *
 * 这类请求一律拒绝，而不是把它当成一次普通操作：子智能体跟着父会话走（见文件头），单独动它等于把族
 * 拆开——删掉它，父会话日志里的 `subagent/catalog` 还指着一条不存在的会话；搬走它，父会话的日志在
 * 旧目录、它的日志在新目录；导出它，包里那条 catalog 指向一个不在包里的会话。
 *
 * 父会话**不在库里**的（孤儿）不算：没有可跟随的会话，它只能被单独收拾，而收下它并不拆开任何东西。
 *
 * @param sessions 手上有的全部会话（发现出来的整库）。
 * @param named 这次点名的 id 集合。
 * @returns 需要拒绝的 `{ id, parentId }`，顺序跟着 `named` 的迭代顺序（调用方据此逐条报错）。
 */
export function loneSubagents(
  sessions: readonly DiscoveredSession[],
  named: ReadonlySet<string>,
): Array<{ id: string; parentId: string }> {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const out: Array<{ id: string; parentId: string }> = []
  for (const id of named) {
    const session = byId.get(id)
    if (session === undefined || session.header.origin !== 'subagent') continue
    const parentId = session.header.parentSession
    if (parentId === undefined || parentId === '' || named.has(parentId)) continue
    if (!byId.has(parentId)) continue
    out.push({ id, parentId })
  }
  return out
}

/**
 * 点名几条会话 → 整族。
 *
 * 顺序：点名的在前（按传入顺序），随后是各自的子智能体（按层展开），全局去重。所以"点名的排在最前、
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
    // 分叉（有父指针、不是子智能体）不在这张表里：它是独立会话，父走了它不走（见文件头）。
    if (session.header.origin !== 'subagent') continue
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
