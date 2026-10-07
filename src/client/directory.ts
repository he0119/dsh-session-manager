/**
 * 宿主目录选择器（`uiWorkspace`）的持有处。
 *
 * 为什么单独一个模块：那是个**客户端服务**，只能在声明过 `inject` 的 fiber 里读；
 * 而设置页组件是外壳渲染的，它手上没有那个 fiber。所以由插件入口
 * （[index.ts](./index.ts)）用 `ctx.inject(['uiWorkspace'], …)` 把服务收进一组 thunk，
 * 这里只存这组 thunk，组件在**点击时**取用——服务晚于本插件到达也能用上。
 *
 * 存的是 thunk 而不是服务本身：服务到达/卸载时只换这组函数，调用方拿到的永远是当前那一组。
 * 服务不在（宿主没装目录选择器）时返回 `undefined`，由组件给出提示而不是让按钮装作可用。
 *
 * **两个调用面互斥**：宿主的 `directoryPicker` 是能力位服务，`native` 只有 `pick()`、
 * `browse` 只有 `list()`（见 [tools.ts](../../src/tools.ts) 的 `directoryPickerKind`）。
 * 种类由宿主报给界面（`/meta` 的 `pickerKind`，`/state` 里也有同一份），界面据此决定「浏览…」开哪一种。
 *
 * @module dsh-session-manager/client/directory
 */

/** 一层目录的列表（宿主 `directoryPicker.list` 的返回形状）。 */
export interface DirectoryListing {
  /** 这一层的绝对路径。 */
  path: string
  /** 宿主 home，作为"从哪儿开始"的兜底。 */
  home: string
  /** 从根到这一层的面包屑（可点，用来往上跳）。 */
  crumbs: Array<{ name: string; path: string; hidden: boolean }>
  /** 这一层的子目录（**只有目录**，宿主的浏览能力不列文件）。 */
  entries: Array<{ name: string; path: string; hidden: boolean }>
  /** 条目太多被截断过。 */
  truncated: boolean
}

/** 目录选择器的调用面：`null` = 用户取消，`string` = 选中的绝对路径。 */
export type PickDirectory = () => Promise<string | null>

/** 列一层目录；省略 `path` = 宿主 home。 */
export type ListDirectory = (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>

/** 宿主提供的目录选择器：两个调用面都在，用哪个由宿主的能力种类决定。 */
export interface DirectoryApi {
  /** 宿主系统对话框（只有 `native` 宿主支持）。 */
  pick: PickDirectory
  /** 页面内浏览（只有 `browse` 宿主支持）。 */
  list: ListDirectory
}

/** 当前可用的选择器；服务没到位时为 `undefined`。 */
let current: DirectoryApi | undefined

/** 记下当前选择器（传 `undefined` 表示服务已卸载）。 */
export function setDirectoryApi(api: DirectoryApi | undefined): void {
  current = api
}

/** 取当前选择器；没有则返回 `undefined`。 */
export function getDirectoryApi(): DirectoryApi | undefined {
  return current
}

/**
 * 把选择器返回值收拾成可以当"目录项目目录键"用的形状：去掉结尾的多余斜杠。
 *
 * 会话的 `cwd` 与注册表里的工作区路径都不带结尾斜杠，而选择器有可能返回 `/a/b/`——
 * 那样会凭空多出一个「不同的项目目录」，搬迁时匹配不到任何会话。除根目录外一律削掉。
 */
export function normalizePickedPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}
