// test/styles.test.mjs — 样式表的四条硬约束（读源码，不看产物）。
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
  return css
}

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
 * 登记在案的例外：检查面没给、但确实需要的那一个，且**必须带回落链**。
 *
 * `--dsw-alias-label-primary-foreground` 是宿主填充按钮自己的前景色（浅色主题 #fff、深色主题
 * #0f1115），也就是"填充按钮上该用什么字色"的唯一正解；检查面没有它，于是 `.dsm-primary`
 * 写成 `var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1, #fff))`：
 * 拿不到就退到表面色——`brand-primary` 在明暗两套里都是表面的反色，拿表面色当字色读得出来。
 */
const REGISTERED_EXCEPTIONS = new Set(['--dsw-alias-label-primary-foreground'])

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

/** 逐行抽出 `属性: 值;` 声明（这份样式表里的声明都是一行一条）。 */
function declarations(cssText) {
  const out = []
  cssText.split('\n').forEach((line, index) => {
    const match = /^\s*([a-z-]+)\s*:\s*([^;]+);\s*$/.exec(line)
    if (match !== null) out.push({ property: match[1], value: match[2], line: index + 1 })
  })
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
