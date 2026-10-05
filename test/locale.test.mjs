// test/locale.test.mjs — 插件展示元信息自检：标题 / 描述从哪儿来。
//
// 宿主**不激活插件**就读这两个文件：`dsh-app-boot` 的 `readPluginMeta()` 先用 Node 的 ESM 解析器
// 解析 `<包名>/locale/en.json`，解析不到就一个字典都不读（其余语言是把 `en.json` 所在目录 readdir
// 出来的），标题随即沿 `locale meta.title` → `package.json.name` → 完整 Cordis 插件名 逐级回退。
// 于是「忘了导出」这件事没有报错，只有现象：插件列表里那一行的标题静默变成
// `@he0119/dsh-session-manager`，而描述因为 `package.json.description` 本来就是中文，看起来一切正常。
//
// 这里钉四件事，都是上面那条链上会静默失败的地方：
//   1) `locale/en.json` 在——它是唯一的发现入口，缺了它中文标题也一起没有；
//   2) 每个语言文件名都是一个语言 id（宿主拿文件名当语言键，形状不对它直接抛诊断）；
//   3) 各语言的 `meta` 键集与 `en.json` 一致——字段缺失允许，但"中文少写一句描述"要在这里红；
//   4) `package.json` 的 `exports` 与 `files` 真的把 `locale/*.json` 放出去了——少任何一条，
//      上面的文件在安装后都解析不到，第 1~3 条却照样是绿的。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 宿主对语言文件名的判据（`dsh-app-boot` 的 `LANGUAGE_ID`），文件名就是语言键。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** `locale/` 下的语言文件：文件名（去掉 .json）→ 解析后的内容。 */
function dictionaries() {
  const dir = join(root, 'locale')
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  return files.map((name) => ({
    language: name.slice(0, -'.json'.length),
    file: `locale/${name}`,
    parsed: JSON.parse(readFileSync(join(dir, name), 'utf8')),
  }))
}

test('locale：en.json 是发现入口，每个语言文件名都是一个语言 id', () => {
  const entries = dictionaries()
  assert.ok(
    entries.some((entry) => entry.language === 'en'),
    '缺 locale/en.json：宿主只在解析到它时才去 readdir 同目录的其它语言，中文标题会跟着一起消失',
  )
  for (const entry of entries) {
    assert.match(entry.language, LANGUAGE_ID, `${entry.file}：文件名应当是语言 id，如 zh.json / zh-CN.json`)
  }
})

test('locale：meta.title 与 meta.description 是非空字符串，各语言键集一致', () => {
  const entries = dictionaries()
  const english = entries.find((entry) => entry.language === 'en')
  const keysOf = (entry) => Object.keys(entry.parsed.meta ?? {}).sort()

  for (const entry of entries) {
    assert.equal(typeof entry.parsed.meta, 'object', `${entry.file}：缺 meta 对象`)
    for (const field of ['title', 'description']) {
      const value = entry.parsed.meta[field]
      assert.equal(typeof value, 'string', `${entry.file}：meta.${field} 应当是字符串`)
      assert.notEqual(value.trim(), '', `${entry.file}：meta.${field} 不能是空串——空值会让宿主按缺字段回退`)
    }
    assert.deepEqual(
      keysOf(entry),
      keysOf(english),
      `${entry.file}：meta 的键集要与 locale/en.json 一致（中英两份都要有标题和描述）`,
    )
  }
})

test('locale：package.json 真的把 locale/*.json 导出并发布', () => {
  assert.equal(
    pkg.exports?.['./locale/*.json'],
    './locale/*.json',
    'exports 里缺 "./locale/*.json"：宿主的 ESM 解析器拿到的是 ERR_PACKAGE_PATH_NOT_EXPORTED，' +
      '它会当成"这个包没有 locale 目录"静默回退成包名',
  )
  assert.ok(
    (pkg.files ?? []).some((entry) => entry === 'locale/*.json' || entry === 'locale'),
    'files 里缺 locale：本机测试读得到源码目录，装进 profile 之后那两个文件根本不在包里',
  )
})
