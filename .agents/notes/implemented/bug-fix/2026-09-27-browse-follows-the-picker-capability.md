# Agent Note: 「浏览…」按宿主的能力走

Status: implemented

## Problem

宿主的目录选择器（`@deepseek-ai/dsh-host-directory-picker`）是一只**互斥的能力位**服务：

- `capability()` 返回 `{ kind: 'native', … }` 时**只**提供 `pick()`（在宿主显示器上弹系统对话框）；
- 返回 `{ kind: 'browse', … }` 时**只**提供 `list()` / `createDirectory()`（页面自己画浏览器）。

`dsh-api-workspace-controller` 在协议层就把两者分开了：浏览器界面这一侧的 profile 装的是
`dsh-client-ui-directory-picker-browse`，即 `browse` 那一只——此时硬调 `pickDirectory()` 一定被宿主
以 `directory-picker/unavailable`（`… needs the native capability; the composed picker serves
"browse"`）拒绝。

也就是说，「点『浏览…』就调 `pickDirectory()`」这个写法**在浏览器里是必错的**：桌面端能用，正是这
一点让它在开发机上不容易被察觉。

## Decision

宿主侧 `directoryPickerKind(ctx)` 读出 `capability().kind`，经 `GET /state` 的 `pickerKind` 字段交给
页面（读不到、认不出、或 `capability()` 抛错都退回 `null`）；页面按它走：

- `native` → `pick()` 弹系统对话框；
- `browse` → 页面内展开一个目录浏览框（`src/client/components/DirectoryPicker.tsx`），数据来自宿主的
  `listDirectory()`，每一步跳转用的都是宿主返回的 `path`，本插件不碰文件系统、不猜路径；
- `null`（含旧宿主没有这个字段）→ **不显示**「浏览…」，只留「手输路径」+ 候选列表，并给一句说明。

## Alternatives considered

**直接调 `pickDirectory()`。** 在浏览器半侧的 profile 上必被拒——原则是**不摆一个一定会报错的按钮**。

**两条路都摆出来（一个「选目录」一个「浏览」）。** 其中一条必然失败，而失败信息是宿主给的一句英文
协议错误，使用者无从判断该点哪个。

**`capability()` 认不出时猜一个。** 猜错的方向是「按钮点了报错」；不显示只损失一条改值的路，而手输
路径仍然在。

## Consequences

- 判定只有一处：`pickerKind` 从宿主侧算出、经 `/state` 下发，页面不再自己探测能力。
- `uiWorkspace` 在客户端同样受「服务属性必须声明过 `inject` 才可读」这条规矩管（见
  [可选服务只能走 ctx.get 或 ctx.inject](../bug-fix/2026-09-27-optional-services-need-inject.md)）：
  它在别的客户端插件手上，写进本插件顶层 `inject` 就等于「没有它整页都别装」。所以用
  `ctx.inject(['uiWorkspace'], cb)` 把两个调用面收成一个 thunk 存在 `src/client/directory.ts`，
  界面点「浏览…」时才取当前那一个——服务晚到也能用上，服务不在则退回「只有手输路径」的形状。
