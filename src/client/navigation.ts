/**
 * 「去插件页看看 sync 配置」这条路。
 *
 * 配置不再是设置里的一页（设置只放官方那几项），而是挂在**插件页**上（`plugins.bundle.config`，见
 * [index.ts](./index.ts)）。于是侧栏这一页要给一条跳过去的路：宿主客户端插件管理器在运行时
 * `provide` 了一个 `pluginNavigation` 服务（`openList()` / `openBundle(packageName)`），这里把它收成
 * 一个 thunk，组件在点击那一刻才取用——服务晚到或不在都不影响页面装配。
 *
 * 与 [directory.ts](./directory.ts) 同一个形状：模块级持有、`undefined` 表示服务不在，调用方自己
 * 决定怎么说"这个宿主没有那条路"。
 *
 * @module dsh-session-manager/client/navigation
 */

/** 宿主插件管理器给的那条导航：`null` 表示这个宿主没有插件页（比如桌面版没装插件管理器）。 */
export interface PluginNavigationApi {
  /** 打开**本插件**的页面（已安装那一栏里点进这个包）。 */
  openPackage: () => void
}

/** 当前可用的导航；服务没到位时为 `undefined`。 */
let current: PluginNavigationApi | undefined

/** 记下当前导航（传 `undefined` 表示服务已卸载）。 */
export function setNavigationApi(api: PluginNavigationApi | undefined): void {
  current = api
}

/** 取当前导航；没有则返回 `undefined`。 */
export function getNavigationApi(): PluginNavigationApi | undefined {
  return current
}
