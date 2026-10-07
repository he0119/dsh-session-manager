// test/styles.test.mjs — 样式表的五条硬约束（读源码，不看产物）。
//
// 为什么值得为它单开一个文件：颜色写错**只会在一种主题下错**，而开发者通常只盯着自己那一种。
// 真实事故（用户截图报的）：`.dsm-primary` 写死 `color: #fff`，浅色主题下白字配深色填充没毛病，
// 深色主题下 `brand-primary` 本身就是 #f9fafb 那种近白——白底白字，填充按钮整个读不出来
// （对比度 1.05:1）。类型系统、产物冒烟、真实 profile 的 HTTP 核对**全都抓不到**这种错，
// 只有"肉眼看着不对"能抓到。所以这里把能机械核对的部分固化下来：
//
//   1) 声明里的颜色必须走 token：不许出现 `color: #fff` / `background: rgba(...)` 这类字面量。
//      token 自带明暗两套值，字面量最多对上其中一套（上面那条事故就是这么来的）。
//      字面量只允许出现在 `var(--token, 回落)` 的**回落位**上。
//   2) 用到的 token 必须在宿主 `Theme` 检查面给出的名单里。检查面之外的 token 是内部实现，
//      改名/换值不通知插件；硬用就得在注释里写明理由，并登记进下面的例外表。
//   3) 每个 `var(--dsw-alias-*)` 都要带回落值：宿主主题不提供这个 token 时（旧版本、别的
//      profile）界面还能照常显示，而不是整条声明作废。
//   4) 标签（`.dsm-tag`）不许折行。真实事故（用户截图报的）：导入预演表的动作列里，
//      标签是可以按字折行的，于是自动布局把它压到一列只有一个汉字宽——「跳过」竖成两行、
//      表头「动作」也折了，整张表看着错位。标签是个小块，不该被当成一句话来排版。
//   5) `state-*` 色不许裸当文字色。真实事故（用 agent-browser 打开真实设置页量出来的）：
//      `.dsm-tagSkip` 拿 `state-idle-primary` 当字色，白底 1.48:1、深色 2.1:1；`.dsm-warn`
//      拿 `state-warn-primary` 当字色，白底 2.15:1。state 色是指示色，"看不见"是它的正常值域。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/**
 * `src/client/styles.ts` 里那份样式表正文。
 *
 * 取的是**第一个**反引号到下一个行首反引号之间的内容：CSS 里不许出现反引号（模板字面量里
 * 一个反引号就会把字符串提前截断，而 tsc 的报错会落在很远的地方，不好认）。
 */
function readCss() {
  const source = readFileSync(join(root, 'src', 'client', 'styles.ts'), 'utf8')
  const marker = 'export const CSS = `'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, '找不到 CSS 模板字面量')
  const from = start + marker.length
  const end = source.indexOf('\n`\n', from)
  assert.notEqual(end, -1, 'CSS 模板字面量没有正常收尾（注释里混进了反引号？）')
  const css = source.slice(from, end)
  assert.ok(css.length > 2000, '取出来的 CSS 太短，模板字面量可能被提前截断了')
  // 报错时要给**文件里的**行号，不是样式表正文里的行号：差一个"模板字面量从第几行开始"。
  cssLineOffset = source.slice(0, start).split('\n').length
  return css
}

/** 样式表正文第 1 行在 `styles.ts` 里的行号（`readCss()` 顺手算出来的）。 */
let cssLineOffset = 0

const css = readCss()

/**
 * 宿主 `Theme` 检查面列出的可用 token（`cordis_inspect_query` → client / Theme / listTokens）。
 * 这份名单就是插件与主题之间的契约：名单外的一律算内部实现。
 */
const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])

/**
 * 登记在案的例外：检查面没给、但确实需要的那些，且**必须带回落链**。
 *
 * - `--dsw-alias-label-primary-foreground` 是宿主填充按钮自己的前景色（浅色主题 #fff、深色主题
 *   #0f1115），也就是"填充按钮上该用什么字色"的唯一正解；检查面没有它，于是 `.dsm-primary`
 *   写成 `var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1, #fff))`：
 *   拿不到就退到表面色——`brand-primary` 在明暗两套里都是表面的反色，拿表面色当字色读得出来。
 * - `--dsw-alias-label-tertiary`（浅色主题 #81858c）是**内建设置页说明行的本色**。在真实设置页里
 *   量过：「内置插件」那一页的 `p` 说明行计算色正是 rgb(129,133,140)，也就是这个 token 在本页作用域
 *   里的解析值；字号/布局都对上了，颜色差一档就会看出"这页和别的页不是一套"。检查面只列到
 *   `label-secondary`（#61666b，比它深一档），所以要登记。回落退到 `label-secondary`：仍是次要
 *   文字色，只是稍深一点，缺 token 的老版本上不会读不出来。
 */
const REGISTERED_EXCEPTIONS = new Set([
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-tertiary',
])

/** 把 `var(...)` 整段挖掉，剩下的才是"没走 token"的字面量。嵌套的 var 多跑几轮就挖干净了。 */
function withoutVar(cssText) {
  let text = cssText
  for (let round = 0; round < 6; round += 1) {
    const next = text.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, 'var')
    if (next === text) break
    text = next
  }
  return text
}

/**
 * 逐条抽出 `属性: 值;` 声明。
 *
 * 早先这版只认"一行一条"的写法（`^\s*属性: 值;$`），于是**单行规则整条漏检**——
 * `.dsm-warn { color: var(--…); }` 那种写法根本进不了检查。真实事故正好长这样：
 * `.dsm-tagIdle, .dsm-tagSkip { color: var(--dsw-alias-state-idle-primary, …); … }` 是一整行，
 * 对比度 1.48:1，而检查全绿。现在按花括号扫：值里不含 `;`/`{`/`}`，所以选择器（`…:hover {`）不会
 * 被当成声明，单行和多行写法都能捞到。注释先挖成等长空白，免得注释里的 `1.48:1` 被当声明。
 */
function declarations(cssText) {
  const blank = cssText.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
  const out = []
  const pattern = /([a-z-]+)\s*:\s*([^;{}]+);/g
  let match
  while ((match = pattern.exec(blank)) !== null) {
    out.push({
      property: match[1],
      value: match[2].trim(),
      line: cssLineOffset + blank.slice(0, match.index).split('\n').length - 1,
    })
  }
  return out
}

const COLOR_PROPERTIES = new Set([
  'color',
  'background',
  'background-color',
  'border',
  'border-color',
  'border-bottom-color',
  'outline',
  'outline-color',
])

test('样式表里的颜色都得走 token，不许写字面量', () => {
  const offenders = []
  for (const { property, value, line } of declarations(css)) {
    if (!COLOR_PROPERTIES.has(property)) continue
    // 只允许 `color-mix(...)` 里出现 token 之外的成分，且它自己也得靠 token 兑出来。
    const probe = withoutVar(value)
    const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(probe)
    if (literal !== null) offenders.push(`第 ${line} 行 ${property}: ${value}`)
  }
  assert.deepEqual(offenders, [], '颜色字面量只允许写在 var(--token, 回落) 的回落位里')
})

test('用到的 token 必须在 Theme 检查面的名单里（例外要登记）', () => {
  const used = new Set(css.match(/--dsw-alias-[a-z0-9-]+/g) ?? [])
  const unknown = [...used].filter((token) => !THEME_TOKENS.has(token) && !REGISTERED_EXCEPTIONS.has(token))
  assert.deepEqual(unknown, [], '检查面之外的 token 是内部实现，要用就得登记并写明理由')
})

test('每个 token 都带回落值，主题缺这个 token 时声明不会整条作废', () => {
  // 带回落值的写法是 `var(--token, …)`，所以这个正则只捞得到"光秃秃"的那些。
  const missing = css.match(/var\(--dsw-alias-[a-z0-9-]+\)/g) ?? []
  assert.deepEqual(missing, [], 'var(--token) 少了回落值')
})

/** 取某个选择器的规则块正文（这份样式表的选择器都顶格写在行首）。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match === null ? null : match[1]
}

test('标签不许折行：它是小块，不是一句话', () => {
  const body = ruleBody('.dsm-tag')
  assert.notEqual(body, null, '找不到 .dsm-tag 规则')
  assert.match(body, /white-space:\s*nowrap/, '窄列里标签会竖成两行（「跳/过」），必须 nowrap')
})

test('组头里的标签与名字一样高：行高压到 18px（12px 的字 + 2px 边框 = 名字那一行 20px）', () => {
  // 为什么钉它：标签默认行高 20px，加上下各 1px 边框就是 22px，于是挂了标签的组头比没挂的高 2px
  // （真实 dev GUI 里量到 39 vs 38px），同一列组头的下沿参差。列表与弹窗两处选择器不同、值同一个。
  for (const selector of ['.dsm-groupPick > .dsm-tag', '.dsm-planGroupHead .dsm-tag']) {
    const body = ruleBody(selector)
    assert.notEqual(body, null, `找不到 ${selector} 规则`)
    assert.match(body, /line-height:\s*18px/, `${selector} 的行高要与名字那一行（20px）对得上`)
  }
})

test('预演表的动作列：同步那张表自己量列宽，标签再长也不许顶到下一列', () => {
  // 真实事故（用户截图报的）：同步预演的动作列沿用了导入预演那 60px（单元格左右各 8px padding，
  // 内容只有 44px），而它装的是「本机有、远端没有」这种动词短语——浏览器里实测 110px，en 那句
  // 158px，nowrap 顶出格子 114px、压住后面那一列的会话名 98px。修法两半：这张表自己量列宽，
  // 再加一条"顶不出去"的兜底。
  const syncRule = ruleBody('.dsm-syncPlanTable .dsm-colAction')
  assert.notEqual(syncRule, null, '同步预演的动作列要单独声明列宽')
  const width = Number(/width:\s*([\d.]+)px/.exec(syncRule ?? '')?.[1])
  // 浏览器里量到最长的那颗标签 63px（en 'Re-push'）；加上单元格左右 8px padding 是 79px。
  assert.ok(width >= 79, `动作列声明了 ${width}px，装不下最长的标签（要 ≥79px）`)
  const tag = ruleBody('.dsm-planTable .dsm-tag')
  assert.notEqual(tag, null, '预演表的标签要有兜底规则')
  assert.match(tag ?? '', /max-width:\s*100%/, '标签要限宽，否则顶出格子压住邻居')
  assert.match(tag ?? '', /overflow:\s*hidden/, '限了宽还要截断，不然文字照旧画在格子外面')

  // 「这次不动」那张表的状态列装的是「两边各自写过」这种短语，比动词长一档：真机（dev GUI）量到最宽
  // 的一颗是 en "Remote ahead" 94.7px（zh「两边各自写过」86px），加单元格左右 8px padding 是 110.7px。
  const keptRule = ruleBody('.dsm-keptTable .dsm-colAction')
  assert.notEqual(keptRule, null, '「这次不动」那张表的状态列要单独声明列宽')
  const keptWidth = Number(/width:\s*([\d.]+)px/.exec(keptRule ?? '')?.[1])
  assert.ok(keptWidth >= 111, `状态列声明了 ${keptWidth}px，装不下最长的那颗标签（要 ≥111px）`)
})

test('组头只摆名字：右端那两串数字靠自己的 margin-left 贴住右缘', () => {
  // 组头原来靠一段 `flex: 1 1 0` 的等宽路径（曾经是 .dsm-groupPath）把计数块挤到右缘；那一格撤掉之后
  // （身份与本机路径进了名字的悬浮提示），让位改由计数块自己承担。少了 margin-left: auto，数字会紧贴
  // 名字，而"这组几条 / 选中几条"在每个组头里离右缘多远就取决于名字有多长——同一个列表里数字对不齐。
  // 这里没有渲染器，读的是声明本身。
  const counts = ruleBody('.dsm-groupCounts')
  assert.notEqual(counts, null, '找不到 .dsm-groupCounts 规则')
  assert.match(counts, /margin-left:\s*auto/, '计数块自己贴右缘（组头里已经没有可让位的元素了）')
  assert.match(counts, /flex:\s*none/, '计数块不压缩：窄屏下先被压扁的该是名字，不是数字')
})

test('计划表的项目组头：一条横幅，横排的是内层那一行', () => {
  // 同步预演按项目分组之后，组头是表里跨列的一行（`.dsm-planTable .dsm-planGroupHead`）。
  // 它得自己声明两件事，否则会被 `.dsm-table th` 压回去：
  //   - 字色：那一条把 th 一律写成次要色，而组头的名字是这一段的标题（与列表那边的组头同色）；
  //   - 底色：浅色主题里 bg-layer 那几档是同一个白，层次只能靠"字色兑出来的一层"（同 .dsm-groupHead）。
  const head = ruleBody('.dsm-planTable .dsm-planGroupHead')
  assert.notEqual(head, null, '找不到计划表组头的规则')
  assert.match(head ?? '', /color:\s*var\(--dsw-alias-label-primary/, '组头标题走主文字色')
  assert.match(head ?? '', /color-mix\(/, '底色用字色兑出来的一层——bg-layer 那几档在浅色主题里是同一个白')
  assert.match(head ?? '', /border-bottom:\s*1px solid var\(--dsw-alias-border-l2/, '下边框把组头与它那几行分开')
  // 横排的是**内层**：给 th 自己换 display 会让浏览器补一个匿名单元格，fixed 布局的列宽跟着走形。
  const inner = ruleBody('.dsm-planTable .dsm-planGroupInner')
  assert.notEqual(inner, null, '找不到组头内层那一行的规则')
  assert.match(inner ?? '', /display:\s*flex/, '图形、标题、路径、条数要横着排')
  // 第三列（远端机器）沿用原来那一列 26% 的宽度：分组之后它只放机器名，多出来的归会话列。
  assert.notEqual(ruleBody('.dsm-planTable .dsm-colMachine'), null, '「这次不动」的机器列要声明列宽')
})

test('计划弹窗的三段段头：13px/600 的主文字色 + 一颗 12px 的中性药丸，不再与正文同一档', () => {
  // 真实缺陷（用户报的"和其他内容区分并不明显"）：三个段头原来是 `.dsm-hint`（13px/400 次要色，
  // dev GUI 里量到 rgb(97, 102, 107)），与紧挨着的"跳过 N 条空白会话…"一字不差——三张表之间因此
  // 没有可见的分界。修法是把那一行变成段头（`h3` + `.dsm-planHead`），所以这里钉住"它不再是正文
  // 那一档"：字号仍是 13px，靠 600 的字重与 label-primary 分开。
  const head = ruleBody('.dsm-planHead')
  assert.notEqual(head, null, '找不到 .dsm-planHead 规则')
  assert.match(head ?? '', /font-weight:\s*600/, '段头要比正文重一档（正文是 400）')
  assert.match(head ?? '', /color:\s*var\(--dsw-alias-label-primary/, '段头走主文字色（正文说明句是次要色）')
  assert.match(head ?? '', /font-size:\s*13px/, '字号仍是正文那一档：段头靠字重与颜色分开，不靠变大')
  assert.match(head ?? '', /display:\s*flex/, '标题与条数药丸横着排')
  // 外边距只给上面 16px：这几段在普通块流里（不是 flex 子项），相邻外边距照常折叠，量到的是"离上一段
  // 16px、离下面那张表 0px"。标题贴住它自己那张表、与上一段分开，靠的就是这个差；两边一样大时标题
  // 看起来像上一段的尾巴。
  assert.match(head ?? '', /margin:\s*16px\s+0\s+0/, '段头贴住下面那张表，与上一段拉开')
  const pill = ruleBody('.dsm-planHead .dsm-tag')
  assert.notEqual(pill, null, '段头里的条数药丸要单独声明')
  assert.match(pill ?? '', /font-weight:\s*400/, '药丸里的条数是数据，不跟着段头一起加粗')
  assert.match(pill ?? '', /line-height:\s*18px/, '药丸行高与组头、列表里的标签同一条，不把段头顶高')
})

test('state 色不许裸当文字色：它是指示色，浅色主题下淡到读不出来', () => {
  // 真实事故（浏览器里量的，明暗两套都量了）：`.dsm-tagSkip` 拿 `state-idle-primary` 当字色，
  // 浅色主题 #d4d4d4 在白底上 1.48:1、深色 #545557 在 #232324 上 2.1:1；`.dsm-warn` 拿
  // `state-warn-primary` 当字色，浅色主题白底 2.15:1。都是"白底白字"那个家族的事故：
  // 字还在 DOM 里、还能被读屏读出来，只是人看不见——类型检查、产物冒烟、HTTP 核对全抓不到。
  //
  // state 色是**指示色**（点、边框、淡填充），色值本身就没按文字对比度选。宿主的警告块也是这个
  // 分工：`state-warn-tertiary` 当底、`state-warn-label` 当字、`state-warn-primary` 当边。
  // 检查面只给了 primary 那一档，所以字要自己兑：`color-mix(... 55%, label-primary)`，
  // 亮色主题往深里走、深色主题往浅里走，一条声明在两套主题里各自走向可读的一侧。
  const offenders = []
  for (const { property, value, line } of declarations(css)) {
    if (property !== 'color') continue
    if (!value.includes('--dsw-alias-state-')) continue
    if (value.includes('color-mix(')) continue
    offenders.push(`第 ${line} 行 ${property}: ${value}`)
  }
  assert.deepEqual(offenders, [], 'state 色要当文字色，得先用 color-mix 和 label-primary 兑过')
})

test('页头照内建设置页的规格：16px/500 的 h2 标题 + 隔 12px 一行 14px 的说明行', () => {
  // 为什么钉它：这一页的页头是**手写**的（官方设置页也是手写 h2 + p，没有现成原语可复用），
  // 规格只能照量出来的数字抄。抄错的后果就是真实事故里那种"看着不对但没人说得清哪不对"——
  // 抄错参照页也会：18px/600 那一档量的是「插件」**整页**的标题，而本页是设置外壳里的一个区块，
  // 相邻的「模型」「内置插件」「Agent 预设」三个区块的标题都是 16px/500、说明行 14px/22px。
  const head = ruleBody('.dsm-head')
  assert.notEqual(head, null, '找不到 .dsm-head 规则')
  assert.match(head, /flex-direction:\s*column/, '标题与说明要上下排（内建页就是列布局），不该挤成一行')
  assert.match(head, /gap:\s*12px/, '标题与说明之间是 12px，与内建页的节奏一致')

  const title = ruleBody('.dsm-title')
  assert.notEqual(title, null, '找不到 .dsm-title 规则')
  assert.match(title, /font-size:\s*16px/, '区块标题是 16px（与「模型」「内置插件」那几页同规格）')
  assert.match(title, /font-weight:\s*500/)
  assert.match(title, /line-height:\s*24px/, '标题行高 24px——量出来的就是它，不是按字号算的比例')

  const intro = ruleBody('.dsm-intro')
  assert.notEqual(intro, null, '找不到 .dsm-intro 规则')
  assert.match(intro, /font-size:\s*14px/, '说明行 14px（内建页的说明行就是这一档）')
  assert.match(intro, /--dsw-alias-label-tertiary/, '说明行用 label-tertiary，与内建页的说明行同色')
})

test('组内行的缩进由组头那几个尺寸推出来：组头的勾选框恒在行勾选框左边 16px', () => {
  // 为什么钉它：折叠开关从组头右端挪到**最前**之后，组头的内容整体右移了一个开关的宽度，组内那些行
  // 的缩进必须跟着加同样多。少加了会怎样：组头的勾选框跑到组内行的**右边**去，"这些行挂在这个组头
  // 下面"当场读反（这条是量出来的：改回 26px 时组头勾选框 x=504、行勾选框 x=498）。
  // 几何值本身是量着调的，所以这里钉的不是某一个 px 数，而是**它们之间的关系**。
  const head = ruleBody('.dsm-groupHead')
  const toggle = ruleBody('.dsm-groupToggle')
  const row = ruleBody('.dsm-group > .dsm-row')
  assert.notEqual(head, null, '找不到 .dsm-groupHead 规则')
  assert.notEqual(toggle, null, '找不到 .dsm-groupToggle 规则')
  assert.notEqual(row, null, '找不到 .dsm-group > .dsm-row 规则')

  const px = (body, pattern, what) => {
    const match = pattern.exec(body)
    assert.notEqual(match, null, `读不到${what}`)
    return Number(match[1])
  }
  // 四值 padding 的第四个是左边（上 右 下 左）
  const padLeft = px(head, /padding:\s*[\d.]+px\s+[\d.]+px\s+[\d.]+px\s+([\d.]+)px/, '组头的左内边距')
  const gap = px(head, /gap:\s*([\d.]+)px/, '组头的间距')
  const toggleWidth = px(toggle, /width:\s*([\d.]+)px/, '折叠开关的宽度')
  const rowPad = px(row, /padding-left:\s*([\d.]+)px/, '组内行的左内边距')

  // 16px 就是这个层级差（本来是 26px 与组头 10px 内边距凑出来的，见 styles.ts 的注释）
  assert.equal(
    rowPad,
    padLeft + toggleWidth + gap + 16,
    '组内行的缩进要等于"组头内容左缘 + 16px"，否则组头的勾选框会跑到行勾选框右边',
  )
  assert.ok(padLeft <= 6, '组头左内边距要小：最前面那个折叠开关自己就是这一组的左缘')
})
