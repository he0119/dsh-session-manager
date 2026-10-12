# Agent Note: 行上的动作等悬停——它藏在行尾那一格里

Status: implemented

## Problem

会话页每行有一枚「内容」（打开这条会话的完整内容）。它原来摆在标题那一格（`.dsm-rowLabel`）里、
永远可见，样式是一枚有边框的小块：12px 字、1px 边框、4px 圆角、文字 `label-secondary`。同一格里还
坐着状态标签（「活动中」）：12px 字、1px 边框、6px 圆角、同一个文字色；两者盒高只差 2px（22 与
20px）。行上于是并排着两枚几乎一样的小块，一枚是状态、一枚能点，读的人分不出哪个是哪个——截图里
「内容」被当成第二枚标签。

## Decision

- **动作挪到行尾那一格**，与时刻叠在同一个格子里：`.dsm-slot` 的两个子元素都是 `grid-area: 1 / 1`
  （格子宽度取两者的最大值，正好是时刻的宽度）。
- **平时 `visibility: hidden`**，`：hover` 或 `:focus-within` 时顶掉时刻出场。用 `visibility` 而不是
  `display`：占位一直在，切换时行宽不动；同时它不进 tab 顺序，键盘落到这一行的勾选框时整行 `:focus-within`
  再让它出场。
- **它不再是"一枚小块"**：`border: none`、无底色、走 `brand-primary` 文字色、指针悬在它自己身上时加
  下划线。盒子是标签那套语法，动作不该长成标签。
- **触屏**（`@media (hover: none)`）没有悬停：`.dsm-slot` 改回并排，动作常显——否则那一格永远只有时刻，
  动作再也见不到。
- 只有给得出 `onInspect` 的行这么摆（会话页）。导出 / 迁移挑选 / 计划清单那些行照旧只有时刻一格。

真实 dev GUI 里量的（`getComputedStyle` + `getBoundingClientRect`，深浅两套主题都量过）：悬停前后
行宽 527px、标题格 238px、行尾格 110px 全部不变，动作的右缘与时刻的右缘同为 985px；静止时时刻可见、
动作 `visibility: hidden`，悬停时反过来。headless Chrome 报 `hover: none`，所以桌面那一档是把那段
`@media (hover: none)` 临时摘掉量的（触屏那一档就是在它默认的状态下量的）。

## Alternatives considered

**留在标题那一格里，只把边框去掉。** 位置还在标签旁边，仍是"标签那一格里两枚小块"，只是其中一枚没了
盒子；把动作搬走比把它改瘦更能解决"分不出哪个是哪个"。

**在行尾新加一列，平时 `display: none`。** 动作出现/消失时标题那一格被拉宽或压窄，被省略的标题会跟着
跳；换成 `visibility: hidden` 占位则不跳，但每行为一枚平时不出现的动作白留 24px（列表才 527px 宽）。

**用官方 `Button size="sm"`（28px 高）。** 行是 32px 高、上下各 6px 内边距，塞进去把整行顶到 40px；
行内的控件得跟标签同档（≤20px）。

**把标题本身做成入口。** 整行是 `<label>`，点标题现在就是勾选；改成打开内容会让"点行＝勾选"这条已经
在用的语义走形，而且误触的代价是弹窗。

## Consequences

- 会话页那些行的时刻在悬停时会消失，这与宿主自己的会话列表一致（它的 `.sessionRow` 32px 高，
  `.rowActions` 默认 `display: none`，悬停时与时间那一格互换）。
- 静止时行上只剩状态标签，动作的发现性靠"悬停到哪儿都看得见"；触屏由 `@media (hover: none)` 兜住
  （那时两样并排，标题格窄 32px）。
- 结构由 `test/client.test.mjs` 钉住（动作在行尾那一格里、不在 `.dsm-rowLabel` 里），颜色与可见性由
  `test/styles.test.mjs` 钉住（叠格子、默认隐藏、悬停可见、触屏常显）。
