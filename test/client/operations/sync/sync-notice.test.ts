// 一次同步之后页面顶部那句话：只说结果，其余折成一句"另有…"。
//
// 这一句原来每项单说一句（覆盖、跟着删、附件、整理、计划重算各一句），一次什么都碰上的同步报到 187 字；
// 而它挂在页面顶部、旁边就是「知道了」，读的人只想知道"拉了几条、推了几条"。判据钉在这里：
//
//   1. 结论在最前面，只有条数，没有字节；
//   2. 其余项折成**一句**，各项之间用「、」隔开；
//   3. 顶掉 / 删掉本机内容时，"旧的那份在「备份与回滚」里"只说一次（挂最后，不逐项重复）；
//   4. 一条会话都没搬、只补了对象时不报"拉取 0 条"，换一句"这次没有会话要搬"；
//   5. 什么都没发生时返回 `undefined`（不摆一条"已拉取 0 条"）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeSyncNotice, type SyncNoticeFacts } from '../../../../src/client/operations/sync/syncNotice.ts'
import { zh, type Translate } from '../../../../src/client/shared/i18n/locales.ts'

/** 用真的中文词典当翻译函数：核的就是用户会看到的那句话。 */
const dict: Record<string, string> = zh
const t = ((key: string, vars?: Record<string, unknown>): string =>
  String(dict[key]).replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? '?'))) as Translate

const base: SyncNoticeFacts = {
  pulled: 0,
  pushed: 0,
  replaced: 0,
  deleted: 0,
  attachmentsIn: 0,
  attachmentsOut: 0,
  attachmentsMissing: 0,
  tidied: 0,
  replanned: false,
}

const say = (patch: Partial<SyncNoticeFacts>): string | undefined => describeSyncNotice({ ...base, ...patch }, t)

test('同步提示：结论先说条数，不带字节', () => {
  assert.equal(say({ pulled: 3, pushed: 2 }), '已拉取 3 条、推送 2 条。')
})

test('同步提示：其余项折成一句「另有…」', () => {
  const text = say({
    pulled: 1,
    pushed: 1,
    replaced: 1,
    deleted: 2,
    attachmentsIn: 2,
    attachmentsOut: 3,
    tidied: 4,
    replanned: true,
  })
  assert.ok(text !== undefined)
  assert.equal(
    text,
    '已拉取 1 条、推送 1 条。另有：覆盖本机 1 条、跟着删 2 条、取回附件 2 个、上传附件 3 个、整理远端 4 个包、计划重算过。旧的那份在「备份与回滚」里。',
  )
  // 一整句，不是六句：句号只该出现在结论、折叠句和那句尾巴上（三处）。
  assert.equal((text.match(/。/g) ?? []).length, 3, '整条最多三句')
  assert.equal(text.includes('旧的那份在「备份与回滚」里。旧的那份'), false, '那句尾巴只说一次')
})

test('同步提示：只补了附件对象时不说"拉取 0 条"', () => {
  const text = say({ attachmentsIn: 4 })
  assert.equal(text, '这次没有会话要搬。另有：取回附件 4 个。')
  assert.equal(text?.includes('0 条'), false)
})

test('同步提示：本机缺的对象也算一项（用户要能看见"图片为什么挂了"）', () => {
  assert.equal(say({ pulled: 1, attachmentsMissing: 2 }), '已拉取 1 条、推送 0 条。另有：本机缺 2 个附件对象。')
})

test('同步提示：什么都没发生时不摆一条"已拉取 0 条"', () => {
  assert.equal(say({}), undefined)
})
