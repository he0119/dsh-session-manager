# Agent Note: 可选服务只能走 ctx.get 或 ctx.inject

Status: implemented

## Problem

Cordis 的 Context 是个 Proxy，**服务属性只有在当前 fiber 的 `inject` 里声明过才可读**，否则同步抛
`cannot get property "X" without inject`——**即使那个服务确实存在**。

这条坑的隐蔽之处在测试里：**根 context（fiber 没有 runtime）走的是非严格路径**，属性读法在根上、
或从根 `provide` 的服务上都能蒙对；纯对象假 ctx 更是完全读得到。于是本插件在真实 profile 里整个
起不来（`web-dev` 的日志：`cannot get property "webServer" without inject`），而当时的假 ctx 测试
**全绿**。

## Decision

- 硬依赖写进 `inject`（本插件是 `tools`）；
- 可选服务（`webServer`、`workspaceRegistry`）走 `optionalService(ctx, name)`（内部是 `ctx.get`），
  或者用 `ctx.inject([name], cb)` 开一个子 fiber——后者顺带解决顺序问题：服务由别的 bundle 提供、
  晚于本插件到位时，回调会在它到位后跑，端点不会永远缺席；
- 卸载时子 fiber 随父 fiber 一起释放，所以 `ctx.inject` 里注册的路由不需要再手工收集。

测试侧对应的决定：`test/artifact.test.mjs` 与 `test/tools.test.ts` 都在**真实 Cordis 的 fiber 上**、
并由**兄弟** fiber 提供服务，就是为了让这类错误在测试里就炸。

## Alternatives considered

**把可选服务也写进顶层 `inject`。** 那就把「可选」变成了「没有它整页都别装」——非 Web profile 上
本插件会直接消失，而它其余的能力（工具层）本来是能用的。

**用 `as any` / 索引访问绕过 Proxy。** Proxy 拦的是属性读取本身，绕过它要么改宿主、要么把类型系统
关掉，而错误依然在运行时。

**继续用假 ctx 做单元测试。** 假 ctx 读什么属性都成功，这条错误在测试里不存在——这正是它发生过的
原因。

## Consequences

- 每个可选服务的读取都收敛在 `optionalService()` / `ctx.inject()` 两处，类型上是 `unknown`，形状由
  各自的探测器（`archiveOps()`、`directoryPickerKind()`）核对。
- 服务缺失时的行为是显式的一支（回 409 并说明原因、或退回降级形状），不是靠属性读取恰好不抛。
