/**
 * 「同步」这一面此刻该摆哪一段。
 *
 * 四段是 面板 → 计划 → 应用 → 结果（见 [design.md](../../../../docs/design.md) 的「执行与结果」那一节）。
 * 三个输入：`local` 是这一页自己走到哪（`null` = 还停在面板段，没算计划也没写进去），`running` 是宿主
 * 那边这一趟还在跑（可能由这一页发起，也可能是别处发起、这一页认领来的），`done` 是这一趟已经结束、
 * 结论还没被用户按「完成」收掉。
 *
 * 为什么把这条判断单独拎出来：状态栏那枚「同步中 3/7」点开的就是这一面。若这时只看 `local` 画成
 * 面板段，用户看到的是一份「上次同步」和一枚按不动的「同步」，正在跑的那一趟一条字都没有——这就是
 * 要修的那个现象（实测：状态栏写着「同步中…」，点进去只有上次的结论）。跑着时先摆应用段，进度就在
 * 那一段里。
 *
 * 跑完不回面板段，换成结果段：结论、没做到的清单与「撤销」都在那一页上，按「完成」才收掉。所以
 * `done` 排在 `local === 'apply'` 之前——应用结束后这一页手上还记着"我刚按了确认"，可那件事已经完了，
 * 该看的是结果。
 *
 * 这一页正在算计划（`local === 'plan'`）时不跟着后台那一趟跑走：那份计划正是用户当下在看的东西，
 * 换掉它等于把手上这一步藏起来。
 *
 * @module dsh-session-manager/client/operations/sync/syncStage
 */

/** 弹窗的四段：面板（状态与工具）/ 计划 / 应用（进度）/ 结果。 */
export type SyncStage = 'idle' | 'plan' | 'apply' | 'done'

/**
 * 按"这一页走到哪""宿主那边跑没跑""这一趟完了没有"算这一段。
 *
 * @param local 这一页自己的意图：`plan` 在算计划、`apply` 刚按了确认、`null` 停在面板段。
 * @param running 宿主那边这一轮同步还在跑。
 * @param done 这一轮结束了、结论还没被收掉（这一页自己的那一趟，或认领来的那一趟都算）。
 * @returns 该摆哪一段。
 */
export function syncStage(local: 'plan' | 'apply' | null, running: boolean, done: boolean): SyncStage {
  if (local === 'plan') return 'plan'
  if (running) return 'apply'
  if (done) return 'done'
  return local === 'apply' ? 'apply' : 'idle'
}
