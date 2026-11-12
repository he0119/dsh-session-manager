/**
 * 列表与那三个弹窗共用的入参。
 *
 * 数据只取一次：`/state` 由页面骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉，面板只管渲染
 * 与自己的动作。这样开关弹窗不会各拉一份，也避免"两处对同一个库给出不同数字"。
 *
 * @module dsh-session-manager/client/types
 */

import type { MetaResponse, StateResponse } from './api.ts'
import type { DirectoryApi } from './directory.ts'
import type { Translate } from './logic/locales.ts'

/** 面板入参。 */
export interface PanelShare {
  /** 注入面带来的翻译函数。 */
  t: Translate
  /** 会话库与工作区清单；首帧还没读到时为 null。 */
  state: StateResponse | null
  /**
   * 会话库位置与能力位那一份（`GET /meta`）；还没到、或这个宿主没有那条路由时为 `undefined`。
   *
   * 它比 `state` 先到，所以"库在哪、这个宿主能不能归档"这类**不依赖清单**的结论按 `state ?? meta`
   * 取：清单没到也能说实话，而不是先按"没有"画一遍再改。
   */
  meta: MetaResponse | undefined
  /** 重新拉 `/meta` 与 `/state`（写入成功后调用，让列表与注册表归属跟上）。 */
  reload: () => Promise<void>
  /**
   * 开「导出 / 导入」那一面（弹窗由页面骨架持有，见 [ManagerPanel.tsx](./components/ManagerPanel.tsx)）。
   *
   * 它是列表动作行里唯一**不**要求勾选的一枚：导出要用勾选，导入不用——一个包里带什么与列表里勾了
   * 什么无关。所以它总是可点，进去之后导出那一栏才看得到勾中的那几条。
   */
  openTransfer?: () => void
  /**
   * 就地改清单里的那几条（见 [statePatch.ts](./logic/statePatch.ts)）。
   *
   * 动作落地之后先按响应把改过的行改对：用户点完立刻看到结果，不必等宿主把整库重扫一遍再把快照发
   * 回来（本机 1423 条上那一步 0.9～1.1 秒）。整库快照随后在后台取回来覆盖它，到了以快照为准。
   */
  patch?: (update: (state: StateResponse) => StateResponse) => void
  /**
   * 取当前可用的宿主目录选择器（注入面给的 thunk，见 [directory.ts](./directory.ts)）。
   * 取到 `undefined` 表示这个宿主没提供选择器，界面要给出提示而不是留一个点了没反应的按钮；
   * 拿到之后用哪个调用面（`pick` / `list`）由宿主报来的 `pickerKind` 决定（见 api.ts 的
   * `MetaResponse`）。
   */
  directory?: () => DirectoryApi | undefined
}
