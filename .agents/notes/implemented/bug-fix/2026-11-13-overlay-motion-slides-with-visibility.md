# Agent Note: 浮动面板进出用滑动，不用 display 一步切换

Status: implemented

## Problem

两层浮动面板（左栏的「项目与筛选」、右侧的「详情」）在窄屏是"说有就有、说没就没"：`display: none` 与
`display: flex` 一步切换。用户看不出它从哪一边来、往哪一边去，点开与收起都像东西突然蹦出来 /
突然消失——原话是"打开和关闭都好生硬"。

## Decision

窄屏这两层改成**一直摆在版上、靠 transform 滑动**：

- 关着时 `transform: translateX(±100%)` 加 `visibility: hidden`（不接点击、不进无障碍树），配
  `transition: transform 160ms ease-out, visibility 0s linear 160ms`——滑出去那 160ms 里它还看得见，
  滑完才真的隐藏；打开那一下把浮动面板类换掉，`transition-delay: 0s` 让它当场开始滑。
- 方向按位置来：左栏从左边滑出、右栏从右边滑出，位移正好是它自己的宽度（280px / 340px）。
- 外面那层空白陪着演完：同样用 `visibility` 的 160ms 延迟让出点击，免得收起那半截动画里点到下面的
  列表行。
- 160ms、`ease-out`：能看出来是"滑"，又不至于让每次开合都等。真实 GUI 里采样到的整段是
  -200 → -153 → -111 → -71 → -35 → -2 → 26 → 50 → 68 → 78 → 80（x，毫秒级），肉眼是一段连续的位移。
- `prefers-reduced-motion: reduce` 时 `transition: none`：滑出与收起都当场完成。

位移不会把盒子甩到页面外：这一页外面有 `.dsm-globalPage { overflow: hidden }`，滑出去的那截被裁掉，
不产生横向滚动条。

## Alternatives considered

**只做淡入淡出（opacity）。** 最省事，但这两层是从侧边出来的抽屉，用户要看的是"从哪边来"；纯淡入
淡出只是变软，方向感仍然没有。

**淡入 + 轻微缩放（scale 0.98）。** 不产生溢出，但文字在缩放过程里会糊一下，而且抽屉不该"长"出来。

**`clip-path` 擦除。** 不动布局也不溢出，可它是把内容切成一条缝慢慢展开，读起来像进度条，不是抽屉。

**更长的动画（240–320ms）。** 每次开合都要多等一截，连着挑几条会话时会烦；160ms 已经能看清整段滑动。

**留着 `display` 切换、只给背景加过渡。** display 一出现就没有过渡可言（这也正是"生硬"的来由），
这条路绕不开。

## Consequences

- 两层浮动面板在窄屏一直占着 DOM（关着时 `visibility: hidden`），点不到也读不到；宽屏完全不受影响——
  那几条规则只在容器查询那一档。
- 收起后要等 160ms 才真的隐藏，这段时间里它仍接点击。这是刻意的：动画演完之前不该把底下那块列表
  放出来。
- 由 `test/styles.test.mjs` 钉住：关着是 `visibility: hidden` 加位移到边界外、带 `transform 160ms`
  的过渡、`visibility` 延迟 160ms；打开是 `visibility: visible` 加 `transform: none`；降级块里是
  `transition: none`。
- 真实 dev GUI 里量过：开左栏 x 从 -200 滑到 80（80ms 时 -2、146ms 时 78），关左栏滑回 -200、
  160ms 后隐藏；右栏从 876 滑到 536；`prefers-reduced-motion` 下第一帧就已经在位。
