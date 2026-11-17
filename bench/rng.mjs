// 确定性随机数：同一档规模每次生成的夹具必须逐字节相同，基线才有可比性。
//
// @module dsh-session-manager/bench/rng
/**
 * mulberry32：32 位种子、周期足够、实现只有几行。
 * @param seed 种子。
 * @returns 每次调用返回 [0, 1) 的伪随机数。
 */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 从 [min, max] 里取一个整数。 */
export function between(random, min, max) {
  return min + Math.floor(random() * (max - min + 1))
}
