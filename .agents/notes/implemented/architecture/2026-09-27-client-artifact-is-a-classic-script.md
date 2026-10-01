# Agent Note: 浏览器半侧的产物是经典脚本，只 require 基线模块

Status: implemented

## Problem

DSH 的[客户端模块系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)
只认 `window.__ModuleLoader__.load({ id, factory })` 这种方式报名的脚本，工厂拿到一个同步的
`require`，返回的 `module.exports` 就是插件的导出面（`inject` 与 `apply`）。

也就是说浏览器半侧的产物**不是**一个 npm 包：它没有 node_modules 解析，也没有旁挂依赖的路由。
而界面要画控件、要 JSX、要跟官方设置页长得一样。

## Decision

产物是一个经典脚本（cjs 外面套三行 banner/intro/footer），只有平台基线模块保持 `require`，其余一律
内联。基线是三条：

- `react`、`react/jsx-runtime`；
- `@deepseek-ai/dsh-client-ui-primitives`——官方给 Web Client 写的共享 React 原子组件库
  （Button / Checkbox / Tag / Switch / Input / Modal / SettingsForm…，zero Cordis）。

`tsdown.config.ts` 的 `CLIENT_EXTERNALS` 就是这份名单。控件改用它、不手写；要引非基线模块必须在
`dsh.client.external` 里点名。

## Alternatives considered

**把 `ui-primitives` 内联进包。** 那等于把一份 React 组件复制进来，还会跟宿主那份的 hooks 语义脱钩。

**继续手写控件。** 那是与官方设置页逐像素一致这个目标的直接对手；官方 62 个 `dsh-client-*` 包里
有 47 个的产物直接 `require` 它，而没有任何一个包把它写进 `dsh.client.external`——它是平台基线，
用之前不必声明。

**把 `ui-primitives` 也写进 `dsh.client.external`。** 它的地位由「模块表按 specifier 分发」确立，
写进 external 反而是把一个基线模块声明成非基线请求。

## Consequences

- 契约错了在源码层面看不出来，只有跑一遍产物才知道：`test/client.test.mjs` 用假的加载器与假
  `require` 按这份契约执行 `lib/client.js`。
- 代价是跟上游的版本节奏绑在一起——模块表按 specifier 分发、没有版本协商，控件 API 改了编译期发现
  不了（控制范围的那道门见
  [peer 范围是宿主的装配门](2026-09-28-peer-range-is-the-hosts-assembly-gate.md)）。
- 「包边界」只禁止运行时导入**另一个功能插件**的值；`ui-primitives` 这类职责收窄、没有功能生命周期的
  静态 owner 正是官方鼓励共享的那类。
