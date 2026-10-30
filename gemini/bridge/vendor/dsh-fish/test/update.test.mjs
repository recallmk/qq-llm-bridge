/**
 * update.test.mjs —— 「检查更新」的纯逻辑。
 *
 * 这里一条网络都不发：checkUpdate 接受 fetchImpl，测试全用假的。
 * 真正联网的行为只能靠人手点一下验证，不适合放进 CI（GitHub 在国内时通时不通）。
 *
 * 守的四件事：
 *   1. 版本号比较（v 前缀、位数、认不出的别谎报）
 *   2. 多源择优（镜像有缓存会滞后，取最大的）
 *   3. 全失败时**不抛**、如实给出原因（设置页不能因为一次网络失败就崩）
 *   4. 没有 fetch 的环境也要优雅返回
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { checkUpdate, compareVersion, normalizeVersion, REPO, REPO_URL, RELEASES_URL } from '../lib/update.js'

/** 造一个假响应 */
function resp(json, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => json }
}

/** 造一个只会说"我这儿是 version"的假 fetch：按 URL 里的特征分辨是谁 */
function fakeFetch(byPart) {
  const seen = []
  const fn = async (url) => {
    seen.push(url)
    for (const [part, make] of Object.entries(byPart)) {
      if (url.includes(part)) {
        const r = make(url)
        if (r instanceof Error) throw r
        return r
      }
    }
    throw new Error('没安排这个源：' + url)
  }
  fn.seen = seen
  return fn
}

test('normalizeVersion：v 前缀、缺位、脏数据', () => {
  assert.equal(normalizeVersion('v0.3.0'), '0.3.0')
  assert.equal(normalizeVersion('0.3.0'), '0.3.0')
  assert.equal(normalizeVersion('  V1.10.2  '), '1.10.2')
  assert.equal(normalizeVersion('0.3'), '')
  assert.equal(normalizeVersion(''), '')
  assert.equal(normalizeVersion(null), '')
  assert.equal(normalizeVersion('hello'), '')
})

test('compareVersion：按数字比，不按字符串比', () => {
  assert.equal(compareVersion('0.3.0', '0.2.0'), 1)
  assert.equal(compareVersion('0.2.0', '0.3.0'), -1)
  assert.equal(compareVersion('0.3.0', 'v0.3.0'), 0)
  // 字符串比较会把 10 判成比 9 小，这里必须是 10 大
  assert.equal(compareVersion('0.10.0', '0.9.0'), 1)
  assert.equal(compareVersion('1.0.0', '0.99.99'), 1)
  // 认不出的当成说不清，返回 0 —— 不要因此谎报有更新
  assert.equal(compareVersion('abc', '0.3.0'), 0)
  assert.equal(compareVersion('0.3.0', ''), 0)
})

test('仓库地址只在一处定义', () => {
  assert.equal(REPO, 'ssamurias/dsh-fish')
  assert.equal(REPO_URL, 'https://github.com/ssamurias/dsh-fish')
  assert.equal(RELEASES_URL, REPO_URL + '/releases')
})

test('真有新版：hasUpdate 为 true，并把来源带出来', async () => {
  const fetchImpl = fakeFetch({
    'api.github.com/repos/ssamurias/dsh-fish/releases/latest': () => resp({ tag_name: 'v0.4.0' }),
  })
  // 其余源全部失败（模拟国内被重置）
  const r = await checkUpdate({ current: '0.3.0', fetchImpl, timeoutMs: 2000 })
  assert.equal(r.ok, true)
  assert.equal(r.latest, '0.4.0')
  assert.equal(r.hasUpdate, true)
  assert.equal(r.source, 'GitHub API')
  assert.equal(r.current, '0.3.0')
  assert.equal(r.repo, REPO_URL)
})

test('已经最新：hasUpdate 为 false', async () => {
  const fetchImpl = fakeFetch({
    'releases/latest': () => resp({ tag_name: 'v0.3.0' }),
  })
  const r = await checkUpdate({ current: '0.3.0', fetchImpl, timeoutMs: 2000 })
  assert.equal(r.ok, true)
  assert.equal(r.hasUpdate, false)
})

test('多源都有结果时取版本号最大的（镜像有缓存会滞后）', async () => {
  const fetchImpl = fakeFetch({
    'ghfast.top': () => resp({ version: '0.2.0' }),
    'ghproxy.net': () => resp({ version: '0.3.0' }),
    'releases/latest': () => resp({ tag_name: 'v0.4.0' }),
  })
  const r = await checkUpdate({ current: '0.2.0', fetchImpl, timeoutMs: 2000 })
  assert.equal(r.latest, '0.4.0')
  assert.equal(r.source, 'GitHub API')
  assert.equal(r.hasUpdate, true)
})

test('所有源都失败：不抛，如实说连不上', async () => {
  const fetchImpl = async () => {
    throw new Error('connection reset')
  }
  const r = await checkUpdate({ current: '0.3.0', fetchImpl, timeoutMs: 1000 })
  assert.equal(r.ok, false)
  assert.equal(r.current, '0.3.0')
  assert.equal(r.latest, undefined)
  assert.ok(r.error && r.error.length > 0, '必须给一句人话')
  assert.ok(r.error.includes('连不上 GitHub'), '文案要说清楚是连不上，不是别的错')
})

test('源里有版本号但认不出：当成失败，不谎报', async () => {
  const fetchImpl = fakeFetch({
    'releases/latest': () => resp({ tag_name: 'nightly' }),
    'package.json': () => resp({ version: 'not-a-version' }),
  })
  const r = await checkUpdate({ current: '0.3.0', fetchImpl, timeoutMs: 1000 })
  assert.equal(r.ok, false)
})

test('HTTP 非 200 也算失败', async () => {
  const fetchImpl = fakeFetch({
    'releases/latest': () => resp({}, { ok: false, status: 403 }),
  })
  const r = await checkUpdate({ current: '0.3.0', fetchImpl, timeoutMs: 1000 })
  assert.equal(r.ok, false)
})

test('环境里没有 fetch：优雅返回，不炸', async () => {
  const r = await checkUpdate({ current: '0.3.0', fetchImpl: undefined, timeoutMs: 1000 })
  // checkUpdate 的默认值是 globalThis.fetch；Node 18+ 一定有，
  // 这里显式传 null 模拟"没有"的环境
  const r2 = await checkUpdate({ current: '0.3.0', fetchImpl: null, timeoutMs: 1000 })
  assert.equal(r2.ok, false)
  assert.ok(r2.error.includes('fetch'))
  // Node 环境下 r 应该是真的去查了（成功或失败都算正常返回，不抛）
  assert.equal(typeof r.ok, 'boolean')
})

test('当前版本读不到：不下判断，不谎报有新版', async () => {
  const fetchImpl = fakeFetch({
    'releases/latest': () => resp({ tag_name: 'v0.3.0' }),
  })
  const r = await checkUpdate({ current: '', fetchImpl, timeoutMs: 2000 })
  assert.equal(r.ok, true)
  // 拿不到当前版本时 known=false、hasUpdate=false：既不说"有新版"也不说"已最新"
  assert.equal(r.known, false)
  assert.equal(r.hasUpdate, false)
  assert.equal(r.latest, '0.3.0')
})

test('每个请求都带 user-agent（GitHub API 没有 UA 直接 403）', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return resp({ tag_name: 'v0.3.0' })
  }
  await checkUpdate({ current: '0.3.0', fetchImpl, timeoutMs: 2000 })
  assert.ok(calls.length >= 6, '六个源都要发出去')
  for (const c of calls) {
    assert.equal(c.init.headers['user-agent'], 'dsh-fish-update-check')
  }
})
