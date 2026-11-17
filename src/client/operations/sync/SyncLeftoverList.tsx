/**
 * 「没做到」的清单：按原因分组、逐条画会话名与原因，带 id 的给「只看这一条」。
 *
 * 为什么分组：一批遗留里混着几件该由不同的人/不同的机器去处理的事——缺附件对象要等持有对象的那台
 * 机器推、两边都写过的要人裁决、会话正开着的要重启 DSH、目录对不上的要改映射。原来 50 条平铺成一列
 * 长句子，每条都从头读到尾才分得清是哪一类，页面上能看到的只有开头四条。
 *
 * 为什么默认每组只摆三条：一次遗留可能几十条，全铺开时弹窗正文拉成一页，读的人既看不到总数也找不到
 * 第二类。三条够认出"这一组都是什么"，剩下的按需展开。
 *
 * 行内三段各占一行：会话名（500）、id（12px 等宽、次要色）、原因（正文色）。名字与原因挤在同一行时，
 * 长标题会把"为什么"顶到屏幕外——这正是这一版要修的事。
 *
 * @module dsh-session-manager/client/operations/sync/SyncLeftoverList
 */

import * as React from 'react'

import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'

import { groupLeftovers, LEFTOVER_KEY, LEFTOVER_PREVIEW, LEFTOVER_TONE, type LeftoverGroup } from './syncLeftovers.ts'
import type { Translate } from '../../shared/i18n/locales.ts'
import type { SyncLeftover, SyncLeftoverKind } from '../../api.ts'

/** 一条：名字 / id / 原因三行，右边那枚动作只在点得过去时出现。 */
function LeftoverRow({
  item,
  onFocus,
  t,
}: {
  item: SyncLeftover
  onFocus?: ((sessionId: string) => void) | undefined
  t: Translate
}): React.ReactElement {
  /*
   * 新宿主给拆开的两半（`title` + `detail`），旧记录只有一句话（`message`）。
   *
   * 旧记录不能同时画 `message` 与 id：那句话本来就已经是「名字（id）：原因」，再单摆一行 id 就重复了。
   * 所以看 `detail` 在不在决定画法，而不是看 `title`——附件那条没有标题、只有 id 与原因。
   */
  const split = item.detail !== undefined
  const name = item.title ?? item.sessionId
  return (
    <li className="dsm-leftoverRow">
      <div className="dsm-leftoverMain">
        {split ? (
          <>
            {name === undefined ? null : <span className="dsm-leftoverName">{name}</span>}
            {item.title !== undefined && item.sessionId !== undefined ? (
              <span className="dsm-leftoverId">{item.sessionId}</span>
            ) : null}
            <span className="dsm-leftoverReason">{item.detail}</span>
          </>
        ) : (
          <span className="dsm-leftoverReason">{item.message}</span>
        )}
      </div>
      {item.sessionId !== undefined && onFocus !== undefined ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (item.sessionId !== undefined) onFocus(item.sessionId)
          }}
        >
          {t('sync.leftovers.focus')}
        </Button>
      ) : null}
    </li>
  )
}

/** 一组：组头（类别标签 + 条数）+ 最多三行 + 展开按钮。 */
function LeftoverGroupBlock({
  group,
  open,
  onToggle,
  onFocus,
  t,
}: {
  group: LeftoverGroup
  open: boolean
  onToggle: () => void
  onFocus?: ((sessionId: string) => void) | undefined
  t: Translate
}): React.ReactElement {
  const hidden = group.items.length - LEFTOVER_PREVIEW
  const rows = open || hidden <= 0 ? group.items : group.items.slice(0, LEFTOVER_PREVIEW)
  return (
    <section className="dsm-leftoverGroup">
      <div className="dsm-leftoverGroupHead">
        {/* 官方 Tag 不转发 title，所以布局挂钩挂在外层 span 上（与页内其它标签同一做法）。 */}
        <span className="dsm-tag">
          <Tag tone={LEFTOVER_TONE[group.key]}>{t(LEFTOVER_KEY[group.key])}</Tag>
        </span>
        <span className="dsm-leftoverGroupCount">{t('sync.leftovers.count', { count: group.items.length })}</span>
      </div>
      <ul className="dsm-listPlain">
        {rows.map((item, index) => (
          <LeftoverRow key={`${index}-${item.message}`} item={item} onFocus={onFocus} t={t} />
        ))}
      </ul>
      {hidden <= 0 ? null : (
        <div className="dsm-leftoverMore">
          <Button variant="outline" size="sm" aria-expanded={open} onClick={onToggle}>
            {open ? t('sync.leftovers.less') : t('sync.leftovers.more', { count: hidden })}
          </Button>
        </div>
      )}
    </section>
  )
}

/**
 * @param props.items 一次同步的全部「没做到」（`leftoversOf()` 归一过的那一份）。
 * @param props.onFocus 点「只看这一条」时把那一条交给页面外壳；没这一项就不摆按钮。
 * @param props.t 翻译函数。
 * @returns 按原因分组的清单；没有条目时不渲染。
 */
export function SyncLeftoverList({
  items,
  onFocus,
  t,
}: {
  items: readonly SyncLeftover[]
  onFocus?: ((sessionId: string) => void) | undefined
  t: Translate
}): React.ReactElement | null {
  /** 展开了哪几组（只存分组键；弹窗关掉就跟着没了，这是"看一眼"的状态，不必记住）。 */
  const [opened, setOpened] = React.useState<readonly SyncLeftoverKind[]>([])
  if (items.length === 0) return null
  const toggle = (key: SyncLeftoverKind): void => {
    setOpened((now) => (now.includes(key) ? now.filter((item) => item !== key) : [...now, key]))
  }
  return (
    <div className="dsm-leftoverGroups">
      {groupLeftovers(items).map((group) => (
        <LeftoverGroupBlock
          key={group.key}
          group={group}
          open={opened.includes(group.key)}
          onToggle={() => toggle(group.key)}
          onFocus={onFocus}
          t={t}
        />
      ))}
    </div>
  )
}
