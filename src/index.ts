// src/index.ts — 插件入口（薄组合层；package.json 的 main 指向构建产物 lib/index.js）。
//
// 消费宿主的 tools 服务，并在宿主提供 webServer 时挂上界面用的端点。
// workspaceRegistry 只在"探测上游是否提供 reassign 能力"时读取（见 tools.ts 的 effectMode），
// 不是硬依赖，因此未挂载该服务时插件仍可用，只是迁移需要重启才生效。
//
// 本包的核心（project-key | paths | zstd-frame | session-log | discovery | registry |
// plan | journal | execute | artifacts | transfer）保持**零 DSH 依赖**，可独立测试与在 CLI 里复用；
// 只有本文件、tools.ts 与 web.ts 依赖宿主（web.ts 只依赖一个 `{ register() }` 形状，不 import 宿主包）。
import { readFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import { type PluginConfig, decodeAll, registerTools, resolvePaths } from './tools.ts'
import { registerWebRoutes, type WebServerLike } from './web.ts'

/** 插件 id（与 cordis.patch.yml 里的 id 对应）。 */
export const name = 'session-manager'

// workspaceRegistry 不在 inject 里：它只是"能否即时生效"的探测对象，
// 硬依赖会让没有该服务的 profile 整个插件起不来。
export const inject = ['tools']

/**
 * 读本包版本号写进导出包的来源信息。
 *
 * 构建产物在 `lib/index.js`，`../package.json` 即包根，因此源码与产物两种形态都成立；
 * 读不到就返回 undefined——来源信息只是排查用的注释，不该让插件起不来。
 */
function pluginVersion(): string | undefined {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version
  } catch {
    return undefined
  }
}

/**
 * Cordis 插件入口。
 * @returns 卸载函数：宿主热卸载时逐个注销已注册的工具与路由。
 */
export function apply(ctx: Context, config: PluginConfig = {}): () => void {
  const paths = resolvePaths(config)
  const disposers = registerTools(ctx, config)

  // Web 端点按需接入：没有 webServer 的 profile（纯工具/其它前端）照旧只有工具，不该因此起不来。
  const webServer = (ctx as { webServer?: WebServerLike }).webServer
  if (webServer && typeof webServer.register === 'function') {
    disposers.push(registerWebRoutes(webServer, { paths, decodeAll, pluginVersion: pluginVersion() }))
  }

  const logger = (ctx as { logger?: { info?: (message: string) => void } }).logger
  logger?.info?.(
    `dsh-session-manager 已就绪：sessions=${paths.sessionsRoot} registry=${paths.registryPath} backups=${paths.backupRoot}` +
      (webServer ? ` api=${'/dsh-session-manager/api'}` : '（本 profile 没有 webServer，界面不可用）'),
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
