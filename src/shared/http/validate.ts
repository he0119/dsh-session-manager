// 请求参数里"必须在盘上真的存在"的那一条：目标工作区目录。
//
// 放在传输那一层旁边而不是某个操作里：导入与迁移都要过同一道门，各写一遍迟早一边漏掉。header.cwd
// 指向一个不存在的目录，导入或迁移出来的会话就是坏的——宿主打开它会报 corrupt，而那时已经搬完了。
//
// @module dsh-session-manager/shared/http/validate
import { statSync } from 'node:fs'

export function assertTargetCwd(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('缺少目标工作区目录（targetCwd）')
  const cwd = value.trim()
  let stat
  try {
    stat = statSync(cwd)
  } catch {
    throw new Error(`目标工作区目录不存在：${cwd}`)
  }
  if (!stat.isDirectory()) throw new Error(`目标工作区不是一个目录：${cwd}`)
  return cwd
}
