// 三档规模：`small` 给日常改动的快速回路，`default` 是合并前要过的那一档，`full` 用来复现大会话库。
//
// 数字都对着真实会话库取的：维护者本机 994～1400 条、最大一份日志压缩后 13.7 MB（解开 48 MB）、
// 一页内容视图 80 条事件、一次迁移几十条。`full` 比本机再大一档，用来确认"库再长一半也不会掉进
// 另一个数量级"。
//
// @module dsh-session-manager/bench/profiles
export const PROFILES = {
  // `hugeBytes`：库里最大那一份日志的**解开后**字节数（真实本机最大一份 48 MB）。内容视图那条场景
  // 专挑它，因为"打开最大的一条会话"是用户唯一会明确感觉到卡的那一下。
  small: { sessions: 80, projects: 8, largeSessions: 1, hugeBytes: 4_000_000, seed: 11 },
  default: { sessions: 400, projects: 24, largeSessions: 4, hugeBytes: 12_000_000, seed: 11 },
  full: { sessions: 1200, projects: 40, largeSessions: 8, hugeBytes: 48_000_000, seed: 11 },
}

/** 事件规模的分布（占全部会话的比例）。真实库里绝大多数会话都很短，长的是少数。 */
export const SIZE_MIX = {
  small: { ratio: 0.6, min: 40, max: 300 },
  medium: { ratio: 0.35, min: 300, max: 2000 },
  large: { ratio: 0.05, min: 3000, max: 9000 },
}
