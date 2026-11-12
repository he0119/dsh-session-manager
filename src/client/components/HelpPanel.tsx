/**
 * 「说明」弹窗（页头那枚「?」）：把这一页会遇到的词与代价一次讲清。
 *
 * 为什么单独开一页，而不是把话都写在动作页上：动作页上那些段子混着两类内容——"当下要做的决定"
 * （点下去会开一个确认弹窗、会先备份）与"查词典"（子智能体 / 空白 / 已归档各是什么意思、谁判的、删完
 * 侧边栏为什么还在）。前者是操作前的最后一句话，必须贴在按钮边上；后者读者只会查一次，写在动作页上
 * 就是每次都要扫过去的散文（实测三页正文 187 / 382 / 144 字，最长的一段 192 字）。于是按"用到的
 * 时刻"分开：动作页只留决定，词条与边界条件集中到这一页，两处不各写一份口径。
 *
 * 词条**复用行上那几枚标签的文案**（`t('tag.subagent')` / `t('tag.subagentTip')` …）：同一件事在
 * 悬浮提示与这一页里必须是同一句话，各写一份就会漂。这一页只补标签没说到的部分（"可见"这一类、
 * 每页做什么、数据从哪来、常见疑问）。
 *
 * 页面上只有四张卡片：原先单独一张"会碰什么盘"与「常见疑问」逐条重复（回滚与恢复、删完侧边栏为什么
 * 还在、活动中的会话怎么关掉），独有那几条（备份时机、子智能体跟着父会话走、包里有什么）并进常见疑问。
 *
 * @module dsh-session-manager/client/HelpPanel
 */

import * as React from 'react'

import type { PanelShare } from '../types.ts'

/**
 * 分类词典：词与解释都取自行上那几枚标签（`tagX` 是词、`tagXTip` 是解释），只有"可见"是新写的。
 * 顺序按宿主的判定顺序走（子智能体 → 空白 → 已归档）再补上跨类的两类（活动中、未分组）。
 */
const CATEGORIES = [
  ['help.categories.visible', 'help.categories.visibleTip'],
  ['tag.subagent', 'tag.subagentTip'],
  ['tag.blank', 'tag.blankTip'],
  ['tag.archived', 'tag.archivedTip'],
  ['tag.live', 'tag.liveTip'],
  ['list.ungrouped', 'list.ungroupedTip'],
] as const

/**
 * 四件事各在哪儿做：顺序按"从最常看到的最不常看到的"排（列表 → 导出导入 → 同步 → 备份与回滚）。
 *
 * 页签去掉之后这一节的回答从「哪一页」变成「哪儿」：前一件是页面本身，后三件各是一处入口
 * （动作行、页头状态、状态栏），词条就是那三处入口按钮上的字（`place.*`）。
 */
const ENTRY_LINES = [
  ['place.sessions', 'help.entry.sessions'],
  ['place.transfer', 'help.entry.transfer'],
  ['place.sync', 'help.entry.sync'],
  ['place.backup', 'help.entry.backup'],
] as const

/** 常见疑问：问答同上一条同一个形状（dt 问、dd 答）。会碰什么盘的独有内容收在这里。 */
const FAQ = [
  ['help.faq.unownedQ', 'help.faq.unownedA'],
  ['help.faq.deletedQ', 'help.faq.deletedA'],
  ['help.faq.transcriptQ', 'help.faq.transcriptA'],
  ['help.faq.retitleQ', 'help.faq.retitleA'],
  ['help.faq.restartQ', 'help.faq.restartA'],
  ['help.faq.liveQ', 'help.faq.liveA'],
  ['help.faq.backupQ', 'help.faq.backupA'],
  ['help.faq.familyQ', 'help.faq.familyA'],
  ['help.faq.exportQ', 'help.faq.exportA'],
  ['help.faq.forkQ', 'help.faq.forkA'],
  ['help.faq.passwordQ', 'help.faq.passwordA'],
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

/** 「说明」弹窗。 */
export function HelpPanel({ t, state, meta }: Pick<PanelShare, 't' | 'state' | 'meta'>): React.ReactElement {
  // 两条路径来自 `/meta` 或 `/state`（同一份取值，见 ManagerPanel）：这一页只印它们，不自己推。
  const facts = state ?? meta
  return (
    <>
      <p className="dsm-hint">{t('help.hint')}</p>

      <HelpSection title={t('help.categories.title')}>
        <dl className="dsm-defs">
          {CATEGORIES.map(([term, tip]) => (
            <React.Fragment key={term}>
              <dt>{t(term)}</dt>
              <dd>{t(tip)}</dd>
            </React.Fragment>
          ))}
        </dl>
        <p className="dsm-hint">{t('help.categories.note')}</p>
      </HelpSection>

      <HelpSection title={t('help.entry.title')}>
        <dl className="dsm-defs">
          {ENTRY_LINES.map(([tab, line]) => (
            <React.Fragment key={tab}>
              <dt>{t(tab)}</dt>
              <dd>{t(line)}</dd>
            </React.Fragment>
          ))}
        </dl>
      </HelpSection>

      <HelpSection title={t('help.where.title')}>
        <dl className="dsm-defs">
          <dt>{t('help.where.library')}</dt>
          <dd>
            <span className="dsm-path">{facts?.sessionsRoot ?? t('loading')}</span>
            <br />
            {t('help.where.libraryText')}
          </dd>
          <dt>{t('help.where.registry')}</dt>
          <dd>
            <span className="dsm-path">{facts?.registryPath ?? t('loading')}</span>
            <br />
            {t('help.where.registryText')}
          </dd>
        </dl>
      </HelpSection>

      <HelpSection title={t('help.faq.title')}>
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
