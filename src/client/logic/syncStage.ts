/**
 * 「同步」这一面此刻该摆哪一段。
 *
 * 三段是 面板 → 计划 → 落地（见 [design.md](../../../docs/design.md)）。两个输入：
 * `local` 是这一页自己走到哪（`null` = 还停在面板段，没算计划也没落地），`running` 是宿主那边
 * 这一趟还在跑（可能由这一页发起，也可能是别处发起、这一页认领来的）。
 *
 * 为什么把这条判断单独拎出来：状态栏那枚「同步中 3/7」点开的就是这一面。若这时只看 `local` 画成
 * 面板段，用户看到的是一份「上次同步」和一枚按不动的「同步」，正在跑的那一趟一条字都没有——这就是
 * 要修的那个现象（实测：状态栏写着「同步中…」，点进去只有上次的结论）。跑着时先摆落地段，进度就在
 * 那一段里；跑完之后 `local` 与 `running` 都归零，自然回到面板段看结论。
 *
 * 这一页正在算计划（`local === 'plan'`）时不跟着后台那一趟跑走：那份计划正是用户当下在看的东西，
 * 换掉它等于把手上这一步藏起来。
 *
 * @module dsh-session-manager/client/logic/syncStage
 */

/** 弹窗的三段：面板（状态与工具）/ 计划 / 落地（进度）。 */
export type SyncStage = 'idle' | 'plan' | 'apply'

/**
 * 按"这一页走到哪"与"宿主那边跑没跑"算这一段。
 *
 * @param local 这一页自己的意图：`plan` 在算计划、`apply` 刚按了确认、`null` 停在面板段。
 * @param running 宿主那边这一轮同步还在跑。
 * @returns 该摆哪一段。
 */
export function syncStage(local: 'plan' | 'apply' | null, running: boolean): SyncStage {
  if (local !== null) return local
  return running ? 'apply' : 'idle'
}
