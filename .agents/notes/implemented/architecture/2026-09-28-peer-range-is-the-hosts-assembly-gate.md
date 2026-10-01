# Agent Note: peer 范围就是宿主的装配门

Status: implemented

## Problem

宿主（`dsh-app-boot` 的 `evaluatePluginCompatibility`）逐个看包名以 `@deepseek-ai/dsh` 或
`@deepseek-ai/dsh-` 开头的 peer，用 semver **带 `includePrerelease`** 去判运行中的那个版本收不收得下。
收不下就**整条 bundle 不装**，日志里一句
`skipping profile bundle "<包名>": Plugin <包名>@<版本> is incompatible with dsh <版本>`，其余什么也
不说（插件自己的 `apply` 根本没跑）。

0.2.0 之前本包声明的还是 `^0.1.7-rc.2`，升到 0.2.0 宿主后整页消失，就是这道门拦的。

## Decision

`engines.dsh` 与两个 DSH peer（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-ui-primitives`）
都写 `^0.2.0-rc.1`（`@deepseek-ai/cordis` 按自己那条线写 `^4.0.4`——它不在
`@deepseek-ai/dsh` 前缀里，所以那条线不设门），同代副本进 `devDependencies` 供构建。

## Alternatives considered

**放宽到「任意 0.x」。** 那正是这道门要挡的事：跨 minor 线时模块表与控件 API 都可能换过，而失败形态
是「整页不出现」——最难查的那种。

**只写 `engines.dsh`、不写 peer。** 装配门读的是 peer 前缀，`engines` 不是它判的依据。

**写 `>=0.2.0-rc.1`。** 上限开着等于把「收得下」这件事交给运气；包管理器判 peer 用的是默认语义，
与宿主的门对 rc 的宽严还不同——默认语义只认同 minor 同 patch 的 rc，宿主的门还收同 minor 的任意
rc（`^0.2.0-rc.1` 收得下 `0.2.1-rc.1`，收不下 `0.3.0-rc.1`，换 minor 线时要改这一行）。

## Consequences

- 真遇到改名删导出，`Slot` 条目会渲染成一个空 `div`（控制台里是 `slot entry crashed in '<slot>'`），
  使用者看到的是空白而不是错误——所以这道门是唯一的拦，不能只靠「编译期能发现」。
- 升级宿主代时必须同时改 peer 范围与 `devDependencies`；`test/manifest.test.mjs` 核的是**声明**：
  拿宿主自己的 `evaluatePluginCompatibility` 走一遍 `package.json`，要求它接受
  `devDependencies` 装的那条版本线、又不接受更早的宿主。
