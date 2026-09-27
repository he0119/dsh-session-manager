/**
 * `dsh-session-manager` 的 Web Client 端：把「会话管理」注册成设置里的独立一页。
 *
 * 页面主体在 [ManagerPanel.tsx](./ManagerPanel.tsx)（页内分「导入导出」与「迁移」两页），
 * 文案在 [locales.ts](./locales.ts)，端点调用在 [api.ts](./api.ts)，样式在 [styles.ts](./styles.ts)
 * ——这里只做组装。
 *
 * 注册进 `settings.section`：设置左侧导航里的一页，与「通用 / 模型 / 插件 / 账户 / Agent 预设」
 * 并列。没有选另外两个相似的槽位，理由是它们各自有一个真问题：
 *   - `plugins.detail.section`（插件详情页里的一段）归属感最贴，但要按 subject
 *     （`item` / `row` / `bundle`）自过滤，而判断依据是**包在插件管理器里的表示形态**；
 *     猜错不报错，只是永远不渲染——静默空白。它还会在包内每一行的页面上各渲染一次，
 *     而本页要的是整页宽高（会话表 + 预演表），塞进 `gap: 32px` 的 section 列会挤。
 *   - `settings.plugins.tab`（「插件」设置区里的一个页签）那条页签栏的语义是「插件列表的视图」，
 *     一个功能页挤进去属于借位。
 *
 * 三个刻意的取舍：
 *   - 用 `ctx.slots.inject(...)` 而不是直接 `register`：`settings.section` 由设置外壳在运行时
 *     声明，那个声明完全可能晚于本插件 `apply`，直接注册会撞上「槽位尚未声明」；
 *   - `label` 用 thunk：外壳投影导航行时走 `resolveSlotLabel`（是函数就调用），并且订阅了 locale
 *     快照，切语言或后到的字典都会让那一行重新投影，不必自己重新注册；
 *   - 运行时只 `require('react')`（平台基线模块），**不 require 宿主的 UI 原语包**：那份包不是
 *     稳定契约，而它一抛异常就会让整个槽位条目变成崩溃占位。控件自己写，颜色只用主题 token。
 *
 * 类型面也是结构化的（不 import 宿主客户端包的类型）：本包不在类型层与那些包绑死，
 * 代价是 `ctx` 的成员只在运行期成立，由 `test/client.test.mjs` 的注册面断言兜住。
 *
 * 另有一处**服务借用**：目录字段的「浏览…」走宿主自己的 `uiWorkspace`，而不是本插件
 * 自己糊一套文件系统访问。它是可选依赖，收在 [directory.ts](./directory.ts) 里；宿主给的
 * 选择器分 `native`（系统对话框）与 `browse`（页面内浏览）两种能力，界面按宿主报来的
 * `pickerKind` 选一种，见那里的说明。
 *
 * @module dsh-session-manager/client
 */

import { ManagerPanel } from './ManagerPanel.tsx'
import { type DirectoryListing, getDirectoryApi, setDirectoryApi } from './directory.ts'
import { NS, en, zh, type Translate } from './locales.ts'
import { installStyles } from './styles.ts'

/** 插件名（客户端模块系统里的 factory id，等于包名）。 */
export const name = '@he0119/dsh-session-manager'

/** 本页注册的槽位：设置左侧导航里的一页。 */
export const SECTION_SLOT = 'settings.section'
/**
 * 本页的槽位 id（也是设置外壳 `only` 过滤时用的那个键）。
 *
 * 叫 `session-manager` 而不是 `session-transfer`：这一页现在同时管"搬会话"和"带走/带回来"，
 * 名字要跟页面一样能覆盖两件事。
 */
export const SECTION_ID = 'session-manager'
/** 排在官方那几页之后（账户 -10 / 通用 0 / 模型 10 / 插件 15 / Agent 预设 20），不插队。 */
export const SECTION_ORDER = 30

/** 槽位注册的入参形状（只取本模块用得到的字段）。 */
interface SlotRegistration {
  name: string
  id: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => Record<string, unknown>
}

/** `slots` 服务的最小面。 */
interface SlotsService {
  inject(slot: string, callback: () => unknown): unknown
  register(registration: SlotRegistration, component: unknown): () => void
}

/** `locale` 服务的最小面。 */
interface LocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
}

/**
 * `uiWorkspace` 服务的最小面：本页只用它的目录选择器。
 *
 * 两个方法对应宿主能力位的两只（`native` / `browse`），**互斥**——在 `browse` 宿主上
 * `pickDirectory()` 会被宿主以 `directory-picker/unavailable` 拒绝，反之 `listDirectory()`
 * 也会。界面用宿主报来的 `pickerKind`（`/state`）选其中一个，不试错。
 */
interface UiWorkspaceService {
  /** 宿主系统对话框（`native` 宿主）：绝对路径，用户取消 `null`。 */
  pickDirectory(): Promise<string | null>
  /** 页面内浏览（`browse` 宿主）：列一层子目录；省略路径 = 宿主 home。 */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
}

/** 客户端根上下文的最小面。 */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): unknown
  slots: SlotsService
  locale: LocaleService
  /**
   * 起一个**带依赖声明**的子 fiber（Cordis 的 `inject`：等价于就地注册一个只声明这些依赖的子插件）。
   *
   * 本页用它按需收 `uiWorkspace`：那个服务由别的客户端插件提供，写进本插件的顶层 `inject`
   * 数组就等于"服务不在，整页都别装"，代价太大；这里声明成可选依赖，服务到位时回调才跑，
   * 卸载时跑回调返回的清理函数。返回值是那个子 fiber，本模块不用它。
   */
  inject(
    dependencies: readonly string[],
    callback: (scoped: ClientContext & { uiWorkspace: UiWorkspaceService }) => void | (() => void),
  ): unknown
}

/**
 * 客户端插件入口。
 *
 * `apply` 必须保持同步：宿主 Cordis 会卸载 async apply 里 `await` 之后注册的 `ctx.effect`。
 * 本函数里没有任何 await——注册本身是同步的，页面的数据由它自己在挂载后去取。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-manager: dictionaries')
  ctx.effect(() => installStyles(), 'dsh-session-manager: stylesheet')

  // 目录选择器是可选依赖：它在别的客户端插件手上，晚到或不在都不该拖住本页的注册。
  // 收成 thunk 交给页面，点「浏览…」时才取当前那一个；服务卸载后再点会得到提示而不是空转。
  ctx.inject(['uiWorkspace'], (scoped) => {
    setDirectoryApi({
      pick: () => scoped.uiWorkspace.pickDirectory(),
      list: (path, signal) => scoped.uiWorkspace.listDirectory(path, signal),
    })
    return () => setDirectoryApi(undefined)
  })

  ctx.slots.inject(SECTION_SLOT, () =>
    ctx.slots.register(
      {
        name: SECTION_SLOT,
        id: SECTION_ID,
        order: SECTION_ORDER,
        // thunk：外壳投影导航行时会调用它，切语言后重新投影即可，不必重新注册。
        label: () => ctx.locale.bind(NS)('title'),
        locale: NS,
        // 同理给一个**取选择器的函数**：投影时它可能还没到位，点击那一刻才作数。
        inject: () => ({ t: ctx.locale.bind(NS), directory: () => getDirectoryApi() }),
      },
      ManagerPanel,
    ),
  )
}

/** 依赖的客户端服务：槽位注册面与字典服务。 */
export const inject = ['slots', 'locale']
