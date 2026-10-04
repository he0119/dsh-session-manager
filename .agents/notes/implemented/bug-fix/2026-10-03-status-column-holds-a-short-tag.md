# Agent Note: 预演表的状态列只放短标签，整句留给 title

Status: implemented

## Problem

同步预演的三段清单里，窄列装的都是整句，两处都出过可见的问题：

- 两张计划表（会拉取 / 会推送）沿用导入预演那张表的动作列：`.dsm-planTable .dsm-colAction`
  声明 60px，`table-layout: fixed` 下内容区只有 60 − 16（单元格左右各 8px padding）= 44px。导入预演
  放的是两个字的标签（「新建」「跳过」），同步预演放的是整句：「本机有、远端没有」实测 110px
  （en `here, not on the remote` 158px）、「本机更新，重推刷新」122px（en `local is ahead,
  re-uploaded` 176px）。`.dsm-tag` 是 `white-space: nowrap` 的小块，于是标签直接画到右边那一格上：
  实测顶出格子 114px、压住会话名 98px——两列的字叠在一起，谁也没读全。
- 「两边都有、这次不动」那一节把状态与会话名**拼进同一句**（`syncNote`：`{name}：{why}`），整行同色
  同号。读出来是「会话管理操作弹窗确认：两边各自写过（vibe-coding）」这种一行一行的文字：状态与
  具体是哪条会话完全分不出来——而三段里只有这一节是用户要逐条看的。

## Decision

三段清单一个口径：**状态进标签、会话单独一列、整句挂 title**。

- 可见文字换成短标签：拉取 / 推送两张表是动作（`syncTagPull` / `syncTagPush` / `syncTagRepush`），
  「这次不动」那张是状态（`syncTagDiverged` / `syncTagRemoteAhead` / `syncTagNoMapping` /
  `syncTagMissingTarget`）。
- 整句（`syncCode*`）挂在标签的 `title` 上。
- 「这次不动」那一段也画成表（`.dsm-keptTable`）：状态 / 会话 / 说明三列，说明列放"要用户动手"的
  那条路径（缺的映射、不存在的目录）或"是哪台机器持有的另一份"。

列宽按"列宽是设计、不该由内容的字数决定"的口径分开量：

- 同步那两张表 `.dsm-syncPlanTable .dsm-colAction { width: 88px }`（内容区 72px，装得下最宽的
  en `Re-push` 63px，余 9px）；
- 「这次不动」那张表 `.dsm-keptTable .dsm-colAction { width: 122px }`（内容区 106px，装得下最宽的
  en `Remote ahead` 94.7px，余 11px）；
- 导入预演那张表仍留 60px——「新建」「跳过」用不上更宽。

再加一条兜底：预演表里的标签 `box-sizing: border-box` + `max-width: 100%` + `overflow: hidden` +
`text-overflow: ellipsis`。列宽是设计、标签长短是文案，两者对不上时宁可让这一格自己截断，也不要把
邻居压掉一半（`border-box` 是必须的：默认 content-box 下 `max-width` 只管文字那一层，左右 6px
padding 与 2px 边框照样多顶出去 14px）。

## Alternatives considered

**把列宽加到装得下整句。** en 那句要 158px，加单元格 padding 是 174px，会话那一列（吃掉剩余宽度）
要少 114px —— 为一句已经挂在 `title` 里、而且每行都一样的话，把会话名的宽度让出去，不划算。

**让状态列的标签折行。** `.dsm-tag` 的 nowrap 是量出来的：折行会把行高从 38px 顶到两行，中文还会从
词中间断开（「本机有、远」/「端没有」）。标签是方块，不是一句话。

**可见文字只留一个字（「拉」「推」），整句放 title。** 两个字太含糊：推表里"新推"与"本机领先要重推"
是两件不同的事，而这两件事恰好是那一列唯一的用处。

**「这次不动」那一节保持整行说明。** 那正是分不出状态的写法（见 Problem 第二条）：三段里唯一需要
逐条看的清单，反而把"是什么状态"与"是哪条会话"揉成一团。改成表之后它与另外两张同形，会话名回到
`label-primary`、状态退回 `label-secondary` 的标签里。

**取消状态列，只留会话名，状态交给分组标题。** 分组标题只说得出"没动"，说不了"为什么没动"——而
「缺映射」与「两边各自写过」对用户是两件完全不同的事（一个要他补配置，一个不用管）。

## Consequences

- 真机（dev GUI）量到：状态列 122px、会话列 316px、说明列 154px（表宽 592px），行高 38px；最宽那颗
  标签 en `Remote ahead` 94.7px，余 11px，`scrollWidth > clientWidth` 为假（没截断）。
- 颜色沿用既有的中性标签（`.dsm-tagSkip`）：浅色字 `rgb(97, 102, 107)` / 边框 `rgba(0, 0, 0, 0.1)`，
  深色字 `rgb(207, 211, 214)` / 边框 `rgba(255, 255, 255, 0.12)`；会话名回到 `label-primary`
  （浅 `rgb(15, 17, 21)` / 深 `rgb(249, 250, 251)`），说明列 `label-secondary`。两套主题都是量出来的
  值，没有新 token。
- 「这次不动」那一节从整行说明变成三列表，行高 38px；长标题照旧走省略号（`title` 属性里是完整 id）。
- 验证：`test/client.test.mjs` 钉住三张表都带变体类、第三列表头是 `colNote`、可见文字是短标签、整句
  在 `title` 上、状态与会话名**不再挤在同一个文本节点**里；`test/styles.test.mjs` 钉住两张表各自的
  列宽下界（88 / ≥111px，都是量出来的）与兜底那三条声明。五处篡改各自红在对应断言上：退回整行说明
  （红在"三张表都要带变体类"）、表上不带 `dsm-keptTable`、状态列放整句（红在标签文案）、列宽退回
  88px、标签去掉 `title`。
- `test/client.test.mjs` 测的是**构建产物**：篡改源码之后要先 `pnpm build` 再跑，否则红不了。
