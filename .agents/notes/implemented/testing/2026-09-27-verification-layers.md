# Agent Note: 每一层测试证明什么

Status: implemented

## Problem

这个包同时在三个地方执行：宿主的进程（`lib/index.js`）、浏览器里的经典脚本（`lib/client.js`）、
以及它自己写的文件格式与文件系统操作。一份测试不可能同时覆盖这三处，而「测试都绿了」是最容易让人
误判的一句话——本仓库真的发生过假 ctx 全绿、真实 profile 里整个起不来的事。

## Decision

按「哪一层证明什么」分工，各层不互相顶替：

| 层 | 证明的事 | 位置 |
|---|---|---|
| 单元 | `projectKey` / `encodeSegment` 与宿主逐字节一致；有损碰撞确实存在 | `test/project-key.test.ts` |
| 单元 | 多帧原语、首帧边界、**多帧感知守卫会拒绝 `node:zlib`** | `test/zstd-frame.test.ts` |
| 单元 | 保结构改写只动 header；拒绝错 `cwd` / 非 header / 首帧多行 | `test/session-log.test.ts` |
| 单元 | 启动四条不变式逐类可抓；`reHome` 前后校验 | `test/registry.test.ts` |
| 单元 | 迁移编排：预演只读、dry-run 零写入、执行后复核、回滚还原、**备份目录越界一律拒** | `test/migrate.test.ts` |
| 产物契约 | 按模块加载器契约执行 `lib/client.js`：导出面、Slot、字典键集、四个分页、两级标记 | `test/client.test.mjs` |
| 宿主契约 | 在**真实 Cordis fiber** 里加载 `lib/index.js`：激活、可选服务探测、八条路由挂上、卸载摘干净 | `test/artifact.test.mjs` |
| 端到端 | 沙箱内造多帧日志 + 注册表，跑 `plan → apply → verify → rollback`，断言**逐字节**还原 | `test/engine.test.ts` |
| 契约 | 用**真实 `@deepseek-ai/dsh-tools`** 走 `defineTool`：schema 归一化、实参校验、真实执行 | `test/tools.test.ts` |
| 真实数据 | 本机真实会话日志（多帧）+ 真实注册表（条数随本机环境，测试自己打印出来） | `test/real-data.test.ts` |

## Alternatives considered

**只留端到端。** 端到端跑不出「守卫会不会拒绝 `node:zlib`」这类反事实——它用的是**正确的**解码器；
而格式与边界正是这个包最容易错的地方。

**用假的 ctx / 假的宿主对象做单元测试。** 纯对象假 ctx 读什么属性都成功，于是「没声明 `inject`
就读服务」这条错误在测试里不存在（见
[可选服务只能 `ctx.get` / `ctx.inject`](../bug-fix/2026-09-27-optional-services-need-inject.md)）。

## Consequences

- 「测试绿了」必须配上「哪一层绿的」，报告里按上面这张表说。
- 真实数据那一层是**回归锚点**：它对着宿主自己写出来的文件验，而不是对着本包造的形状验。
- 新增一条断言时要问它属于哪一层；四层都不属于的，多半是在测实现细节。
