/**
 * 插件配置的 schema，以及被设置面接管的字段怎么读。
 *
 * 这里决定的不只是"有哪些字段"，还有**哪些字段能在插件管理器里改**：`sync` 整节带 `.volatile()`，
 * 于是它在宿主手里是**活引用**（`config.sync` 是一个用 `.get()` 取值的 Ref），Loader 每次配置变更都是
 * 对同一个引用做就地更新——界面上改完 URL 与映射，下一次预演/同步就用新值，**不必重启 DSH**。
 *
 * `sessionsRoot` / `registryPath` / `backupRoot` 刻意**不标** volatile，两处原因：它们改了会半生效
 * （会话库已经按旧根读进来了），而且设置接缝**只暴露 volatile 字段**——不标就自然不出现在那张表单上，
 * 不会摆出"改了好像生效、其实要重启"的输入框。
 *
 * volatile 还要求字段有**固定对象路径**（不能嵌在数组/字典里），所以 `sync` 是一个具名子对象，
 * 而不是把 `syncUrl`、`syncMapping` 平铺在根上：平铺开也能用，但表单里就分不出这是同一件事的一组配置。
 *
 * 活引用只在宿主交到 `apply` 手里的那一份出现。测试与其它调用方交的是普通对象，`syncSection()`
 * 因此对两种形状都读得出同一份值。
 *
 * @module dsh-session-manager/config
 */
import z from '@deepseek-ai/schemastery'

/**
 * schema 的最小结构面：Loader 真正用到的那几项——可调用（校验并填默认值）、`toJSON()`（生成设置
 * 表单、`--dump-config-schema`）、`meta`（volatile 标记）。
 *
 * 为什么手写而不是让 TS 推导：schemastery 推导出来的类型里带着 cosmokit 内部的 `Volatile` 引用，
 * 而本包的声明是逐文件 unbundle 出来的（tsdown 的 types 目标），那种匿名推导类型没法命名（TS2742）。
 * 于是这两个导出显式标注、并在赋值处转一次型——**只为声明能落地**，运行期就是 schemastery 那份
 * schema 本身（谁在乎这件事，看 `Config` 与 `--dump-config` 的实际输出）。
 */
export interface ConfigSchema {
  (data: unknown): unknown
  toJSON?(): unknown
  meta?: { volatile?: boolean }
}

/** 一次同步的配置（配置里的原始形态；核心层的解析形态见 src/sync.ts 的 `SyncSettings`）。 */
export interface SyncConfig {
  /** 远端资源根（WebDAV 集合地址）；不配这一项就等于没开同步。 */
  url: string
  /** 这台机器的标识；缺省取主机名。两台机器用同一个 id 会互相盖掉对方的格子。 */
  machineId?: string
  username?: string
  /**
   * 密码的**引用**（环境变量名），不是密码本身。
   *
   * 与 DSH 自己的口径一致：配置里只放引用，值由宿主的 credentials 服务解析；没有那个服务时退到
   * `process.env`。于是配置备份、同步、截图都不会把密码带走——那张表单里也一样，它填的是引用名。
   */
  passwordRef?: string
  /** 显式映射：远端 `cwd` → 本机目录（`/home/alice/dev/proj: /opt/work/proj`）。 */
  mapping?: Record<string, string>
  /** 单次请求超时（毫秒），缺省 30000。 */
  timeoutMs?: number
}

/** 插件配置。 */
export interface PluginConfig {
  sessionsRoot?: string
  registryPath?: string
  backupRoot?: string
  sync?: SyncConfig
}

/**
 * 同步那一节的 schema。
 *
 * 整节 volatile：这是设置面里唯一"改了立即生效"的一节。字段都不带默认值——缺席要好过拿一个空串
 * 冒充"用户填了空"，`url` 为空与没配这一节在行为上是同一件事（工具与界面都按"没配置"处理）。
 */
export const SyncConfigSchema = z
  .object({
    url: z.string(),
    machineId: z.string(),
    username: z.string(),
    passwordRef: z.string(),
    mapping: z.dict(z.string()),
    timeoutMs: z.number().step(1).min(1),
  })
  .volatile() as unknown as ConfigSchema

/**
 * 插件配置的 schema。
 *
 * Loader 用它校验 profile 里那一节（非法值在装配时当场抛），设置接缝用它生成那张表单。根节点
 * 刻意**不**标 volatile：标了会把上面三个路径字段也一起变成活字段、暴露进表单。
 */
export const Config = z.object({
  sessionsRoot: z.string(),
  registryPath: z.string(),
  backupRoot: z.string(),
  sync: SyncConfigSchema,
}) as unknown as ConfigSchema

/**
 * 宿主交到 `apply` 手里的活引用形态：`sync` 那一节是活引用（`.get()` 取值），其余是快照值。
 *
 * 这一份是**手写**的而不是从 schema 推导的：推导出来的类型会在声明里带进 cosmokit（见 `AnySchema`），
 * 而这里要表达的是"宿主会交来什么形状"，手写反而更准。
 */
export interface PluginConfigRef {
  sessionsRoot?: string
  registryPath?: string
  backupRoot?: string
  sync?: { get(): SyncConfig | undefined }
}

/**
 * 配置的两种来路：设置面管着的活引用，或普通对象（测试、以及没有走设置面的调用方）。
 *
 * 两种都要收，因为同一份代码同时供两条路用：宿主交的是前者，测试与核心层构造的是后者。
 */
export type PluginConfigInput = PluginConfig | PluginConfigRef

/**
 * 读同步那一节。
 *
 * 活引用每次调用都重新读（这就是"改完不用重启"的全部机制：不是插件重新挂载，而是它每次都从同一个
 * 引用里取当前值）；普通对象直接当值用。
 *
 * @param config 插件配置（活引用或普通对象，也可以是 undefined）。
 * @returns 当前那份同步配置；没配这一节就是 undefined。
 */
export function syncSection(config: PluginConfigInput | undefined): SyncConfig | undefined {
  const raw = config?.sync
  if (raw === undefined || raw === null) return undefined
  const read = (raw as { get?: () => SyncConfig | undefined }).get
  if (typeof read === 'function') return read.call(raw) ?? undefined
  return raw as SyncConfig
}
