# Agent Note: 页头照内建设置页的规格

Status: implemented

## Problem

官方设置页的页头**没有原语可用**：`dsh-client-ui-settings-plugins`（「插件」那一页）自己手写
`h2` + `p`，用打包哈希的类名（`pbvGtq_section` / `pbvGtq_heading` / `pbvGtq_intro`）写本地 CSS。
那份类名与那个功能插件包都不该复用，所以规格只能**去真实设置页里量**。

这里原先写成 14px 的 `span` 加一行 `row` 布局，一眼就能看出「和内置插件那页不是一套」。

## Decision

照内建设置页的规格写：`h2` 18px/600 的标题独占一行，下面隔 12px 跟一行 13px 的说明行，整体是
`display:flex; flex-direction:column; gap:12px`。说明行的颜色是 `--dsw-alias-label-tertiary`
（浅色主题 **#81858c**，量的就是那一页 `p` 说明行的计算色）。

## Alternatives considered

**复用那个功能插件包的类名。** 类名带打包哈希，换一代就变；而且那是另一个包私有的 CSS，复用等于把
自己的版面绑在别人的实现细节上。

**用 `ui-primitives` 里最接近的控件凑。** 页头没有对应原语（这正是它被手写的原因），凑出来的东西
在行高与间距上与相邻的官方页面对不齐。

**按「看起来差不多」定一个值。** 上面那两个数字（18px/600、13px + 12px 间距）是从真实页面量出来的；
凭感觉定就回到了改动前那个「一眼看出不是一套」的状态。

## Consequences

- 检查面只列到 `label-secondary`（#61666b，比 `label-tertiary` 深一档），所以 `label-tertiary` 进了
  `test/styles.test.mjs` 的例外表并带回落链。
- 规格有两处钉着：`test/styles.test.mjs` 查 `font-size` / `flex-direction` / 说明行的 token，
  `test/client.test.mjs` 查结构（标题必须是 `h2`、说明必须是 `p`、说明不在标题行里）。
