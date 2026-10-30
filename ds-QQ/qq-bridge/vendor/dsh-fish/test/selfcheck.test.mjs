/**
 * selfcheck.test.mjs —— 2026-10-25 加：自检里那两条「永远红」的回归
 *
 * 用户报了很具体的一组现象：cookie 明明保存成功、账号也登录上了，
 * 自检却一直显示
 *   ✗ B 站登录  还没存
 *   ✗ 连着 B 站  有响应但没有内容
 *
 * 两条都是**形状错误**，不是环境问题：
 *   1. `readOwner()` 是 async，自检里漏了 `await` → 拿到 Promise → `Boolean(ow?.cookie)` 恒 false；
 *   2. `client.popular()` 返回 `{ ok, code, message, data:[…] }` 而不是数组，
 *      原来用 `Array.isArray(r)` 判 → 恒 false → 不管通不通都报「没有内容」。
 *
 * 这组用例守的就是这两点，顺带守「自检的联网请求必须带 cookie」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { runChecks } from '../lib/selfcheck.js'
import { writeOwner } from '../lib/store.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

async function withRoot(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fish-selfcheck-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const ITEM = (r, id) => r.items.find((it) => it.id === id)

test('存过 cookie 之后，自检的「B 站登录」必须是绿的', async () => {
  await withRoot(async (root) => {
    await writeOwner({ mid: '42', nickname: '大号', account: { mid: '9', name: '测试鱼' }, cookie: 'SESSDATA=abc; bili_jct=xyz' }, root)
    const r = await runChecks({ root, net: false, host: {}, peers: [] })
    const it = ITEM(r, 'cookie')
    assert.equal(it.ok, true, `应为绿，实际：${it.detail}`)
    assert.match(it.detail, /已存/)
    assert.match(it.detail, /测试鱼/)
  })
})

test('自检里显示的是登录账号，不拿领养人昵称冒充', async () => {
  await withRoot(async (root) => {
    await writeOwner({ mid: '42', nickname: '大号', cookie: 'SESSDATA=abc; bili_jct=xyz' }, root)
    const it = ITEM(await runChecks({ root, net: false, host: {}, peers: [] }), 'cookie')
    assert.equal(it.detail.includes('大号'), false, '领养人昵称不是登录账号')
  })
})

test('只有 SESSDATA、缺 bili_jct：红，且说清缺什么', async () => {
  await withRoot(async (root) => {
    await writeOwner({ cookie: 'SESSDATA=abc' }, root)
    const it = ITEM(await runChecks({ root, net: false, host: {}, peers: [] }), 'cookie')
    assert.equal(it.ok, false)
    assert.match(it.detail, /bili_jct/)
  })
})

test('popular 返回对象形状：拿到数据就是绿', async () => {
  await withRoot(async (root) => {
    const client = { popular: async () => ({ ok: true, code: 0, message: 'OK', data: [{ bvid: 'BV1' }] }) }
    const it = ITEM(await runChecks({ root, client, net: true, host: {}, peers: [] }), 'net')
    assert.equal(it.ok, true, `应为绿，实际：${it.detail}`)
    assert.match(it.detail, /拿到 1 条/)
  })
})

test('popular 明确失败时，把错误码说出来而不是「有响应但没有内容」', async () => {
  await withRoot(async (root) => {
    const client = { popular: async () => ({ ok: false, code: -352, message: '风控校验失败', data: [] }) }
    const it = ITEM(await runChecks({ root, client, net: true, host: {}, peers: [] }), 'net')
    assert.equal(it.ok, false)
    assert.match(it.detail, /-352/)
    assert.match(it.fix, /风控/)
  })
})

test('真的没内容时，仍然报「有响应但没有内容」', async () => {
  await withRoot(async (root) => {
    const client = { popular: async () => ({ ok: true, code: 0, data: [] }) }
    const it = ITEM(await runChecks({ root, client, net: true, host: {}, peers: [] }), 'net')
    assert.equal(it.ok, false)
    assert.match(it.detail, /有响应但没有内容/)
  })
})

test('源码守门：三处 readOwner 都必须 await（漏了就是上面那两条假红）', async () => {
  const sc = await readFile(join(ROOT, 'lib', 'selfcheck.js'), 'utf8')
  assert.ok(sc.includes('const ow = await readOwner(root)'), '自检里读 owner 要 await')

  const ob = await readFile(join(ROOT, 'lib', 'observe.js'), 'utf8')
  assert.ok(ob.includes('(await readOwner(root))?.cookie'), '/selfcheck 建 client 时要用真 cookie')
  assert.ok(!/cookie: readOwner\(root\)\?\.cookie/.test(ob), '不许留下没 await 的旧写法')

  const vd = await readFile(join(ROOT, 'lib', 'video.js'), 'utf8')
  assert.ok(vd.includes('(await readOwner(root))?.cookie'), '看画面取 cookie 也要 await')
})

test('源码守门：/owner POST 只认登录账号，不许覆盖领养人', async () => {
  const ob = await readFile(join(ROOT, 'lib', 'observe.js'), 'utf8')
  assert.ok(ob.includes('await saveAccount(me, root)'), '「测试登录」成功时要记下登录账号')
  assert.ok(ob.includes('登录的是'), '存 cookie 之后要认一次，并在回执里说登录的是谁')
  assert.equal(
    /saveOwner\(\{\s*mid:\s*String\(me\.mid\)/.test(ob),
    false,
    '不许再把登录账号写进领养人那两格',
  )
})
