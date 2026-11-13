/**
 * 这一页的样式，按 effect 生命周期注入 `<style>`。
 *
 * 颜色只用宿主 `Theme` 检查面列出的 token（`--dsw-alias-*`），每个都带一个中性的回落值，
 * 深浅主题自动跟随。检查面之外还有几枚宿主其实在用的 token（卡片描边、次要/最静的文字色等），
 * 它们逐个登记在 `test/styles.test.mjs` 的例外表里并写明理由——**用了就必须登记**，
 * 不然"这枚 token 改名了"这件事没人会发现。**主题色不能拿"另一个主题下的观感"去估**：
 * 深色主题里的 `brand-primary` 是近白色，在它上面写死白字就是白底白字。
 *
 * 卡片与控件的几何**不自己发明**，照官方那几份 CSS module 的原文抄，并在真实 dev GUI 里量一遍确认：
 * 卡片圆角 20px / 1px 描边（内建「插件」页的 `.card`）、输入框 0.5px 描边（`Input.module.css`）、
 * 标签是胶囊（`Tag.module.css`）。手写控件换官方原语之后，那些控件的几何**由官方给**，
 * 这里只保留布局类的部分（见 `.dsm-tag` 那段注释）。
 *
 * 不用任何宿主原语包的类名：那些是打包器哈希出来的私有产物，抄不到也不该抄。
 *
 * 排版分两层，都是**照着设置外壳自己的页量出来的**（不是估的）：
 *
 * - **页头**照内建设置页（「模型」「内置插件」「Agent 预设」都是这一档）的节奏：`h2` 16px/500 的标题
 *   独占一行（行高 24px），下面 12px 跟一行 14px 的说明（用 `label-tertiary`——内建页那一行的计算色
 *   就是它解析出来的 `#81858c`），再往下才是内容。上游那套页头是设置外壳的功能插件包自己手写的
 *   （类名是 `zGbnIq_` 这种打包哈希），本插件刻意不 require 它，所以规格只能这样量过来。
 * - **卡片**照「插件」页那一类管理列表：一个区块一张卡片（发丝描边 + 大圆角）、行高紧凑、
 *   次要文字用 `label-secondary`。
 *
 * 外层的水平留白与滚动由设置外壳给（它那一列是 `padding: 0 24px 24px; overflow-y: auto`），
 * 所以这里不再自己加页面级 padding。
 *
 * @module dsh-session-manager/client/styles
 */

/** 样式归属（卸载与热替换都按它认领）。 */
export const STYLE_OWNER = 'dsh-session-manager/client.css'

/** 样式表正文。 */
export const CSS = `
/*
 * 正文与次要文字的字号照内建设置页量出来的两档（不是按美观定的）：正文那一档是 **14px / 行高 20px**
 * （内建卡片的标题就是它），次要那一档是 **12px / 行高 18px**（内建卡片的描述就是它）。所以正文字号
 * 走这一层继承，凡是"比正文淡一档"的字都显式写成 12px/18px，而不是只换个颜色。
 */
/*
 * 主栏那一版（侧栏入口点开之后的落点）：宿主给的容器是定高的 flex 列，且 overflow 是 hidden。
 *
 * 这里的骨架从"一列限宽的内容"换成了"整页工作台"：内容列**占满**主栏，页面本身不滚；滚的是卡片
 * 里的列表。960px 上下限那一版是给设置弹窗里的格子用的，从侧栏进来整块主栏时，1920 的窗口两侧会各
 * 空出三百多像素。其余三件事搬进宽弹窗之后，这个上限在页面这一级只剩工作台一处，弹窗按自己的正文
 * 形态定宽（见 .dsm-workDialog）。
 */
/*
 * 插件页里这一包的那格配置（plugins.bundle.config）。形状照 dsh-context 那张配置卡：一组一个标题
 * （16/600），组里一行一件事——标签与说明在左、控件在右；组与组之间一条发丝线。控件外观仍归官方
 * 控件库，这里只管摆位与分组。
 */
.dsm-settingPrefs { padding: 4px 0; display: flex; flex-direction: column; }
.dsm-settingGroup { display: flex; flex-direction: column; gap: 2px; }
.dsm-settingGroup + .dsm-settingGroup {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.16));
  margin-top: 18px;
  padding-top: 18px;
}
.dsm-settingGroupTitle { color: var(--dsw-alias-label-primary, #1f2329); font-size: 16px; font-weight: 600; line-height: 24px; }
.dsm-settingRow { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
.dsm-settingText { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.dsm-settingLabel { color: var(--dsw-alias-label-primary, #1f2329); font-size: 14px; line-height: 22px; }
/* 标签那一行的横排（标签 + 一枚状态标签，比如密码的「已配置」）。 */
.dsm-settingLabelRow { display: flex; align-items: center; gap: 6px; }
.dsm-settingNote { color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 1.5; }
.dsm-settingColumn { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
/* 右侧那一列控件固定宽度：一行一件事，不随窗口拉成一条长条。 */
.dsm-settingInput { flex: none; width: 320px; }
.dsm-settingColumn > .dsm-settingInput, .dsm-mapRow > .dsm-settingInput { width: auto; flex: 1 1 12rem; min-width: 0; }

.dsm-globalPage {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #ffffff);
}
.dsm-globalScroll { flex: 1; min-height: 0; overflow: hidden; display: flex; }
.dsm-globalContent {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 24px 16px;
  box-sizing: border-box;
}

.dsm-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 14px;
  line-height: 20px;
}
/*
 * 页头是一条工具条：标题、同步状态、页面级动作同排。窄到放不下时换行，行距收回 8px——换行之后
 * 两行仍是一块头，不该按块间距 16px 拉开。
 */
.dsm-head { display: flex; align-items: center; gap: 16px; row-gap: 8px; flex-wrap: wrap; flex: none; }
.dsm-title { flex: none; margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
/*
 * 页头那枚同步状态：它是官方 Button，外观不在这里画，只保证文字不折行、不参与收缩——它旁边就是
 * 三枚页面级动作，窄下去时先换行的是整条工具条，不该让"同步 · 自动推送"断成两截。
 */
.dsm-headChip { flex: none; white-space: nowrap; }
.dsm-headAction { flex: none; }
.dsm-spacer { flex: 1 1 auto; }
/* 底部状态栏：库在哪、多少条、备份与回滚在哪儿、哪个构建。整页只此一行，不随弹窗开关。 */
.dsm-statusBar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #646a73));
  font-size: 12px;
  line-height: 18px;
}
.dsm-statusLib { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 状态栏里那枚入口（备份与回滚）：官方 Button 的外观，这里只让它不参与收缩。 */
.dsm-statusAction { flex: none; }
/*
 * 状态栏里那一格「同步中 3/7」：它是文字 + 手型，与旁边两枚描边按钮**不是一个样**——它说的是"这一阵的
 * 动静"，不像「导入…」那样是一个要点的门。所以只给一处布局：不参与收缩、单行、不折行（39px 那一行里
 * 一折就顶出去）。数字换成等宽数字，进度跳 9/10 → 10/10 时宽度不抖。
 */
/*
 * 同步状态那枚点外面的一层：只为挂悬浮提示（官方 StateDot 不透传 title）。它得是 inline-flex 且不吃行高，
 * 否则按钮里那 10px 的点会把 28px 的行高顶开。
 */
.dsm-dotSlot { display: inline-flex; align-items: center; }
.dsm-statusJob {
  flex: none;
  white-space: nowrap;
  /* 进度跳 9/10 → 10/10 时宽度不抖：数字等宽。 */
  font-variant-numeric: tabular-nums;
}
.dsm-statusVersion { flex: none; }
/*
 * 「导入」那一面：一个 640 的窄弹窗，正文是两个字段加一对按钮，纵向排、16px 一道缝。
 *
 * 导出不再有弹窗——它按下去就打包下载（见 ManagePanel 的 doExport），所以原来那套"两栏并排 +
 * 容器查询叠回一列"的布局没有对象了，跟它一起去掉。
 */
.dsm-importBody { display: flex; flex-direction: column; gap: 16px; }
/*
 * 拖放：那一格既是「选择文件」的按钮，也是落点；整页在拖着文件时蒙一层虚线框。
 *
 * 虚线是"可以往这儿放"的通用说法，所以静止时就是虚线；悬停时描边转品牌色、底色兑一层淡的——只有一个
 * 提示，没有再加文字按钮或图标。两层都不吃鼠标事件（pointer-events: none）：盖住的那一层要是能接住
 * 指针，拖到页面上的 dragover 就会被它拦下，落点反而失效。
 */
.dsm-dropZone {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 6px 10px;
  border: 1px dashed var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  border-radius: 10px;
}
.dsm-dropZone[data-over='true'] {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 6%, transparent);
}
.dsm-dropVeil {
  position: fixed;
  inset: 12px;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 只画一圈虚线，不蒙白：蒙一层半透明的底会把整页洗淡，读起来像"又一个弹窗"，而不是"松手放到这儿"。 */
  border: 2px dashed var(--dsw-alias-brand-primary, #4d6bfe);
  border-radius: 16px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 4%, transparent);
  pointer-events: none;
}
/* 那句话自己带一块底：虚线框里直接写字会被下面的列表透过来干扰。 */
.dsm-dropVeilPill {
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f2329);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16);
  font-size: 14px;
  line-height: 20px;
}

/*
 * 卡片外壳照官方卡片（内建「插件」页那张 .card）量出来的规格：**圆角 20px**、**1px 描边**、底色是表面白。
 * 描边走 settings-card-stroke 而不是 border-l1：前者是官方给"设置卡片描边"这件事的专名 token，
 * 真实 dev GUI 里量到浅色 **rgba(0, 0, 0, 0.16)**、深色 **rgba(255, 255, 255, 0.2)**，与官方那张 .card
 * 的 borderTopColor 逐字相同（浅色主题两处都是 rgba(0, 0, 0, 0.16)）；原来的 border-l1 只到
 * rgba(0, 0, 0, 0.04)，卡片边界比官方淡了一大截——同一页里并排看就是"这张卡没画框"。
 *
 * 圆角不再自己写数值：它对的是官方那张卡的**观感**，官方那边是写死 20px（不是某个 radius token，
 * --dsw-radius-lg 是 16px、--dsw-radius-panel 是 28px，都对不上），所以这里也写死 20px。
 */
.dsm-card {
  border: 1px solid var(--dsw-alias-settings-card-stroke, rgba(0, 0, 0, 0.16));
  border-radius: 20px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 列表那张卡片：吃满页面剩下的高度，头、筛选、动作行不动，中间的表自己滚。 */
.dsm-cardFill { flex: 1; min-height: 0; overflow: hidden; }
.dsm-cardHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-cardTitle { font-weight: 600; }
/*
 * 次要文字：内建卡片的描述那一档（12px / 18px），比正文小一号。只换颜色不换字号是不够的——同一段
 * 说明与正文一样大时，"这是补充"这件事只能靠颜色说，而颜色在换主题、换屏幕时会漂。
 */
.dsm-hint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #646a73);
}
/*
 * 说明页：词条（dt 词 / dd 解释）与问答共用一个两列网格。词比解释重一档，解释用次要灰；
 * 词条列不折行（"子智能体""未分组"最多四个字），解释列吃掉剩下的宽度。
 */
.dsm-defs {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0;
  font-size: 14px;
  line-height: 22px;
}
.dsm-defs dt { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; white-space: nowrap; }
.dsm-defs dd { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); }
/* 问答的"问"是一整句话，不能按 nowrap 排——它会顶穿词条列。 */
.dsm-defsFaq dt { white-space: normal; }
/*
 * FAQ 是"问题一行、答案一行"，本来就没有第二列：.dsm-defs 那条 minmax(0, auto) 会把问题的
 * max-content 吃满整行，答案那一列因此拿到 0px——每个答案一行只放得下一个字符，整列垂到卡片右缘
 * 外面（真实 dev GUI 里量到 dd 宽 0px、高 1122px；声明成单列之后宽 534px、高 88px）。
 */
.dsm-defsFaq { grid-template-columns: minmax(0, 1fr); }
/* 路径这类机器可读的字串：等宽 + 次要灰，避免与正文混成一句。 */
.dsm-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
/*
 * 这一页的按钮不在这里画：动作按钮一律是官方 Button（Button.module.css 那套，variant 决定外观、
 * size 决定 36px/14px 与 28px/12px 两档，填充与前景色也由官方那份点明）。本页原先手写的那套
 * .dsm-button / .dsm-primary 已经删掉，连它那条"检查面没给填充按钮的前景色，只好拿表面色当回落"
 * 的链子一起——那个前景色 token 官方按钮本来就在用，不必本页再拼一遍。
 *
 * 这一条注释刻意不写出那个 token 的名字：test/styles.test.mjs 扫 token 时连注释一起扫，写出来就会
 * 逼着那份名单把它当成"本页在用的 token"再登记一次，而本页已经不用它了。
 */

/*
 * 分组表头里的名字（同步弹窗那几张按项目分组的三张表，见 SyncPanel）：它就是那一行**唯一**的字
 * （项目身份与本机路径都在它的悬浮提示里，见 planRows.projectLabel()），不折行；实在挤不下时截断。
 */
.dsm-groupTitle {
  font-size: 14px;
  font-weight: 600;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 组头右侧的"这组几条 / 选中几条"：一整块，不折行、不压缩。 */
.dsm-groupCounts {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
/*
 * 组头上的标签（"未登记目录"与主机名）也是不可压的：它的字不能折行，压窄了就会溢出自己的框。
 *
 * 行高压到 18px：12px 的字 + 上下各 1px 边框正好等于 14px 名字那一行的高度（20px），于是挂了标签的
 * 组头不会比没挂的高出来（改之前 22px，量到 39 vs 38px——同一列组头高度不齐）。
 */
.dsm-groupPick > .dsm-tag { flex: none; line-height: 18px; }
/*
 * 组内的会话行：整行缩进一格（勾选框也跟着走，读起来就是"挂在组头下面"），左缘那条 2px 的导引线
 * 逐行相接，成一条竖线。它压在整个列表的左边界上，正是"这一组"的范围。
 */
.dsm-group > .dsm-row {
  /* 48px = 组头内容左缘（4px 内边距 + 20px 开关 + 8px 间距）再让 16px：
     组头的勾选框与组内行的勾选框恒差这 16px，"行挂在组头下面"才读得出来。
     代价是行里的标题少了 22px 宽——这一档是量着调的，改开关尺寸时要跟着改。 */
  padding-left: 48px;
  box-shadow: inset 2px 0 0 0 color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent);
}
/*
 * 子智能体行：缩进到父会话的下一级（列表里的父子关系与删除 / 迁移的级联展开是同一棵树，见
 * groups.ts 的 nestSessions）。
 *
 * 手段与上面组头那一档同一套：**再缩进一格 + 一条导引线**。线画在父行内容左缘那一格（组内行是
 * 48px，也就是父行勾选框的左边），于是同一屏里出现两条平行的竖线：外面那条是"这一组的范围"，
 * 里面那条是"这几行挂在上面那条父会话下面"。层次不能只挂在缩进上——窄屏、长标题、色觉差异下，
 * 最先被压没的正是缩进。
 *
 * 一格 24px：正好是行里勾选框那一列的宽度，父行与子行的勾选框因此差一格，一眼看得出谁在谁下面。
 * 级数在 groups.ts 封顶（MAX_NEST_DEPTH），所以这里只写到三级。
 */
/*
 * 导引线用**底图**画，不用 box-shadow：inset 阴影的语义是"从左边起画 Npx 宽的带"，只适合画贴着左缘
 * 的那一条（组界线就是 2px）。要画在第 50px 上，就得先铺 52px 的带、再把它左边的 50px 擦掉——而
 * box-shadow 只能叠、不能擦。底图上一条 2px 的色标正好是这件事。
 * 因此 .dsm-row:hover 只能改 background-color（写成 background 简写会把底图一起清掉，悬停时导引线
 * 一闪就没了）。
 */
.dsm-group > .dsm-row.dsm-rowNest1 {
  padding-left: 72px;
  background-image: linear-gradient(
    to right,
    transparent 0,
    transparent 50px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 50px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 52px,
    transparent 52px
  );
}
.dsm-group > .dsm-row.dsm-rowNest2 {
  padding-left: 96px;
  background-image: linear-gradient(
    to right,
    transparent 0,
    transparent 50px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 50px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 52px,
    transparent 52px,
    transparent 74px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 74px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 76px,
    transparent 76px
  );
}
.dsm-group > .dsm-row.dsm-rowNest3 {
  padding-left: 120px;
  background-image: linear-gradient(
    to right,
    transparent 0,
    transparent 50px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 50px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 52px,
    transparent 52px,
    transparent 74px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 74px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 76px,
    transparent 76px,
    transparent 98px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 98px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 100px,
    transparent 100px
  );
}
/* 两级图形标记的共用部分：颜色跟着所在处的字色档次走，尺寸由 SVG 自己定。 */
.dsm-levelIcon { flex: none; display: block; color: var(--dsw-alias-label-secondary, #646a73); }
/* 工作区那一个跟它自己的标题同色（组头是"重"的那一级），会话那一个留在次要色上。 */
.dsm-levelWorkspace { color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-list {
  /* 整页里不必再用 320px 的小窗：给一个随视口的上限，短列表不留空、长列表不把页面推得很长。 */
  max-height: min(420px, 42vh);
  overflow: auto;
  /* 常驻一条滚动条占位：装了占位滚动条的环境里，溢出与否都不再改行宽（否则行里右对齐的列会左右跳）。 */
  scrollbar-gutter: stable;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 10px;
}
/*
 * 「会话」页的列表**高度固定**（不是上面那条 max-height）。只有这一页有筛选条：筛掉多少行，列表就
 * 矮多少，而这一页一矮，设置弹窗外层那条滚动条就一进一出——装了占位滚动条的环境里，这一进一出把
 * 整个卡片的右边缘挪 15px，卡头按钮与行里右对齐的字节、时间全跟着跳，筛一下动一下。
 * 固定之后这一页的高度与筛选无关，外层滚动条再也不会因为筛选而切换（实测 35 / 5 / 1 行三种状态下
 * 都是 242px，外层滚动容器的 scrollHeight 都是 760px）。代价是筛完只剩几行时框里留一块空——
 * 上面那条"短列表不留空"的取舍在这里让位，因为不跳比不留空重要。
 * "一条都没筛出来"的空态也画在这个框**里面**（见 ManagePanel），换成框的兄弟就等于把框撤了。
 */
.dsm-listFixed { height: min(420px, 42vh); }
/*
 * 主栏那一版：列表吃掉卡片剩下的高度，自己成为滚动视口。固定 420px 是给设置弹窗那一版的——
 * 宽屏上会变成一条 1600×420 的横带，而且翻到下面时筛选条早滚走了。
 */
.dsm-listFill { flex: 1; min-height: 0; max-height: none; }
/*
 * 表头：列的说明，跟列表一起滚，但贴在框顶。必须不透明——滚过去的行不能从它背后透出来。
 * 列宽与 .dsm-rowManage 逐字一致，两处改一处就会错位。
 */
.dsm-tableHead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: 24px 16px minmax(120px, 1.4fr) 168px 84px 120px;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 12px;
  line-height: 18px;
}
.dsm-sort {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dsm-sort:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-sort:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: 2px; border-radius: 2px; }
.dsm-sortStatic { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 数字与时间右对齐：表头与行里的值贴同一条边，列才读得成一张表。 */
.dsm-sortNum { text-align: right; }
/*
 * 勾选式列表行（导出列表 / 迁移挑选）：五列 = 勾选框、层级标记、标题、字节、时间。
 * 行里不再重复 cwd：它在组头上（导出）或字段上（迁移），重复一遍只会把标题挤窄。
 */
.dsm-row {
  display: grid;
  grid-template-columns: 24px 16px minmax(120px, 1.4fr) auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  cursor: pointer;
}
.dsm-row:last-child { border-bottom: none; }
/* 「会话」页那一行：勾选框、图形标记、标题与标签、项目、字节、时间（六列，与表头逐列对齐）。 */
.dsm-rowManage { grid-template-columns: 24px 16px minmax(120px, 1.4fr) 168px 84px 120px; }
.dsm-rowManage > .dsm-meta { text-align: right; }
/* 「项目」那一格是文字，不跟着数字右对齐：它与表头一起从左边读。 */
.dsm-rowManage > .dsm-owner { text-align: left; }
/* 计划清单里那一行没有勾选框（清单不是勾选面），于是少一列，且它不可点。 */
.dsm-rowPlan {
  grid-template-columns: 16px minmax(120px, 1.4fr) auto auto;
  cursor: default;
}
/*
 * 计划清单里级联带进来的那些（"随父删" / "随父迁"）：也缩进一级，让"哪几条是点名的父会话带进来的"
 * 不用读标签就看得出（宿主给的顺序已经是"点名的在前、随后是各自的后代"，见 family.ts 的 familyOf）。
 *
 * 这一份清单不按目录分组，所以基准是行自己的 10px 内边距而不是上面那 48px；导引线画在父行内容左缘
 * （10px），子行再往里让一格（24px）。
 */
.dsm-rowPlan.dsm-rowNest1 {
  padding-left: 34px;
  /* 同上面组内行：导引线走底图，别用 box-shadow（那是"从左边起 Npx 宽的带"） */
  background-image: linear-gradient(
    to right,
    transparent 0,
    transparent 10px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 10px,
    color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 14%, transparent) 12px,
    transparent 12px
  );
}
.dsm-rowPlan.dsm-rowNest2 { padding-left: 58px; }
.dsm-rowPlan.dsm-rowNest3 { padding-left: 82px; }
/*
 * 悬停底色同样不能拿表面 token 当"稍深一点"：浅色主题里 bg-layer-1/2/3 **全是同一个白**，
 * 铺上去等于没有反馈。改成把字色兑透明做一层薄雾（宿主外壳自己也这么兑），明暗两套都看得见。
 */
.dsm-row:hover { background-color: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 6%, transparent); }
.dsm-rowId { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
/*
 * 行上的标题：正文字体（id 才走等宽），单行省略。
 *
 * 省略号是必须的：标题长度由用户的第一句话决定，不能让它把字节/时间两列顶出屏幕。被截掉的部分
 * 靠悬浮提示补全（见 planRows.sessionLabel：提示里是"完整标题 + id"两行）。min-width: 0 是网格与
 * 表格里做省略的前提——默认 min-width:auto 会让格子撑到内容宽度，text-overflow 就没机会生效。
 */
.dsm-rowTitle {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 行里"名字 + 小标签（未分组）"的这一格：标签紧跟在名字右边，不参与省略。
 *
 * 名字这一格从"网格的一格"变成了"一格里的 flex 行"，所以两件事得补上：名字要 flex: 1 1 auto
 * 才会去吃掉标签之外的空档，标签要 flex: none 才不会被压变形。整格 min-width: 0 是外层网格
 * 做省略的前提（同 .dsm-rowTitle 的注释）。
 *
 * id 型的名字（没有标题的老会话）在这条行里也改成单行省略：它本来靠 overflow-wrap: anywhere
 * 折行，而这里右边多了枚标签，一折行整行就变两行高，跟相邻行参差不齐。省略掉的部分照样有悬浮
 * 提示（planRows.sessionLabel 的 tip 就是完整 id）。
 */
.dsm-rowLabel { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsm-rowLabel > .dsm-rowTitle, .dsm-rowLabel > .dsm-rowId { flex: 1 1 auto; }
.dsm-rowLabel > .dsm-rowId { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-rowLabel > .dsm-tag { flex: none; }
.dsm-meta { color: var(--dsw-alias-label-secondary, #646a73); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/*
 * 行尾那一格：时刻与那枚「详情」叠在同一个格子里，键盘落到这一行时后者顶掉前者。
 *
 * 叠格子而不是并排：格宽取两者的最大值（正好是时刻的宽度），于是切换时行宽不动、右边几列也不动；
 * 并排则要为平时不出现的那枚按钮白留一段宽度，改成 display: none 又会让标题那一格在切换时被拉宽
 * （文字跟着跳）。
 */
.dsm-slot { display: grid; align-items: center; }
.dsm-slot > * { grid-area: 1 / 1; justify-self: end; }
/*
 * 行尾那枚「详情」与时刻叠在同一格：平时 visibility: hidden（不进 tab 顺序；键盘落到这一行的勾选框
 * 时整行 :focus-within 再让它出场，那时 Tab 也够得着它）。
 *
 * 鼠标与触屏不靠它：点整行就打开右栏（见 sessionList.tsx 的 openDetailOf），所以悬停时这一格仍是
 * 时刻，不再浮出一枚多余的动作。
 */
.dsm-slotActions { display: flex; align-items: center; gap: 8px; visibility: hidden; }
/*
 * 行上的动作是**动作**，不是标签——所以没有盒子（盒子是标签那套语法）、走 brand 色。
 * visibility 继承自 .dsm-slotActions。
 */
.dsm-rowDetail {
  border: none;
  background: transparent;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-brand-primary, #3370ff);
  cursor: pointer;
  visibility: inherit;
}
/* 键盘落在这一行：时刻让位，按钮出场。 */
.dsm-row:focus-within .dsm-time { visibility: hidden; }
.dsm-row:focus-within .dsm-slotActions { visibility: visible; }
.dsm-rowDetail:hover { text-decoration: underline; }
.dsm-rowDetail:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3370ff);
  outline-offset: 1px;
}
.dsm-empty { padding: 14px; color: var(--dsw-alias-label-secondary, #646a73); }
/*
 * 工作台：左栏（项目与筛选）+ 列表。整块高度由页面给（.dsm-root 的 flex 列），两边各自滚。
 *
 * container-type: inline-size 让下面那条 @container 读的是**这一块自己的宽度**，不是窗口宽度：
 * 宿主侧栏可以收起，同一个窗口下页面可用宽能差两百多像素，按窗口分档会在收起侧栏的一瞬间判错。
 */
.dsm-workbench {
  position: relative;
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
  container-type: inline-size;
}
/*
 * 主栏是浮层外面那层空白（.dsm-scrim）的定位参照：它铺的就是这张卡片这一块，不越到左栏去。
 */
.dsm-workbenchMain {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/*
 * 左栏是一张卡片：宽度固定 208px，里面分三段——头、项目清单（自己滚）、筛选。
 * 不用边框竖线而用一张卡，是为了和右边那张列表卡同一套几何（圆角 / 描边 / 内边距）。
 */
.dsm-tree {
  box-sizing: border-box;
  width: 208px;
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}
.dsm-treeHead { flex: none; }
.dsm-treeList {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0 -4px;
  scrollbar-gutter: stable;
}
.dsm-treeRow { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 6px; border-radius: 8px; }
.dsm-treeRow:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 6%, transparent); }
.dsm-treeRow[data-selected='true'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3370ff) 12%, transparent);
}
/*
 * 行上的整组勾选框：平时收起，悬停 / 键盘落在这一行时出现；已经勾了（含勾了一半）就一直显形——
 * 否则"我勾了两条"这件事在静止状态下看不见。
 */
.dsm-treeCheck { flex: none; width: 14px; display: flex; align-items: center; opacity: 0; }
.dsm-treeRow:hover .dsm-treeCheck, .dsm-treeRow:focus-within .dsm-treeCheck { opacity: 1; }
.dsm-treeCheck:has(input:checked), .dsm-treeCheck:has(input:indeterminate) { opacity: 1; }
/*
 * 名字与条数是同一个按钮：点整行就是"只看这个项目"。勾选框是它的兄弟节点，不是它的子节点——
 * 按钮里套 checkbox 是非法嵌套，点勾选框也会被读成"选了项目"。
 */
.dsm-treePick {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dsm-treePick:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: 1px; border-radius: 6px; }
.dsm-treeIcon { flex: none; width: 14px; height: 14px; }
.dsm-treeName { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dsm-treeCount { flex: none; font-size: 11px; color: var(--dsw-alias-label-secondary, #646a73); font-variant-numeric: tabular-nums; }
.dsm-treeRow[data-selected='true'] .dsm-treeName { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 500; }
.dsm-treeRow[data-selected='true'] .dsm-treeCount { color: var(--dsw-alias-brand-primary, #3370ff); }
/* 筛选那一段钉在栏底：项目多的时候滚的是上面那份清单，筛选一直在。 */
.dsm-treeFilters {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsm-treeFilters .dsm-filters { padding: 0; }
/* 宽屏上这枚开关与「关闭」都不出现：左栏一直摆着。 */
.dsm-treeToggle, .dsm-treeClose { display: none; }
/*
 * 浮层外面那层空白：窄屏有浮层打开时铺满列表这一块（左栏的「项目与筛选」与右侧「详情」之外那片），
 * 点它就收起（见文末的两条容器查询）。
 * 它不画任何东西——浮层已经靠宽度与右边那道阴影跟列表分开，再压一层底色只是把下面的列表染灰。
 * 它挂在 .dsm-workbenchMain 里（见 ManagePanel）：左栏在 960–1180 那一档还是常驻的一列，这一层
 * 因此不会盖住它。position / inset / z-index 那三行平时不起作用（display:none 不在布局里），
 * 只有容器查询那一档把它打开时才用得上。
 */
.dsm-scrim {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 5;
}
/*
 * 「会话」页右栏：一条会话的详情。宽屏上一直摆着（没选时是一句提示），窄屏收成浮层（见文末的
 * 容器查询）。宽度 340 是量出来的：再宽，1600 窗口下列表的标题列就只剩一百多像素。
 */
.dsm-inspector {
  box-sizing: border-box;
  width: 340px;
  flex: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow: hidden;
}
.dsm-inspectorEmpty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 24px 8px;
  text-align: center;
}
.dsm-inspectorEmptyTitle { margin: 0; font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-inspectorBody { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.dsm-inspectorName { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; overflow-wrap: anywhere; }
.dsm-inspectorTags { display: flex; flex-wrap: wrap; gap: 6px; }
/*
 * 开头两轮：一段只读的摘要，不是时间线。每轮一行轮次标签，加「你 / 答」两行；每格最多四行，
 * 再多就交给「打开完整内容」。上下各一条发丝线，与元数据分开。
 */
.dsm-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsm-previewHead { font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-previewTurn { display: flex; flex-direction: column; gap: 3px; }
.dsm-previewLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-previewRow { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 6px; align-items: start; }
.dsm-previewWho { font-size: 12px; line-height: 20px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-previewText {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary, #1f2329);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}
.dsm-facts {
  display: grid;
  grid-template-columns: 62px minmax(0, 1fr);
  gap: 8px 10px;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
}
.dsm-facts dt { color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.dsm-inspectorId { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dsm-inspectorActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
/* 右栏正开着的那一行：左缘一条品牌色细线 + 一点底色，知道右栏说的是哪一条。 */
.dsm-rowManage[data-opened='true'] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3370ff) 6%, transparent);
  box-shadow: inset 2px 0 0 0 var(--dsw-alias-brand-primary, #3370ff);
}
.dsm-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-select, .dsm-file {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 8px;
  font: inherit;
  max-width: 100%;
}
.dsm-file { padding: 3px; }
/* 目录字段的值：撑满一行（旁边留给「手输路径」），长值单行省略（完整值在它的悬浮提示里），别把
   布局顶宽。这枚控件是**按钮**（点开候选面板，见 CandidatePanel.tsx），所以还要把浏览器给按钮的
   默认外观收回来：文字靠左、内容两端对齐、光标是手型。 */
.dsm-selectPath { flex: 1 1 22rem; min-width: 0; }
.dsm-pathValue {
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  cursor: pointer;
}
.dsm-pathValueText {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 页面内目录浏览框：一个缩进的浅底小面板，和所在字段同宽。 */
.dsm-browser {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.dsm-browserHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 当前这一层的完整路径：单行省略（完整值在 title 里），长路径不该把这个框顶宽。 */
.dsm-browserPath {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-crumbs { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.dsm-crumb {
  border: none;
  background: transparent;
  color: var(--dsw-alias-brand-primary, #3370ff);
  font: inherit;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: pointer;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/*
 * 悬停底色是"字色兑透明的一层薄雾"，不是某个表面 token：检查面里的表面色在浅色主题下多半也是
 * 白的（bg-layer-3 就是 #fff），铺上去等于没有反馈。宿主外壳自己也这么兑（color-mix +
 * transparent），所以这里跟着走；真遇到不认 color-mix 的浏览器，就只是少一层悬停反馈。
 */
.dsm-crumb:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
}
.dsm-crumb:disabled { color: var(--dsw-alias-label-secondary, #646a73); cursor: default; }
/* 一层子目录：等宽两列铺开，比竖排一行一览得多。 */
.dsm-dirList {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 2px;
  max-height: min(260px, 30vh);
  padding: 4px;
}
.dsm-dirEntry {
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-dirEntry:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 8%, transparent);
}
.dsm-dirEntry:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: -1px; }
.dsm-dirHidden { color: var(--dsw-alias-label-secondary, #646a73); }
/*
 * 候选面板的列表：与目录浏览框同一个 .dsm-dirList 皮，只是**一行一个**、一行两行字。
 * 一行一个是因为候选的文案比一个目录名长得多（"身份/标题 — 本机路径 — N 条会话"），两列并排会被
 * 截成谁也认不出来；两行字则是把名字留在第一行、路径与条数退到第二行小字里（见 planRows.candidateRow）。
 */
.dsm-candidateList { grid-template-columns: minmax(0, 1fr); }
.dsm-candidate {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  /* 覆盖 .dsm-dirEntry 的单行省略：两行各自省略。 */
  white-space: normal;
}
.dsm-candidateName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-candidateMeta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 第一行是"名字 + 那枚「不存在」的标签"（见 planRows.candidateRow）：名字先让位，标签不缩。 */
.dsm-candidateHead { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dsm-candidateHead > .dsm-tag { flex: none; }
/* 点不动的候选不该再给悬停反馈：那层底色是"这一行能点"的信号。 */
.dsm-dirEntry:disabled { cursor: default; }
.dsm-dirEntry:disabled:hover { background: transparent; }
.dsm-table { width: 100%; border-collapse: collapse; }
.dsm-table th, .dsm-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  vertical-align: top;
}
.dsm-table th { color: var(--dsw-alias-label-secondary, #646a73); font-weight: 500; }
/* 导入计划那张表的列宽**写死**（fixed 布局）：会话那一列吃掉剩余宽度，其余按内容量好。
   自动布局碰上长路径会算出一个很怪的比例——动作列被挤成两个字宽（「动作」自己都折行），
   会话列每行只剩十来个字符。列宽是设计，不该由内容的字数决定。
   单元格要 border-box：默认 content-box 下 padding: 5px 8px 会**加到**列宽上，
   声明 72px 实占 88px——那 16px 是从"吃掉剩余宽度"的会话列身上扣的。实测修之前：
   表宽 534px → 动作 88 / 会话 155 / cwd 187 / 大小 104，单行高 271px（会话列里 id 折 3 行、
   冲突原因折 8 行），20 行就是 5400px 的表。 */
.dsm-planTable { table-layout: fixed; }
.dsm-planTable th, .dsm-planTable td { box-sizing: border-box; }
.dsm-planTable .dsm-colAction { width: 60px; }
/* 同步计划那两张表（拉取 / 推送）的动作列装的是「重推刷新」这种动词短语，比导入计划的两个字长一档，
   所以这两张表自己量一个列宽：实测 12px 字号下最宽的一个是 en 'Re-push' 63px、zh「重推刷新」62px，
   加单元格左右各 8px padding 是 79px，再留约 9px 余量。列宽仍然是**设计**（fixed 布局），只是这
   张表的设计跟着它自己的内容走；会话那一列照旧吃掉剩下的宽度（列宽从 60 → 88px，那一列少 28px）。
   真实事故（用户截图报的）：这一列还是 60px 时，标签「本机有、远端没有」实测 110px（en 那句
   158px），顶出格子 114px、压住后面那一列 98px —— 标签是 nowrap 的，装不下就直接画在邻居身上。 */
.dsm-syncPlanTable .dsm-colAction { width: 88px; }
/* 「这次不动」那张表的状态列装的是「两边各自写过」这种短语，比拉/推两张表的动词长一档：真机
   （dev GUI）量到最宽的一颗是 en "Remote ahead" 94.7px、zh「两边各自写过」86px（都含左右 padding
   与 2px 边框）。取 122px：内容区 106px，最宽那颗还剩 11px 余量，与拉/推那张表的 9px 同一档。 */
.dsm-keptTable .dsm-colAction { width: 122px; }
/* 兜底：计划表的标签再长也不许顶出格子。列宽是设计，标签的长短是文案——两者对不上时宁可让这一格
   自己截断（完整的那句在 title 里），也不要让邻居的会话名被压掉一半。三处都要：max-width 限宽、
   overflow 截断、box-sizing: border-box 让限的是**整个标签**（默认 content-box 下 max-width 只管文字
   那一层，左右 6px padding 与 2px 边框照样多顶出去 14px）。实测：把整句标签塞进这一格，加这三条之后
   标签右缘停在格子内容边界以内、文字截断（scrollWidth > clientWidth），不再碰到下一列。 */
.dsm-planTable .dsm-tag {
  box-sizing: border-box;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 弹窗里那份清单的组头挂着同一枚主机标签，行高与列表那边同一条规格（见 .dsm-groupPick > .dsm-tag）。 */
.dsm-planGroupHead .dsm-tag { line-height: 18px; }
.dsm-planTable .dsm-colCwd { width: 26%; }
/* 「这次不动」那张表的第三列（远端机器）：宽度沿用原来那一列的 26%。分组之后这一列不再放路径
   （路径去组头了），只放机器名——机器名比路径短，多出来的宽度归中间的会话列。 */
.dsm-planTable .dsm-colMachine { width: 26%; }
/* 大小那一列：68px 时「111.0 KB」（8 个字符 + 千分位）会被截成「111.0…」（真机量到 scrollWidth 72
   > clientWidth 68），往上让到 80px——最长的「999.9 KB」也放得下。 */
.dsm-planTable .dsm-colBytes { width: 80px; }
/*
 * 计划表里的项目组头：一条横跨整行的横幅，一个项目底下挂着它那几行（会拉取 / 会推送 / 没动三张表同一套）。
 *
 * 底色与列表那边的 .dsm-groupHead 同一档（字色 12% 兑在卡片底色上）、路径同样是等宽次要色——同一个
 * 目录在列表与弹窗里长得一样，才不必重新认一遍。区别是没有折叠与勾选：弹窗里这份清单只是读一遍。
 *
 * 选择器带 .dsm-planTable 不只为了就近分组：.dsm-table th（一个 class + 一个元素）比单个 class
 * 更具体，光写 .dsm-planGroupHead 的话内边距与字色都会被它压回去。
 */
.dsm-planTable .dsm-planGroupHead {
  padding: 6px 8px;
  color: var(--dsw-alias-label-primary, #1f2329);
  background: var(--dsw-alias-bg-layer-1, transparent);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 12%, var(--dsw-alias-bg-layer-1, #fff));
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
}
/* 组头里的那一行内容：图形 + 标题 + 路径 + 条数。横着排的是**里面这一层**，不是 th 自己换 display
   （表格单元格改成 flex 会让浏览器补一个匿名单元格，列宽就不再由 fixed 布局说了算）。 */
.dsm-planTable .dsm-planGroupInner { display: flex; align-items: center; gap: 8px; }
/*
 * 计划弹窗里那三段的段头（会拉取 / 会推送 / 两边都有、这次不动）。
 *
 * 原来是与正文同一档的 .dsm-hint（13px/400 次要色）：紧挨着"跳过 N 条空白会话…"那种说明句，三张表
 * 之间看不出分界。段头改成 13px/600 的主文字色（h3 默认的 1.17em / bold / 1em 外边距在这里被覆盖），
 * 条数退进一颗 12px 的中性药丸——标题、正文、标签各有各的形状。
 *
 * 外边距只给上面 16px：这几段落在弹窗正文那个普通块流里（不是 flex 子项），相邻外边距照常折叠，量到的
 * 就是"离上一段 16px、离下面那张表 0px"。标题因此紧贴它自己那张表、与上一段分开——"这条标题说的是下面
 * 那张表"靠的就是这个差（真实 dev GUI 里量到 16px / 0px，深浅两套主题同值）。
 */
.dsm-planHead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 16px 0 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f2329);
}
/* 药丸里装的是条数，不跟着段头一起加粗；行高与会话列表、组头里的标签同一条（18px + 上下各 1px 边框
   = 段头那一行的 20px，于是药丸不会把这一行顶高：实测两处都是 20px）。 */
.dsm-planHead .dsm-tag { font-weight: 400; line-height: 18px; }
/* cwd 那一格里的路径要能断行（fixed 布局下列宽不会再变），否则长路径顶出格子。 */
.dsm-cwd { color: var(--dsw-alias-label-secondary, #646a73); overflow-wrap: anywhere; }
/*
 * .dsm-tag 只是**布局挂钩**：标签的几何与配色都由官方 Tag 原语给（Tag.module.css 是 999px 胶囊 /
 * padding 1px 8px / 11px 字 / 行高 17px / 字重 500，tone 决定配色），本页只往上挂"这一页怎么摆它"
 * 的那几条。
 *
 * 这个类挂在**两处**，按那一枚标签有没有悬浮提示分：
 *   - 有提示的（官方 Tag 不收 title，见 ConfirmDialog 那类取舍）挂在包着它的那层 span（带 title）上——
 *     .dsm-groupPick > / .dsm-rowLabel > / .dsm-candidateHead > 这些子选择器选中的就是这一层；
 *   - 没提示的挂在官方 Tag 自己身上（上面那几条后代选择器照样命中）。
 *  一份标签只有一处带这个类，避免同一枚被两条规则各算一遍。
 *
 * 为什么这里要 display: inline-flex：本页要用 max-width + overflow 做"窄列里截断"（子选择器那层若
 * 还是 inline，max-width 根本不生效），官方 Tag 自己是 inline-flex，本页这层得跟它一致。
 *
 * 不再写 border-radius / padding / font-size / 配色：那些是"标签长什么样"，归官方管；本页再写一遍
 * 会与官方那份打架，谁生效取决于样式表注入顺序。nowrap 留在这儿是给竖排字兜底——官方那一份自己
 * 也有，但标签一旦被换回手写的 span 这一页就会竖起来，测试也钉它。
 */
.dsm-tag {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
/* state 色非当文字色不可的时候，先和 label-primary 兑一下：亮色主题往深里走、深色主题往浅里走，
   同一条声明在两套主题里各自走向可读的一侧（浅色主题实测 warn 5.57:1 / error 9.75:1 / ok 5.82:1）。 */
.dsm-error { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d83931) 55%, var(--dsw-alias-label-primary, #1f2329)); }
.dsm-warn { color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97b00) 55%, var(--dsw-alias-label-primary, #1f2329)); }
.dsm-ok { color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea121) 55%, var(--dsw-alias-label-primary, #1f2329)); }
/*
 * 计划那一段的结论：一句、加粗、按结论染色（只有"没有要同步的"才染绿）。数字与远端沉到下面那行脚注里，
 * 明细是表。三层各有各的样子，读起来才分得开——原来三件事都在 14px 的同一句里。
 */
.dsm-planVerdict { font-weight: 600; }
/*
 * 计划那一段的正文自己拿节奏（12px）：结论、数字、脚注清单、段头、表都在这一层里，段距一致。
 * 外边距归零的理由同上一节（.dsm-workBody 那条）——官方弹窗里的段落带 12px 上下外边距，叠在 gap
 * 上就不齐了。
 */
.dsm-planBody { display: flex; flex-direction: column; gap: 12px; }
.dsm-planBody > * { margin-block: 0; }
.dsm-planFacts { font-variant-numeric: tabular-nums; }
/* 脚注清单与上面那行数字同一档（12/18）：它们都是"表里没有、但会被碰到"的交代，不该比数字更响。 */
.dsm-planNotes { font-size: 12px; line-height: 18px; }
.dsm-banner {
  border: 1px solid currentColor;
  border-radius: 8px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
/*
 * 横幅里那枚按钮不参与收缩。
 *
 * 横幅是一行横向 flex（"一句话 + spacer + 按钮"），句子长的时候剩余宽度不够：中文可以在任意两个字之间
 * 断行，按钮的 min-content 就退成**一个字**宽，于是「知道了」被挤成竖着的两行（真实 dev GUI 里量到
 * 按钮 40px 宽、两行高）。让这一枚不收缩、把宽度留给句子换行——句子本来就该折行，按钮不该。
 */
.dsm-banner > button { flex: none; }
.dsm-fields { display: flex; flex-direction: column; gap: 8px; }
.dsm-field { display: flex; flex-direction: column; gap: 4px; }
.dsm-fieldLabel { color: var(--dsw-alias-label-secondary, #646a73); }
/*
 * 输入框的外观不在这里画：文本框一律是官方 Input（Input.module.css：外层 32px 高、0.5px 描边、
 * 圆角 --dsw-radius-md、focus-within 时描边转 state-business-primary）。本页只往上挂"这一页
 * 怎么摆它"的布局：撑满字段那一列，border-box 免得内边距把宽度顶出父容器。
 *
 * 原先那套 border / background / border-radius / padding / :focus-visible 已经删掉——那些
 * 是"输入框长什么样"，官方那份才是唯一来源；本页再写一遍会与它打架，谁生效取决于样式表注入顺序。
 */
.dsm-input {
  width: 100%;
  box-sizing: border-box;
}
/* 路径映射：一行一条，左右各一个输入框、右边一个删除；窄屏时整行换行而不是把输入框压扁。 */
.dsm-mapRows { display: flex; flex-direction: column; gap: 6px; }
.dsm-mapRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-mapRow > .dsm-input { flex: 1 1 12rem; min-width: 0; }
.dsm-mapArrow { color: var(--dsw-alias-label-secondary, #646a73); }
/* 同步设置表单：字段一列排开，配对的两个字段并排一行（窄屏自动换行）。 */
.dsm-syncForm { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 2px; }
/*
 * 表单底部那一块（动作行 + 探测结论）：动作行里是「保存 / 测试连接 / 放弃改动」，探测的说明与结论另起
 * 一行紧贴在下面。
 *
 * 是一列而不是一行，就为了结论要跟着按钮走：按一下按钮，答案就该出现在按的地方。这一块整体摆在表单
 * 哪一头、为什么，见 SyncConfigForm.tsx 里那段说明。
 */
.dsm-syncTools { display: flex; flex-direction: column; gap: 6px; margin-bottom: 2px; }
/*
 * 设置页那种"标题 + 说明 + 右端一个开关"的行。规格照内建设置页的开关行量出来的（
 * dsh-client-ui-settings-general 的 DeveloperToolsRow）：行是 space-between 的两端对齐、纵向居中、
 * 间距 24px；标题 14px/20px（正文那一档），说明 12px/18px 且用次要色（与 dsm-hint 同一档）。
 *
 * 本仓不给它加分割线：内建那一行上下都有 border-bottom，是因为通用设置页把若干行叠成一列；这里只有
 * 这一行，加线反而像把表单切开。
 */
/* 自动那一档的三选一控件：与原来的开关同一摆法（顶到右端、不撑高那一行）。 */
.dsm-toggleRow > [role='tablist'] { flex: none; }
.dsm-toggleRow { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.dsm-toggleText { min-width: 0; }
.dsm-toggleTitle { font-size: 14px; line-height: 20px; }
.dsm-toggleDesc { margin-top: 4px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 12px; line-height: 18px; }
.dsm-options { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
/*
 * 「会话」页的筛选条：与行上的小标签同一套视觉（一排小胶囊），选中的那一枚用品牌色描边 + 淡填充。
 * 描边与填充都走 token：brand-primary 在深浅两套主题里都是能读出来的强调色，而"选中"这件事同时
 * 由 aria-pressed 表达，所以颜色只是辅助——色觉不同的人靠描边粗细与 aria 状态照样分得清。
 */
/*
 * 筛选条分两行（见 sessionList.tsx 的 SessionFilterBar）：
 *   第一行 = 「筛选」+ 一排类别胶囊；第二行 = 搜索框 + 那句说明。
 * 为什么不让说明句/搜索框跟胶囊挤一行：它们只要挂在容器右边缘附近，位置就跟着容器的宽度变，而设置
 * 弹窗里那条 15px 的滚动条一进一出就会改宽度——实测旧写法（说明句用 spacer 顶到右端）一次挪 9px，
 * 装了占位滚动条的环境是 15px；改成紧跟胶囊也还是不稳（那一行只剩三十来 px 余量，窄一点就整行换行，
 * 实测换行阈值 30px）。两行之后：胶囊那行的余量宽出九十来 px（阈值 135px），搜索框与说明句都在固定
 * 的左边界上，容器怎么变都不动。
 */
.dsm-filters { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dsm-filterSearch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
/* 搜索框：与 .dsm-select / .dsm-file 同一套皮（边框、底色、圆角都走 token）。字号 13px 是内建输入框
   那一档（内建那几页的输入框就是 13px / 行高 18px），比正文小一号。 */
.dsm-search {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  border-radius: 8px;
  padding: 1px 8px;
  width: 180px;
}
.dsm-search::placeholder { color: var(--dsw-alias-label-secondary, #646a73); }
/* 候选面板里的筛选框：它是面板的主控件，撑满一行（180px 那个宽度是给列表工具栏那一行用的）。改宽属于
   改 .dsm-search 自己，所以挨着它写——上面的候选面板那一段只管那个列表长什么样。 */
.dsm-candidateFilter { width: 100%; }
.dsm-filter {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: none;
  color: var(--dsw-alias-label-secondary, #646a73);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  border-radius: 6px;
  padding: 0 8px;
  white-space: nowrap;
  cursor: pointer;
}
.dsm-filter:hover:not([aria-pressed='true']) { color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-filter[aria-pressed='true'] {
  color: var(--dsw-alias-label-primary, #1f2329);
  border-color: var(--dsw-alias-brand-primary, #3370ff);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3370ff) 12%, transparent);
}
.dsm-filter:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: 1px; }
/* 每类各有多少条：数字比标签淡一档，读起来仍走 label-secondary（同 .dsm-tag 的理由）。 */
.dsm-filterCount { color: var(--dsw-alias-label-secondary, #646a73); margin-left: 5px; }
/* 勾选框那一层不在这里画：它是官方 Checkbox（Checkbox.module.css 自带 16px 方框、6px 间距与
   焦点环）。原先手写的 .dsm-check 已经删掉。 */
/*
 * 确认弹窗：官方 Modal 给遮罩、卡片、标题栏与焦点归还（ConfirmDialog.tsx 里说明了为什么必须用它），
 * 这里只调两件事——宽度与滚动。
 *
 * 宽度：官方那张卡是 min(380px, 100%)，按"一句话 + 两个按钮"量的；本页的正文里是计划清单（会话行、
 * 计划表、动作列表），380px 会把标题与 cwd 挤没。640px 是按最长的那几行量的：计划清单里那四列
 * （勾选框位 / 名字 / 字节 / 时间）在这个宽度下不用截断。
 *
 * 重复写两遍类名（.dsm-dialog.dsm-dialog）是为了压过官方那张卡自己的宽度声明：两边都是单类选择器，
 * 谁生效取决于样式表的先后顺序，而官方那份是宿主注入的、顺序不由本插件决定；提一档特异性就不会随
 * 加载顺序变。
 *
 * 滚动：官方的卡片是 overflow: hidden 的纵向 flex 容器，正文那一层得自己写 min-height: 0 才能
 * 被压缩（flex 项默认的 min-height: auto 会撑到内容高度），overflow-y: auto 才有意义。标题栏跟着
 * 正文一起滚——清单再长也顶不出卡片，因为卡片本身限了 max-height: 100%（官方那份 Modal.module.css
 * 的注释就是这么要求的：消费者用 max-height: 100% 限高，别自己算视口）。
 */
.dsm-dialog.dsm-dialog { width: min(640px, 100%); max-height: 100%; }
/* 说明弹窗比一般确认弹窗宽一档：四节词条，640 里「哪里做什么」会挤成很窄的两列。 */
.dsm-dialog.dsm-helpDialog { width: min(760px, 100%); }
/*
 * 做事的那三个弹窗（导出 / 导入、同步、备份与回滚）再宽一档：1080 是它们原来在页面上的可读宽度
 * （见「非会话那三件限在可读宽度」那篇的由来），搬进弹窗之后清单与表单一个字都不用重排；再窄下去，
 * 传输那两栏与同步的计划表都要折行。窄窗口靠 min(1080px, 100%) 自己收。
 *
 * 为什么不是把 640 那一档改宽：确认弹窗（删除、迁移、回滚）的正文是"一句话 + 清单"，拉宽只会让
 * 一段说明变成很长的一行；这两种弹窗的宽度按正文形态分，不按"都是弹窗"合并。
 */
.dsm-dialog.dsm-workDialog { width: min(1080px, 100%); }
/*
 * 宽弹窗的正文层：原先这三页是 .dsm-panel，那次「相邻两张卡片贴在一起」的缺陷就出在"gap 不往里
 * 继承"上（见 .dsm-root 那条注释）。搬进弹窗之后它们一样需要自己那一层 16px，否则横幅与卡片、
 * 两张卡片之间都会贴住。
 */
.dsm-workBody { display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 20px; }
/*
 * 官方弹窗 portal 到 document.body，落在本页 .dsm-root 之外：那里面的段落带的是宿主正文默认的上下
 * 外边距（12px），叠在 gap 上就成了 28——两块之间比设计的 16 宽出一截。本页的规矩是「间距只由 gap
 * 给」，所以这一层直接把外边距收掉（只收直接子元素，表格、清单里的段落照旧）。
 */
.dsm-workBody > * { margin-block: 0; }
.dsm-helpBody { display: flex; flex-direction: column; gap: 16px; }
/* 弹窗自己已经是卡片：说明里那四节不再各套一圈卡片壳，留标题与正文的节奏。 */
.dsm-helpDialog .dsm-card { border: none; background: transparent; padding: 0; }
/* 官方的正文层就是"唯一那个滚动区"（RiskConfirmation 也这么用）。overscroll-behavior: contain
   挡住滚动链：正文滚到底之后不再把页面/卡片跟着推。 */
.dsm-dialogContent { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

/*
 * 「看差异」那一页（同步页三张表最后那一列 + 点开之后的比对视图）。
 *
 * 条目本身沿用内容视图那套类名（dsm-item / dsm-itemHead，同一张事件卡的头行），所以这里只补**布局**：
 * 那几块之间各自留间距、列宽固定住（免得三张表的列宽随状态列的标签长短抖动）。一个颜色都不写。
 *
 * 注意 contentClassName 落在官方 Modal 的**外层**（标题栏 + 正文），真正的正文是里面那层官方
 * _body_*；它的 display: flex 没有 gap。所以块间那 24px 必须挂在自己的 .dsm-diffBody 上，
 * 写在 .dsm-diffContent 上只会拉开标题栏与正文，块与块之间仍是 0（实测第一版就是这样）。
 */
.dsm-colDiff { width: 96px; }
.dsm-diffCell { white-space: nowrap; }
.dsm-diffContent {
  display: flex; flex-direction: column;
  /* 字号照正文那一档自己写：官方 Modal 会 portal 到 document.body，于是弹窗落在那套 dsm-root（13px 继承
     链）之外，正文会继承文档根的 16px——同一条会话在弹窗里与在页面里长得不一样（内容视图那层同样自己
     写了一遍）。量过：不写这条时这里量到 16px/normal，写上之后是 14px/20px。 */
  font-size: 14px; line-height: 20px;
}
.dsm-diffBody { display: flex; flex-direction: column; gap: 24px; }
.dsm-diffRelation { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0; }
/* 分区：块与块之间 24px（上面那条 gap），一块里面 12px。均匀一种间距会糊成一片；但只收紧不收，
   标题、事实、结论、计数、表、尾巴、尾注又会挤成一整块。 */
.dsm-diffSection { display: flex; flex-direction: column; gap: 12px; }
.dsm-diffTails { gap: 20px; }
.dsm-diffHead { display: flex; flex-direction: column; gap: 6px; }
.dsm-diffLive { margin: 0; padding: 8px 12px; }

/* 尾注与正文分开：底下那句"只读"不是尾巴块的一部分。 */
.dsm-diffNote { border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08)); padding-top: 12px; }
.dsm-diffHeader { display: flex; flex-direction: column; gap: 8px; }
.dsm-diffField { width: 120px; }
.dsm-diffField .dsm-tag { margin-top: 2px; }
.dsm-diffFieldName { display: block; }
.dsm-diffTail { display: flex; flex-direction: column; gap: 8px; }
/* 一张事件卡在差异页里比内容视图更疏一点：这里两侧都是长列表，卡又窄，6px 的卡内边距读起来
   像一叠贴紧的纸条。只改差异页这一层，内容视图的密度不跟着动。 */
.dsm-diffTail .dsm-item { padding: 8px 10px; }
/* 顶部三格计数（共同 / 本机独有 / 远端独有）：横排一行、每格里标签在上数字在下——横着摆的
   "标签+数字"三组读起来像一句话，竖着摆才读成三格数据。 */
.dsm-diffStats { display: flex; gap: 32px; flex-wrap: wrap; }
.dsm-diffStat { display: flex; flex-direction: column; gap: 4px; min-width: 88px; }
/* 块头那枚标签要**收成小块**：容器是竖排 flex，默认 stretch 会把标签拉成整条，看着像一条横幅而不是
   一枚分类标记（实测第一版就是这样）。只让它自己靠左，下面那些条目卡照旧占满整宽。 */
.dsm-diffTail > .dsm-tag, .dsm-diffHeader > .dsm-tag { align-self: flex-start; }
/*
 * 正文那一层：块与块之间的节奏（官方那层 body 是纵向 flex 但不给间距）、以及**字号**。
 *
 * 字号必须自己写：官方 Modal 会 portal 到 document.body，于是弹窗落在那套 .dsm-root（13px）之外，
 * 正文会继承文档根的 16px——同一条会话行在弹窗里与在页面里长得不一样（在真实 dev GUI 里量过：
 * 不写这一条时弹窗里的行 16px、行高更大，页面里的行 13px）。弹窗里摆的就是页面上的那几个组件，
 * 两处必须同规格。
 */
.dsm-dialogBody { display: flex; flex-direction: column; gap: 8px; font-size: 14px; line-height: 20px; }
/*
 * 底部那对按钮不再需要本页写字号：它们是官方 Button 的缺省尺寸（36px / 14px），而官方按钮在
 * Button.module.css 里把 font-size 写在 md 那一档上，不靠继承——原先那条
 * .dsm-dialog .dsm-button { font-size: 14px } 是给手写按钮补继承的（footer 在我们那层 body 之外，
 * 会继承文档根的 16px），现在整个删掉。
 */
/*
 * 进度条：同步这种"按条走网络"的长动作（整库可能上百条）用它回答"做到第几条了"。
 *
 * 轨道走 border-l2 而不是 bg-layer-*：浅色主题里那三级底色是同一个白，铺在白底弹窗上等于没有轨道
 * （行悬停底色那里踩过同一个坑）。填充走 brand-primary，与主按钮同一支颜色。
 */
.dsm-progress {
  height: 6px;
  border-radius: 3px;
  background: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  overflow: hidden;
}
.dsm-progressFill {
  height: 100%;
  background: var(--dsw-alias-brand-primary, #1f2329);
  transition: width 120ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .dsm-progressFill { transition: none; }
}
/*
 * 进度横幅：后台同步与「立即推送一次」那一轮都落在页面横幅里（见 ManagerPanel.tsx / SyncPanel.tsx）。
 *
 * .dsm-banner 自己是一行横向 flex（为"一句话 + spacer + 关闭"那种形状写的），而这里装的是竖着排的
 * 状态卡：标题那行（状态点 + 这是哪一趟）/ 进度块 / 一句说明（见 ProgressBlock.tsx）——不换方向的话
 * 那几行会横着挤成一排。
 *
 * 几何照卡片那一档（内边距 12px 14px、块间 8px、描边走 settings-card-stroke）：它现在装的是三四行
 * 读数，用"一句话横幅"的 6px 10px 会挤得像一条夹缝，描边用 currentColor（原来那条）则跟着文字色
 * 变，深色主题里是一圈发灰的粗框。
 */
.dsm-progressBanner {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  padding: 12px 14px;
  border-color: var(--dsw-alias-settings-card-stroke, rgba(0, 0, 0, 0.16));
}
/* 标题那行：官方 StateDot 的 ongoing 转圈（14px）+ 一句话。点与字都靠中线，转圈时行高不跟着跳。 */
.dsm-progressHead { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsm-progressTitle {
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #1f2329);
}
/*
 * 进度块内部：那句"做到哪儿了" → 条 → 正在处理的那一条 → 说明，四样之间 6px（比"块内 8px"紧一档，
 * 它是一段连续读数而不是四个块）。节奏走容器的 gap，不给 <p> 留浏览器默认外边距——默认 1em 上下会
 * 让四样之间的间距一会儿 2px、一会儿 13px，整块看着忽松忽紧（这一条是这次重画的主要原因）。
 */
.dsm-progressBlock { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsm-progressBlock > p { margin: 0; }
/* 计数那行用等宽数字：条走到 9 → 10 时，"第几条"那串不跟着左右抖。 */
.dsm-progressText {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-variant-numeric: tabular-nums;
}
/* 正在处理的那一条：12/18 三级色、单行省略（完整名字在悬浮提示里）。它只是"现在在搬哪一条"，
   不该比上面那句计数更亮更大。 */
.dsm-progressItem {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #646a73));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsm-progressNote {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #646a73));
}
.dsm-listPlain {
  margin: 0;
  padding-left: 18px;
  color: var(--dsw-alias-label-secondary, #646a73);
  max-height: 240px;
  overflow: auto;
}
.dsm-listPlain li { overflow-wrap: anywhere; }
.dsm-fields-label { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 500; margin: 0; }
.dsm-registry, .dsm-problems, .dsm-effect { display: flex; flex-direction: column; gap: 4px; }
/* ── 「上次同步」那张清单（SyncPanel 的面板段） ──────────────────────────────
   两件事分两档画，否则"多久以前""没做到几条""那几句原话"与下面两段说明会连成一条灰字河：

   1. 干净那一趟：一行小标题 + 一行读数，不画框（对话框里不套卡片，见 design.md 那条）；
   2. 有遗留：成"一块记录"——底色 + 左边一道告警色细线，把这件事与下面那几句说明分开。
      它不是卡片：没有一圈框、没有重复的标题，只是一段被标出来的记录。 */
.dsm-lastRun { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* 块里那几行不许带浏览器默认段距：<p> 的 1em 上下会让节奏在 6 / 12 / 18px 之间乱跳，
   四行字看着一样松，谁也不挨着谁（这一条是这次重画的主要原因）。 */
.dsm-lastRun p { margin: 0; }
.dsm-lastRunHead { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 10px; }
.dsm-lastRunTitle { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 500; }
/* 读数那半句：12/18 次要色、等宽数字（条数从 9 跳到 10 时不左右抖）。与标题同一行，标题说明"这是什么"，
   它说明"什么时候、多少"。 */
.dsm-lastRunFacts {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-variant-numeric: tabular-nums;
}
.dsm-lastRun[data-dsm-leftover='true'] {
  padding: 10px 12px;
  border-radius: 8px;
  border-left: 3px solid var(--dsw-alias-state-warn-primary, #d97b00);
  /* 底色不用"卡片那一层"：浅色主题里 bg-layer-2 就是对话框的白底，等于没染；这里取告警色的极淡
     一层，深浅两套主题里都是"这一块被标出来了"，不会在浅色下凭空消失。 */
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97b00) 7%, transparent);
}
.dsm-leftovers { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* 「没做到 N 条」是个小标签，不是正文：12/18、600、告警色。原来它与下面的原话同为 14px，谁主谁次看不出来。 */
.dsm-leftoversTitle {
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97b00) 55%, var(--dsw-alias-label-primary, #1f2329));
}
.dsm-leftovers .dsm-listPlain {
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0;
}
/* 一条：原话（正文色——它是内容，不该比上面那枚小标签还暗）+ 可选的 sm 动作；多条之间一道发丝线。 */
.dsm-leftoverRow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dsm-leftoverRow:first-child { padding-top: 0; }
.dsm-leftoverRow:last-child { padding-bottom: 0; }
.dsm-leftoverRow + .dsm-leftoverRow {
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
}
.dsm-leftoverRow > span { min-width: 0; flex: 1 1 auto; }
/* 那枚动作不许被挤窄：默认 flex 会把它压到内容宽度以下，五个字就折成两行（量到过 79px → 两行）。 */
.dsm-leftoverRow > button { flex: none; }

.dsm-backupRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
}
.dsm-backupRow:last-child { border-bottom: none; }
.dsm-backupMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
/* ── 会话内容视图（TranscriptDialog） ─────────────────────────────────────────
   一条事件一块，头部那行固定是"种类 + 工具名 + 时刻 + seq + 事件类型"：日志里的 seq 会跳号，
   所以它只当参照物，真正的位置由加载顺序说明（见 TranscriptDialog 的模块注释）。 */
.dsm-transcriptContent {
  display: flex; flex-direction: column; gap: 10px; min-height: 0;
  /* 正文那一档：字号**必须自己写**，理由同 .dsm-dialogBody——官方 Modal portal 到 document.body，
     弹窗落在那套 .dsm-root（14px）之外，不写就继承文档根的 16px。真实缺陷（用户截图里量出来的）：
     不写时筛选条右端那串「显示 25 / 已读 25 条」按 16px 渲染（墨迹 29–32 device px），与紧挨着
     的芯片（12px，23px）同占一行，一行里两个字号。 */
  font-size: 14px;
  line-height: 20px;
}
.dsm-transcriptFacts { display: flex; flex-direction: column; gap: 4px; }
.dsm-transcriptName { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
/* 词条是 12px 的字：行高跟着降到 18px（上面 .dsm-defs 那一档是 14px/22px，不改就量到 24px 的行距）。 */
.dsm-transcriptFactsGrid { gap: 2px 12px; font-size: 12px; line-height: 18px; }
/* 筛选与计数那一行在正文那一层里贴顶：滚动时它留在上头，轮次标题停在它下面。
   底色必须与卡片同层（bg-layer-2），否则滚过去的条目会从它背后透出来。 */
.dsm-transcriptFilters {
  position: sticky; top: 0; z-index: 2;
  background: var(--dsw-alias-bg-layer-2, #fff);
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
  padding: 6px 0;
}
/* 右端那串计数与芯片同档（12px/18px）：它是这一行的补充说明，不是正文那一档。 */
.dsm-transcriptFilters .dsm-meta { font-size: 12px; line-height: 18px; }
.dsm-chip {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  background: transparent; color: var(--dsw-alias-label-secondary, #646a73);
  border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer;
}
.dsm-chip:hover { border-color: var(--dsw-alias-brand-primary, #3370ff); }
.dsm-chipOn {
  border-color: var(--dsw-alias-brand-primary, #3370ff);
  color: var(--dsw-alias-brand-primary, #3370ff);
}
/* 列表自己不滚：滚动区是上面那一层。它以前按视口算高度（max-height: 58vh + overflow: auto），
   卡片一封顶（max-height: 100%）它就撑出卡片，被卡片的 overflow: hidden 裁掉最后一截——列表
   滚到底也没用，那一截根本画不出来。 */
.dsm-transcriptList {
  display: flex; flex-direction: column; gap: 8px;
}
/*
 * 轮次那一节：标题自己停在顶上（在正文那一层里 sticky），下面是这一轮的条目；点标题就折起来。
 *
 * 底色必须与卡片**同层**（bg-layer-2：官方 Modal 卡片的背景就是它）。用 bg-base 的话深色主题下
 * 会横出一条比卡片更黑的色带——它看着就像一块贴上去的黑条，而不是这一节的标题。
 */
.dsm-turnHead {
  /* 停在筛选那一行下面：那个偏移量由视图量出来写进 --dsm-turn-top（窄窗口里芯片会折成两行，那一行
     会变高），没有它时退到 640px 宽下量到的 37px。 */
  position: sticky; top: var(--dsm-turn-top, 37px); z-index: 1;
  display: flex; align-items: center; gap: 6px;
  list-style: none; cursor: pointer;
  padding: 4px 0;
  background: var(--dsw-alias-bg-layer-2, #fff);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 12px; line-height: 18px; font-weight: 600;
}
/* 折叠标记自己画（ChevronIcon），浏览器那个三角不要；右端那几个数是补充说明，不跟着加粗。 */
.dsm-turnHead::-webkit-details-marker { display: none; }
.dsm-turnHead .dsm-meta { font-weight: 400; }
.dsm-turnLabel { color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-turnHead .dsm-chevron { transition: transform 120ms linear; }
.dsm-turn:not([open]) .dsm-turnHead .dsm-chevron { transform: rotate(-90deg); }
.dsm-turnBody { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
.dsm-turn:not([open]) .dsm-turnBody { display: none; }
/* 折起来就整段收掉。必须显式写：dsm-turnBody 自己声明了 display: flex，作者样式压过浏览器替 details
   收内容的默认规则，于是标记转了向、内容却还摊在下面（实测：第 3 轮折着，下面照样冒出 74 / 75 步那些
   条目，看着像"不属于这一轮"）。 */

@media (prefers-reduced-motion: reduce) {
  .dsm-turnHead .dsm-chevron { transition: none; }
}
.dsm-item {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  border-left-width: 3px; border-radius: 6px; padding: 6px 8px;
  display: flex; flex-direction: column; gap: 4px;
  /* 一张事件卡里的一切都是次要那一档（12px/18px）：头行、正文、脚注（item.note）。
     头行、pre、summary 那三处各自还写着同一档字号——它们是那三类块自己的规格，这里只是兜底，
     少写这一条时脚注那行会去继承正文层的 14px（再往前是文档根的 16px）。 */
  font-size: 12px;
  line-height: 18px;
}
.dsm-item-user { border-left-color: var(--dsw-alias-brand-primary, #3370ff); }
.dsm-item-assistant { border-left-color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-item-reasoning { border-left-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2)); }
.dsm-item-tool-call, .dsm-item-tool-result { border-left-color: var(--dsw-alias-state-warn-primary, #ff8800); }
.dsm-item-system { border-left-color: var(--dsw-alias-state-success-primary, #34c724); }
.dsm-itemHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.dsm-itemKind { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-itemName { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsm-itemBody > summary { cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-pre {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-primary, #1f2329);
  max-height: 320px; overflow: auto;
}
/*
 * 窄屏（这一块自己的宽度 ≤960px）：左栏收成从左边滑出的浮层。
 *
 * 960 是量出来的门槛：再窄下去，208px 的左栏 + 列表最少 532px + 16px 间距就装不下了（表会先横向滚）。
 * 浮层与左栏是**同一份 DOM**：不渲染两套，项目选中态与筛选芯片就不会各说各话。
 */
@container (max-width: 960px) {
  .dsm-tree {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 6;
    width: 280px;
    display: flex;
    /* 关着时挪到左边界之外。display 那样切是切不出过渡的，所以换成"一直摆着、看不见"：
       visibility: hidden 让它不接点击、也不进无障碍树，滑出去 160ms 之后才真的隐藏。 */
    visibility: hidden;
    transform: translateX(-100%);
    transition: transform 160ms ease-out, visibility 0s linear 160ms;
    border-radius: 0 20px 20px 0;
    box-shadow: 10px 0 28px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 18%, transparent);
  }
  .dsm-tree.dsm-treeOpen {
    visibility: visible;
    transform: none;
    transition-delay: 0s;
  }
  /*
   * 这一档左栏自己也成了浮层：它一打开，外面那层空白就显形（z-index 比浮层低一档，浮层里的项目行
   * 与筛选芯片照旧可点）。选择器读的是浮层自己那个 dsm-treeOpen 类：状态只有一个出处，JS 里不必
   * 再同步一份"要不要接点击"。空白跟着浮层进出：滑出去的那 160ms 里它还在，免得半路上点到下面的
   * 列表。
   */
  .dsm-tree.dsm-treeOpen ~ .dsm-workbenchMain .dsm-scrim {
    visibility: visible;
    transition-delay: 0s;
  }
  .dsm-treeToggle, .dsm-treeClose { display: inline-flex; }
}
/*
 * 窄屏（这一块自己的宽度 ≤1180px）：右栏从文档流里出来、贴右边浮着；没选会话时整栏不出现。
 *
 * 1180 是量出来的门槛：再窄，208px 的左栏 + 340px 的右栏 + 两边间距之后，列表只剩不到 600px，
 * 六列就不够了（时间列会被压到 120px 以下）。宽窄是同一份 DOM，靠容器查询换位置。
 */
@container (max-width: 1180px) {
  .dsm-inspector {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 7;
    width: 340px;
    display: flex;
    /* 与左栏同一套：关着时挪到右边界之外、不可见但还在版上，滑出去之后才隐藏。 */
    visibility: hidden;
    transform: translateX(100%);
    transition: transform 160ms ease-out, visibility 0s linear 160ms;
    border-radius: 20px 0 0 20px;
    box-shadow: -10px 0 28px color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 18%, transparent);
  }
  .dsm-inspector[data-empty='false'] {
    visibility: visible;
    transform: none;
    transition-delay: 0s;
  }
  /*
   * 右栏成了浮层、而且真的摆着一条会话时，外面那层空白也显形：点它就收起（左栏这一档仍是常驻的
   * 一列，那层空白挂在主栏里，所以点左栏照旧是"只看这个项目"）。右栏在 DOM 里排在主栏之后，
   * 只能从工作台那一层问"右栏开着没有"——:has() 问的是同一个 data-empty。
   */
  .dsm-scrim {
    display: block;
    /* 空白自己不画东西，跟着浮层"晚 160ms 再消失"就够了：收起动画演完，它才让出点击。 */
    visibility: hidden;
    transition: visibility 0s linear 160ms;
  }
  .dsm-workbench:has(.dsm-inspector[data-empty='false']) .dsm-scrim {
    visibility: visible;
    transition-delay: 0s;
  }
}
/* 少动一点：这一层不想要动画时，收起与滑出都当场完成（与轮次标题那条同一个口径）。 */
@media (prefers-reduced-motion: reduce) {
  .dsm-tree,
  .dsm-inspector,
  .dsm-scrim {
    transition: none;
  }
}

`

/**
 * 注入样式表，返回卸载函数。
 *
 * 先删同 `data-plugin-css` 的旧节点：热替换时会重新 append 一份，不认领旧的就会留下幽灵样式。
 */
export function installStyles(): () => void {
  const owner = STYLE_OWNER
  const stale = document.querySelector(`style[data-plugin-css="${owner}"]`)
  if (stale !== null && stale.parentNode !== null) stale.parentNode.removeChild(stale)

  const element = document.createElement('style')
  element.dataset['plugin'] = 'dsh-session-manager'
  element.dataset['pluginCss'] = owner
  element.textContent = CSS
  document.head.appendChild(element)
  return () => {
    if (element.parentNode !== null) element.parentNode.removeChild(element)
  }
}
