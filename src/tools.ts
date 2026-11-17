// src/tools.ts — 把 6 个工具注册给宿主：开关、依赖与顺序。
//
// 每个工具的**定义**在它自己的操作目录里：`operations/migrate/tool.ts`（计划 / 应用 / 回滚 / 复核）、
// `operations/path-repair/tool.ts`、`operations/sync/tool.ts`。这里只剩三件事：
//
//   * 读插件配置的 `tools` 一节，按开关决定注册哪几个（关掉的连 `register` 都不调，宿主那份工具清单里
//     就没有它，模型那边也看不到——这是"关"与"注册了再拒绝调用"的区别）；
//   * 造一份迁移依赖（工具与界面端点共用同一份形状，两个入口因此不会各写一套）；
//   * 把定义交给宿主的 `ctx.tools.register`，按顺序收 disposer。
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { toolsSection, type PluginConfigInput } from './config.ts'
import { migrationTools } from './operations/migrate/tool.ts'
import type { MigrateDeps } from './operations/migrate/migrate.ts'
import { pathRepairTool } from './operations/path-repair/tool.ts'
import { createRemoteWriteGate, type RemoteWriteGate } from './operations/sync/remote-write.ts'
import { syncTool } from './operations/sync/tool.ts'
import {
  effectMode,
  hostCheckpointPort,
  hostRegistryPort,
  liveSessionIds,
} from './shared/host/ports.ts'
import { decodeAll } from './shared/log/log-decode.ts'
import { resolvePaths } from './shared/plugin-paths.ts'
import type { EffectMode } from './shared/types.ts'

/**
 * 按插件配置里 `tools` 一节的开关注册工具（6 个全开时就是 6 个）。
 * @param options.remoteWrite 写远端格子的互斥锁；生产由 `src/index.ts` 造一份交给界面、工具与
 *   自动推送共用。缺席时自己造一把（只测工具时够用）。
 * @returns cordis effect disposer 列表（宿主热卸载时逐个调用）。
 */
export function registerTools(
  ctx: Context,
  config: PluginConfigInput = {},
  options: { remoteWrite?: RemoteWriteGate } = {},
): Array<() => void> {
  const paths = resolvePaths(config)
  const remoteWrite = options.remoteWrite ?? createRemoteWriteGate()
  const mode = (): EffectMode => effectMode(ctx)
  // 预览/执行/回滚都走 src/operations/migrate/migrate.ts 那一份编排，界面端点用的是同一个 deps 形状——
  // 两个入口（工具 / 界面）因此不会各写一套。
  const deps: MigrateDeps = {
    sessionsRoot: paths.sessionsRoot,
    registryPath: paths.registryPath,
    backupRoot: paths.backupRoot,
    decodeAll,
    // 每次调用重新探测（加载条目会随 profile 的热应用来去），探测不到就是"只能重启"。
    hostRegistry: () => hostRegistryPort(ctx),
    // 迁移改写了 cwd，旧检查点因此对不上：统一处理时请宿主重折一遍（见 checkpoint-warm.ts）。
    hostCheckpoints: () => hostCheckpointPort(ctx),
    // 宿主持在内存里的会话搬不动（见 plan.ts 的 `BuildPlanOptions.live`）：两个入口都要问同一件事。
    liveSessionIds: () => liveSessionIds(ctx),
  }
  const disposers: Array<() => void> = []
  const switches = toolsSection(config)

  /*
   * 关掉的那个连 `register` 都不调；空操作让下面六处 `disposers.push(...)` 保持同一个形状，
   * 卸载时照样安全。
   */
  const when = (on: boolean) => (definition: ToolDefinition): (() => void) =>
    on ? ctx.tools.register(definition) : () => {}

  const migration = migrationTools({ paths, deps, mode, decodeAll })
  disposers.push(when(switches.plan)(migration.plan))
  disposers.push(when(switches.migrate)(migration.migrate))
  disposers.push(when(switches.rollback)(migration.rollback))
  disposers.push(when(switches.verify)(migration.verify))
  disposers.push(when(switches.repair)(pathRepairTool({ paths, deps, decodeAll })))
  disposers.push(when(switches.sync)(syncTool({ ctx, config, paths, remoteWrite, mode, decodeAll })))

  return disposers
}
