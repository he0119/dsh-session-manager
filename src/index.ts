// src/index.ts — 插件入口（薄组合层；package.json 的 main 指向构建产物 lib/index.js）。
//
// 硬依赖只有 tools。webServer 与 workspaceRegistry 都是**可选**服务：没有 webServer 的
// profile（纯工具/其它前端）照旧只有工具，没有 workspaceRegistry 也不影响工具本身。
// 这两个服务都只能用 `ctx.get(...)` 或 `ctx.inject(...)` 拿，不能写 `ctx.webServer`——
// 见 optionalService() 的注释（Cordis 会为此同步抛错，本插件曾因此在真实 profile 里起不来）。
//
// 本包的核心（project-key | paths | zstd-frame | session-log | discovery | registry |
// plan | journal | execute | artifacts | transfer）保持**零 DSH 依赖**，可独立测试，也能被工具层与界面共用；
// 只有本文件、tools.ts 与 web.ts 依赖宿主（web.ts 只依赖一个 `{ register() }` 形状，不 import 宿主包）。
import { readFileSync } from 'node:fs'

import type { Context } from '@deepseek-ai/cordis'

import {
  type PluginConfig,
  archiveOps,
  decodeAll,
  describeSyncConfig,
  directoryPickerKind,
  effectMode,
  liveSessionIds,
  registerTools,
  resolvePaths,
  syncRuntime,
} from './tools.ts'
import { API_PREFIX, registerWebRoutes, type WebServerLike } from './web.ts'

/** 插件 id（与 cordis.patch.yml 里的 id 对应）。 */
export const name = 'session-manager'

// workspaceRegistry 不在 inject 里：它只是"能否即时生效"的探测对象，
// 硬依赖会让没有该服务的 profile 整个插件起不来。webServer 同理，它走下面的 ctx.inject。
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

  const logger = (ctx as { logger?: { info?: (message: string) => void } }).logger
  const info = (message: string): void => logger?.info?.(message)

  info(
    `dsh-session-manager 已就绪：sessions=${paths.sessionsRoot} registry=${paths.registryPath} backups=${paths.backupRoot}`,
  )

  // Web 端点用 `ctx.inject` 开一个子 fiber 去等 webServer，而不是在 apply 里直接读 `ctx.webServer`：
  // 一是属性读取要求本 fiber 声明过 inject（那会把插件变成硬依赖），二是子 fiber 顺带解决顺序问题
  // ——webServer 由另一个 bundle 提供，晚于本插件到位时路由会在它到位后补挂，而不是永远缺席。
  ctx.inject(['webServer'], (webCtx: Context) => {
    const webServer = (webCtx as { webServer?: WebServerLike }).webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      info('dsh-session-manager：webServer 形状不认，界面端点未挂')
      return
    }
    const dispose = registerWebRoutes(webServer, {
      paths,
      decodeAll,
      pluginVersion: pluginVersion(),
      // "迁移何时生效"要读宿主服务（workspaceRegistry），那件事只在这里做得了。
      effectMode: () => effectMode(ctx),
      // 同理：目录选择器是"桌面对话框"还是"页面内浏览"，只有宿主自己知道。
      pickerKind: () => directoryPickerKind(ctx),
      // 归档与取消归档是宿主的能力（`workspaceRegistry`，Web profile 才有）：这里把两个方法收成
      // 端口交出去，`src/web.ts` 因此仍然只认一个形状、不认识 Cordis。服务缺席返回 undefined，
      // 界面据此禁用那两个按钮并说明原因。
      registryOps: () => archiveOps(ctx),
      // 删除会拒掉"宿主内存里活着"的会话（它手里还有内存副本与写句柄）。
      liveSessionIds: () => liveSessionIds(ctx),
      // WebDAV 同步：运行时按需造（每次请求重新解析密码引用），/state 只看非敏感的那几个字段。
      sync: () => syncRuntime(ctx, config),
      syncInfo: () => describeSyncConfig(config),
    })
    info(`dsh-session-manager 界面端点已挂：${API_PREFIX}`)
    return dispose
  })

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
