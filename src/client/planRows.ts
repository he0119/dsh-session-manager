/**
 * 列表/表格里一行该怎么写——抽成纯函数，因为这两处都出过错。
 *
 * 一、cwd 那一格在**跳过**的行上说过错话。
 *
 * 计划里的 `toCwd` 只在「会写盘、而且包里本来有 cwd」的会话上出现（见 `src/transfer.ts` 的
 * `ImportEntry`）：按设计，跳过的行没有 `toCwd`，包里没有 cwd 的会话也没有。原来那一格只判断
 * `toCwd === undefined`，于是把跳过的行显示成「保持无 cwd（落 _no-cwd）」——那些会话明明有 cwd
 * （比如 `/home/uy_sun/dev/dsh-aperture`），而且它们根本不会被写盘。用户看到的是"我的会话要被丢进
 * 无 cwd 桶了"，这是把"什么都不会发生"说成了"会发生一件坏事"。
 *
 * 二、一行的"名字"该是标题还是 id（`sessionLabel`）：以前到处显示 `session-9f3c…`，用户认不出是哪条。
 *
 * 判断点摆在一个地方，因此可以被直接测（`test/planRows.test.ts`）。
 *
 * 只用到这几个字段，所以这里**不 import** `/state` 或导入响应的类型：Host 侧的 typecheck 工程
 * `exclude` 了 `src/client`，而 import 会把它拉进那个没有 DOM 的工程里检查（见 groups.ts 里同一段
 * 说明）。
 *
 * @module dsh-session-manager/client/planRows
 */

/** 判断 cwd 这一格只用得上这三个字段。 */
export interface CwdSubject {
  readonly action: 'create' | 'skip'
  /** 包里的原 cwd；缺省表示这条会话本来就没有 cwd。 */
  readonly fromCwd?: string
  /** 落盘后的 cwd；跳过的行与本来就没有 cwd 的会话都没有这个字段。 */
  readonly toCwd?: string
}

/** 这一格的三种说法：跳过不改写 / 本来就没有 cwd / 会改写成目标路径。 */
export type CwdPlan =
  | { readonly kind: 'skip' }
  | { readonly kind: 'keepNoCwd' }
  | { readonly kind: 'rewrite'; readonly from: string; readonly to: string }

/** 把一条计划映射成那一格要说的事。 */
export function describeCwd(subject: CwdSubject): CwdPlan {
  // 先判跳过：跳过时 `toCwd` 必然缺省，但那**不代表**"这条会话没有 cwd"，更不代表要落 _no-cwd。
  if (subject.action === 'skip') return { kind: 'skip' }
  if (subject.toCwd === undefined) return { kind: 'keepNoCwd' }
  // 会写盘且有 cwd 时 `fromCwd` 必然有（`toCwd` 就是由它存在推出来的），兜底只为类型与坏数据。
  return { kind: 'rewrite', from: subject.fromCwd ?? '—', to: subject.toCwd }
}

/** 认一条会话只用得上这两个字段。 */
export interface LabelSubject {
  readonly id: string
  /** 折叠出的标题；读不到就没有（见 `src/session-title.ts`）。 */
  readonly title?: string
}

/** 一行会话在界面上怎么称呼。 */
export interface SessionLabel {
  /** 行上可见的文本。 */
  readonly text: string
  /** 悬浮提示（原生 tooltip）。标题在前、id 在后，见下面的说明。 */
  readonly tip: string
  /** 可见的是标题还是 id：前者走正文字体，后者走等宽（机器名就该长得像机器名）。 */
  readonly kind: 'title' | 'id'
}

/**
 * 一条会话在列表/表格里显示成什么。
 *
 * 显示**标题**而不是 id：`session-9f3c…` 这种 uuid 对人是零信息，用户是在"我上次问那个问题的会话"
 * 这一层挑会话的。id 并没有消失，而是退到悬浮提示里——真要指名道姓（报 bug、对日志）时才需要它。
 *
 * 标题读不到（老会话、日志里就没有标题事件）时**回落到 id**：显示空行或"（无标题）"更没用，
 * 那本来就是这个位置以前显示的东西。
 *
 * 提示里两行放着完整标题 + id：标题在行里可能被省略号截掉，悬停是唯一能看全的地方；而 id 是
 * 用户明确要求"悬浮才显示"的东西。标题就是 id 时（没有标题）不重复一遍。
 *
 * @param subject 只读 id 与 title。
 * @returns 可见文本、提示文本与字体种类。
 */
export function sessionLabel(subject: LabelSubject): SessionLabel {
  const title = subject.title?.trim()
  if (title === undefined || title === '') return { text: subject.id, tip: subject.id, kind: 'id' }
  return { text: title, tip: `${title}\n${subject.id}`, kind: 'title' }
}
