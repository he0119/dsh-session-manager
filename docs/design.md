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

### 2.1 页头、入口与宽弹窗

- 两个落点、两种内容：侧栏那枚图标点开的是**做事**的主栏页（`ManagerPanel`：页面上就是会话列表，
  导出 / 导入、同步、备份与回滚各是一处入口 + 一个宽弹窗；说明从页头的「?」开弹窗）；配置在**插件页**
  里（`plugins.bundle.config`，按包名作键，见 `PluginConfigCard`），分成「同步」这样的小节。为什么分开：
  配置一年改两次，操作用天天用；挤在一页里时，每次同步都得先翻过十来个字段的配置卡，改配置又得先滚到底。
  设置页里不放本包的入口——那边的通用 / 模型 / 插件 / 账户 / Agent 预设才是官方那几页的位置。
- **没有页签**。四件事不再摆成同级：切一次页签就丢一次勾选，而勾选是这一页唯一的输入。三处入口是：
  - 列表卡片底部那条动作行上的「导出 / 导入…」（`manage.transfer.action`，开 1080 宽的传输弹窗）；
  - 页头标题右边那枚**同步状态**（官方 `Button` + `StateDot`）：只说本地知道的事实——这一趟正跑着、
    刚才跑完、磁盘上记着的上一次（`多久以前` / `失败（多久以前）`）、退到配置的「自动推送」或
    「未配置」。点开是远端、计划、差异与确认。它**不联网**，所以不报"待拉几条"；
  - 底部状态栏里的「备份与回滚（N）」（三种写操作共同的后悔面，不属于其中任何一件动作；份数来自
    一次 `/backups` 的目录列举，0 份时只写名字）。
- **勾选是整页一份**：`ManagerPanel` 持有 `useSessionPicking()`，列表与导出清单共用它。勾了 6 条再开
  「导出 / 导入…」，导出那一栏里就是这 6 条；关掉弹窗回来，列表里还是这 6 条。
- **删除 / 迁移之后给「撤销」**：那次动作留下的备份目录挂在成功提示上，点「撤销」开「备份与回滚」
  并直接摆出那份备份的回滚确认（`openBackup(dir)`）。归档这类不留备份的动作不摆它。
- 主栏页标题右边依次是这枚同步状态、「?」（说明弹窗）、「刷新」（重读 `/meta` + `/state`）与「插件设置」
  （跳插件页，宿主 `pluginNavigation.openBundle(包名)`）。四枚都是页面级入口，与标题同排。
- 插件页那一格是**分组设置**的形状，照官方 `dsh-context` 那张配置卡（
  `src/client/components/settingsCard.tsx`）：一组一个 16px/600 的组标题，组里一行一件事——标签
  14px 与它的说明 12px 在左、控件靠右（输入框固定 320px，不随窗口拉成长条）；组与组之间一条
  0.5px 的发丝线。控件外观仍归官方控件库，本页只写摆位。
- 密码那一行也走同一个形状：`type=password` 的官方 `Input` + 标签旁边一枚官方 `Tag`（已配置 /
  未设置）。**不要用 `SettingsSecretField`**——它是个整块的字段（标签 / 徽标 / 输入框 / 说明竖着四层），
  混进这张横排的卡里就是唯一一行长得不一样的东西。只写语义不变：值不进响应，留空即保留已存的那一个。
- 主栏那一版外面多一层 `.dsm-globalPage`：宿主的 `.mainPanel` 是定高 flex 列、`overflow: hidden`，
  滚动视口得由占位方自己给。**页面本身不滚**：滚的是列表卡片里的那张表（`.dsm-listFill`），
  页面上的工作台吃满主栏。
- 「会话」页是**工作台**：左栏（208px，项目与筛选）+ 列表卡片。左栏自己滚，筛选段钉在栏底；窄到
  工作台可用宽 ≤960px 时左栏收成 280px 的浮层，卡头出现「项目与筛选」。两种形态是同一份 DOM，
  靠容器查询换位置（阈值读工作台自己的宽度，不是窗口宽度）。
- 右栏是**详情**（340px）：**开头两轮**（每轮一条人的消息 + 一条回答，各最多四行；选中一条才读
  `/transcript` 的第一页，读到的按会话缓存在组件里）、标题、分类标签、项目 / 目录 / 创建时间 / 大小 /
  文件数 / 会话 id，以及打开完整内容、归档 / 取消归档、勾选 / 取消勾选三枚动作。开头不是完整时间线：
  思考块、工具入参与结果不进来，全部在「打开完整内容」里。宽屏一直摆着（没选时是一句提示）；工作台
  可用宽 ≤1180px 时收成从右边滑出的浮层，没选时整栏不出现，点「关闭」收起。宽窄同样是同一份 DOM。
- 页头是**一条工具条**：`h2` **16px / 行高 24px / 500**、同步状态、右端的「?」「刷新」「插件设置」
  同排；窄到放不下时整排换行（`flex-wrap: wrap`，行距 8px）。状态那一枚不参与收缩、文字不折行
  （`.dsm-headChip`）。
- 库路径、会话数、工作区数、备份与回滚入口、版本号在底部**状态栏**（`.dsm-statusBar`，12px/18px，
  上方一条发丝线；那枚入口按钮让整行从 29px 涨到 **39px**，是量出来的）：它们答的是"这一页在看哪个库、有哪些备份、是哪个构建"，不随弹窗开关。清单没到时
  状态栏说「读取中…」，不画 0。
- 另外三件事各是一个**宽弹窗**（`.dsm-workDialog`，1080px；外壳是 `WorkDialog`，正文层 `.dsm-workBody`
  自带 `gap: 16px`）：传输、同步、备份与回滚。宽度沿用它们原来在页面上的可读宽度，一个字不用重排；
  关掉等于卸载，弹窗里那份计划随之清掉。
- 传输弹窗在这 1080 内**再分两栏**：导出 1.3fr / 导入 minmax(320px, 0.9fr)，1600 下量到 626 + 433；
  窄到 900 以下叠回一列（阈值读这一块自己的宽度）。
- 「说明」是弹窗：页头「?」开官方 `Modal`（760px），四节（分类 / 哪里做什么 / 数据从哪来 / 常见
  疑问）在弹窗正文里，节与节 16px；弹窗本身就是容器，节不再各套一圈卡片壳。
- 依据：[全宽工作台那篇](../.agents/notes/implemented/architecture/2026-11-12-session-page-is-a-full-width-workbench.md)、
  [去掉页签那篇](../.agents/notes/implemented/architecture/2026-11-12-no-page-tabs.md)、
  [分页间距那篇](../.agents/notes/implemented/bug-fix/2026-10-16-inner-blocks-need-their-own-gap.md)。

### 2.2 卡片

- 卡片外壳照官方卡片：圆角 **20px**、1px `settings-card-stroke` 描边、`bg-layer-1` 底色、
  内边距 **12px 14px**、纵向 `gap: 10px`。列表那张是 `.dsm-cardFill`：吃满页面剩下的高度，
  卡头、动作行不动，中间的表自己滚。右栏 `.dsm-inspector` 也是同一张卡：头不动，正文自己滚，
  三枚动作钉在卡底。
- 卡片头部只放不动数据的工具（搜索、全选 / 清空、收起 / 展开）；**卡片级的主动作一律放底部动作行**
  （`.dsm-controls`），破坏性动作用 `dsm-spacer` 顶到同一行右端。清单行上的动作留在行上。
- 带勾选的清单全站只有一对选行工具：「全选」/「清空」，作用面是眼下列出来的那些；位置在清单之上那一
  行的右端（清单就是整张卡时在卡头）。
- 依据：[卡片动作行](../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md)、
  [一对选行工具](../.agents/notes/implemented/bug-fix/2026-10-08-one-pair-of-pick-tools.md)。

### 2.3 列表

- **「会话」页是平铺表格**：每行六个格子（勾选框 / 图形标记 / 标题与标签 / 项目 / 大小 / 时间）。
  「项目」那一列在册项目写工作区标题、没登记的写路径——平铺之后它是"这条属于哪个目录"的唯一出处。
- 表头三列可点着排（标题 / 大小 / 时间），默认时间从新到旧；**表头吸顶**（`position: sticky`），
  滚的是列表自己。排序只改看，不写盘；比较与筛选在 `logic/manageRows.ts`，`test/manageRows.test.ts` 直接测。
- **左栏的项目树**：`全部项目` + 每个项目（整库条数）。点项目名 = 只看它；鼠标停在项目行上出现
  勾选框 = 整组勾选，作用面与卡头「全选」一致（筛出来的那些），勾了一部分画横杠；这个项目在当前
  视图里没有可勾的行时，勾选框不画。筛选芯片在左栏底部，搜索框在卡头；芯片条数按整库算，不随项目跳。
  清单没到时左栏说「读取中…」，不画"0 个项目"。
- 会话页没有组头与折叠。**「传输」页仍按目录分组**，那套组头 / 折叠 / 整组勾选还在（`SessionGroupHead`）。
- 行尾有两枚动作：「详情」把这一条交给右栏（不打开弹窗，也不改变勾选），「内容」直接打开完整
  时间线。两枚都藏在行尾，悬停或键盘落在这一行时出场；静止时行上只有标签与时刻。右栏正开着的那一行
  左缘有一条品牌色细线；窄屏（触屏）没有悬停，动作顶替时刻那一格常显。
- 空态、加载态不编造结论：清单没到之前说「读取中…」，不把"0 个会话"画上去。空态画在列表框**里面**，
  表头不能因为"这一筛没命中"而消失。
- 依据：[全宽工作台那篇](../.agents/notes/implemented/architecture/2026-11-12-session-page-is-a-full-width-workbench.md)、
  [项目身份与组头](../.agents/notes/implemented/feature/2026-10-04-workspace-shows-project-identity.md)、
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
| 正文 | 14px / 20px | 页面与弹窗正文 | `.dsm-root`、`.dsm-dialogBody`、`.dsm-diffContent` |
| 次要文字 | 12px / 18px | 说明句、标签、脚注、事件卡、底部状态栏 | `.dsm-hint`、`.dsm-item`、`.dsm-statusBar` |
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

- 页面：`.dsm-root` 的 16px 只给它的直接子元素（横幅、工作台），工作台里面的卡片由工作台自己给节奏。
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
- 术语照 [glossary.md](glossary.md) 那张表写：哪个词是官方的、别写什么、出处在哪都在那里，这份规格
  不另记一份。
- 窄列放短标签，整句解释挂 `title`；不把状态与会话名挤成一行同色同号的文字。
- 只读操作说"这一步只读"；不可用 / 被拦下的动作说清原因和出路，不只给一枚点不动的灰按钮。

## 8. 反馈与边界

- 长动作（迁移、同步、导入、删除、回滚）走逐条进度，弹窗正文换成进度块，不转圈等一次性结果。
- 进度块（弹窗里与页面横幅里是同一个，见 [ProgressBlock.tsx](../src/client/components/ProgressBlock.tsx)）
  自上而下四行：那句"做到哪儿了" → 进度条 → 正在处理的那一条（12/18 三级色、单行省略、完整名字挂
  `title`）→ 这句动作自己的说明。块内节奏 6px，用容器的 `gap` 表达，行上的 `<p>` 外边距归零——浏览器
  默认的 1em 上下会让这四行一会儿贴住、一会儿隔开一截。
- 进度横幅（后台同步、立即推送）的头部是一枚官方 `StateDot` 的 ongoing 转圈 + 这是哪一趟（13/18、字重
  500、主色）；横幅按卡片那一档留白（12px 14px），描边取 `settings-card-stroke`，不用 `currentColor`
  （那会跟着文字色变，深色主题里是一圈发灰的粗框）。
- 关掉窗口不停手：同步落地那一趟在宿主里会跑到结束，所以忙碌时弹窗里那枚「取消」换成「转到后台」
  （关掉窗口、活儿照跑），进度搬到页面顶上那条横幅——它挂在**页面**这一级，开别的弹窗、关掉窗口再回来都
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
- `test/client.test.mjs` 是结构与行为的可执行部分：控件来源、动作位置、选行工具、入口、弹窗流程。
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
| 全宽工作台与平铺表 | [2026-11-12](../.agents/notes/implemented/architecture/2026-11-12-session-page-is-a-full-width-workbench.md) |
| 页头照内建设置页（已被取代） | [2026-09-28](../.agents/notes/implemented/architecture/2026-09-28-page-header-matches-the-builtin-settings.md) |
| 正文与次要文字两档 | [2026-10-07](../.agents/notes/implemented/architecture/2026-10-07-body-type-matches-the-builtin-settings.md) |
| 控制件用官方原语 | [2026-10-15](../.agents/notes/implemented/architecture/2026-10-15-controls-come-from-the-official-primitives.md) |
| 卡片动作行 | [2026-10-07](../.agents/notes/implemented/architecture/2026-10-07-card-actions-live-in-a-footer-row.md) |
| 一对选行工具 | [2026-10-08](../.agents/notes/implemented/bug-fix/2026-10-08-one-pair-of-pick-tools.md) |
| 行上动作等悬停 | [2026-10-12](../.agents/notes/implemented/architecture/2026-10-12-row-action-waits-for-hover.md) |
| 页签去掉、改成入口 + 宽弹窗 | [2026-11-12](../.agents/notes/implemented/architecture/2026-11-12-no-page-tabs.md) |
| 分页块间距（换成宽弹窗正文层） | [2026-10-16](../.agents/notes/implemented/bug-fix/2026-10-16-inner-blocks-need-their-own-gap.md) |
| 弹窗正文字号 | [2026-10-12](../.agents/notes/implemented/bug-fix/2026-10-12-dialog-body-declares-its-own-type.md) |
| 弹窗正文块间距 | [2026-10-18](../.agents/notes/implemented/bug-fix/2026-10-18-dialog-body-needs-its-own-gap.md) |
| 颜色只走 token | [2026-09-27](../.agents/notes/implemented/bug-fix/2026-09-27-token-only-colors.md) |
| 动作带边框 | [2026-10-16](../.agents/notes/implemented/bug-fix/2026-10-16-actions-carry-their-frame.md) |
