/**
 * 一条细进度条：长操作（现在只有同步）用来说明"做到第几条了"。
 *
 * 为什么自己画而不用官方控件库：那一套里最近的两个原语是 `StateDot` 的 ongoing 转圈与
 * `TextShimmer`，两者都只回答"还在动"，回答不了"还剩多少"——而这里的等待是几十秒到几分钟，
 * 用户要的正是后者。控件库没有进度条，所以这一段由本插件画（颜色仍然只走检查面的 token）。
 *
 * 进度**分段**：拉与推各走一遍，`total` 由调用方给（来自宿主那条进度事件，界面不自己推算）。两段的
 * 分母不同，合成一个总百分比只会骗人。
 *
 * @module dsh-session-manager/client/ProgressBar
 */

import * as React from 'react'

/**
 * @param current 正在处理第几条（1 起；0 表示还没开始）。
 * @param total 这一段一共多少条。
 * @param label 无障碍名字（进度条自己不带文字，计数与当前条目由调用方写在旁边）。
 */
export function ProgressBar({
  current,
  total,
  label,
}: {
  current: number
  total: number
  label: string
}): React.ReactElement {
  // 越界的值只可能来自坏数据，画成"顶到两头"而不是让宽度算出负数或 >100%。
  const safeTotal = Math.max(0, total)
  const safeCurrent = Math.min(safeTotal, Math.max(0, current))
  const percent = safeTotal === 0 ? 0 : (safeCurrent / safeTotal) * 100
  return (
    <div
      className="dsm-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeTotal}
      aria-valuenow={safeCurrent}
    >
      <div className="dsm-progressFill" style={{ width: `${percent}%` }} />
    </div>
  )
}
