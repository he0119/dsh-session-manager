// WebDAV 客户端：四种方法打真服务，多状态响应的宽容解析单独测。
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { createDavClient, DavError, parseMultiStatus } from '../src/dav.ts'
import { startDavFixture, type DavFixture } from './dav-fixture.ts'

const SANDBOX = join(import.meta.dirname, '.sandbox', 'dav')

function freshRoot(name: string): string {
  const dir = join(SANDBOX, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 起夹具、跑用例、收服务与临时目录（夹具用完立刻删干净）。 */
async function withFixture(
  name: string,
  run: (fixture: DavFixture, client: ReturnType<typeof createDavClient>) => Promise<void>,
  options: {
    /** 夹具要求的凭据。 */
    auth?: { username: string; password: string }
    /** 给客户端用的凭据；缺省与夹具一致（测"凭据错"时给一组不一样的）。 */
    clientAuth?: { username: string; password: string }
  } = {},
): Promise<void> {
  const root = freshRoot(name)
  const fixture = await startDavFixture({ root, ...(options.auth === undefined ? {} : { auth: options.auth }) })
  const credentials = options.clientAuth ?? options.auth
  try {
    await run(fixture, createDavClient({ baseUrl: fixture.url, ...credentials }))
  } finally {
    await fixture.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('dav：put 自动建父集合，get 原样读回', async () => {
  await withFixture('roundtrip', async (fixture, client) => {
    const payload = Buffer.from('hello 会话\n二进制\x00\x01', 'utf8')
    await client.put('machines/robot-a/sess~0041.dshsess', payload)
    assert.deepEqual(await client.get('machines/robot-a/sess~0041.dshsess'), payload)
    // 父集合是客户端自己建的（宿主 PUT 的上一级不存在时服务器回 409）
    assert.ok(
      fixture.requests.some((line) => line === 'MKCOL /dav/machines'),
      `没建中间集合：${fixture.requests.join(', ')}`,
    )
    assert.deepEqual(readFileSync(join(fixture.root, 'machines', 'robot-a', 'sess~0041.dshsess')), payload)
  })
})

test('dav：list 给出子项的种类与字节数，且不含自己', async () => {
  await withFixture('list', async (_fixture, client) => {
    await client.put('machines/robot-a/index.json', Buffer.from('{"a":1}', 'utf8'))
    await client.ensure('machines/robot-b')
    const entries = await client.list('machines')
    assert.deepEqual(
      entries.map((entry) => `${entry.name}:${entry.kind}`).sort(),
      ['robot-a:collection', 'robot-b:collection'],
    )
    const files = await client.list('machines/robot-a')
    assert.deepEqual(files, [{ name: 'index.json', kind: 'file', bytes: 7 }])
  })
})

test('dav：list 一个不存在的集合返回空数组，而不是抛错', async () => {
  await withFixture('missing', async (_fixture, client) => {
    assert.deepEqual(await client.list('machines'), [])
  })
})

test('dav：get 一个不存在的文件抛出带状态码的 DavError', async () => {
  await withFixture('get404', async (_fixture, client) => {
    const error = await client.get('machines/robot-a/index.json').then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    assert.ok(error instanceof DavError)
    assert.equal(error.status, 404)
    assert.equal(error.method, 'GET')
  })
})

test('dav：ensure 幂等（已有集合的 405 不算错）', async () => {
  await withFixture('ensure', async (fixture, client) => {
    await client.ensure('machines/robot-a')
    await client.ensure('machines/robot-a')
    assert.ok(fixture.requests.filter((line) => line === 'MKCOL /dav/machines/robot-a').length >= 2)
  })
})

test('dav：Basic 凭据不对时如实报 401', async () => {
  const auth = { username: 'alice', password: 's3cret' }
  await withFixture(
    'auth',
    async (_fixture, client) => {
      await assert.rejects(
        () => client.list('machines'),
        (error: unknown) => error instanceof DavError && error.status === 401,
      )
    },
    { auth, clientAuth: { username: 'alice', password: 'wrong' } },
  )
  // 凭据对了就能列出来：同一个夹具配置下换个客户端再来一次
  const root = freshRoot('auth-ok')
  const fixture = await startDavFixture({ root, auth })
  try {
    const client = createDavClient({ baseUrl: fixture.url, ...auth })
    await client.put('machines/robot-a/index.json', Buffer.from('{}', 'utf8'))
    assert.equal((await client.list('machines'))[0]?.name, 'robot-a')
  } finally {
    await fixture.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('dav：传输层失败（连不上的地址）报 status 0 而不是崩掉', async () => {
  const client = createDavClient({ baseUrl: 'http://127.0.0.1:1/dav', timeoutMs: 2_000 })
  const error = await client.list('machines').then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof DavError)
  assert.equal(error.status, 0)
})

test('dav：probe 只读地看清资源根、集合与里面有什么（两次 PROPFIND，一个字节都不写）', async () => {
  await withFixture('probe', async (fixture, client) => {
    await client.ensure('machines/robot-a')
    const before = fixture.requests.length
    assert.deepEqual(await client.probe('machines'), {
      rootStatus: 207,
      rootOk: true,
      collectionStatus: 207,
      collectionExists: true,
      entries: [{ name: 'robot-a', kind: 'collection' }],
    })
    // "只读"是这条功能的承诺，所以钉住它发的是什么：恰好两次 PROPFIND。
    assert.deepEqual(
      fixture.requests.slice(before).map((line) => line.split(' ')[0]),
      ['PROPFIND', 'PROPFIND'],
    )
  })
})

test('dav：probe 把"这一层还没建"与"认证不过 / 地址不对 / 连不上"分开报', async () => {
  // 资源根在、要探的集合还没有：404 是正常的第一次（同步会 MKCOL 出来），不是失败。
  await withFixture('probe-missing', async (_fixture, client) => {
    assert.deepEqual(await client.probe('machines'), {
      rootStatus: 207,
      rootOk: true,
      collectionStatus: 404,
      collectionExists: false,
      entries: [],
    })
  })

  // 凭据不对：401 出在资源根那一次上，后面那次不发。
  await withFixture(
    'probe-401',
    async (fixture, client) => {
      const before = fixture.requests.length
      const probe = await client.probe('machines')
      assert.equal(probe.rootStatus, 401)
      assert.equal(probe.rootOk, false)
      assert.equal(probe.collectionStatus, 0, '资源根就没过，不再问第二次')
      assert.deepEqual(probe.entries, [])
      assert.match(String(probe.detail), /401/)
      assert.equal(fixture.requests.length - before, 1)
    },
    { auth: { username: 'alice', password: 's3cret' }, clientAuth: { username: 'alice', password: 'wrong' } },
  )

  // 地址不对（资源根之外）：404。
  const root = freshRoot('probe-404')
  const fixture = await startDavFixture({ root })
  try {
    const client = createDavClient({ baseUrl: `${fixture.url}-typo` })
    const probe = await client.probe('machines')
    assert.equal(probe.rootStatus, 404)
    assert.equal(probe.rootOk, false)
  } finally {
    await fixture.close()
    rmSync(root, { recursive: true, force: true })
  }

  // 连不上：状态码 0 + 原始原因（不抛异常——探测要的是结论）。
  const unreachable = await createDavClient({ baseUrl: 'http://127.0.0.1:1/dav', timeoutMs: 2_000 }).probe('machines')
  assert.equal(unreachable.rootStatus, 0)
  assert.equal(unreachable.rootOk, false)
  assert.ok(typeof unreachable.detail === 'string' && unreachable.detail.length > 0)
})

test('dav：多状态响应解析对前缀、绝对 URL 与实体转义都宽容', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<D:multistatus xmlns:D="DAV:">',
    // 请求的那个集合自己：必须被滤掉
    '<D:response><D:href>/dav/machines/</D:href><D:propstat><D:prop>',
    '<D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>',
    // 无前缀 + 绝对 URL（有些服务器这么回）
    '<response><href>https://dav.example.com/dav/machines/robot-a/</href><propstat><prop>',
    '<resourcetype><collection/></resourcetype></prop></propstat></response>',
    // 小写前缀 + 实体转义的名字 + 字节数
    '<d:response><d:href>/dav/machines/robot-a/index%20x&amp;y.json</d:href><d:propstat><d:prop>',
    '<d:resourcetype/><d:getcontentlength>42</d:getcontentlength>',
    '</d:prop></d:propstat></d:response>',
    '</D:multistatus>',
  ].join('')
  assert.deepEqual(parseMultiStatus(xml, { path: '/dav/machines', relative: 'machines' }), [
    { name: 'robot-a', kind: 'collection' },
    { name: 'index x&y.json', kind: 'file', bytes: 42 },
  ])
})

test('dav：解析不出 response 时返回空数组（畸形响应不阻塞整次同步）', () => {
  assert.deepEqual(parseMultiStatus('<html>不是 multistatus</html>', { path: '/dav/machines', relative: 'machines' }), [])
})
