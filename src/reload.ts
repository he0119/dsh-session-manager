// src/reload.ts — 「写完之后把注册表交回宿主」的共用一步。
//
// 为什么单独一层：本插件有三处会写 `workspace.json`（迁移、回滚、导入 / 同步拉取），三处都撞上同一件事
// ——注册表文件是唯一的真相，但宿主持着**内存副本**与一份启动时建的 header 索引，文件改了它不知道。
// 每处各写一遍，迟早出现"迁移这边说无需重启、导入那边说重启最稳妥"。所以探测、执行与措辞都只写在这里；
// **执行时机**留给各自的编排层（批量落地时收口一次，而不是每条会话重挂一次）。
//
// 本模块保持**零 DSH 依赖**：端口由宿主那半侧（`src/tools.ts` 的 `workspaceReloadPort()`）探测后注入。
import type { EffectMode, ReloadOutcome, WorkspaceReloadPort } from './types.ts'

/** 编排层要承认的最小形状：一个"有没有进程内入口"的探测函数。 */
export interface ReloadDeps {
  /**
   * 进程内重挂入口的探测（可选）：有就返回一个能跑的端口，没有就是 undefined——这个宿主只能重启。
   *
   * 每次调用**重新探测**：加载条目会随 profile 的热应用来去，探测结果不该被缓存。
   */
  workspaceReload?: () => WorkspaceReloadPort | undefined
}

/**
 * 让宿主重新接管刚落盘的注册表。
 *
 * 有进程内入口就用它；没有入口、或入口抛错，都**如实回报而不抛**——文件已经写好了，这里失败不该把
 * 一次成功的迁移/导入说成失败。
 * @param deps 编排依赖（只看 `workspaceReload`）。
 * @returns 三态结论；措辞交给 `describeReload()`。
 */
export async function reloadWorkspace(deps: ReloadDeps): Promise<ReloadOutcome> {
  let port: WorkspaceReloadPort | undefined
  try {
    port = deps.workspaceReload?.()
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  if (port === undefined) return { kind: 'unavailable' }
  try {
    await port.run()
    return { kind: 'applied', entryId: port.entryId }
  } catch (error) {
    return { kind: 'failed', entryId: port.entryId, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 这次改动"已经怎样"生效的措辞，工具层与界面层共用这一份。
 * @param outcome 真的写盘之后拿到的重挂结果。
 * @returns 一句给人看的结论。
 */
export function describeReload(outcome: ReloadOutcome): string {
  switch (outcome.kind) {
    case 'applied':
      return (
        `宿主已重新接管注册表（定点重挂工作区那一层${outcome.entryId === undefined ? '' : `：${outcome.entryId}`}），` +
        '无需重启 DSH。'
      )
    case 'failed':
      return (
        `注册表已落盘，但让宿主重新接管失败（${outcome.error ?? '原因未知'}）：` +
        '仍需重启 DSH 才会生效；重启前请勿再改任何工作区，新建 / 改名 / 归档都会用内存副本把这处改动覆盖掉。'
      )
    case 'unavailable':
      return (
        '注册表已落盘，但宿主进程内持有内存副本，需重启 DSH 后才会生效；' +
        '重启前请勿再改任何工作区，新建 / 改名 / 归档都会用内存副本把这处改动覆盖掉。'
      )
  }
}

/**
 * 计划 / 预演口径：这次改动**执行时**会不会即时生效。
 *
 * 与 `describeReload()` 分开：那个说的是"已经发生的事"，这个说的是"会发生的事"。
 * @param mode 探测到的生效模式（`src/tools.ts` 的 `effectMode()`）。
 * @returns 一句给人看的结论。
 */
export function describePlannedEffect(mode: EffectMode): string {
  return mode === 'immediate'
    ? '执行时宿主会就地重挂工作区那一层，无需重启 DSH。'
    : '执行后需要重启 DSH 才会生效；重启前请勿再改任何工作区。'
}

/**
 * "这次到底怎样生效"：真的写盘过就认执行结果，没写盘才退到探测。
 *
 * 两个入口共用它——否则会一边按探测说"无需重启"、一边执行路径其实没接管成功。
 * @param reload 执行结果里带回的重挂结论；缺席 = 这次没写盘。
 * @param fallback 没写盘时的探测结论。
 * @returns 报给调用方 / 界面的生效模式。
 */
export function effectOf(reload: ReloadOutcome | undefined, fallback: EffectMode): EffectMode {
  if (reload === undefined) return fallback
  return reload.kind === 'applied' ? 'immediate' : 'restart-required'
}
