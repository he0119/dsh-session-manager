# Agent Note: 说明页 FAQ 的答案不再被挤成零宽

Status: implemented

## Problem

说明页 FAQ 那一段（`.dsm-defsFaq`）沿用了词条表那套两列网格（`minmax(0, auto) minmax(0, 1fr)`）。
问题句是整句话，它的 max-content 把第一列吃满，第二列只拿到容器剩下的宽度——英文的问题句与答案一样
长，量到第一列 522px、第二列 **0px**：每个答案挤在零宽的框里排版，一行只放得下一个字符，整列垂到卡片
右缘外面（真实 dev GUI 里量到 `dd` 宽 0px、高 1122px）。

中文界面里两列还能分到宽度（280px / 242px），所以这个缺陷只在英文下看得出来——但同一份版面要同时服务
两种语言。

## Decision

FAQ 那一栏自己声明单列：`.dsm-defsFaq { grid-template-columns: minmax(0, 1fr); }`。FAQ 是"问题一行、
答案一行"的结构；两列那套是给"词条 + 解释"用的（`.dsm-defs`，说明页上半部分仍在用，那条不受影响）。

## Alternatives considered

**把第二列的下限从 0 提到 min-content。** 答案列确实不再是零宽（量到 229px），但两列对半的版式把答案
挤进那条窄列：同一条答案从 4 行变成 11 行（高 88px → 242px），问题句也被压到 292px。

**给第一列写死一个比例（40%）。** 问题句在 213px 里折成 8 行（量到 `dt` 高 176px），答案那列同样被挤
窄——两个方向都更差。

**去掉 `.dsm-defsFaq dt { white-space: normal }`，让问题句不折行。** 那是把"问题句顶穿词条列"换回来：
一句话不折行就会溢出卡片。

**把 FAQ 从 `<dl>` 换成一组 `<div>`。** 结构上更贴切，但动的是 JSX 与现有的 `dl` / `dt` / `dd` 断言，
收益只有一行 CSS 那么多。

## Consequences

- 钉在 `test/styles.test.mjs`：`.dsm-defsFaq` 要声明单列。
- 英文：答案从"零宽的一列单字、高 1122px"变成 534px 宽、4 行（高 88px）。
- 中文：一条 FAQ 从 132px（问题与答案各在 280px / 242px 的列里折成 6 行）变成 94px（问题 1 行 +
  答案 3 行 + 6px 间距）——两种语言都变短了。
- 深浅两套主题各量一遍：这条只动列宽，颜色与 token 一行没碰。
