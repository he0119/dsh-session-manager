# Agent Note: 悬浮提示统一走官方 Tooltip

Status: implemented

## Problem

页面上"停一下才知道"的提示有四十多处，全挂在原生 `title` 上：行标题与 id、类型标签、项目路径、
排序表头、筛选项、项目树、值控件、面包屑、目录条目、进度那一条、状态栏的库路径与版本号、同步计划
里的状态标签。原生那枚是浏览器画的——延迟两三秒才出、字体与配色不受主题控制、长提示被窗口边裁掉、
触屏上根本出不来。同一页里也因此混着两种提示观感（官方 `Tooltip` 的气泡与浏览器那个灰条）。

## Decision

- 新增 `src/client/components/Hint.tsx`：一层薄包装，文本交给官方 `Tooltip`，默认 `side="bottom"`、
  `portal` 打开（列表卡片、表格、弹窗正文都带 `overflow`，不挂到 body 外会被裁掉）。
- 所有提示改走 `Hint`：行、标签、项目树、排序表头、筛选项、值控件、面包屑、目录条目、进度那一条、
  状态栏、同步计划里的状态标签。
- `title` 只剩组件的标题属性在用（`Modal` / `WorkDialog` / `HelpSection` / `PlanSectionHead` 的标题），
  它们不是悬浮提示。
- `test/client.test.mjs` 加一条守卫：扫 `src/client/components/*.tsx`，`title={` 只准出现在上面那几
  个组件里，且看的是最近的组件开标签（`title` 常单独占一行）。篡改（随便给一个 `<p>` 加回 `title`）
  这条守卫会红。

## Alternatives considered

**继续用原生 `title`，只把文案统一。** 观感与可读性都还是浏览器那一套：延迟、截断、触屏无提示，
且长提示（标题 + id 两行、路径 + 主机）在窗口边缘会被切掉。

**只给"重要"的提示换 `Tooltip`，其余留 `title`。** 两种提示在同一页并存，用户看到的气泡一会儿是官方
那枚、一会儿是浏览器那枚，比全用原生更乱。

**把 `Tooltip` 直接挂在官方控件上（`Tag` / `Checkbox` / `StateDot`）。** 这几个组件没有 `forwardRef`，
`Tooltip` 要往锚点上挂 `ref`，接不住。所以照旧包一层 `span`（`dsm-tag` 那层），提示挂在这一层。

## Consequences

- 提示立刻出、跟主题走、键盘聚焦也出；长提示在气泡里换行，不再被窗口边裁掉。
- 气泡 `portal` 到 body 外：祖先的 `overflow` 与层叠上下文不再影响它。
- 测试替身把 `Tooltip` 原样返回（DOM 与线上一致），用例改成读 `Hint` 元素的 `text`（`hintOfClass` /
  `hintAround`），不再读 DOM 上的 `title`。
- 官方 `Tag` 那条硬约束跟着改口径：标签挂外层 span 仍然是为了 `flex: none`、限宽截断、行高对齐，
  提示改由 `Hint` 给（见 `AGENTS.md` 与 `docs/design.md` §6）。
- 真实 dev 页面上核过：把鼠标停在同一行的标题上，气泡在下方出现且不被列表卡片的 `overflow` 裁掉。
