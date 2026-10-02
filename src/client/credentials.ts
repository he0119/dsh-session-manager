/**
 * 宿主机凭据服务（浏览器半侧的 `remote.credentials`）的持有处。
 *
 * 为什么要有这一层：密码的值**不进配置文档**，它由宿主的凭据服务持有、按引用名（环境变量名）解析
 * ——这是 DSH 自己的口径（见 [官方凭据子系统的说明](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/credentials)），
 * 也是官方那几个要密钥的插件（如网页搜索、GitHub webhook）的做法：配置里只有引用名，值由配置界面
 * 通过 `remote.credentials` 的 `set` 写进宿主的凭据库。读的那一半只有"配没配、能不能写"（
 * `describe`）——**没有任何一条读路径会返回值**，所以界面上那个输入框永远是空的。
 *
 * 服务只能在声明过 `inject` 的 fiber 里取，而设置页组件是外壳渲染的、手上没有那个 fiber：所以由插件
 * 入口（[index.ts](./index.ts)）用 `ctx.inject(['remote', 'remote.credentials'], …)` 收进这里，
 * 组件在渲染/提交时取用（与 [directory.ts](./directory.ts) 收宿主目录选择器同一套做法）。
 *
 * 与那一处一样，这层只留**结构**：不 import 宿主客户端包的类型，形状由本文件描述，运行期成立与否
 * 由 `test/client.test.mjs` 的注入面断言兜住。
 *
 * @module dsh-session-manager/client/credentials
 */

/** `describe` 的答案：一个引用配没配、来自哪一层、能不能写——**没有值**。 */
export interface CredentialInfo {
  configured: boolean
  source?: string
  writable: boolean
}

/**
 * Remote 调用的结算形状：`ok` 为假时是宿主拒了这个写（例如引用被启动环境里的值遮住，
 * 那种写入会"看起来成功、解析却一直返回被遮住的值"，于是 seam 直接拒），原因在 `error.message`。
 */
export type CredentialResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** 本页要用的那一部分：问状态、写值（官方 Remote 命名空间 `credentials`）。 */
export interface CredentialsApi {
  /** 一次问多个引用，按引用名索引（官方是批量接口，本页一次只问一个）。 */
  describe(refs: readonly string[]): Promise<CredentialResult<Record<string, CredentialInfo>>>
  /** 把一个值写进宿主管的凭据库；空值由宿主拒绝（要清掉一个引用得用它自己的 `unset`）。 */
  set(ref: string, value: string): Promise<CredentialResult<void>>
}

let current: CredentialsApi | undefined

/** 记下当前可用的凭据服务（传 `undefined` 表示服务已卸载）。 */
export function setCredentialsApi(api: CredentialsApi | undefined): void {
  current = api
}

/** 取当前可用的凭据服务；宿主没提供（或已卸载）时为 `undefined`，表单据此说明"密码只能走环境变量"。 */
export function getCredentialsApi(): CredentialsApi | undefined {
  return current
}
