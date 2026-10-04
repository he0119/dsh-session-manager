/**
 * 跨机器的项目身份：仓库的 git remote。
 *
 * 同步的落地要把"别人的 cwd"换成"这台机器的目录"。拿 cwd 当键（配置里的 `mapping`）时，键是机器特有
 * 的绝对路径，于是配置必然每台机器一份——想多机共用一份配置就做不到。git remote 是**机器无关**的：
 * 同一个仓库克隆到哪儿都是同一个身份，于是配置可以字面一样（`url` 相同、`machineId` 缺省取主机名、
 * `mapping` 留空）。
 *
 * 身份只认 remote，不认目录名与仓库名：同一个仓库在两台机器上叫不同名字的目录也照样对得上；反过来，
 * 两台机器上同名的目录若是两个仓库，也不会被认成同一个项目。
 *
 * 除了同步落地，界面也用这份身份显示"这是哪个项目"（`createRepoLookup()`，`/state` 里那一栏
 * `repos`）：本机绝对路径是机器特有的，同一个项目在两台机器上可以落在完全不同的目录里，而
 * `host/owner/repo` 是仓库自己的名字。
 *
 * 这一层零 DSH 依赖，跑 git 的入口是注入的（[GitRunner]），所以判定逻辑能单测，不必真去克隆。
 *
 * @module dsh-session-manager/repo
 */

import { spawn } from 'node:child_process'
import { relative, sep } from 'node:path'

/** 一条会话所在仓库的信息。 */
export interface RepoLocation {
  /** 规范化后的身份：`host/owner/repo`。 */
  repo: string
  /** 会话的 cwd 在仓库根之下的相对路径（POSIX 分隔符）；仓库根自己就是 `.`。 */
  repoPath: string
  /** 仓库根（本机绝对路径）。 */
  root: string
}

/** 跑一条 git 命令并返回 stdout；失败时 reject。注入是为了可测。 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

/** 去掉 URL 里的凭据（`https://user:token@host/...` → `https://host/...`）。 */
function stripCredentials(raw: string): string {
  return raw.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/@]*@/, '$1').replace(/^[^/@\s]+@/, '')
}

/** 仓库路径部分的规范形式：去掉两头斜杠与结尾的 `.git`。 */
function trimRepoPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

/**
 * 把一条 remote 规范化成机器无关的身份。
 *
 * 认这几种写法（同一仓库在它们之间切换时身份不变）：`git@host:owner/repo.git`、
 * `ssh://git@host/owner/repo.git`、`https://host/owner/repo`、`https://user@host/owner/repo.git`。
 * host 一律小写，owner/repo 保持原样（那是仓库自己的名字）。
 *
 * 认不出来的（`file://`、裸路径、本机自己的 git 目录、以及 host 既没有 `@` 也没有点的 scp 形状——
 * 那种与 Windows 盘符 `C:/x` 无从区分）**原样退回**，只去掉凭据：同一个字符串在别的机器上也是同一个
 * 字符串，身份照样成立，只是没被规范化。凭据（用户名/令牌）任何情况下都不进身份，因为它要写进远端
 * 索引。
 *
 * @param remote git remote 的原文。
 * @returns 身份；空串时 undefined。
 */
export function canonicalRepo(remote: string): string | undefined {
  const raw = remote.trim()
  if (raw === '') return undefined
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return stripCredentials(raw)
    }
    // `file://` 与 `ssh:///path` 这类没有主机的，退回原串（它多半是机器相关的路径）。
    if (url.protocol === 'file:' || url.hostname === '') return stripCredentials(raw)
    // 带端口的 remote 与不带端口的是两个端点（同一个 host 上不同端口的仓库不是同一个），端口进身份。
    const host = `${url.hostname.toLowerCase()}${url.port === '' ? '' : `:${url.port}`}`
    const path = trimRepoPath(url.pathname)
    return path === '' ? host : `${host}/${path}`
  }
  const scp = /^(?:([^/@\s]+)@)?([^/:\s]+):(?!\\)(.+)$/.exec(raw)
  // host 带 `@`（`git@host:...`）或带点（`github.com:...`）才认；`C:/x` 这种盘符与它无从区分，退回原串。
  if (scp !== null && (scp[1] !== undefined || (scp[2] ?? '').includes('.'))) {
    const host = (scp[2] ?? '').toLowerCase()
    const path = trimRepoPath(scp[3] ?? '')
    return path === '' ? host : `${host}/${path}`
  }
  return stripCredentials(raw)
}

/** 跑一条 git 命令；任何失败（没装 git、不是仓库、超时）都当成"没有这个信息"。 */
async function git(run: GitRunner, args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    return await run(args, cwd)
  } catch {
    return undefined
  }
}

/**
 * 一条目录所在仓库的身份与相对位置。
 *
 * 多条 remote 时优先 `origin`，没有 `origin` 就按名字排序取第一个：结果要确定，不跟着 git 的输出
 * 顺序走。
 *
 * @param dir 会话的 cwd（可以是仓库里的子目录）。
 * @param run 跑 git 的入口。
 * @returns 身份；不是仓库、没有 remote、读不出身份时 undefined（调用方退回 cwd 那条老路）。
 */
export async function repoLocation(dir: string, run: GitRunner): Promise<RepoLocation | undefined> {
  const root = (await git(run, ['rev-parse', '--show-toplevel'], dir))?.trim()
  if (root === undefined || root === '') return undefined
  const listed = (await git(run, ['remote'], dir))?.split('\n').map((line) => line.trim())
  const remotes = (listed ?? []).filter((line) => line !== '')
  if (remotes.length === 0) return undefined
  const name = remotes.includes('origin') ? 'origin' : [...remotes].sort()[0]
  const url = (await git(run, ['config', '--get', `remote.${name}.url`], dir))?.trim()
  if (url === undefined || url === '') return undefined
  const repo = canonicalRepo(url)
  if (repo === undefined) return undefined
  const rel = relative(root, dir).split(sep).join('/')
  return { repo, repoPath: rel === '' ? '.' : rel, root }
}

/**
 * 真去跑 git 的入口。
 *
 * 关掉两件会挂住宿主的事：`GIT_TERMINAL_PROMPT=0`（没有终端时不要去问凭据）与 `GIT_OPTIONAL_LOCKS=0`
 * （读身份不该去抢索引锁）。每个调用都带超时——这一步是给同步用的旁路信息，读不到就退回老路，不值得
 * 卡住整次同步。
 *
 * @param options.timeoutMs 单条命令的上限，缺省 2000ms。
 * @returns 跑 git 的入口。
 */
export function createGitRunner(options: { timeoutMs?: number } = {}): GitRunner {
  const timeout = options.timeoutMs ?? 2000
  return (args, cwd) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-C', cwd, ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8')
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`git ${args.join(' ')} 退出码 ${String(code)}：${err.trim().slice(0, 200)}`))
      })
    })
}

/** 一批目录的项目身份：目录路径 → `host/owner/repo`；认不出来的目录不在表里。 */
export type RepoMap = ReadonlyMap<string, string>

/**
 * 认一批目录的项目身份（界面要按目录显示"这是哪个项目"）。
 *
 * **进程内缓存**：同一个目录只问一次 git——身份是仓库自己的名字，一个插件实例的生命周期里几乎不变，
 * 而 `/state` 是页面的热路径（每帧都拉一次），每次都为二十来个目录起 git 进程会把列个会话拖慢。
 * 代价是**改了 remote 要重启 DSH 才会刷新显示**（同步落地那条路不复用这份缓存，它每次现读，
 * 所以"落到哪儿"永远是对的，只有这一行字会旧）。
 *
 * 目录不存在、不是仓库、没有 remote、没装 git——一律记成"没有身份"并缓存下来，不会每次重问。
 *
 * @param options.run 跑 git 的入口（可注入，便于测试）。
 * @returns 认身份的函数。
 */
export function createRepoLookup(options: { run?: GitRunner } = {}): (dirs: readonly string[]) => Promise<RepoMap> {
  const run = options.run ?? createGitRunner()
  const cache = new Map<string, Promise<string | undefined>>()
  return async (dirs: readonly string[]): Promise<RepoMap> => {
    const wanted = [...new Set(dirs.filter((dir) => dir !== ''))]
    const found = await Promise.all(
      wanted.map(async (dir): Promise<[string, string] | undefined> => {
        let pending = cache.get(dir)
        if (pending === undefined) {
          pending = repoLocation(dir, run).then((location) => location?.repo)
          cache.set(dir, pending)
        }
        const repo = await pending
        return repo === undefined ? undefined : [dir, repo]
      }),
    )
    const out = new Map<string, string>()
    for (const entry of found) if (entry !== undefined) out.set(entry[0], entry[1])
    return out
  }
}
