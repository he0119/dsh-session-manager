/**
 * 页内两个分页共用的入参。
 *
 * 数据只取一次：`/state` 由页面骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉，分页只管渲染
 * 与自己的动作。这样切分页不会各拉一份，也避免"两个分页对同一个库给出不同数字"。
 *
 * @module dsh-session-manager/client/types
 */

import type { StateResponse } from './api.ts'
import type { DirectoryApi } from './directory.ts'
import type { Translate } from './logic/locales.ts'

/** 分页入参。 */
export interface PanelShare {
  /** 注入面带来的翻译函数。 */
  t: Translate
  /** 会话库与工作区清单；首帧还没读到时为 null。 */
  state: StateResponse | null
  /** 重新拉 `/state`（写入成功后调用，让列表与注册表归属跟上）。 */
  reload: () => Promise<void>
  /**
   * 取当前可用的宿主目录选择器（注入面给的 thunk，见 [directory.ts](./directory.ts)）。
   * 取到 `undefined` 表示这个宿主没提供选择器，界面要给出提示而不是留一个点了没反应的按钮；
   * 拿到之后用哪个调用面（`pick` / `list`）由 `state.pickerKind` 决定。
   */
  directory?: () => DirectoryApi | undefined
}
