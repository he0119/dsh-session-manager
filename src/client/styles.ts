/**
 * 这一页的样式，按 effect 生命周期注入 `<style>`。
 *
 * 颜色只用宿主 `Theme` 检查面列出的那十几个 token（`--dsw-alias-*`），每个都带一个中性的回落值，
 * 深浅主题自动跟随。唯一的例外是 `.dsm-primary` 的字色：那个位置宿主的检查面没给 token，
 * 于是显式写了回落链（见该处注释）——**主题色不能拿"另一个主题下的观感"去估**，深色主题里的
 * `brand-primary` 是近白色，所以填充按钮上写死白字就是白底白字。
 *
 * 不用任何宿主原语包的类名：那些是打包器哈希出来的私有产物，抄不到也不该抄。
 *
 * 排版分两层，都是**照着设置外壳自己的页量出来的**（不是估的）：
 *
 * - **页头**照内建设置页（如「内置插件」）的节奏：`h2` 18px/600 的标题独占一行，下面 12px 跟一行
 *   13px 的说明（用 `label-tertiary`——内建页那一行的计算色就是它解析出来的 `#81858c`），再往下
 *   才是内容。上游那套页头是 `@deepseek-ai/dsh-client-ui-settings-general` 的原语渲染的（类名
 *   是 `pbvGtq_` 这种打包哈希），本插件刻意不 require 它，所以规格只能这样抄过来。
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
.dsm-root {
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 13px;
  line-height: 20px;
}
.dsm-head { display: flex; flex-direction: column; gap: 12px; }
.dsm-titleRow { display: flex; align-items: baseline; gap: 12px; }
.dsm-title { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.2; }
.dsm-intro {
  margin: 0;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #646a73));
}
.dsm-spacer { flex: 1 1 auto; }
.dsm-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dsm-cardHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-cardTitle { font-weight: 600; }
.dsm-hint { color: var(--dsw-alias-label-secondary, #646a73); }
/*
 * 说明页：词条（dt 词 / dd 解释）与问答共用一个两列网格。词比解释重一档，解释用次要灰；
 * 词条列不折行（"子代理""未分组"最多四个字），解释列吃掉剩下的宽度。
 */
.dsm-defs {
  display: grid;
  grid-template-columns: minmax(0, auto) minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.dsm-defs dt { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 600; white-space: nowrap; }
.dsm-defs dd { margin: 0; color: var(--dsw-alias-label-secondary, #646a73); }
/* 问答的"问"是一整句话，不能按 nowrap 排——它会顶穿词条列。 */
.dsm-defsFaq dt { white-space: normal; }
/* 说明页里那段"会碰什么盘"是并列的几条，用项目符号而不是词条。 */
.dsm-bullets { margin: 0; padding-left: 18px; color: var(--dsw-alias-label-secondary, #646a73); font-size: 13px; line-height: 1.6; }
.dsm-bullets li + li { margin-top: 4px; }
/* 路径这类机器可读的字串：等宽 + 次要灰，避免与正文混成一句。 */
.dsm-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.dsm-button {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 10px;
  font: inherit;
  cursor: pointer;
}
.dsm-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #3370ff); }
.dsm-button:disabled { opacity: 0.5; cursor: default; }
.dsm-button.dsm-primary {
  background: var(--dsw-alias-brand-primary, #3370ff);
  border-color: var(--dsw-alias-brand-primary, #3370ff);
  /*
   * 字色**不能写死白**：brand-primary 在深色主题里是 #f9fafb 那种近白（它是"表面的反色"，
   * 不是为了当填充色才存在），写死 #fff 就是白底白字——按钮整个读不出来。宿主内置按钮用的是
   * label-primary-foreground（浅色主题 #fff、深色主题 #0f1115），但它不在 Theme 检查面的
   * 那 14 个 token 里，所以这里挂了回落链：拿不到就退到 bg-layer-1——brand-primary 在明暗
   * 两套里都是表面的反色，拿**表面色**当字色一定读得出来。
   */
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1, #fff));
}
.dsm-button.dsm-primary:hover:not(:disabled) {
  /* 往表面色混一点点：深色主题里变暗、浅色主题里变亮，两边都像"被按了一下"。 */
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #3370ff) 88%, var(--dsw-alias-bg-layer-1, #fff));
}
/*
 * 一条列表里的两级：**工作区**是组头，**会话**是组头下面缩进的那些行。
 * 区分手段叠了四层，任意一套主题、任意一种色觉下都读得出上下级：
 *   ① 底色——组头是一条实心横幅，会话行是卡片底色；
 *   ② 缩进 + 竖向导引线——会话行整行往里缩，并沿左缘挂一条线（"这几行属于上面那个组头"）；
 *   ③ 字号——组头 14px/600，会话行跟着页面的 13px/400；
 *   ④ 图形——组头是文件夹，会话行是对话气泡（见 [icons.tsx](./icons.tsx)）。
 * 为什么不靠"更深一点的底色"单独扛：浅色主题里 bg-layer-1/2/3 全是同一个白（见下面 .dsm-row:hover
 * 的注释），能用的只有"字色兑出来的薄雾"，而它对屏幕、亮度、色觉都敏感——层次不能只挂在它身上。
 */
.dsm-group { display: block; }
.dsm-group:first-child .dsm-groupHead { border-top: none; }
/*
 * 组头是一条"带底色、随列表滚动粘住"的横幅：底色用字色薄雾兑在**卡片表面色**上，于是它既是不透明
 * 的（粘住时底下的行不会透出来），又在明暗两套主题里都是"比卡片略深/略浅一层"的区分色。
 * 前一条声明是给不认 color-mix 的浏览器留的退路：没有底色也还读得出来，只是少了横向的分组感。
 *
 * 12% 而不是更淡：组头的底色要一眼看出是"另一个层级"，不是"某一行被选中了"。
 */
.dsm-groupHead {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  /*
   * 一条组头永远只占一行：nowrap + 让路径（flex-basis: 0，见下面 .dsm-groupPath）先让位。
   * 反面教材是本次改之前的写法：wrap + 路径用内容宽度参与折行计算，于是路径一长，右手的两个
   * 计数就被挤到第二行——组头长成两行、数字跑到左边，看着像坏了（532px 宽的列表里真实发生过）。
   * 换行是**最后**的手段，截断才是。
   */
  flex-wrap: nowrap;
  /* 左边只留 4px：最前面那个折叠开关自己就是"这一组的左缘"，留 10px 会让它离边框太远。 */
  padding: 8px 10px 8px 4px;
  /* 组头自己不是点整组的地方（那一块是里面的 .dsm-groupPick），鼠标形状跟着那个 label 走。 */
  cursor: default;
  background: var(--dsw-alias-bg-layer-1, transparent);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 12%, var(--dsw-alias-bg-layer-1, #fff));
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
}
/*
 * 组头里"点一下就是整组勾选／取消"的那一块：勾选框、标记、名字、路径、右侧那两串数字。
 *
 * 它独占组头除折叠按钮以外的全部宽度（点击面因此仍是整行），路径的让位规则也在这个 flex 行里生效。
 */
.dsm-groupPick {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
/*
 * 组头右端的折叠开关：一个 20px 的方形按钮（够得着、能聚焦），图形是 12px 的尖角。
 * 收起时把尖角转成朝右——图形只有一份，状态由 aria-expanded 表达（读屏与视觉同一个来源）。
 */
.dsm-groupToggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #646a73);
  cursor: pointer;
}
.dsm-groupToggle:hover { background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06)); }
.dsm-groupToggle[aria-expanded='false'] .dsm-chevron { transform: rotate(-90deg); }
.dsm-chevron { display: block; }
/*
 * 分组列表的工具栏（"按目录分组" ＋ 全部收起 / 全部展开）：自己占一行、靠左排。
 * 靠左是刻意的：挂到右边缘的东西会随容器宽度动，而卡片宽度会被外层滚动条一进一出改掉 15px。
 */
.dsm-groupTools { display: flex; align-items: center; gap: 6px; }
/*
 * 组头里的名字：它就是这一行的主角，不折行；实在挤不下时截断（截断了还有悬浮提示补全）。
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
/*
 * 组头里的路径：等宽 + 次要色。它是机器字符串，人写的会话标题是句子——字体不同，两者就不会被
 * 当成同一类东西（尤其那个目录名与会话标题重名的时候）。
 *
 * flex: 1 1 0（基准宽度 0）是这一行不折行的关键：它不参与折行/撑宽的计算，多出来的地方
 * 由它独占（界面宽时它显示全，窄时它先截断）。右边那两串数字因此永远待在原地。
 */
.dsm-groupPath {
  flex: 1 1 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #646a73);
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
/* 组头上的标签（"未登记目录"）也是不可压的：它的字不能折行，压窄了就会溢出自己的框。 */
.dsm-groupPick > .dsm-tag { flex: none; }
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
 * 子代理行：缩进到父会话的下一级（列表里的父子关系与删除 / 迁移的级联展开是同一棵树，见
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
  /* 常驻一条滚动条槽位：装了占位滚动条的环境里，溢出与否都不再改行宽（否则行里右对齐的列会左右跳）。 */
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
/*
 * 「会话」页那一行曾经多一列（"这条属于哪个工作区"）：那一页现在也按目录分组了，归属进了组头，
 * 行因此回到与导出列表同一个五列模板——那个类只剩"这是管理页的行"这个标记作用（测试拿它当选择器）。
 */
/* 删除预演里那一行没有勾选框（预演结果不是勾选面），于是少一列，且它不可点。 */
.dsm-rowDelete {
  grid-template-columns: 16px minmax(120px, 1.4fr) auto auto;
  cursor: default;
}
/*
 * 删除预演清单里"随父会话删"的那些：也缩进一级，让"哪几条是点名的父会话带进来的"不用读标签就看得出
 * （宿主给的顺序已经是"点名的在前、随后是各自的后代"，见 family.ts 的 familyOf）。
 *
 * 这一份清单不按目录分组，所以基准是行自己的 10px 内边距而不是上面那 48px；导引线画在父行内容左缘
 * （10px），子行再往里让一格（24px）。
 */
.dsm-rowDelete.dsm-rowNest1 {
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
.dsm-rowDelete.dsm-rowNest2 { padding-left: 58px; }
.dsm-rowDelete.dsm-rowNest3 { padding-left: 82px; }
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
.dsm-empty { padding: 14px; color: var(--dsw-alias-label-secondary, #646a73); }
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
/* 目录下拉：撑满一行（旁边留给「浏览…」按钮），长路径由浏览器自己省略，别把布局顶宽。 */
.dsm-selectPath { flex: 1 1 22rem; min-width: 0; }
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
.dsm-table { width: 100%; border-collapse: collapse; }
.dsm-table th, .dsm-table td {
  text-align: left;
  padding: 5px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  vertical-align: top;
}
.dsm-table th { color: var(--dsw-alias-label-secondary, #646a73); font-weight: 500; }
/* 导入预演那张表的列宽**写死**（fixed 布局）：会话那一列吃掉剩余宽度，其余按内容量好。
   自动布局碰上长路径会算出一个很怪的比例——动作列被挤成两个字宽（「动作」自己都折行），
   会话列每行只剩十来个字符。列宽是设计，不该由内容的字数决定。
   单元格要 border-box：默认 content-box 下 padding: 5px 8px 会**加到**列宽上，
   声明 72px 实占 88px——那 16px 是从"吃掉剩余宽度"的会话列身上扣的。实测修之前：
   表宽 534px → 动作 88 / 会话 155 / cwd 187 / 大小 104，单行高 271px（会话列里 id 折 3 行、
   冲突原因折 8 行），20 行就是 5400px 的表。 */
.dsm-planTable { table-layout: fixed; }
.dsm-planTable th, .dsm-planTable td { box-sizing: border-box; }
.dsm-planTable .dsm-colAction { width: 60px; }
/* 同步预演那两张表（拉 / 推）的动作列装的是「重推刷新」这种动词短语，比导入预演的两个字长一档，
   所以这两张表自己量一个列宽：实测 12px 字号下最宽的一个是 en 'Re-push' 63px、zh「重推刷新」62px，
   加单元格左右各 8px padding 是 79px，再留约 9px 余量。列宽仍然是**设计**（fixed 布局），只是这
   张表的设计跟着它自己的内容走；会话那一列照旧吃掉剩下的宽度（列宽从 60 → 88px，那一列少 28px）。
   真实事故（用户截图报的）：这一列还是 60px 时，标签「本机有、远端没有」实测 110px（en 那句
   158px），顶出格子 114px、压住后面那一列 98px —— 标签是 nowrap 的，装不下就直接画在邻居身上。 */
.dsm-syncPlanTable .dsm-colAction { width: 88px; }
/* 兜底：预演表的标签再长也不许顶出格子。列宽是设计，标签的长短是文案——两者对不上时宁可让这一格
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
.dsm-planTable .dsm-colCwd { width: 26%; }
.dsm-planTable .dsm-colBytes { width: 68px; }
/* cwd 那一格里的路径要能断行（fixed 布局下列宽不会再变），否则长路径顶出格子。 */
.dsm-cwd { color: var(--dsw-alias-label-secondary, #646a73); overflow-wrap: anywhere; }
/* 标签是个小块：挤在窄列里也不能折成两行（导入预演表的动作列里曾经折成「跳/过」）。 */
.dsm-tag { border-radius: 6px; padding: 0 6px; font-size: 12px; white-space: nowrap; }
/* state 色是指示色，不是文字色：它在浅色主题里淡到读不出来。实测（浏览器里量的，两套主题都量了）
   state-idle-primary = #d4d4d4，白底 1.48:1；深色 #545557 在 #232324 上 2.1:1。
   state-warn-primary = #f59e0b，白底 2.15:1。所以文字一律走 label 色（浅 5.8:1 / 深 10.4:1），
   state 色只留在边框和一层淡填充上——绿色「新建」、灰色「跳过」还是那个颜色，字却是读得出来的。 */
.dsm-tagCreate {
  color: var(--dsw-alias-label-primary, #1f2329);
  border: 1px solid var(--dsw-alias-state-success-primary, #2ea121);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea121) 14%, transparent);
}
/* 中性标签：导入预演里的 skip、导出列表里"不是已登记工作区"的目录，都只是"没什么动作"。 */
.dsm-tagIdle, .dsm-tagSkip {
  color: var(--dsw-alias-label-secondary, #646a73);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12));
}
/* state 色非当文字色不可的时候，先和 label-primary 兑一下：亮色主题往深里走、深色主题往浅里走，
   同一条声明在两套主题里各自走向可读的一侧（浅色主题实测 warn 5.57:1 / error 9.75:1 / ok 5.82:1）。 */
.dsm-error { color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d83931) 55%, var(--dsw-alias-label-primary, #1f2329)); }
.dsm-warn { color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97b00) 55%, var(--dsw-alias-label-primary, #1f2329)); }
.dsm-ok { color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #2ea121) 55%, var(--dsw-alias-label-primary, #1f2329)); }
.dsm-banner {
  border: 1px solid currentColor;
  border-radius: 8px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 页内分页：贴着卡片区的下划线式页签，和设置外壳自己的 tab 视觉区分开 */
.dsm-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsm-tab {
  appearance: none;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #646a73);
  font: inherit;
  cursor: pointer;
  padding: 6px 10px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.dsm-tab:hover { color: var(--dsw-alias-label-primary, #1f2329); }
.dsm-tab[aria-selected='true'] {
  color: var(--dsw-alias-label-primary, #1f2329);
  border-bottom-color: var(--dsw-alias-brand-primary, #3370ff);
  font-weight: 600;
}
.dsm-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: -2px; }
.dsm-fields { display: flex; flex-direction: column; gap: 8px; }
.dsm-field { display: flex; flex-direction: column; gap: 4px; }
.dsm-fieldLabel { color: var(--dsw-alias-label-secondary, #646a73); }
.dsm-input {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 5px 8px;
  font: inherit;
  width: 100%;
  box-sizing: border-box;
}
.dsm-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3370ff); outline-offset: -1px; }
/* 路径映射：一行一条，左右各一个输入框、右边一个删除；窄屏时整行换行而不是把输入框压扁。 */
.dsm-mapRows { display: flex; flex-direction: column; gap: 6px; }
.dsm-mapRow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsm-mapRow > .dsm-input { flex: 1 1 12rem; min-width: 0; }
.dsm-mapArrow { color: var(--dsw-alias-label-secondary, #646a73); }
/* 同步设置表单：字段一列排开，配对的两个字段并排一行（窄屏自动换行）。 */
.dsm-syncForm { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 2px; }
.dsm-syncRow { display: flex; gap: 12px; flex-wrap: wrap; }
.dsm-syncRow > .dsm-field { flex: 1 1 16rem; min-width: 0; }
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
/* 搜索框：与 .dsm-select / .dsm-file 同一套皮（边框、底色、圆角都走 token）。 */
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
.dsm-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.dsm-result {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08));
  padding-top: 8px;
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
.dsm-backupRow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
}
.dsm-backupRow:last-child { border-bottom: none; }
.dsm-backupMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
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
