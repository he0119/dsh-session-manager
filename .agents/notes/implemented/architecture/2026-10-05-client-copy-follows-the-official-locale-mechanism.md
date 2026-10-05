# Agent Note: 客户端文案按官方 locale 机制接进类型系统

Status: implemented

## Problem

本页的中英文案原先自带一套：两份字典都是普通对象，键集一致只靠 `test/client.test.mjs` 在运行期比对；
`t` 由本插件注册 `settings.section` 时自己 `inject`，组件再留一层中文兜底（`translateWith(zh)`）。三件
事由此成立：

- 键名打错（`t('cancelDialog')` 这种）编译期看不出来，运行期界面上直接露出键名本身；
- 官方插件示例的写法是注册条目声明 `locale: NS`，`t` 由框架作为 props 送进组件（`PropsLocale`）。
  自带一份 `inject` 的 `t` 与官方机制并行，等于两套真相，而且会盖掉框架那一个；
- 官方把通用词收在宿主 `common` 命名空间，查找链是"本命名空间 → `common` → 键名本身"。本页自己
  再写一遍「取消 / 关闭 / 保存」，就成了两处维护。

## Decision

- **字典与键集按官方类型写**：`zh` 是键集真源（`as const`），`en: LocaleDictOf<NS>` 逐键核，命名空间
  用 `declare module '@deepseek-ai/dsh-client-ui-slots'` 合并进 `LocaleNamespaceMap`。少键、多键、
  `t('…')` 写错键都是编译错误；`Translate = TranslateNS<NS>` 让 `t` 自己就是这一份键域。
- **`t` 不再自 inject**：注册条目带 `locale: NS`，页面从 props 收 `t`（`ManagerPanelProps.t` 因此是
  必填）。插件自己 `inject` 的那一份只剩目录选择器。
- **键名改点分**：`page.title` / `transfer.import.apply` / `sync.progress.pushing` 这种分层名字，
  与官方示例同一套读法（`section.clear` / `dialog.preparingTitle`）。
- **三个两语言同文的词复用宿主 `common`**：`cancel` / `close` / `save` 在本字典里刻意缺席，
  `REUSED_COMMON` 用 `satisfies readonly CommonKey[]` 在编译期核它们真的是 `common` 的键。
  「读取中…」与「收起」**没有**复用：宿主那两个词的文案与语气都不同，复用等于改文案。
- **代价是两只只 import 类型的 devDependency**：`@deepseek-ai/dsh-client-ui-slots`（`TranslateNS` /
  `LocaleDictOf` / `PropsLocale`）与 `@deepseek-ai/dsh-client-locale`（`CommonKey` / `BuiltInLocaleId`）。

## 只引类型，运行期字节不变

`verbatimModuleSyntax` 下类型导入会被完全擦除：产物里仍然只有那三个平台基线模块的 `require`
（`test/client.test.mjs` 按产物文本核这一条），`dsh.client.external` 一个条目都没加。类型层的绑定不
构成运行时依赖，也不会把 `schemastery` 之类拖进浏览器产物。

## 中文兜底删掉了

原先 `t` 缺席时回落到中文一份。现在没有兜底：框架按 `locale` 送 `t`，那一层的服务不在时就是 Slot
条目的崩溃占位（与其它 props 同一个失败面）。取舍是"少一种语言"对"界面静默换成另一种语言"——用户
看到的是"这一页坏了"，而不是"这一页忽然说中文"。

## 运行期的第二道

编译期管字面量键，动态拼出来的键（标签表、状态码 → 键的映射）管不到。`test/client.test.mjs` 的假
翻译函数因此当场核两件事：问到的键在本字典里，或者在那三个刻意复用的 `common` 词里；另有一条核
`inject()` 里**没有** `t`（多 inject 一个会把框架那一个盖掉）。

## Alternatives considered

- **保留自带 `inject` 的 `t` 与中文兜底，只把键名改点分**：改动最小，但两套机制并行，且兜底会在
  用户切到英文后把这一页显示成中文。否决。
- **只做类型、不引官方包**（自己 `as const` + 互相 `satisfies`）：少两只 devDependency，但
  `CommonKey` 与 `PropsLocale` 都来自官方的声明合并，不引就得自己抄一份宿主键集，官方加词或改
  props 形状时要跟着改。否决。
- **键名保持驼峰、只加类型**：能拿到大部分收益，但读法与官方示例不一致（分层看不见），且复用
  `common` 时要让 `cancel` 与 `cancelDialog` 并排出现。否决。
- **把文案改成与 `common` 一致以便全量复用**：文案是用户可见的东西，"对齐机制"不该顺手改文案。
  否决（只复用两种语言同文的三个词）。

## Consequences

- 新增一个字面量键时，忘写 `en` 会在 `pnpm typecheck` 就报出来（`LocaleDictOf` 少键即错），
  不必等测试。
- 宿主 `common` 的键集变了（比如 `save` 改名），本包会在编译期跟着红——这正是要的：那时该决定是
  跟着改还是自己写一份。
- 组件 props 里 `t` 变成必填，任何"忘了传 `t`"的渲染路径会当场编译不过，而不是静默显示中文。
- `src/client/logic/locales.ts` 之外的客户端源码仍然只认"一个 `(key, params) => string` 的形状"，
  键集类型从那一处 `Translate` 单向流出。
