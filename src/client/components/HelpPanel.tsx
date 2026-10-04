/**
 * 「说明」分页：把这一页会遇到的词与代价一次讲清。
 *
 * 为什么单独开一页，而不是把话都写在动作页上：动作页上那些段子混着两类内容——"当下要做的决定"
 * （点下去会开一个确认弹窗、会先备份）与"查词典"（子代理 / 空白 / 已归档各是什么意思、谁判的、删完
 * 侧边栏为什么还在）。前者是操作前的最后一句话，必须贴在按钮边上；后者读者只会查一次，写在动作页上
 * 就是每次都要扫过去的散文（实测三页正文 187 / 382 / 144 字，最长的一段 192 字）。于是按"用到的
 * 时刻"分开：动作页只留决定，词条与边界条件集中到这一页，两处不各写一份口径。
 *
 * 词条**复用行上那几枚标签的文案**（`t('tagSubagent')` / `t('tagSubagentTip')` …）：同一件事在
 * 悬浮提示与这一页里必须是同一句话，各写一份就会漂。这一页只补标签没说到的部分（"可见"这一类、
 * 每页做什么、数据从哪来、常见疑问）。
 *
 * 页面上只有四张卡片：原先单独一张"会碰什么盘"与「常见疑问」逐条重复（回滚与恢复、删完侧边栏为什么
 * 还在、活动中的会话删不掉），独有那几条（备份时机、子代理跟着父会话走、包里有什么）并进常见疑问。
 *
 * @module dsh-session-manager/client/HelpPanel
 */

import * as React from 'react'

import { translateWith, zh } from '../logic/locales.ts'
import type { PanelShare } from '../types.ts'

/** 没有注入面时的兜底翻译。 */
const fallback = translateWith(zh as unknown as Record<string, string>)

/**
 * 分类词典：词与解释都取自行上那几枚标签（`tagX` 是词、`tagXTip` 是解释），只有"可见"是新写的。
 * 顺序按宿主的判定顺序走（子代理 → 空白 → 已归档）再补上跨类的两类（活动中、未分组）。
 */
const CATEGORIES = [
  ['catVisible', 'catVisibleTip'],
  ['tagSubagent', 'tagSubagentTip'],
  ['tagBlank', 'tagBlankTip'],
  ['tagArchived', 'tagArchivedTip'],
  ['tagLive', 'tagLiveTip'],
  ['ungroupedSource', 'ungroupedTip'],
] as const

/** 四个分页各管什么：与页签同一个顺序（会话 → 迁移 → 传输 → 同步）。 */
const TAB_LINES = [
  ['tabManage', 'helpTabManage'],
  ['tabMigrate', 'helpTabMigrate'],
  ['tabTransfer', 'helpTabTransfer'],
  ['tabSync', 'helpTabSync'],
] as const

/** 常见疑问：问答同上一条同一个形状（dt 问、dd 答）。会碰什么盘的独有内容收在这里。 */
const FAQ = [
  ['faqUnownedQ', 'faqUnownedA'],
  ['faqDeletedQ', 'faqDeletedA'],
  ['faqRestartQ', 'faqRestartA'],
  ['faqBackupQ', 'faqBackupA'],
  ['faqFamilyQ', 'faqFamilyA'],
  ['faqExportQ', 'faqExportA'],
  ['faqForkQ', 'faqForkA'],
  ['faqPasswordQ', 'faqPasswordA'],
] as const

/** 一张卡片：标题 + 正文，动作页那些卡片同一个外壳。 */
function HelpSection({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="dsm-card">
      <div className="dsm-cardHead">
        <span className="dsm-cardTitle">{title}</span>
      </div>
      {children}
    </div>
  )
}

/** 「说明」分页。 */
export function HelpPanel({ t = fallback, state }: PanelShare): React.ReactElement {
  return (
    <>
      <p className="dsm-hint">{t('helpHint')}</p>

      <HelpSection title={t('helpCategoriesTitle')}>
        <dl className="dsm-defs">
          {CATEGORIES.map(([term, tip]) => (
            <React.Fragment key={term}>
              <dt>{t(term)}</dt>
              <dd>{t(tip)}</dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="dsm-hint">{t('helpCategoriesNote')}</p>
      </HelpSection>

      <HelpSection title={t('helpTabsTitle')}>
        <dl className="dsm-defs">
          {TAB_LINES.map(([tab, line]) => (
            <React.Fragment key={tab}>
              <dt>{t(tab)}</dt>
              <dd>{t(line)}</dd>
            </React.Fragment>
          ))}
        </dl>
      </HelpSection>

      <HelpSection title={t('helpWhereTitle')}>
        <dl className="dsm-defs">
          <dt>{t('helpWhereLibrary')}</dt>
          <dd>
            <span className="dsm-path">{state?.sessionsRoot ?? ''}</span>
            <br />
            {t('helpWhereLibraryText')}
          </dd>
          <dt>{t('helpWhereRegistry')}</dt>
          <dd>
            <span className="dsm-path">{state?.registryPath ?? ''}</span>
            <br />
            {t('helpWhereRegistryText')}
          </dd>
        </dl>
      </HelpSection>

      <HelpSection title={t('helpFaqTitle')}>
        <dl className="dsm-defs dsm-defsFaq">
          {FAQ.map(([question, answer]) => (
            <React.Fragment key={question}>
              <dt>{t(question)}</dt>
              <dd>{t(answer)}</dd>
            </React.Fragment>
          ))}
        </dl>
      </HelpSection>
    </>
  )
}
