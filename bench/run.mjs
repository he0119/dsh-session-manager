#!/usr/bin/env node
// bench/run.mjs — 跑基准，并与提交进仓库的基线比一比。
//
// 一次运行 = 生成/复用样例库 → 先跑校准（把机器快慢归一化）→ 每个场景各起一个**子进程**（冷缓存、独立
// RSS、互不污染）→ 汇总成表 → 对照基线判定。
//
// 判定三条：
//   1. 最长主线程停顿不得超过场景预算（绝对毫秒，见 scenarios.mjs 的 `budgetMs`）；
//   2. 归一化后的 wall 不得超过基线的 (1 + tolerance)——除得非常快的小场景（噪声主导）不比 wall；
//   3. 没有基线时只报数（提示 `--update`），不判失败。
//
// @module dsh-session-manager/bench/run
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ensureFixture } from './fixture.mjs'
import { measure } from './measure.mjs'
import { PROFILES } from './profiles.mjs'
import { SCENARIOS } from './scenarios.mjs'

const HERE = import.meta.dirname
const BASELINE_PATH = join(HERE, 'baseline.json')
const BASELINE_VERSION = 1

function parseArgs(argv) {
  const args = { profile: 'default', only: undefined, iterations: undefined, update: false, check: true, json: false, rebuild: false, tolerance: 0.25, child: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') args.profile = argv[++i]
    else if (arg === '--only') args.only = argv[++i].split(',').map((value) => value.trim()).filter(Boolean)
    else if (arg === '--iterations') args.iterations = Number(argv[++i])
    else if (arg === '--update') args.update = true
    else if (arg === '--no-check') args.check = false
    else if (arg === '--json') args.json = true
    else if (arg === '--rebuild') args.rebuild = true
    else if (arg === '--tolerance') args.tolerance = Number(argv[++i])
    else if (arg === '--child') args.child = argv[++i]
    else if (arg === '--list') args.list = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return args
}

/** 子进程：只跑一个场景，把结果按一行 JSON 打到 stdout。 */
async function runChild(args) {
  const manifest = await ensureFixture(args.profile)
  const scenario = SCENARIOS.find((entry) => entry.id === args.child)
  if (scenario === undefined) throw new Error(`未知场景：${args.child}`)
  const state = { manifest }
  await scenario.prepare?.(state)
  const result = await measure(
    () => scenario.run(state),
    {
      iterations: args.iterations ?? scenario.iterations ?? 3,
      // 冷场景不预热（预热就等于把"冷"这件事测没了）；其余也靠 prepare 预热，这里不再重复。
      warmup: 0,
    },
  )
  await scenario.teardown?.(state)
  process.stdout.write(JSON.stringify({ id: scenario.id, ...result }) + '\n')
}

/** 跑一个子进程并解析它最后一行 JSON。 */
function runChildProcess(args, scenarioId) {
  const cli = [join(HERE, 'run.mjs'), '--child', scenarioId, '--profile', args.profile]
  if (args.iterations !== undefined) cli.push('--iterations', String(args.iterations))
  return new Promise((resolve, reject) => {
    execFile(process.execPath, cli, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`场景 ${scenarioId} 失败：${stderr || stdout || error.message}`))
        return
      }
      const line = stdout.trim().split('\n').filter(Boolean).at(-1)
      try {
        resolve(JSON.parse(line))
      } catch {
        reject(new Error(`场景 ${scenarioId} 的输出不是 JSON：${stdout.slice(-500)}`))
      }
    })
  })
}

/**
 * 把样例库的文件先读一遍，摸热 OS 的页缓存。
 *
 * 为什么需要：刚跑完构建或装依赖时，`bench/.work` 那几十 MB 会被挤出页缓存，第一次跑基准就变成
 * 磁盘冷读——2026-11-17 实测 `scan.cold` 因此报了「比基线慢 +364.8%」，紧接着重跑是 -4.1%。
 * 那种红灯量的不是代码，却会训练人「红了就重跑」，门就失效了。所以先摸一遍，让每次跑都从同一个
 * 起点开始；真正"冷"的是应用层的缓存（扫库缓存、日志缓存），那个照旧按各场景的 `prepare` 算。
 *
 * @param manifest `ensureFixture()` 的返回值。
 * @returns 读过的文件数与字节数（打印用）。
 */
function warmFixture(manifest) {
  let files = 0
  let bytes = 0
  const visit = (path) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      // 不是目录（注册表那份 JSON）：直接读它。
      try {
        bytes += readFileSync(path).byteLength
        files += 1
      } catch {
        // 读不动就跳过。
      }
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        // 写操作场景的临时副本（`.tmp-*`）不进统计：它们每次现造现删。
        if (entry.name.startsWith('.tmp-')) continue
        visit(child)
        continue
      }
      if (!entry.isFile()) continue
      try {
        bytes += readFileSync(child).byteLength
        files += 1
      } catch {
        // 读不动的文件（权限、刚好被删）跳过：让它按原样暴露给真正要读它的场景。
      }
    }
  }
  for (const path of [manifest.sessionsRoot, manifest.projectionDir, manifest.davRoot, manifest.registryPath]) visit(path)
  return { files, bytes }
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return undefined
  try {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    return baseline.version === BASELINE_VERSION ? baseline : undefined
  } catch {
    return undefined
  }
}

const percent = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`
const pad = (text, width) => String(text).padEnd(width)

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write('\n用法：pnpm bench [--profile small|default|full] [--only id,id] [--update] [--no-check]\n\n')
    return
  }
  if (args.list === true) {
    for (const scenario of SCENARIOS) process.stdout.write(`${scenario.id.padEnd(20)} ${scenario.title}\n`)
    return
  }
  if (args.child !== undefined) {
    await runChild(args)
    return
  }
  if (PROFILES[args.profile] === undefined) throw new Error(`未知的 profile：${args.profile}`)

  const startedAt = Date.now()
  const manifest = await ensureFixture(args.profile, { rebuild: args.rebuild })
  const warmed = warmFixture(manifest)
  const selected = args.only === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => args.only.includes(scenario.id))
  if (selected.length === 0) throw new Error(`--only 没选中任何场景：${args.only.join(',')}`)

  const calibrationScenario = SCENARIOS.find((scenario) => scenario.id === 'calibration.cpu')
  const calibration = selected.some((scenario) => scenario.id === 'calibration.cpu')
    ? undefined
    : await runChildProcess(args, calibrationScenario.id)

  const results = []
  for (const scenario of selected) {
    results.push(await runChildProcess(args, scenario.id))
  }
  const calibrationMs = calibration?.wallMs ?? results.find((entry) => entry.id === 'calibration.cpu')?.wallMs
  if (calibrationMs === undefined || !(calibrationMs > 0)) throw new Error('校准没有跑出有效耗时')

  const baseline = loadBaseline()
  const baselineProfile = baseline?.profiles?.[args.profile]
  const report = { version: BASELINE_VERSION, profile: args.profile, node: process.version, generatedAt: new Date().toISOString(), calibrationMs, scenarios: {} }
  for (const entry of results) {
    report.scenarios[entry.id] = { wallMs: entry.wallMs, stallMs: entry.stallMs, rssMb: entry.rssMb }
  }

  if (args.json === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(`\n样例库：${manifest.profile} · ${manifest.sessions.length} 条会话 / ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MB · 远端 ${manifest.remote.pushed} 条\n`)
    process.stdout.write(`校准：${calibrationMs.toFixed(1)} ms（wall 一律除以它再比）\n`)
    process.stdout.write(`样例库已摸热：${warmed.files} 个文件 / ${(warmed.bytes / 1024 / 1024).toFixed(1)} MB\n\n`)
    process.stdout.write(`${pad('场景', 20)}${pad('wall(ms)', 10)}${pad('相对基线', 10)}${pad('停顿/预算', 14)}${pad('RSS(MB)', 9)}\n`)
    process.stdout.write('─'.repeat(64) + '\n')
  }

  const failures = []
  for (const scenario of selected) {
    const result = results.find((entry) => entry.id === scenario.id)
    if (result === undefined) continue
    const base = baselineProfile?.scenarios?.[scenario.id]
    let delta
    let normalisedOk = true
    if (base !== undefined && result.wallMs >= 5) {
      const ratio = result.wallMs / calibrationMs / (base.wallMs / baselineProfile.calibrationMs)
      delta = ratio - 1
      normalisedOk = ratio <= 1 + args.tolerance
    }
    // 预算可以按档给（48 MB 的极端日志与 12 MB 的常规日志不是同一条线）。
    const budget = typeof scenario.budgetMs === 'object' ? (scenario.budgetMs[args.profile] ?? scenario.budgetMs.default) : scenario.budgetMs
    const stallOk = budget === undefined || result.stallMs <= budget
    if (!stallOk) failures.push(`${scenario.id} 停顿 ${result.stallMs} ms 超过预算 ${budget} ms`)
    if (!normalisedOk) failures.push(`${scenario.id} wall 比基线慢 ${percent(delta)}（容差 ${percent(args.tolerance)}）`)
    if (args.json !== true) {
      process.stdout.write(
        `${pad(scenario.id, 20)}${pad(result.wallMs.toFixed(1), 10)}${pad(delta === undefined ? '—' : percent(delta), 10)}${pad(budget === undefined ? '—' : `${result.stallMs} / ${budget}`, 14)}${pad(result.rssMb, 9)}\n`,
      )
    }
  }

  if (args.update === true) {
    const next = baseline ?? { version: BASELINE_VERSION, profiles: {} }
    next.version = BASELINE_VERSION
    next.profiles = { ...(next.profiles ?? {}), [args.profile]: { node: process.version, generatedAt: new Date().toISOString(), calibrationMs, scenarios: report.scenarios } }
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n')
    process.stdout.write(`\n基线已写入 ${BASELINE_PATH}（profile=${args.profile}）。\n`)
    return
  }

  if (args.check && failures.length > 0) {
    process.stderr.write(`\n基准未通过（${failures.length} 项）：\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
    process.stderr.write('确认这是有意的取舍再 `pnpm bench:update` 重写基线，并在 PR 里说明。\n')
    process.exitCode = 1
    return
  }
  process.stdout.write(`\n通过：${selected.length} 个场景，用时 ${((Date.now() - startedAt) / 1000).toFixed(1)} s。\n`)
}

await main()
