/**
 * 自动推送"没跑"的那几个原因码——界面这一侧的**运行期清单**。
 *
 * 为什么需要一份清单，而不是直接用类型：`AutoPushSkip` 是 `src/sync.ts` 里的**联合类型**，编译之后
 * 就不存在了；而界面要按码去字典里挑句子（`sync.autoPush.skip.<码>`），那一步是运行期的字符串。
 * 两边对不上的表现很安静——不报错、不崩，只是那句话退回「宿主没有说原因」。
 *
 * 所以清单与字典由 `test/sync-form.test.ts` 两处钉住：
 *
 *   1. 清单里的每个码，中英字典都得有 `sync.autoPush.skip.<码>`；
 *   2. `src/sync.ts` 里 `runAutoPush()` / `createAutoPushTimer()` 报出来的每个 `skip` 字面量，
 *      都得在这份清单里（宿主会报、界面不认 = 用户看到一句没用的"没说原因"）。
 *
 * 与核心层的 `AutoPushSkip` 是**同一套名字**，加码时要三处一起改（`src/sync.ts` 的联合、这里、
 * 两份字典）。这条链路上没有编译期保护，`test/sync-form.test.ts` 是唯一的一道闸。
 *
 * @module dsh-session-manager/client/logic/autoPush
 */

/**
 * `AutoPushOutcome.skip` 可能出现的全部值（顺序与 `src/sync.ts` 的 `AutoPushSkip` 一致）。
 *
 * - `disabled`：这个宿主/profile 没开自动推送；
 * - `interval`：兜底那一轮还没到点（距离上一次真跑不到间隔）；
 * - `busy`：上一轮还在跑（这一轮直接让开，不排队）；
 * - `idle`：有得算但一条都不用推。
 *
 * **没有"正在攒连发"这一项**：静默窗口只推迟推送，不会让任何一次询问得到"没跑"（`touched()` 与手点
 * 那一次都走 `force`）。见 `src/sync.ts` 里 `AutoPushSkip` 那段。
 */
export const AUTO_PUSH_SKIP_CODES = ['disabled', 'interval', 'busy', 'idle'] as const

/** 清单里的一项。 */
export type AutoPushSkipCode = (typeof AUTO_PUSH_SKIP_CODES)[number]
