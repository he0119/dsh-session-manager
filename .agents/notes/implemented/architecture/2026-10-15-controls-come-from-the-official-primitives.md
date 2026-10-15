# Agent Note: 控制件用官方原语，本页只挂布局挂钩

Status: implemented

## Problem

本页原先自己画了一套控件：`.dsm-button` / `.dsm-button.dsm-primary` / `.dsm-input` / `.dsm-tag` /
`.dsm-tab`，逐个写尺寸、圆角、描边、配色与焦点环。宿主那边同时还在用
`@deepseek-ai/dsh-client-ui-primitives` 的 `Button` / `Input` / `Checkbox` / `Tag` /
`SegmentedControl` 画同一批东西。两套都在，同一个元素上谁生效取决于样式表注入顺序，而本页那份是照着
官方的样子猜的，官方换代就会走形。

有现象可查的有三处：

- `.dsm-button.dsm-primary` 为了当填充按钮，自己拼了一条前景色回落链（`label-primary-foreground`
  不在 Theme 检查面的名单里）。官方 `.primary` 用的就是这个 token，本页那条链子是在重造官方已有的东西。
- 手写标签拿 `state-idle-primary` 当**文字色**：浅色主题白底对比度 **1.48:1**、深色 **2.1:1**，用户
  截图报过（见 [颜色只走检查面的 token](../bug-fix/2026-09-27-token-only-colors.md)）。
- 手写标签是带 `title` 的 `span`，文字与提示在同一层；换成官方 `Tag` 之后提示没地方放——官方 `Tag`
  只收 `tone` / `className` / `children`，**不转发 `title`**（见 `Tag.d.ts`）。

## Decision

控制件的观感一律归官方原语，本页不再画一遍。逐个替换：

| 原来手写 | 现在是官方 |
| --- | --- |
| `<button className="dsm-button">` | `Button`（`variant` 分 `ghost` / `outline` / `primary` / `toolbar`） |
| `.dsm-button.dsm-primary` | `Button variant="primary"` |
| `<input className="dsm-input">` | `Input` |
| `<input type="checkbox">` | `Checkbox` |
| `<span className="dsm-tag dsm-tagIdle">` 等 | `Tag`（`tone` 分 `neutral` / `quiet` / `success` / `danger`） |
| 手写 `role="tab"` 的一排页签 | `SegmentedControl` |

本页的 CSS 因此只剩**布局挂钩**：`.dsm-row` / `.dsm-group` / `.dsm-list` / `.dsm-card` /
`.dsm-controls` / `.dsm-tabsRow` / `.dsm-tag` / `.dsm-tabsAction` 这些"这一页怎么摆它"的规则。
几何与配色（边框、圆角、内边距、字号、tone 决定的底与字色、焦点环）一个字都不再写——写在这里会与官方
那份打架。删掉的规则：`.dsm-button` 系列、`.dsm-tab` 系列、`.dsm-tabs`、`.dsm-tagCreate` /
`.dsm-tagIdle` / `.dsm-tagSkip`、`.dsm-check`、`.dsm-dialog .dsm-button`。

**保留手写的三处**，因为官方没有对应物：

- `GroupCheckbox`——组头那枚是**三态**（全选 / 半选 / 未选），官方 `Checkbox` 只有受控的
  `checked`，没有 `indeterminate`，也不给 ref。
- `ProgressBar`——官方没有进度条原语。
- 内容视图里用 `<details>` 做的轮次折叠。

## 带提示的标签：布局挂钩挂在"包着它的那层 span"上

官方 `Tag` 不转发 `title`，所以有悬浮提示的标签写成
`<span className="dsm-tag" title={…}><Tag tone={…}>{…}</Tag></span>`：提示在外层 span，文字与 tone
在官方 `Tag`。没有提示的标签（段头那枚计数药丸、"未加入工作区"）把 `dsm-tag` 直接挂在官方 `Tag` 上。

这个类挂在**两层中的一层**，不是两层都挂，为的是让下面这几条 `>` 子选择器各自只命中一枚元素：

- `.dsm-groupPick > .dsm-tag`、`.dsm-rowLabel > .dsm-tag`、`.dsm-candidateHead > .dsm-tag` 是
  "不许被挤扁（`flex: none`）"与行高对齐，选中的是包着 Tag 的那层 span；
- `.dsm-planTable .dsm-tag`（限宽截断）、`.dsm-planHead .dsm-tag`（药丸不加粗）、
  `.dsm-planGroupHead .dsm-tag`（行高）是后代选择器，两种挂法都命中。

`.dsm-tag` 自己只写 `display: inline-flex; align-items: center; white-space: nowrap`：`inline-flex`
是给 `max-width` + `overflow` 那对截断规格用的（inline 元素上 `max-width` 不生效），`nowrap` 是给竖排
字兜底。它**不写** `border-radius` / `padding` / `font-size` / 配色。

## Alternatives considered

**继续手写，只是把值抄准。** 抄准的只是今天这一版：官方换一版就得再抄一遍，而两份样式表同时存在时谁都
可能赢——这不是值抄得准不准的问题。

**把官方那几份 CSS module 复制进 `styles.ts`。** 类名带打包哈希、内容是别人的实现细节，复制等于把本页
绑在官方内部结构上；而且官方升级后本页那份不会跟着变，漂移照样发生。

**用官方 `Tooltip` 原语代替 `title`。** 它是给"需要排版的气泡"用的，而这里只要一句原生提示；换过去
还得给每一枚标签配一个受控的开合状态，收益对不上代价。

**只把 `className` 传给 `Tag`、不包 span。** 这是最初的做法，结果是布局挂钩**静默失效**（`.dsm-tag`
选择器一条都不命中）而且提示全丢——`pnpm test` 与 `test/styles.test.mjs` 当时都还是绿的，因为样式表里
规则还在、只是 DOM 里没有带这个类的元素。现在每枚标签都必须落到"自己带类"或"被带类的 span 包着"两
种之一，由 `test/client.test.mjs` 钉住。

**弹窗那对按钮继续用 `ghost` + `size="sm"`。** 官方弹窗（`RiskConfirmation`）用的是 `outline` +
`primary`、**缺省尺寸**，量到就是 36px / 14px；`sm` 是 28px / 12px，摆在弹窗里比官方那对轻一档，同屏
就是两种规格。

## Consequences

- 浏览器半侧的基线模块名单不变：仍然只 `require` `react` / `react/jsx-runtime` /
  `@deepseek-ai/dsh-client-ui-primitives`，`dsh.client.external` 仍是空数组。
- 冒烟测试（`test/client.test.mjs`）的假 react 得认 `forwardRef` 与 `memo`：官方 `Button` 是
  `forwardRef(function Button(…))`，早先判 `typeof node.type === 'function'` 的走法认不出它，37 条
  client 用例集体变红。现在统一走 `isComponentType()` / `renderType()` / `typeNameOf()`。
- 钉"每枚标签都带上 `.dsm-tag`"的那条断言是本页最容易复发的一处：类名漏传不会报错、不会崩，只会让
  样式静默失效。
- `test/styles.test.mjs` 的 token 例外表从四例缩到两例：填充按钮的前景色那枚不再需要本页登记，官方
  Tag / Input / SegmentedControl 三份 CSS module 用的那三枚也不再出现在本页 CSS 里（这份检查扫的是
  `src/client/styles.ts`，注释也算——所以本页注释里也不要写出那枚 token 的名字，写出来就会被当成
  "本页在用它"）。
- 官方 `Tag` 渲染出来是 `<span class="<哈希> …" data-tone="…">`，所以认标签要认**组件那一层**的
  名字，不能认类名——`elementsOf()` 会把组件元素替换成渲染结果，名字叫 `Tag` 的东西不会出现在结果里。
- 真实 dev GUI 里两套主题各量一遍（`getComputedStyle`）：`.dsm-card` 圆角 **20px**、描边
  **1px rgba(0,0,0,0.16) / rgba(255,255,255,0.2)**；官方 `Tag` **11px / 17px / 999px / 1px 8px /
  500**；`Input` 外层 **32px**；「刷新」那枚官方 `Button` 是 **28px / 12px / 8px**（`sm`），官方弹窗那
  对是 **36px / 14px / 12px**（缺省 `md`）；`SegmentedControl` 每段 **28px / 13px / 8px**。标签的
  `dsm-tag` 在 flex 父容器里计算成 `display: flex`（`inline-flex` 被 flex 项 blockify），不是漏挂。
