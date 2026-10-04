// test/repo.test.ts — 跨机器的项目身份：remote 规范化，以及"这条目录属于哪个仓库"。
//
// 这一层决定的是"两台机器怎么认出同一个项目"。判据要能挡住两类错：把同一个仓库的两种写法认成两个
// 项目（ssh 与 https、带不带 .git、带不带用户名），以及把两个无关的目录认成一个（Windows 盘符
// `C:/x` 不能被当成 `host:path`）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalRepo, createGitRunner, createRepoLookup, repoLocation, type GitRunner } from '../src/repo.ts'

test('项目身份：同一个仓库的各种写法归一到同一个身份', () => {
  const same = [
    'git@github.com:he0119/dsh-session-manager.git',
    'ssh://git@github.com/he0119/dsh-session-manager.git',
    'https://github.com/he0119/dsh-session-manager',
    'https://github.com/he0119/dsh-session-manager.git',
    'https://someone@github.com/he0119/dsh-session-manager.git',
    '  https://GitHub.com/he0119/dsh-session-manager.git  ',
    'github.com:he0119/dsh-session-manager',
  ]
  for (const remote of same) {
    assert.equal(canonicalRepo(remote), 'github.com/he0119/dsh-session-manager', remote)
  }
  // host 大小写归一到小写；owner/repo 保持原样（那是仓库自己的名字）
  assert.equal(canonicalRepo('https://gitlab.example.com/Team/Repo.git'), 'gitlab.example.com/Team/Repo')
})

test('项目身份：凭据不进身份（身份要写进远端索引）', () => {
  assert.equal(canonicalRepo('https://alice:ghp_secrettoken@github.com/o/r.git'), 'github.com/o/r')
  assert.equal(canonicalRepo('git@github.com:o/r.git'), 'github.com/o/r')
  // 认不出来的形状原样退回，但凭据照样去掉（scp 的用户名、URL 的 userinfo 都算凭据）
  assert.equal(canonicalRepo('C:/repos/thing'), 'C:/repos/thing')
  // 连 scheme 都没有、又带着凭据的写法：落进原样退回那条路，凭据照样得去掉（它要写进远端索引）
  assert.equal(canonicalRepo('alice:ghp_secrettoken@host/owner/repo'), 'host/owner/repo')
  // scp 的绝对路径写法是**认得出来**的（不是退回原串）：它得与 ssh:// 那条写法归到同一个身份。
  assert.equal(canonicalRepo('alice@fileserver:/srv/git/thing.git'), 'fileserver/srv/git/thing')
  assert.equal(canonicalRepo('ssh://alice@fileserver/srv/git/thing.git'), 'fileserver/srv/git/thing')
  // 带端口的 remote 与不带端口的是两个端点：端口进身份，IPv6 的方括号保留
  assert.equal(canonicalRepo('https://alice:token@[::1]:8080/o/r.git'), '[::1]:8080/o/r')
  assert.equal(canonicalRepo('ssh://git@github.com:2222/o/r.git'), 'github.com:2222/o/r')
})

test('项目身份：认不出来的形状原样退回，不猜', () => {
  // 本机自己的 git 目录：机器相关，能做的只有"原样当身份"
  assert.equal(canonicalRepo('/srv/git/thing.git'), '/srv/git/thing.git')
  assert.equal(canonicalRepo('file:///srv/git/thing.git'), 'file:///srv/git/thing.git')
  // 空串 / 只有空白：没有身份
  assert.equal(canonicalRepo(''), undefined)
  assert.equal(canonicalRepo('   '), undefined)
})

test('项目身份：多个 remote 时优先 origin，没有 origin 就按名字排序取第一个', async () => {
  const asked: string[] = []
  const run: GitRunner = async (args, cwd) => {
    asked.push(args.join(' '))
    assert.equal(cwd, '/work/proj')
    if (args[0] === 'rev-parse') return '/work/proj\n'
    if (args[0] === 'remote') return 'upstream\norigin\n'
    if (args[0] === 'config') return 'git@github.com:o/r.git\n'
    throw new Error(`unexpected ${args.join(' ')}`)
  }
  assert.deepEqual(await repoLocation('/work/proj', run), {
    repo: 'github.com/o/r',
    repoPath: '.',
    root: '/work/proj',
  })
  assert.ok(asked.includes('config --get remote.origin.url'), '有 origin 就用 origin')

  const noOrigin: GitRunner = async (args) => {
    if (args[0] === 'rev-parse') return '/work/proj\n'
    if (args[0] === 'remote') return 'zeta\nbeta\n'
    if (args[0] === 'config') return 'https://example.com/o/r.git\n'
    throw new Error('unexpected')
  }
  assert.equal((await repoLocation('/work/proj', noOrigin))?.repo, 'example.com/o/r')
})

test('项目身份：子目录记下相对路径（拉取回来才能落回同构的位置）', async () => {
  const run: GitRunner = async (args) => {
    if (args[0] === 'rev-parse') return '/work/proj\n'
    if (args[0] === 'remote') return 'origin\n'
    if (args[0] === 'config') return 'git@github.com:o/r.git\n'
    throw new Error('unexpected')
  }
  assert.deepEqual(await repoLocation('/work/proj/packages/web', run), {
    repo: 'github.com/o/r',
    repoPath: 'packages/web',
    root: '/work/proj',
  })
})

test('项目身份：不是仓库 / 没有 remote / git 报错，都当"没有身份"', async () => {
  const boom: GitRunner = async () => {
    throw new Error('not a git repository')
  }
  assert.equal(await repoLocation('/tmp/nope', boom), undefined)

  const noRemote: GitRunner = async (args) => {
    if (args[0] === 'rev-parse') return '/work/proj\n'
    if (args[0] === 'remote') return '\n'
    throw new Error('unexpected')
  }
  assert.equal(await repoLocation('/work/proj', noRemote), undefined)

  const emptyUrl: GitRunner = async (args) => {
    if (args[0] === 'rev-parse') return '/work/proj\n'
    if (args[0] === 'remote') return 'origin\n'
    if (args[0] === 'config') return '\n'
    throw new Error('unexpected')
  }
  assert.equal(await repoLocation('/work/proj', emptyUrl), undefined)
})

test('项目身份：真去跑 git（起一个临时仓库）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsm-repo-'))
  try {
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    }
    git(['init', '--quiet', '--initial-branch=main'])
    git(['remote', 'add', 'origin', 'git@github.com:he0119/demo-proj.git'])
    const found = execFileSync('node', ['--input-type=module', '-e', `
      import { repoLocation, createGitRunner } from '${join(import.meta.dirname, '../src/repo.ts')}'
      const found = await repoLocation('${dir}', createGitRunner())
      process.stdout.write(JSON.stringify(found))
    `], { encoding: 'utf8' })
    const parsed = JSON.parse(found) as { repo: string; repoPath: string; root: string }
    assert.equal(parsed.repo, 'github.com/he0119/demo-proj', '真实 git 上也要认出身份')
    assert.equal(parsed.repoPath, '.')
    // 非仓库的目录：没有身份（而不是抛）
    const none = execFileSync('node', ['--input-type=module', '-e', `
      import { repoLocation, createGitRunner } from '${join(import.meta.dirname, '../src/repo.ts')}'
      process.stdout.write(String(await repoLocation('${tmpdir()}', createGitRunner())))
    `], { encoding: 'utf8' })
    assert.equal(none, 'undefined')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('界面用的项目身份：一个目录一次进程里只问一次 git，认不出来的不记', async () => {
  let calls = 0
  const run: GitRunner = async (args, cwd) => {
    calls += 1
    if (cwd === '/work/a') {
      if (args[0] === 'rev-parse') return '/work/a\n'
      if (args[0] === 'remote') return 'origin\n'
      if (args[0] === 'config') return 'git@github.com:he0119/a.git\n'
    }
    // 不是仓库的目录：`git rev-parse` 失败（真实的 git 就是这么失败的）
    throw new Error(`git ${args.join(' ')} 退出码 128`)
  }
  const lookup = createRepoLookup({ run })
  // 空串（没有 cwd 的那一组）不是目录，压根不该去问 git
  const first = await lookup(['/work/a', '/work/plain', '/work/a', ''])
  assert.deepEqual([...first], [['/work/a', 'github.com/he0119/a']], '只记认出来的那些')
  assert.equal(calls, 4, '一个目录一次：/work/a 三条命令 + /work/plain 一条（空串不问）')

  // 第二次：一个 git 都不问（缓存，认不出来的那些也缓存着）——/state 是页面的热路径
  const second = await lookup(['/work/a', '/work/plain'])
  assert.deepEqual([...second], [['/work/a', 'github.com/he0119/a']])
  assert.equal(calls, 4, '缓存命中就一条命令都不发')
})
