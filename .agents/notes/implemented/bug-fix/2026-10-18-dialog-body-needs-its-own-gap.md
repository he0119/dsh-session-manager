# Agent Note: 弹窗正文的块间节奏要挂在真正的正文层

Status: implemented

## Problem

「看差异」弹窗里标题、活动提示、关系与计数、两条尾巴、尾注几乎贴在一起。真实 GUI 里量到这几块的
`bottom` 与下一块的 `top` 相等——块间距是 `0px`，不是看起来紧。

原因是给官方 `Modal` 传的 `contentClassName` 落在**外层**（标题栏 + 正文），而真正的正文是里面那层
官方 `_body_*`：它自己 `display: flex` 但 `gap: normal`。原先写在 `.dsm-diffContent` 上的
`gap: 20px` 只拉开了标题栏与正文；写在 `.dsm-diffSection` 上的 8px 只作用于一节内部，标题、提示、
关系块、尾巴、尾注这几个**直接子元素**之间仍然没有间距。分页那一层也踩过同一类坑（
[页内分页那一层自己要留块间距](2026-10-16-inner-blocks-need-their-own-gap.md)）：布局类只对自己那一层
生效，外层写了不等于里面写了。

## Decision

在 `Modal` 里再包一层自己的 `.dsm-diffBody`，把块间节奏挂在这一层：

- 块与块之间 `gap: 24px`；
- 一块里面 `gap: 12px`（原先是 8px，块间与块内的差别保留）；
- 事件卡在差异页里 `padding: 8px 10px`、卡与卡 `gap: 8px`（内容视图那张卡不跟着变）；
- 顶部标题与来源两行 `gap: 6px`，尾注上方 `padding-top: 12px`；
- 活动提示本身 `padding: 8px 12px`。

`dsm-diffContent` 继续只负责字号与行高那一档（官方 Modal 落在那套 `.dsm-root` 之外）。

## Alternatives considered

- **把 `gap` 写在 `contentClassName` 那一层**：只拉开标题栏与正文，正文里的块仍然贴在一起——就是这次
  的实际原因。
- **按官方那层带 hash 的 `_body_*` 写样式**：hash 随官方版本变，样式会静默失效。
- **给每个块单独加 `margin-bottom`**：块与块之间、块与提示/尾注之间各写一遍，最后一块还会多出一段空白；
  节奏不再由一处控制。
- **改官方 `Modal` 的 body 默认 gap**：那是官方控件库的契约，本包只该在自己的内容里布局。

## Consequences

- 差异弹窗的块间节奏现在真的生效：真实 GUI 量到正文直接子元素间隔 `24px`，块内 `12px`。
- `test/styles.test.mjs` 钉住 `.dsm-diffBody` 的 `display: flex` 与 `gap: 24px`；只写外层那层会再退回
  0px 而测试不红，所以这条断言盯的是真正的正文层。
- 以后给官方 `Modal` 加内容时，先看 `contentClassName` 落在哪一层；需要块间距就自己包一层，不按外层
  的类名推断。
