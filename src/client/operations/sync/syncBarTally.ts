/**
 * 状态栏那一格要的两串数：这一趟搬了几条**会话**、搬了几个**附件对象**。
 *
 * 为什么要有这一层：宿主报的进度一段一段、每段各有各的分母（`pull` / `push` 数是会话，`attach` 数是
 * 附件对象，`repo` 数是本机仓库目录，`tidy` 数是远端包）。状态栏原来直接拿最后一条事件画
 * 「同步中 20/21」，那个 21 可能是 21 个目录、21 个对象或者 21 个远端包，与"还剩几条会话要搬"无关
 * ——实测最容易撞上的是 `repo` 那一段（十几个到二十几个目录）。
 *
 * 所以只留两种数，而且只在真的搬东西那几段里动：
 *
 * - **会话**：`pull` 与 `push` 两段。两段各有自己的分母，不能把 `done` 直接相加，所以换段时把上一段
 *   的总数并进 `carried`（换段意味着上一段已经跑完了）。
 * - **附件对象**：`attach` 那一段。它是**按会话分批**的（某一条会话引用的那几个对象），每批自己的
 *   分母；一批的开始是 `done === 0`，跑完的标志是"这一批的最后一条已经来过"（`done + 1 === total`，
 *   事件发在开始处理下一条之前）——那时把整批并进 `objectsBase`。于是对外那两串数是"已经处理过的
 *   对象 / 这一趟已知要处理的"，分母会随着往后走慢慢补齐：这与弹窗里那条固定分母的进度条不同，
 *   状态栏只有一串字，所以按"到目前为止"说。
 *
 *   一批开始之后一定会把这一批的每个序号都报一遍（每个对象失败只记问题、不中断这一批，见
 *   `attachments.ts`），所以"跑完就整批记上"不会多记。
 *
 * 其余各段（算计划、备份、写注册表、整理远端）一个数都不动：它们量的是别的东西，说了反而误导；细节
 * 留在同步那一面（见 [ProgressBlock.tsx](../../shared/ui/ProgressBlock.tsx)）。
 *
 * @module dsh-session-manager/client/operations/sync/syncBarTally
 */

import type { ProgressEvent } from '../../api.ts'

/** 会话级那两段（`pull` / `push`）：只有它们数的是会话。 */
export type SessionPhase = 'pull' | 'push'

/** 状态栏那一格的两串数，加上折叠它们要留着的几格中间状态。 */
export interface SyncBarTally {
  /** 会话级进度上一段是哪一段；换段时把上一段的总数并进 `carried`。 */
  phase: SessionPhase | null
  /**
   * 前面那几段里已经搬完的会话数。
   *
   * 只有拉取段跑完、进推送段时才非零：那两条路各数各的（一次整库同步实测是"先拉 3 条、再推 84 条"），
   * 两段的 `done` 相加会得到 84 而不是 87。
   */
  carried: number
  /** 这一趟搬完的会话数 / 要搬的会话总数；还没进到搬会话那两段时是 `null`。 */
  sessions: { done: number; total: number } | null
  /** 前面几批已经处理完的附件对象总数。 */
  objectsBase: number
  /** 正在处理的那一批附件对象；这一批跑完（或者还没开始过）就是 `null`。 */
  objects: { done: number; total: number } | null
}

/**
 * 空的一份（一趟刚开始，或者刚跑完）。
 *
 * @returns 每一项都是"还不知道"。
 */
export function emptyTally(): SyncBarTally {
  return { phase: null, carried: 0, sessions: null, objectsBase: 0, objects: null }
}

/**
 * 附件那一批要是已经跑到最后一条了，就把它整批并进 `objectsBase`。
 *
 * 单独一步是因为"一批跑完"与"下一批开始"之间可能隔着别的段的事件（会话那两段、补对象之后的收尾
 * 那几段）：不并的话，那一格会永远停在 `3/8` 的最后一格上前进不了。
 *
 * @param tally 当前那一份。
 * @returns 并过了的新一份；没到最后一格就是原样（同一个对象）。
 */
function settleObjects(tally: SyncBarTally): SyncBarTally {
  const batch = tally.objects
  if (batch === null || batch.done + 1 < batch.total) return tally
  return { ...tally, objectsBase: tally.objectsBase + batch.total, objects: null }
}

/**
 * 收下一条进度事件，更新那两串数。
 *
 * 纯函数：同样的旧状态 + 同样的事件，得到同样的新状态；不认识的段名原样返回同一份（`Object.is` 相等，
 * 订阅者据此判"没变"）。
 *
 * @param prev 上一条事件之后的那一份。
 * @param event 宿主刚推来的一条。
 * @returns 新的那一份（没变化时就是 `prev` 本身）。
 */
export function foldBarTally(prev: SyncBarTally, event: ProgressEvent): SyncBarTally {
  // 不是附件那一段的事件，都意味着上一批附件对象已经过去了。
  const tally = event.phase === 'attach' ? prev : settleObjects(prev)
  if (event.phase === 'pull' || event.phase === 'push') {
    // 分母是 0 的那一段没有"第几条"可讲（拉取 / 推送两段不会这样，防御一下）。
    if (event.total <= 0) return tally
    if (tally.phase === event.phase && tally.sessions !== null) {
      return { ...tally, sessions: { done: tally.carried + event.done, total: tally.carried + event.total } }
    }
    // 换段：上一段（拉取）那些会话已经全部搬完，把它们整段并进来。
    const carried = tally.sessions === null ? 0 : tally.sessions.total
    return {
      ...tally,
      phase: event.phase,
      carried,
      sessions: { done: carried + event.done, total: carried + event.total },
    }
  }
  if (event.phase !== 'attach' || event.total <= 0) return tally
  // 附件对象：`done === 0` 或者分母换了，就是新的一批开始了。
  const batch = tally.objects
  if (batch === null) return { ...tally, objects: { done: event.done, total: event.total } }
  if (event.done === 0 || batch.total !== event.total) {
    return {
      ...tally,
      objectsBase: tally.objectsBase + batch.total,
      objects: { done: event.done, total: event.total },
    }
  }
  return { ...tally, objects: { done: event.done, total: event.total } }
}

/**
 * 附件对象那两串数（把正在处理那一批与前面几批合成一行）。
 *
 * @param tally 折出来的那一份。
 * @returns `null` = 这一趟还没搬过附件对象（或者宿主没有附件服务）；那时状态栏不提附件。
 */
export function attachmentTallyOf(tally: SyncBarTally): { done: number; total: number } | null {
  if (tally.objects === null) {
    if (tally.objectsBase <= 0) return null
    // 这一趟搬过对象、眼下没有正在搬的那一批：报"已经搬完的那些"。
    return { done: tally.objectsBase, total: tally.objectsBase }
  }
  return { done: tally.objectsBase + tally.objects.done, total: tally.objectsBase + tally.objects.total }
}
