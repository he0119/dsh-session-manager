// 测两件事：整段耗时（wall）与**最长一次主线程停顿**（stall）。
//
// 为什么停顿是主角：这个仓库的性能预算按"用户点一下会不会卡"划线（见 AGENTS.md 的「性能与阻塞预算」），
// 而一段总耗时 800 ms 的活如果每 5 ms 让出一轮，用户只看到进度条；反过来总耗时 120 ms 但中间按住主线程
// 120 ms，界面整个僵住。所以每个场景同时报 wall 与 stall，后者对照预算判定。
//
// 停顿用 `monitorEventLoopDelay` 的直方图最大值（1 ms 分辨率）：它量的是事件循环被占住的时长，不包含
// 浏览器渲染与网络。另配一个心跳（默认 5 ms）作交叉校验：两者取大，避免直方图被采样窗口抹掉尖峰。
//
// @module dsh-session-manager/bench/measure
import { monitorEventLoopDelay } from 'node:perf_hooks'

/**
 * 起一只停表，量"事件循环最长一次被占住多久"。
 * @param options.intervalMs 心跳间隔（毫秒）。
 */
export function startStallMeter(options = {}) {
  const intervalMs = options.intervalMs ?? 5
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  let last = performance.now()
  let maxGap = 0
  const timer = setInterval(() => {
    const now = performance.now()
    // 减掉心跳自身那一份：间隔 5 ms 的定时器晚到 7 ms，说明主线程被占了 2 ms。
    maxGap = Math.max(maxGap, now - last - intervalMs)
    last = now
  }, intervalMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last - intervalMs)
      histogram.disable()
      return {
        stallMs: Math.max(0, Math.round(Math.max(maxGap, histogram.max / 1e6))),
        histogramMaxMs: Math.round(histogram.max / 1e6),
        heartbeatMaxMs: Math.round(Math.max(0, maxGap)),
      }
    },
  }
}

/** 中位数（空数组返回 NaN）。 */
export function median(values) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * 量一个动作。
 *
 * `warmup` 次不计入结果（模块加载、JIT、页缓存要热起来）；之后每次各起一只停表，报中位数 wall 与
 * **最大** stall（最坏那一次才是用户会遇到的卡顿）。
 *
 * @param fn 要量的动作（同步或异步）。
 * @param options.iterations 计入的轮数（默认 3）。
 * @param options.warmup 预热轮数（默认 1；冷启动场景传 0）。
 */
export async function measure(fn, options = {}) {
  const iterations = options.iterations ?? 3
  const warmup = options.warmup ?? 1
  for (let i = 0; i < warmup; i++) await fn()
  const walls = []
  const stalls = []
  for (let i = 0; i < iterations; i++) {
    const meter = startStallMeter()
    const started = performance.now()
    await fn()
    const wallMs = performance.now() - started
    const { stallMs } = meter.stop()
    walls.push(wallMs)
    stalls.push(stallMs)
  }
  return {
    wallMs: Math.round(median(walls) * 10) / 10,
    wallSamplesMs: walls.map((value) => Math.round(value * 10) / 10),
    stallMs: Math.max(...stalls),
    rssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }
}
