# Agent Note: 插件标题来自包导出的 locale 元信息

Status: implemented

## Problem

插件管理页「已安装」里这个包的标题是 `@he0119/dsh-session-manager`（设置里的插件清单还会把 npm
scope 剥掉，显示成 `session-manager`），而它下面那行描述是中文。看起来像"标题漏翻了"，实际是两个
字段各自沿不同的回退链落到了不同来源。

宿主的插件展示元信息**不进插件代码**：`dsh-app-boot` 的 `readPluginMeta()` 用 Node 的 ESM 解析器
解析 `<包名>/locale/en.json`，把同目录里其它 `*.json` 读成各语言字典；标题按 `locale meta.title` →
`package.json.name` → 完整 Cordis 插件名 逐级回退，描述按 `locale meta.description` →
`package.json.description` → 不显示描述 回退。本包只有 `package.json.description` 是中文，于是描述
"恰好"正常，标题露馅。

这条链上没有任何一步会报错：`en.json` 解析不到（文件不在，或 `exports` 没放行）就等于"这个包没有
locale 目录"，一个字典都不读，标题静默变成包名；本地测试全绿，装进 profile 才现形。

## Decision

随包发布两份展示元信息（`locale/en.json`、`locale/zh.json`），字段只有 `meta.title` 与
`meta.description`；[package.json](../../../../package.json) 的 `exports` 加
`"./locale/*.json": "./locale/*.json"`，`files` 加 `locale/*.json`。

- `en.json` 是**发现入口**，不是"英文兜底"：宿主先解析到它，再去 readdir 它所在目录。所以中文那份
  以英文那份存在为前提，不能只发 `zh.json`。
- 文件名就是语言键，形状要匹配宿主的 `LANGUAGE_ID`（`zh`、`zh-CN` 这类）。
- 文案面向插件列表里那一行，写一句人话，不照抄 `package.json.description`（那是给 npm 检索用的技术
  描述）。中文标题「会话管理器」、描述「在设置页里导出、导入会话包，把会话和工作区搬到新目录，还能在
  两台机器之间同步会话。」，英文一份同义。

三处门禁跟着钉：

- [test/locale.test.mjs](../../../../test/locale.test.mjs)：`en.json` 在、每个文件名是语言 id、
  各语言 `meta` 的键集与英文一致、`exports` 与 `files` 真的放行了 `locale/*.json`。
- [scripts/check-package.mjs](../../../../scripts/check-package.mjs) 的运行期文件清单加入这两份
  JSON——宿主真的会读它们，少任何一份都只在装进 profile 后现形。
- 同一个脚本里，`exports` 的通配条目不再当字面路径核：改按形状匹配，**至少要匹配到一个真实文件**。

## Alternatives considered

- **只发 `locale/zh.json`**：宿主的发现入口是常量 `en.json`，单独一份中文文件不会被 readdir 到；
  中文标题不会出现，也不会报错。
- **把展示文案塞进本包自己的字典（`src/client/logic/locales.ts`）**：那份字典只覆盖本包页面里的字，
  插件列表那一行由宿主外壳渲染、读的是包的元信息，改自己的字典对它没有影响。
- **只把 `package.json.description` 改成人话**：描述确实会回退到它，但标题没有对应的回退位（`name`
  只能是 npm 包名）；而且同一个字段还服务 npm 的检索与项目主页，两个受众要的东西不一样。
- **加进 `files` 但不加进 `exports`**：Node 的 ESM 解析器受 `exports` 限制，拿到的是
  `ERR_PACKAGE_PATH_NOT_EXPORTED`，宿主把这一类错误当成"没有 locale 目录"跳过——文件在包里也没用。
- **在 `check-package.mjs` 里直接跳过通配条目**：省三行代码，代价是 `exports` 多一条永不失败的断言；
  真写成 `locale/*.yaml` 时自检照旧全绿，而标题照样回退。

## Consequences

- 插件管理页与设置里的插件清单，标题变成「会话管理器」/ "Session Manager"，描述换成上面那一句；
  界面语言切到哪份就读哪份。读元信息不激活插件，所以关掉的、以及预设里的插件同样显示。
- 改标题与描述从此改 `locale/*.json`；`package.json.description` 只剩 npm 检索与 locale 缺失时的
  回退两份作用，两边不再需要对齐。
- 包体多两个 JSON（实测 225 + 197 字节）。
- `check-package.mjs` 的通配分支对 `exports` 里将来任何通配条目生效：匹配不到真实文件即失败。
- 安装预览不受影响：宿主仍用 npm registry 的信息，不用 locale 元信息替换。
