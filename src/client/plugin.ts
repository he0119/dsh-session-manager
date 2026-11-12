/**
 * 本包的 npm 包名，客户端半侧唯一的写法来源。
 *
 * 两处要用它：客户端模块系统的 factory id（等于包名，见 [index.ts](./index.ts)），以及插件页里这一
 * 包那格配置的键（`plugins.bundle.config` 按**包名**作键）。写两遍就会有一天只改了一处。
 *
 * @module dsh-session-manager/client/plugin
 */

/** 本包的 npm 包名。 */
export const PLUGIN_NAME = '@he0119/dsh-session-manager'
