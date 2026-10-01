# Agent Note: 颜色只走检查面的 token

Status: implemented

## Problem

颜色写死只会在**一种主题下**错。真事是 `.dsm-primary` 写死了 `color: #fff`：

- 浅色主题下 `brand-primary` 是近黑，白字没问题；
- 深色主题下它是 `--dsw-static-neutral-bluish-50` 的 **#f9fafb**（近白——因为它是「表面的反色」，
  不是为了当填充色才存在），于是白底白字、对比度 **1.05:1**，按钮上的字整个没了。

类型、产物冒烟、真实 profile 的 HTTP 核对全都抓不到这种错，只有肉眼能发现。

## Decision

颜色只用宿主 `Theme` 检查面列出的 `--dsw-alias-*`，每条声明都带中性回落值，深浅主题自动跟随。
检查面没给的位置显式挂回落链，例如 `.dsm-primary` 的字色走
`var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1, #fff))`。

同一条纪律的另外三处，都是量出来的：

- **悬停底色**不能用 `bg-layer-3`——它在浅色主题里就是 #fff，铺在白卡片上等于没有反馈；改成把
  `label-primary` 兑 8% 透明的薄雾（宿主外壳自己也这么兑）。
- **state 色是「指示色」，不是文字色**：`state-*-primary` 的色值没按文字对比度选。量到的：
  `state-idle-primary` 是 #d4d4d4，白底 **1.48:1**；深色主题里它是 #545557，在 #232324 上
  **2.1:1**；`state-warn-primary` 是 #f59e0b，白底 **2.15:1**。所以文字一律走 `label-*`
  （浅 5.8:1 / 深 10.4:1），state 色只留在边框和一层淡填充上；非当文字色不可时就
  `color-mix(in srgb, …, 55%, label-primary)` 兑一下——亮色主题往深里走、深色主题往浅里走，
  同一条声明在两套主题里各自走向可读的一侧（实测 warn 5.57:1 / error 9.75:1 / ok 5.82:1）。
- **名单外的 token** 要登记进 `test/styles.test.mjs` 的例外表并写明理由（现有两例：
  `label-primary-foreground`、`label-tertiary`）。

## Alternatives considered

**给每个位置写死一个「两套主题都好看」的颜色。** 上面的比值就是这条路的结果：两套主题的同一位置由
不同的 token 服务，不存在一个同时对的常量。

**只写 `--dsw-alias-*` 的裸引用、不挂回落值。** 宿主那一代没有这个 token 时，`var()` 会整个失效，
声明的属性退化成继承值——比一个中性色更难查。

**在 state 色上加大字号来救对比度。** 字号不改对比度；而且它错的方向（一种主题下淡到看不见）与字号
无关。

## Consequences

- 五条纪律由 `test/styles.test.mjs` 机械核对（颜色必须走 token、token 必须在名单里、token 必须带回落
  值、标签不许折行、state 色不许裸当文字色），反事实都验过会失败。
- **对比度推不出来**：它取决于宿主**当时**给的那套 token 值。上面这些比值是在浏览器里量的——
  `agent-browser` 打开真实的设置页，逐个元素取 `getComputedStyle` 的前景色，背景色沿祖先链一路
  `color-mix` 合成到不透明为止，再按 WCAG 相对亮度算比值，明暗两套主题各跑一遍。
