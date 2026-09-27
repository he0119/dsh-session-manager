// src/index.ts — 插件入口（薄组合层；package.json 的 main 指向构建产物 lib/index.js）。
//
// 消费宿主的 tools 服务。workspaceRegistry 只在"探测上游是否提供 reassign 能力"时读取
// （见 tools.ts 的 effectMode），不是硬依赖，因此未挂载该服务时插件仍可用，
// 只是迁移需要重启才生效。
//
// 本包的核心（project-key | paths | zstd-frame | session-log | discovery | registry |
// plan | journal | execute | artifacts）保持**零 DSH 依赖**，可独立测试与在 CLI 里复用；
// 只有本文件与 tools.ts 依赖 @deepseek-ai/dsh-tools。
import type { Context } from '@deepseek-ai/cordis'

import { type PluginConfig, registerTools, resolvePaths } from './tools.ts'

/** 插件 id（与 cordis.patch.yml 里的 id 对应）。 */
export const name = 'session-manager'

// workspaceRegistry 不在 inject 里：它只是"能否即时生效"的探测对象，
// 硬依赖会让没有该服务的 profile 整个插件起不来。
export const inject = ['tools']

/**
 * Cordis 插件入口。
 * @returns 卸载函数：宿主热卸载时逐个注销已注册的工具。
 */
export function apply(ctx: Context, config: PluginConfig = {}): () => void {
  const paths = resolvePaths(config)
  const disposers = registerTools(ctx, config)
  const logger = (ctx as { logger?: { info?: (message: string) => void } }).logger
  logger?.info?.(
    `dsh-session-manager 已就绪：sessions=${paths.sessionsRoot} registry=${paths.registryPath} backups=${paths.backupRoot}`,
  )
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载期忽略单个注销失败
      }
    }
  }
}
