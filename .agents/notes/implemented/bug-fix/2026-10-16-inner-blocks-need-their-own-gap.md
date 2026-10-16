# Agent Note: 页内分页那一层自己要留块间距

Status: implemented

## Problem

「说明」那一页整页都是卡片，卡与卡之间**一点缝都没有**：真实 dev GUI 里量到相邻两张卡片的间距是
`0px`（前一张的 `bottom` 就是后一张的 `top`，两张卡片只剩各自的 1px 描边分得开）。

原因不在卡片上：卡片都长在分页本体那一层里，而 `.dsm-root` 那份 `gap: 16px` 只作用于它的**直接**子
元素——也就是分页那一层自己。再往里不传，所以那一层里的卡片、提示句、表格全贴在一起。这一层原来是
个没有任何布局规则的空 `div`（只有 `id` / `role="tabpanel"`），量到的计算值是 `display: block`、
`gap: normal`。

「说明」最显眼（整页都是卡片），但五个分页都有同一个毛病，只是别处卡片之间夹着横幅、清单，视觉上看
不出来。

## Decision

给分页本体那一层一个类 `.dsm-panel`：`display: flex; flex-direction: column; gap: 16px`。

`16px` 与 `.dsm-root` 同值，不是新起一档：内建设置页行与行之间的节奏就是每一行自己的
`padding: 16px 0`，而这一页最外层那份 gap 早就是这一档了。分页是 `.dsm-root` 的直接子元素，两层用同
一个数，跨分页切换时页面的节奏不会变。

## Alternatives considered

**给 `.dsm-card` 自己加 `margin-bottom`。** 卡片与**别的**东西（提示句、横幅、表格）之间的距离会跟卡
片与卡片之间的距离不一致，而且分页最后那张卡片还会多带一段空白。

**只写 `.dsm-card + .dsm-card`。** 只解决相邻的两张卡片；「提示句 + 卡片」「卡片 + 表格」这些节奏还是
散的，而那一层本来就是"整页的块"。

**五个分页组件各自包一层 flex 容器。** 同一条规格写五遍，样式归属也散——这本来就是外壳那一层的
事（`ManagerPanel.tsx` 里那个 `role="tabpanel"`）。

## Consequences

- 五个分页（会话 / 传输 / 同步 / 备份 / 说明）一起受益：分页内部一律 16px 的块间距。
- 规格由 `test/styles.test.mjs` 钉住三条（`display: flex` / `flex-direction: column` / `gap: 16px`）：
  这一层将来再被谁改回 `block`，卡片会立刻重新贴在一起，而那种改动不会报错、不会崩。
- 内建设置页那份 `padding: 16px 0` 是这一档的依据，将来官方改节奏时这里跟着改同一个数。
