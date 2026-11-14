/**
 * 悬浮提示：本页所有"停一下才知道"的提示都走它。
 *
 * 为什么不再用原生 `title`：原生那枚是浏览器画的——延迟两三秒、字体与配色不受控、长提示被窗口边
 * 裁掉、触屏上根本出不来。官方 `Tooltip` 把提示画成一块气泡：立刻出、跟着主题、`portal` 之后不被
 * 表格与卡片的 overflow 裁掉，键盘聚焦也出。
 *
 * 用法：把这枚组件套在**一个原生元素**外面（`span` / `button` / `td` 都行），提示文字用 `text`。
 * 不要套在官方控件上（例如 `Checkbox`）：`Tooltip` 要往子元素上挂 `ref`，没有 `forwardRef` 的组件
 * 接不住，得先包一层 `span`。
 *
 * @module dsh-session-manager/client/Hint
 */

import * as React from 'react'

import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'

export interface HintProps {
  /** 提示文字；空串或 `undefined` 时原样返回 `children`，不挂任何东西。 */
  readonly text: string | undefined
  /** 气泡摆在哪边（默认下方；侧边栏那种窄条里的短提示用 right）。 */
  readonly side?: 'top' | 'bottom' | 'right'
  readonly children: React.ReactElement
}

export function Hint({ text, side = 'bottom', children }: HintProps): React.ReactElement {
  if (text === undefined || text === '') return children
  // `portal`：列表卡片、表格、弹窗正文都带 overflow，气泡不挂到 body 上会被裁掉。
  return (
    <Tooltip label={text} side={side} portal>
      {children}
    </Tooltip>
  )
}
