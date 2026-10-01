# Agent Note: 设置导航那一行的图标由外壳决定

Status: implemented

## Problem

「会话管理」在设置左侧导航里和「通用」共用同一个齿轮图标。这**不是本插件写错了**，而是外壳的行为：

- 外壳那张表是硬编码的 id → 图标映射（`dsh-client-ui-settings-general` 的 `navIcon(id)`）：
  `account` → 用户、`models` → 数据、`agent-presets` → 预设、`plugins` → 个性化、
  `archived-sessions` → 归档，**其余一律** `IconSettingsOutlineMedium`（齿轮）；
- `settings.section` 的注册选项只有 `id` / `order` / `label`，没有 `icon`——
  `SettingsSectionOwnerProps` 只给一个 `close`，注册面也捡不到第二个字段。

## Decision

接受齿轮，判据留在 `src/client/index.ts` 的模块头注释里。等上游给注册选项加 `icon`（本页 id 已稳定，
加了只需多传一个字段）。

## Alternatives considered

**改 id 去蹭别人的图标。** 只有 `archived-sessions` 空着，而它的语义是「归档会话」——蹭它既可能与内置
页撞 id，也是拿图标撒谎。

**把图标画在页面内容里（比如页头）来补偿。** 那是往版面上加一个外壳没要求的东西，而导航那一行的
问题并没有被解决。

**自己注册一条导航（绕过 `settings.section`）。** 那就不是在设置里加一页了，而是另一套导航。

## Consequences

- 这是一条**已知边界**，不是待修项：判据写在源码注释里，避免下次再去找「图标怎么没设上」。
- 上游加了 `icon` 之后，这次改动只是多传一个字段，不需要动别的。
