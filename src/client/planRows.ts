/**
 * 导入预演表里「cwd 那一格」该说什么——抽成纯函数，因为这一格在**跳过**的行上说过错话。
 *
 * 计划里的 `toCwd` 只在「会写盘、而且包里本来有 cwd」的会话上出现（见 `src/transfer.ts` 的
 * `ImportEntry`）：按设计，跳过的行没有 `toCwd`，包里没有 cwd 的会话也没有。原来那一格只判断
 * `toCwd === undefined`，于是把跳过的行显示成「保持无 cwd（落 _no-cwd）」——那些会话明明有 cwd
 * （比如 `/home/uy_sun/dev/dsh-aperture`），而且它们根本不会被写盘。用户看到的是"我的会话要被丢进
 * 无 cwd 桶了"，这是把"什么都不会发生"说成了"会发生一件坏事"。
 *
 * 三支分支摆在一个地方，判断点因此可以被直接测（`test/planRows.test.ts`）。
 *
 * 只用到这三个字段，所以这里**不 import** `/state` 或导入响应的类型：Host 侧的 typecheck 工程
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
