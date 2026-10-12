# Agent Note: 弹窗正文层的字号自己写（官方 Modal 不在 .dsm-root 的 14px 里面）

Status: implemented

## Problem

「会话内容」弹窗的筛选条那一行里出现了两个字号：右端的「显示 25 / 已读 25 条」实测墨迹 29–32
device px（16px 的字），紧挨着的五枚芯片（「全部 / 我 / 模型 / 工具 / 其它」）是 23px（12px 的字）。

根子不在这一行，而在正文层：官方 `Modal` 是 portal 到 `document.body` 的，弹窗落在那套 `.dsm-root`
（14px/20px）之外，于是弹窗里**凡是没有自己写字号的东西都继承文档根的 16px**。另一只弹窗
（`ConfirmDialog`）把内容包进 `.dsm-dialogBody`，那条声明就是为这件事写的；会话内容视图的正文层用的是
`dsm-transcriptContent`，没有这一档。

同一处还有第二件：facts 网格写的是 12px 的字，行高却继承 `.dsm-defs` 的 22px——真实 dev GUI 里量到
词条行距 24px、整块 94px 高（12px 那一档配的是 18px 行高）。

## Decision

- **正文层自己写 14px/20px**：`.dsm-transcriptContent` 补上这两条，与 `.dsm-dialogBody` 同值。
- **次要的几处显式写 12px/18px**，不靠继承：筛选条右端那串计数（`.dsm-transcriptFilters .dsm-meta`）、
  一条事件卡里的一切（`.dsm-item`，脚注那行就靠它）、facts 网格（`.dsm-transcriptFactsGrid` 的行高）。

真实 dev GUI 里量的（`getComputedStyle`，深浅两套主题各量一遍）：

| 探针 | 修前 | 修后 |
| --- | --- | --- |
| `.dsm-transcriptContent` | 16px/normal | 14px/20px |
| 筛选条右端的计数 | 16px/normal，盒 140x24 | 12px/18px，盒 105x18 |
| `.dsm-item` / 脚注 | 16px/normal | 12px/18px |
| `.dsm-transcriptFactsGrid` | 12px/22px，盒高 94 | 12px/18px，盒高 78 |

两套主题下这四行的值一致；同一只弹窗里原来就对的地方（标题 16px/24px、会话名 14px/20px、芯片 12px、
`pre` 12px/18px）没有动。

## Alternatives considered

**只给计数那一处补一条字号。** 症状会消失，但"这一层没有字号"这件事还在：脚注那行（`.dsm-meta`）与
`.dsm-error` 同样掉在 16px 上，下一处新增的字也照掉。字号是**这一层**的属性，写在层上才拦得住。

**把正文层默认成 12px。** 那一层的落点里还有整句的错误信息（`.dsm-error`），12px 太小；而且与另一只
弹窗的正文（14px/20px）不一致，同一个设置页里两只弹窗两种正文。

**把内容套进 `<div className="dsm-dialogBody">`。** 两个正文层的块间距不同（8px 与 10px），套上去要靠
选择器顺序压回来；在这一层把字号写全更直接。

## Consequences

- 弹窗里凡是没写字号的东西，落点从文档根的 16px 变成正文那一档 14px/20px；漏写一处的症状因此从"比
  正文大一档"降级成"与正文同档"。
- 会话内容视图的正文与次要两档自此独立于 `.dsm-root`（弹窗与页面同规格，但机制是各写一份），
  `test/styles.test.mjs` 钉住这四处的字号与行高。
