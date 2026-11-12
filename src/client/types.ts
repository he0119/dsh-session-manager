/**
 * 列表与那三个弹窗共用的入参。
 *
 * 数据只取一次：`/state` 由页面骨架（[ManagerPanel.tsx](./ManagerPanel.tsx)）拉，面板只管渲染
 * 与自己的动作。这样开关弹窗不会各拉一份，也避免"两处对同一个库给出不同数字"。
 *
 * @module dsh-session-manager/client/types
 */

import type { MetaResponse, SessionSummary, StateResponse } from './api.ts'
import type { DirectoryApi } from './directory.ts'
import type { Translate } from './logic/locales.ts'
import type { SessionPicking } from './components/sessionList.tsx'

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
   * 开「备份与回滚」，并直接指着某一份备份（删除 / 迁移之后那枚「撤销」走的这条）。
   *
   * 弹窗由页面骨架持有（见 [ManagerPanel.tsx](./components/ManagerPanel.tsx)）：动作页只报"刚留下
   * 哪一份"，由它把那面打开并把那份备份交给备份清单——回滚的动作清单与确认框仍由那边摆。
   */
  openBackup?: (dir: string) => void
  /**
   * 左栏「项目」筛着的那个（`null` = 全部项目）。
   *
   * 它由页面骨架持有：列表拿它筛，导入那一面拿它当目标目录的初值（"落到哪个项目"这件事，用户在左栏
   * 已经说过一次了）。
   */
  project?: { path: string | null }
  /** 换一个项目（左栏那一列点一下）。 */
  setProject?: (next: { path: string | null }) => void
  /**
   * 这一页的勾选集。
   *
   * 由页面骨架持有、列表与导出清单共用同一份：勾了 6 条再开「导出 / 导入」，导出那一栏里就是这 6 条
   * （原来两个页签各有一套，切过去要重勾一遍）。判据在 [sessionList.tsx](./components/sessionList.tsx)
   * 的 `useSessionPicking()`。
   */
  picking: SessionPicking<SessionSummary>
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
