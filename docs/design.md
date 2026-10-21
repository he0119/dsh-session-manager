# 界面设计规范

本文是浏览器半侧（`src/client/**`）界面与样式的**唯一规格入口**。上游是宿主设置页与官方控件库：
本包不自己发明观感，只决定"这一页怎么摆"。每条规格背后的取舍与被否决的备选方案在
[.agents/notes/](../.agents/notes/AGENTS.md) 里，这里只写当前口径与执行位置。

三条原则，先于下面所有具体数字：

1. **跟官方**：控件、几何、色值、术语都向官方设置页与官方控件库看齐；本包只决定"这一页怎么摆"。
2. **少新档**：字号、间距、圆角、颜色不发明第五种"看起来差不多"的值；要加一档，同时改本文件与钉住
   它的测试。
3. **先量后改**：布局与颜色在真实 dev GUI 里量 `getComputedStyle` / `getBoundingClientRect`，不靠
   截图猜；量到的数字写进测试或本文件，不留在一次性的聊天里。

## 1. 平台边界

- 客户端产物是经典脚本，只 `require` 平台基线模块：`react`、`react/jsx-runtime`、
  `@deepseek-ai/dsh-client-ui-primitives`。其余一律内联；要引非基线模块必须在 `dsh.client.external`
  里点名。
- 控件一律用官方控件库（`Button` / `Input` / `Checkbox` / `Tag` / `SegmentedControl`）。本包的 CSS
  只写**布局挂钩**，不画控件外观。
- 页面注册进 `settings.section`；两侧叫 Host 半侧 / 浏览器半侧，术语跟官方文档走：
  [Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client)、
  [客户端 Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)。
- 依据：[控制件用官方原语](../.agents/notes/implemented/architecture/2026-10-15-controls-come-from-the-official-primitives.md)。

## 2. 页面骨架

### 2.1 页头与分页

- 页头没有官方原语，照内建设置页手写：`h2` **16px / 行高 24px / 500** 独占一行，隔 **12px** 一行
  14px 说明（`label-tertiary`）；整体列布局。页头里**不放动作**。
- 页面级的「刷新」挂在页签那一行的右端（`.dsm-tabsRow`），下划线随整行铺满。
- 页内分页用官方 `SegmentedControl`，分页顺序是「会话 → 传输 → 同步 → 备份 → 说明」；迁移是
  「会话」页上的动作，不单独占一页。每页本体是 `.dsm-panel`，自己带 `gap: 16px`——`.dsm-root`
  那份 gap 只作用于直接子元素，不再往里传。
- 依据：[页头那篇](../.agents/notes/implemented/architecture/2026-09-28-page-header-matches-the-builtin-settings.md)、
  [分页间距那篇](../.agents/notes/implemented/bug-fix/2026-10-16-inner-blocks-need-their-own-gap.md)。

### 2.2 卡片

- 卡片外壳照官方卡片：圆角 **20px**、1px `settings-card-stroke` 描边、`bg-layer-1` 底色、
  内边距 **12px 14px**、纵向 `gap: 10px`。
- 卡片头部只放不动数据的工具（刷新、全选 / 清空、收起 / 展开）；**卡片级的主动作一律放底部动作行**
  （`.dsm-controls`），破坏性动作用 `dsm-spacer` 顶到同一行右端。清单行上的动作留在行上。
- 带勾选的清单全站只有一对选行工具：「全选」/「清空」，作用面是眼下列出来的那些；位置在清单之上那一
  行的右端（清单就是整张卡时在卡头）。
- 依据：[卡片动作行](../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md)、
  [一对选行工具](../.agents/notes/implemented/bug-fix/2026-10-08-one-pair-of-pick-tools.md)。

### 2.3 列表

- 列表按项目目录分组；组头只摆名字 + 一枚主机名标签，项目身份与本机路径在悬浮提示里。组头是一条
  粘住的横幅，会话行缩进并带左缘导引线；层次同时靠底色、缩进 / 导引线、字号、图标四层区分。
- 行上的「内容」等动作藏在行尾，悬停或键盘落在这一行时出场；静止时行上只有标签与时刻。
- 空态、加载态不编造结论：清单没到之前说「读取中…」，不把"0 个会话"画上去。
- 依据：[项目身份与组头](../.agents/notes/implemented/feature/2026-10-04-workspace-shows-project-identity.md)、
  [行上动作](../.agents/notes/implemented/architecture/2026-10-12-row-action-waits-for-hover.md)、
  [两阶段加载](../.agents/notes/implemented/architecture/2026-10-07-page-loads-in-two-phases.md)。

### 2.4 弹窗

- 弹窗外壳用官方 `Modal`；宽度 `min(640px, 100%)`，正文自己写 **14px / 20px**（官方 Modal portal 到
  `document.body`，不写会继承文档根的 16px）。
- 会写盘的动作一个按钮开一个确认弹窗：计划与"做不做"同框；只读的预演（看差异、导出、测试连接）
  不开确认，直接说"这一步只读"。
- 弹窗正文的块间距挂在**自己的正文容器**上，不挂官方外层（见 §4.2）。普通确认弹窗用
  `.dsm-dialogBody`（`gap: 8px`）；差异弹窗用 `.dsm-diffBody`（`gap: 24px`）。
- 依据：[一次确认弹窗](../.agents/notes/implemented/architecture/2026-10-03-one-click-confirm-dialog.md)、
  [弹窗字号](../.agents/notes/implemented/bug-fix/2026-10-12-dialog-body-declares-its-own-type.md)、
  [弹窗正文块间距](../.agents/notes/implemented/bug-fix/2026-10-18-dialog-body-needs-its-own-gap.md)。

## 3. 排版

| 层级 | 字号 / 行高 | 用在哪 | 实现 |
| --- | --- | --- | --- |
| 页面标题 | 16px / 24px / 500 | 页头 `h2` | `.dsm-title` |
| 页面说明 | 14px / 22px | 页头下面那句 | `.dsm-intro` |
| 正文 | 14px / 20px | 页面与弹窗正文 | `.dsm-root`、`.dsm-dialogBody`、`.dsm-diffContent` |
| 次要文字 | 12px / 18px | 说明句、标签、脚注、事件卡 | `.dsm-hint`、`.dsm-item` |
| 路径 | 12px / 等宽 | cwd、id、机器名 | `.dsm-path` |
| 输入框 | 13px / 18px | 搜索框（内建输入框那一档） | `.dsm-search` |

- 行高不跟着字号按比例放大：正文 14/20、次要 12/18 是内建设置页量出来的两档。
- 比正文淡一档的文字**同时**换成 12/18，不靠只换颜色表达"这是补充"。
- 代码块 / 事件正文 12/18 等宽；只在内容视图与差异视图里出现，不扩散到页面正文。

## 4. 间距与布局归属

### 4.1 节奏

| 层 | 值 | 用在哪 |
| --- | --- | --- |
| 页面块间 | 16px | `.dsm-root`、`.dsm-panel` |
| 弹窗块间 | 24px | 差异弹窗 `.dsm-diffBody` |
| 普通弹窗块间 | 8px | `.dsm-dialogBody` |
| 块内 | 8px | 一般块内部 |
| 差异分区内部 | 12px | `.dsm-diffSection` |
| 两条尾巴之间 | 20px | `.dsm-diffTails` |
| 标签与值、紧邻两行 | 2–4px | `.dsm-diffStat`、字段标题与值 |
| 控件行 | 6–8px | `.dsm-controls`、工具行 |
| 卡片内边距 | 12px 14px | `.dsm-card` |

**不要发明第五种"看起来差不多"的间距**。新块先问它属于哪一层：页面块、弹窗块、块内、紧邻。
确实需要新档位时，同时改这里与执行它的 CSS / 测试。

### 4.2 归属规则

**`gap` 只对直接拥有这些子元素的那一层生效，不会往里继承。** 这是本页最容易静默坏掉的一条：

- 页面：`.dsm-root` 的 16px 只给分页层，分页里面的卡片要 `.dsm-panel` 自己再写一次。
- 弹窗：官方 `Modal` 的 `contentClassName` 落在外层（标题栏 + 正文），真正的正文是里面那层官方
  body（`display: flex` 但 `gap: normal`）。要块间距就在自己的内容外再包一层（`.dsm-diffBody` /
  `.dsm-dialogBody`），**不要**把 gap 写在外层后假设它已经生效。
- 官方那层带 hash 的 `_body_*` 类不写样式：hash 随版本变，样式会静默失效。
- 节奏用容器的 flex `gap` 表达，不给每个块补 `margin-bottom`；最后一块会因此多出一段空白，块与
  提示 / 表格之间的节奏也会散。
- 官方 `Tag` 的悬浮提示挂在外层 `span.dsm-tag` 上，`dsm-tag` 挂钩不能漏：漏了会让 `flex: none`、
  限宽截断、行高对齐一起静默失效。

### 4.3 验证

布局改动要在真实 dev GUI 里量，不靠看截图猜：

- `getComputedStyle(el).gap` 看容器自己有没有吃到；
- 直接读子元素的 `getBoundingClientRect().top / bottom`，确认相邻块的间隔就是上表那个值；
- 深浅两套主题各量一遍；只改布局、不改颜色时，至少确认色值来自 token，没有新字面量。

## 5. 颜色与主题

- 颜色只用宿主 Theme 检查面列出的 `--dsw-alias-*`，每条声明都带中性回落值：
  `var(--dsw-alias-token, fallback)`。检查面没有的两枚例外（`label-tertiary`、
  `settings-card-stroke`）登记在 `test/styles.test.mjs`，不在别处再列一份。
- `state-*` 色是指示色，不裸当文字色；状态文字要先和 `label-primary` 兑一下（见 `.dsm-warn` /
  `.dsm-error` / `.dsm-ok`）。
- 主题切换只换 token，不换布局；深色下背景三级可能同色，层次不能只靠底色差。
- 依据：[颜色只走 token](../.agents/notes/implemented/bug-fix/2026-09-27-token-only-colors.md)。

## 6. 控件与动作

- 控件只用官方原语；**不许显式写 `variant="ghost"`**——官方缺省的 ghost 就是"看着像一段文字"，
  本页不接受。
- 动作按角色分：
  - `primary`：这一页 / 这个弹窗的主动作，一屏最多一枚；
  - `outline`：会动数据的卡片动作、工具、确认弹窗里的次要动作；行内动作用 `size="sm"`；
  - 破坏性动作放动作行右端，由 `dsm-spacer` 顶开；行上的动作不挪到卡片底部。
- 每枚官方 `Tag` 都挂 `dsm-tag` 布局挂钩；有悬浮提示时外层 `<span className="dsm-tag" title={…}>`。
- 依据：[控制件原语](../.agents/notes/implemented/architecture/2026-10-15-controls-come-from-the-official-primitives.md)、
  [动作带边框](../.agents/notes/implemented/bug-fix/2026-10-16-actions-carry-their-frame.md)。

## 7. 文案

- 字典在 `src/client/logic/locales.ts`，`zh` 是键集真源，`en` 由 `LocaleDictOf` 逐键核；少键 / 多键 /
  写错键都是编译错误。组件从框架 props 拿 `t`，不自己 inject，不留中文兜底。
- 键名点分；通用词（取消 / 关闭 / 保存）复用宿主 `common` 命名空间。
- 术语跟官方：注册表、项目目录、Slot、Host 半侧 / 浏览器半侧、子智能体、拉取 / 推送、轮次 / 第 N 轮。
  旧词（账本、分桶、槽位、子代理、拉下来 / 推上去）不再写。
- 窄列放短标签，整句解释挂 `title`；不把状态与会话名挤成一行同色同号的文字。
- 只读操作说"这一步只读"；不可用 / 被拦下的动作说清原因和出路，不只给一枚点不动的灰按钮。

## 8. 反馈与边界

- 长动作（迁移、同步、导入、删除、回滚）走逐条进度，弹窗正文换成进度块，不转圈等一次性结果。
- 关掉窗口不停手：同步落地那一趟在宿主里会跑到结束，所以忙碌时弹窗里那枚「取消」换成「转到后台」
  （关掉窗口、活儿照跑），进度搬到页面顶上那条横幅——它挂在**页面**这一级，切页签、关掉设置再回来都
  还在，跑完留一行结论直到用户关掉它。其余几个动作关掉窗口只是把进度藏起来、结果照样丢，所以它们
  忙碌时那一枚仍然禁用（见 [syncJob.ts](../src/client/logic/syncJob.ts)）。
- 需要重启这类坏消息在确认前先说，落地后只在真的需要重启时留一条 warn 横幅；成功不要再叠一遍。
- 空态、加载态、失败态各说各的；失败带原始原因，不吞成一句"操作失败"。
- 写盘前先备份；计划永远只读，确认才落地。

## 9. 验收

提交前必须：

```sh
pnpm typecheck && pnpm build && pnpm test && pnpm check:package
```

- `test/styles.test.mjs` 是样式规格的可执行部分：token、字号、页头、卡片几何、间距节奏、弹窗正文层、
  标签不折行。改一条规格就同一次改这里。
- `test/client.test.mjs` 是结构与行为的可执行部分：控件来源、动作位置、选行工具、页签、弹窗流程。
- 界面改动在真实 dev GUI 里量 `getComputedStyle` / `getBoundingClientRect`，深浅两套主题各看一遍；
  不推算色值，不凭截图猜间距。
- 验收用的临时夹具（假会话等）用完立刻删干净，并在报告里写明造过什么、清掉了没有。
- 新断言要篡改验证：把被测行为改回去，测试必须变红。

界面改动自查：

- [ ] 控件全部来自官方原语，没有 `variant="ghost"`，主操作只有一枚。
- [ ] 没有检查面之外的颜色 token；新增例外已登记进 `test/styles.test.mjs`。
- [ ] 块间距挂在直接拥有子元素的那一层，已在 DOM 里量过相邻块的 `top` / `bottom`。
- [ ] 字号落在 §3 的几档里；次要文字同时是 12/18，不只是换颜色。
- [ ] 窄列放短标签，整句在 `title`；不可用动作说明了原因与出路。
- [ ] 深浅主题各看一遍；需要重启之类的坏消息在确认前说出来。
- [ ] 改动了哪条规格，就同一次改了 `test/styles.test.mjs` / `test/client.test.mjs` 里对应的断言。

## 10. 规格索引

| 主题 | 决策笔记 |
| --- | --- |
| 页头照内建设置页 | [2026-09-28](../.agents/notes/implemented/architecture/2026-09-28-page-header-matches-the-builtin-settings.md) |
| 正文与次要文字两档 | [2026-10-07](../.agents/notes/implemented/architecture/2026-10-07-body-type-matches-the-builtin-settings.md) |
| 控制件用官方原语 | [2026-10-15](../.agents/notes/implemented/architecture/2026-10-15-controls-come-from-the-official-primitives.md) |
| 卡片动作行 | [2026-10-07](../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md) |
| 一对选行工具 | [2026-10-08](../.agents/notes/implemented/bug-fix/2026-10-08-one-pair-of-pick-tools.md) |
| 行上动作等悬停 | [2026-10-12](../.agents/notes/implemented/architecture/2026-10-12-row-action-waits-for-hover.md) |
| 分页块间距 | [2026-10-16](../.agents/notes/implemented/bug-fix/2026-10-16-inner-blocks-need-their-own-gap.md) |
| 弹窗正文字号 | [2026-10-12](../.agents/notes/implemented/bug-fix/2026-10-12-dialog-body-declares-its-own-type.md) |
| 弹窗正文块间距 | [2026-10-18](../.agents/notes/implemented/bug-fix/2026-10-18-dialog-body-needs-its-own-gap.md) |
| 颜色只走 token | [2026-09-27](../.agents/notes/implemented/bug-fix/2026-09-27-token-only-colors.md) |
| 动作带边框 | [2026-10-16](../.agents/notes/implemented/bug-fix/2026-10-16-actions-carry-their-frame.md) |
