/**
 * `dsh-session-manager` 的 Web Client 端：把「会话导入导出」注册成 设置 → 插件 里的一页。
 *
 * 页面主体在 [TransferPanel.tsx](./TransferPanel.tsx)，文案在 [locales.ts](./locales.ts)，
 * 端点调用在 [api.ts](./api.ts)，样式在 [styles.ts](./styles.ts)——这里只做组装。
 *
 * 注册进 `settings.plugins.tab`（「插件」设置区里的一个页）：它是**列表槽位**，用自己的 id 就
 * 会与随包发布的那几个页并排出现，点开就是这一页。
 *
 * 两个刻意的取舍：
 *   - 用 `ctx.slots.inject(...)` 而不是直接 `register`：`settings.plugins.tab` 由设置外壳在运行时
 *     声明，那个声明完全可能晚于本插件 `apply`，直接注册会撞上「槽位尚未声明」；
 *   - 运行时只 `require('react')`（平台基线模块），**不 require 宿主的 UI 原语包**：那份包不是
 *     稳定契约，而它一抛异常就会让整个槽位条目变成崩溃占位。控件自己写，颜色只用主题 token。
 *
 * 类型面也是结构化的（不 import 宿主客户端包的类型）：本包不在类型层与那些包绑死，
 * 代价是 `ctx` 的成员只在运行期成立，由 `test/client.test.mjs` 的注册面断言兜住。
 *
 * @module dsh-session-manager/client
 */

import { TransferPanel } from './TransferPanel.tsx'
import { NS, en, zh, type Translate } from './locales.ts'
import { installStyles } from './styles.ts'

/** 插件名（客户端模块系统里的 factory id，等于包名）。 */
export const name = '@he0119/dsh-session-manager'

/** 本页注册的槽位。 */
export const TAB_SLOT = 'settings.plugins.tab'
/** 本页的槽位 id（自己的 id → 与随包发布的页并排，而不是替换它们）。 */
export const TAB_ID = 'session-transfer'
/** 排在随包的「全部插件」页之后。 */
export const TAB_ORDER = 50

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

/** 客户端根上下文的最小面。 */
export interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): unknown
  slots: SlotsService
  locale: LocaleService
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

  ctx.slots.inject(TAB_SLOT, () =>
    ctx.slots.register(
      {
        name: TAB_SLOT,
        id: TAB_ID,
        order: TAB_ORDER,
        // thunk：切语言时外壳重新投影一次即可，不必重新注册。
        label: () => ctx.locale.bind(NS)('tab'),
        locale: NS,
        inject: () => ({ t: ctx.locale.bind(NS) }),
      },
      TransferPanel,
    ),
  )
}

/** 依赖的客户端服务：槽位注册面与字典服务。 */
export const inject = ['slots', 'locale']
