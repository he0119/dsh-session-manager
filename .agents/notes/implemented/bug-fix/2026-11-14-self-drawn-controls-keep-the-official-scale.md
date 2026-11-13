# Agent Note: 自己画的控件也得同一套尺寸与焦点环

Status: implemented

## Problem

官方没有对应原语的那几枚控件由本页 CSS 自己画，尺寸与焦点环没有任何一处写着规格，于是各自漂：

- 同一个 `.dsm-search` 在两处是两种控件：会话页那枚是裸 `<input>`（实测 22px 高），候选面板那枚是
  官方 `Input`（我们的边框与内边距又叠在官方那层壳外面，实测 36px 高）。官方 `Input` 本身是 34px
  （24px 内部输入 + 上下各 8px 内边距 + 1px 边框）。
- 内容视图顶部那排筛选是胶囊（`border-radius: 999px`、23px 高、`border-l1`），左栏那排筛选是方块
  （6px 圆角、20px 高、`border-l2`）——同一类东西两种形状。
- 目录字段的值控件 30px 高、14px 字，与它并排的官方 `Button size="sm"`（28px）差 2px。
- `.dsm-chip`（内容视图筛选）、`.dsm-crumb`（面包屑）、`.dsm-pathValue`（值控件）都没有
  `:focus-visible`：键盘走到它们时露出来的是浏览器默认那圈蓝环（实测 `2px rgb(65, 118, 230) auto`），
  而其余五个手绘控件（`.dsm-sort` / `.dsm-rowOpen` / `.dsm-treePick` / `.dsm-dirEntry` / `.dsm-filter`）
  都是品牌色 2px。

## Decision

- 值控件 28px 高、13px 字（与它并排的官方 `Button size="sm"` 同高）；`.dsm-search` 只留宽度，框归
  官方 `Input`——会话页那枚也换成官方 `Input`，与候选面板那枚同一个控件。官方 `Input` 自己的 34px
  不覆盖：那一行里输入框比旁边两枚 `size="sm"` 高 6px，是官方那枚本来的高度。
- 筛选标签统一一套皮：20px 高、6px 圆角、`0 8px` 内边距、`border-l2`，内容视图那排从胶囊改回方块。
- 三枚缺焦点环的手绘控件补上：品牌色 2px、`outline-offset: 1px`，与另外五个一致。
- 项目树那一行整块可点却没有手型光标（别的行式控件都有），补上。
- 规格写进 `docs/design.md` §6（"自己画的控件"那一条），把这三条数字钉住；`test/styles.test.mjs`
  再钉一次。

## Alternatives considered

**把筛选标签全做成胶囊。** 那就要反过来改左栏那排与 `.dsm-filter`，而左栏底部空间紧：胶囊的
`2px 10px` 内边距会把一行三枚挤成两行。方块更省横向空间，也跟着官方 `Button` 的 6–8px 圆角。

**让搜索框继续用裸 `<input>`，只把高度调到 28px。** 这只是让两个地方"碰巧一样高"：官方的
`Input` 还带自己的焦点环、清除按钮与内部化处理，本页那套皮迟早又漂一次。同一个类名挂在两种元素上
本来就是这次问题的根源。

**不给手绘控件加焦点环，靠浏览器默认那圈。** 浏览器默认环在深色主题里对比度还行，但与本页其它五处
不是一个样子；键盘用户看到两种焦点样式会以为走丢了。

## Consequences

- 键盘走遍整页只有一种焦点样式（品牌色 2px）；搜索框、筛选、面包屑、值控件都看得见焦点在哪。
- 值控件与并排的官方 `size="sm"` 按钮对齐（28px）；输入框仍是官方那枚的 34px，本页不再另画一层。
- 两处筛选长得一样，不再一个胶囊一个方块。
- 由 `test/styles.test.mjs`（`.dsm-search` 不写边框、`.dsm-select` 28px/13px、`.dsm-chip` 与
  `.dsm-filter` 同一套皮、三条焦点环）与 `test/client.test.mjs`（会话页搜索框是官方 `Input` 组件）
  钉住。篡改验过：删掉 `height: 28px`、删掉 `.dsm-chip` 的形状声明、删掉任一条焦点环、把搜索框
  改回裸 `<input>`，各自变红。
- 真实 dev GUI 里量到的（1600 窗口）：搜索框是官方 `Input` 那层壳 34px（内部输入 24px），值控件
  28px，两处筛选都 20px 高、6px 圆角；焦点环实测 `2px rgb(15, 17, 21) solid` + offset 1px（内容视图
  那排筛选与值控件都量过，此前它们露的是 `rgb(65, 118, 230) auto`；面包屑走同一条规则、由测试核）。
