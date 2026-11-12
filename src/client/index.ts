/**
 * `dsh-session-manager` 的 Web Client 端：把「会话管理」拆成两个落点注册出去。
 *
 * **侧栏那一页做事**（挑会话、迁移、导入导出、同步、备份）：`main` 放页面本身，`sidebar.panellist`
 * 放侧栏那一行图标，两者用同一个 id 配对（宿主按 id 把侧栏那条指到主栏那一页）。
 *
 * **设置里那一页只放怎么配**：`settings.section` 挂的是 [SettingsPanel.tsx](./SettingsPanel.tsx)，
 * 里面只有 WebDAV 那张配置卡。为什么分两页：配置一年改两次，操作用天天用——挤在一页里时，每次同步
 * 都得先翻过十来个字段的配置卡，改配置又得先滚到底。官方的 `dsh-context` 也是这么分的（设置里只有
 * 偏好项，数据在侧栏那一页）。
 *
 * 页面主体在 [ManagerPanel.tsx](./ManagerPanel.tsx)（页内分「会话」「迁移」「传输」「同步」「说明」
 * 五个分页），侧栏那一版外面多一层 [SessionManagerPage.tsx](./components/SessionManagerPage.tsx)
 * （主栏要自己带滚动视口），文案在 [locales.ts](./locales.ts)，端点调用在 [api.ts](./api.ts)，
 * 样式在 [styles.ts](./styles.ts)——这里只做组装。
 *
 * 设置那一页与「通用 / 模型 / 插件 / 账户 / Agent 预设」并列。没有选另外两个相似的 Slot，理由是
 * 它们各自有一个真问题：
 *   - `plugins.detail.section`（插件详情页里的一段）归属感最贴，但要按 subject
 *     （`item` / `row` / `bundle`）自过滤，而判断依据是**包在插件管理器里的表示形态**；
 *     猜错不报错，只是永远不渲染——静默空白。它还会在包内每一行的页面上各渲染一次，
 *     而本页要的是整页宽高（会话表 + 计划表），塞进 `gap: 32px` 的 section 列会挤。
 *   - `settings.plugins.tab`（「插件」设置区里的一个页签）那条页签栏的语义是「插件列表的视图」，
 *     一个功能页挤进去属于借位。
 *
 * 三个刻意的取舍：
 *   - 用 `ctx.slots.inject(...)` 而不是直接 `register`：`settings.section` 由设置外壳在运行时
 *     声明，那个声明完全可能晚于本插件 `apply`，直接注册会撞上「Slot 尚未声明」；
 *   - `label` 用 thunk：外壳投影导航行时走 `resolveSlotLabel`（是函数就调用），并且订阅了 locale
 *     快照，切语言或后到的字典都会让那一行重新投影，不必自己重新注册；
 *   - 运行时只 `require` 平台基线模块（`react` / `react/jsx-runtime` /
 *     `@deepseek-ai/dsh-client-ui-primitives`）：控件改用官方控件库（手写的在逐个替换），不引非
 *     基线模块，颜色只用主题 token。基线模块没送到时整个 Slot 条目会变成崩溃占位，所以渲染路径上
 *     不做会抛的事。字典与命名空间那两处**只 import 类型**，产物里一个 require 都不会多。
 *
 * 文案与 `t` 走官方的 locale 机制：字典在 [locales.ts](./logic/locales.ts) 里注册进 `locale`
 * 服务，注册 Slot 时带 `locale: NS`，页面的 `t` 由**框架 props** 送来（`PropsLocale`，见官方
 * 「新增设置卡片」那一页的示例）——本页不再自己 inject 一个 `t`，也不留中文兜底：那一层的服务
 * 不在时框架给的是崩溃占位，而不是"悄悄换一种语言"。`ctx` 的其余成员仍是结构化的最小面，由
 * `test/client.test.mjs` 的注册面断言兜住。
 *
 * 另有一处**服务借用**：目录字段的「浏览…」走宿主自己的 `uiWorkspace`，而不是本插件
 * 自己糊一套文件系统访问。它是可选依赖，收在 [directory.ts](./directory.ts) 里；宿主给的
 * 选择器分 `native`（系统对话框）与 `browse`（页面内浏览）两种能力，界面按宿主报来的
 * `pickerKind` 选一种，见那里的说明。
 *
 * 一个**改不掉的已知限制**：设置左侧导航那一行的图标由外壳画，插件指定不了。外壳里那张表是
 * 硬编码的 id → 图标映射（`dsh-client-ui-settings-general` 的 `navIcon(id)`：`account` / `models` /
 * `agent-presets` / `plugins` / `archived-sessions` 五个 id，其余一律 `IconSettingsOutlineMedium`），
 * 而 Slot 注册的入参里根本没有 `icon` 这一项（外壳投影导航行时只读 `id` / `order` / `label` 三项）。
 * 于是本页与「通用」共用同一个齿轮图标——不是本插件写错了图标，是外壳给所有人兜底的那一个。
 * 不改 id 去蹭别人的图标：唯一空着的是 `archived-sessions`，它的语义是"归档会话"，蹭它既可能与
 * 内置页撞 id，也是拿图标撒谎。要换图标只能等上游给注册选项加 `icon`（本页的 id 已经稳定，
 * 上游加了之后这里只需多传一个字段）。
 *
 * @module dsh-session-manager/client
 */

import type { BuiltInLocaleId } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

import { type CredentialsApi, setCredentialsApi } from './credentials.ts'
import { type DirectoryListing, getDirectoryApi, setDirectoryApi } from './directory.ts'
import { NS, en, zh, type Translate } from './logic/locales.ts'
import { SessionManagerIcon } from './components/icons.tsx'
import { SessionManagerPage } from './components/SessionManagerPage.tsx'
import { PluginConfigCard } from './components/PluginConfigCard.tsx'
import { setNavigationApi } from './navigation.ts'
import { PLUGIN_NAME } from './plugin.ts'
import { installStyles } from './styles.ts'
import { SYNC_SECTION, setSyncConfigApi, type SyncConfigApi } from './logic/syncForm.ts'

/** 插件名（客户端模块系统里的 factory id，等于包名）。 */
export { PLUGIN_NAME as name } from './plugin.ts'

/** 本页注册的 Slot：设置左侧导航里的一页。 */
export const SECTION_SLOT = 'settings.section'
/**
 * 插件页里这一包的那格配置。键是**包名**（`plugins.bundle.config` 的契约），不是设置命名空间。
 */
export const CONFIG_SLOT = 'plugins.bundle.config'

/** 宿主插件管理器的导航面（`pluginNavigation` 服务）：`openBundle` 切到插件页并打开这个包。 */
interface PluginNavigationService {
  /** 切到插件页的「已安装」栏并打开这个包的页面。 */
  openBundle(packageName: string): void
}
/**
 * 本页的 Slot id（也是设置外壳 `only` 过滤时用的那个键）。
 *
 * 叫 `session-manager` 而不是 `session-transfer`：这一页现在同时管"搬会话"和"带走/带回来"，
 * 名字要跟页面一样能覆盖两件事。
 */
export const SECTION_ID = 'session-manager'
/** 排在官方那几页之后（账户 -10 / 通用 0 / 模型 10 / 插件 15 / Agent 预设 20），不插队。 */
export const SECTION_ORDER = 30

/**
 * 侧栏入口 + 主栏页面用的 Slot 与 id。
 *
 * 宿主那两侧按 id 配对：`main` 的 `key` 与 `sidebar.panellist` 的 `id` 必须是同一个值，点了侧栏那一行
 * 主栏就换到它（见 `@deepseek-ai/dsh-client-ui-sidebar` 的 slot 契约：「Each list id addresses the
 * matching main panel」）。与设置里那一页共用 `SECTION_ID`——同一个页面，两个落点。
 */
export const PANEL_SLOT = 'main'
/** 侧栏那一条：宿主负责按钮与无障碍名字，条目只提供图标。 */
export const PANEL_LIST_SLOT = 'sidebar.panellist'
/**
 * 侧栏里的顺序：官方那几个各有自己的位置（插件 …、自动化任务 10、上下文洞察 20），本页排在自动化
 * 任务之后、上下文洞察之前——都在"全局面板"这一串里，谁挨着谁不重要，别插到最前面抢先就行。
 */
export const PANEL_ORDER = 12

/** Slot 注册的入参形状（只取本模块用得到的字段）。 */
interface SlotRegistration {
  name: string
  /** 列表型 Slot（`settings.section`、`sidebar.panellist`）用 id。 */
  id?: string
  /** 键控型 Slot（`main`）用 key，与列表那一条的 id 相同。 */
  key?: string
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

/**
 * `configForms` 服务的最小面：按命名空间取本插件那一节的读写控制器。
 *
 * 这是宿主的设置接缝：读的是生效配置（组合层 + 用户层），写的是用户层——也就是设置对话框里
 * 「Open configuration file」打开的那份文档。插件不另存一份，配置只有一个来源。
 */
interface ConfigFormsService {
  get(namespace: string): SyncConfigApi | undefined
}

/**
 * `locale` 服务的最小面。
 *
 * 两个方法都按**本命名空间**收窄：`register` 的字典要 `LocaleDictOf<NS>`（少键 / 多键是编译
 * 错误），`bind` 回来的翻译函数键域也是这一份加宿主的 `common`。
 */
interface LocaleService {
  register(
    namespace: typeof NS,
    dictionaries: Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>,
  ): () => void
  bind(namespace: typeof NS): Translate
}

/**
 * `uiWorkspace` 服务的最小面：本页只用它的目录选择器。
 *
 * 两个方法对应宿主能力位的两只（`native` / `browse`），**互斥**——在 `browse` 宿主上
 * `pickDirectory()` 会被宿主以 `directory-picker/unavailable` 拒绝，反之 `listDirectory()`
 * 也会。界面用宿主报来的 `pickerKind`（`/meta` 先到，`/state` 里同一份）选其中一个，不试错。
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
   * 本页用它按需收 `uiWorkspace` 与 `remote.credentials`：那两个服务由别的客户端插件提供，写进
   * 本插件的顶层 `inject` 数组就等于"服务不在，整页都别装"，代价太大；这里声明成可选依赖，服务
   * 到位时回调才跑，卸载时跑回调返回的清理函数。返回值是那个子 fiber，本模块不用它。
   *
   * 依赖名与回调拿到的服务由调用方自己配对（泛型参数），本模块不认识具体服务——那种"只在运行期
   * 成立"的形状是本包客户端半侧的统一口径（类型面不 import 宿主客户端包）。
   */
  inject<T extends object>(
    dependencies: readonly string[],
    callback: (scoped: ClientContext & T) => void | (() => void),
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

  // 设置接缝是可选依赖：它由插件管理器提供，缺席（例如只装了设置外壳的宿主）时同步设置表单自己
  // 说明"这个宿主不能在界面里改"，而不是让整页装不上。取到的那一份控制器就是宿主给本插件这一节
  // 的读写面，原样收下——不包一层转发，免得两处形状各自漂移。
  ctx.inject<{ configForms?: ConfigFormsService }>(['configForms'], (scoped) => {
    const controller = scoped.configForms?.get(SYNC_SECTION)
    if (controller === undefined) return undefined
    setSyncConfigApi(controller)
    return () => setSyncConfigApi(undefined)
  })

  // 目录选择器同样是可选依赖：它在别的客户端插件手上，晚到或不在都不该拖住本页的注册。
  // 收成 thunk 交给页面，点「浏览…」时才取当前那一个；服务卸载后再点会得到提示而不是空转。
  ctx.inject<{ uiWorkspace: UiWorkspaceService }>(['uiWorkspace'], (scoped) => {
    setDirectoryApi({
      pick: () => scoped.uiWorkspace.pickDirectory(),
      list: (path, signal) => scoped.uiWorkspace.listDirectory(path, signal),
    })
    return () => setDirectoryApi(undefined)
  })

  // 凭据服务（`remote.credentials`，宿主 Remote 面的一员）同样是可选依赖：宿主没装凭据提供方
  // （例如没有 `dsh-credentials-local` 的 profile）时，同步表单要说明"密码只能走环境变量"，而不是
  // 让整页装不上。两个依赖名都声明：命名空间服务挂在 `remote` 下面，官方客户端插件也是这么写的。
  ctx.inject<{ remote?: { credentials?: CredentialsApi } }>(
    ['remote', 'remote.credentials'],
    (scoped) => {
      const namespace = scoped.remote?.credentials
      if (namespace === undefined) return undefined
      setCredentialsApi({
        describe: (refs) => namespace.describe(refs),
        set: (ref, value) => namespace.set(ref, value),
      })
      return () => setCredentialsApi(undefined)
    },
  )

  // 「去插件页看看配置」那条路：插件管理器在运行时 `provide` 一个 `pluginNavigation`（`openBundle`）。
  // 同样是可选依赖——宿主没装插件管理器时，那一枚按钮自己说明"这个宿主没有插件页"。
  ctx.inject<{ pluginNavigation?: PluginNavigationService }>(['pluginNavigation'], (scoped) => {
    const navigation = scoped.pluginNavigation
    if (navigation === undefined) return undefined
    setNavigationApi({ openPackage: () => navigation.openBundle(PLUGIN_NAME) })
    return () => setNavigationApi(undefined)
  })

  /*
   * 侧栏入口 + 主栏页面：**做事**的地方（挑会话、迁移、导入导出、同步、备份）。
   * 设置里那一页只放**怎么配**（见文件末尾那条注册）——两种读者的状态不一样：配置一年改两次，
   * 操作用天天用。这一点与官方的 `dsh-context` 同一个分法（设置里是偏好项，数据在侧栏那一页）。
   */
  ctx.slots.inject(PANEL_SLOT, () =>
    ctx.slots.register(
      {
        name: PANEL_SLOT,
        key: SECTION_ID,
        locale: NS,
        inject: () => ({ directory: () => getDirectoryApi() }),
      },
      SessionManagerPage,
    ),
  )

  ctx.slots.inject(PANEL_LIST_SLOT, () =>
    ctx.slots.register(
      {
        name: PANEL_LIST_SLOT,
        id: SECTION_ID,
        order: PANEL_ORDER,
        // thunk：切语言后重新投影即可；无障碍名字由宿主从这一份 label 里取。
        label: () => ctx.locale.bind(NS)('page.title'),
        locale: NS,
      },
      SessionManagerIcon,
    ),
  )

  /*
   * 插件页里这一包的那格配置（`plugins.bundle.config`，**按包名作键**）：WebDAV 地址、机器标识、
   * 账号与密码引用、路径映射、自动推送。设置页不再有本包的一页——那里只放官方那几项。
   */
  ctx.slots.inject(CONFIG_SLOT, () =>
    ctx.slots.register(
      {
        name: CONFIG_SLOT,
        key: PLUGIN_NAME,
        locale: NS,
        inject: () => ({}),
      },
      PluginConfigCard,
    ),
  )
}

/** 依赖的客户端服务：Slot 注册面与字典服务。 */
export const inject = ['slots', 'locale']
