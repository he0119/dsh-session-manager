// src/client/components/ProblemsBlock.tsx — 「没做到 N 条」那一块：六个动作的结果页共用。
//
// 画法与「上次同步」那张卡里那块相同（淡告警底 + 左边一道细线 + 小标签标题 + 逐条原话）：
// 同一个 App 里"这件事没做成"只有一种长相，改一处就是各处一起改。
import * as React from 'react'

import type { Translate } from '../logic/locales.ts'

/**
 * @param props.t 翻译函数。
 * @param props.problems 逐条原话（宿主给的，含会话 id 与原因）。
 * @returns 那一块；没有问题时不渲染。
 */
export function ProblemsBlock({ t, problems }: { t: Translate; problems: readonly string[] }): React.ReactElement | null {
  if (problems.length === 0) return null
  return (
    <div className="dsm-warnBlock">
      <div className="dsm-leftovers">
        <p className="dsm-leftoversTitle">{t('run.problemsTitle', { count: problems.length })}</p>
        <ul className="dsm-listPlain">
          {problems.map((problem) => (
            <li key={problem} className="dsm-leftoverRow">
              <span>{problem}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
