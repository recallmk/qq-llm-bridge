/**
 * p5.test.mjs —— 2026-10-23 这一轮的回归测试
 *
 * 守四件事：
 *   1. **三个时段各自独立**：把"醒来时间"改坏，不能顺手把"上网时间"也改掉。
 *   2. **上网时段真的生效**：不在时段里就不许碰 B 站接口（不是先请求再丢弃）。
 *   3. **保存不会被 400 挡回来**：观测台提交的 chat / memory / window / browse.window
 *      必须在 /config 的白名单里。曾漏登记过一次，界面点"保存"直接报错。
 *   4. **设置界面文案不带性别代词**：她/他 在面向用户的字符串里必须为零。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { normalizeConfig, inWindow, DEFAULTS } from '../lib/settings.js'
import { lookBeforeWake } from '../lib/scheduler.js'
import { registerObserve } from '../lib/observe.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

test('默认配置里上网时段是独立的一项', () => {
  const cfg = normalizeConfig({})
  assert.deepEqual(cfg.browse.window, ['08:00', '23:00'])
  assert.deepEqual(cfg.window, ['20:00', '23:00'])
  assert.deepEqual(cfg.comment.window, ['20:00', '23:00'])
})

test('坏时段只回退自己那一项，不牵连别的时段', () => {
  const cfg = normalizeConfig({
    window: ['乱写', '23:00'],
    browse: { window: ['09:00', '18:00'] },
    comment: { window: ['09:00', '09:00'] }, // 起止相同 = 无效
  })
  // 醒来时段坏了 → 回默认
  assert.deepEqual(cfg.window, DEFAULTS.window)
  // 上网时段是好的 → 必须原样保留，不能被上一条连坐
  assert.deepEqual(cfg.browse.window, ['09:00', '18:00'])
  // 说话时段起止相同 → 回它自己的默认，不跟 window 走
  assert.deepEqual(cfg.comment.window, DEFAULTS.comment.window)
})

test('上网时段支持跨零点', () => {
  const cfg = normalizeConfig({ browse: { window: ['22:00', '02:00'] } })
  const at = (h) => new Date(2026, 9, 23, h, 30, 0)
  assert.equal(inWindow({ window: cfg.browse.window }, at(23)), true)
  assert.equal(inWindow({ window: cfg.browse.window }, at(1)), true)
  assert.equal(inWindow({ window: cfg.browse.window }, at(12)), false)
})

test('不在上网时段时，一次 B 站接口都不发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5-'))
  try {
    const calls = []
    const client = new Proxy({}, {
      get: (_t, k) => (...a) => { calls.push(String(k)); return { ok: false } },
    })
    const cfg = normalizeConfig({ browse: { window: ['09:00', '10:00'] } })
    const out = await lookBeforeWake(root, { name: '测试' }, cfg, '2026-10-23', {
      client,
      now: new Date(2026, 9, 23, 15, 0, 0), // 15:00，在时段外
      events: [],
    }, () => {})
    assert.deepEqual(out, { text: '', intro: '', picks: [] })
    assert.deepEqual(calls, [], '时段外不该碰任何接口')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('在上网时段内会真的去取素材（证明闸门不是永远关着）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5b-'))
  try {
    const calls = []
    const client = new Proxy({}, {
      get: (_t, k) => (...a) => { calls.push(String(k)); return { ok: false, note: 'stub' } },
    })
    const cfg = normalizeConfig({ browse: { window: ['09:00', '18:00'] } })
    await lookBeforeWake(root, { name: '测试' }, cfg, '2026-10-23', {
      client,
      now: new Date(2026, 9, 23, 10, 0, 0),
      events: [],
    }, () => {})
    assert.ok(calls.length > 0, '时段内应该走进去')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

/** 极简假 ctx：只提供 observe 需要的两个服务 */
function fakeCtx(root) {
  const routes = []
  const cfg = { connection: null }
  const webServer = { register: (def) => { routes.push(def); return () => {} } }
  return {
    routes,
    cfg,
    get: (k) => (k === 'connection' ? cfg.connection : k === 'webServer' ? webServer : undefined),
    webServer,
    tools: { register: () => {} },
    slots: { inject: () => {}, register: () => {} },
    effect: (fn) => fn(),
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    log: () => {},
    root,
  }
}

test('/config 白名单收下观测台提交的全部环境键（含 chat 与 memory）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5c-'))
  try {
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const route = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
    assert.ok(route, '必须有 /config 路由')

    // 这是观测台 save() 实际提交的形状
    const patch = {
      absenceAfterDays: 3,
      wakesPerDay: 1,
      daily: { events: 1, questions: 1 },
      diary: { visible: true, enabled: true },
      avoid: { keywords: ['恐怖'] },
      window: ['19:00', '22:00'],
      browse: { enabled: true, perDay: 2, topN: 5, danmaku: 3, window: ['08:30', '22:30'] },
      notify: { enabled: false },
      chat: { rotateAfter: 30 },
      memory: { docBudget: 1500 },
      comment: { enabled: false, perDay: 1, replyPerDay: 2, replyToReplies: true, scanEveryMin: 30, window: ['20:00', '23:00'] },
    }
    const body = JSON.stringify(patch)
    const req = {
      method: 'POST',
      url: '/dsh-fish/config',
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
    }
    let status = 0
    let payload = null
    const res = {
      writeHead: (s) => { status = s },
      end: (s) => { payload = JSON.parse(s || '{}') },
      setHeader: () => {},
    }
    await route.handler(req, res)
    assert.equal(status, 200, `保存不该被挡回来：${JSON.stringify(payload)}`)
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.config.browse.window, ['08:30', '22:30'])
    assert.deepEqual(payload.config.window, ['19:00', '22:00'])
    assert.equal(payload.config.chat.rotateAfter, 30)
    assert.equal(payload.config.memory.docBudget, 1500)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('白名单仍然挡得住"指向她本人"的键', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-p5d-'))
  try {
    const ctx = fakeCtx(root)
    ctx.cfg.connection = { requestRejection: () => null }
    registerObserve(ctx, { root })
    const route = ctx.routes.find((r) => String(r.path || '').endsWith('/config'))
    const body = JSON.stringify({ persona: { name: '小美' }, traits: { shy: 1 } })
    const req = {
      method: 'POST',
      url: '/dsh-fish/config',
      headers: { 'content-type': 'application/json' },
      on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body, 'utf8')); if (ev === 'end') fn() },
    }
    let status = 0
    const res = { writeHead: (s) => { status = s }, end: () => {}, setHeader: () => {} }
    await route.handler(req, res)
    assert.equal(status, 400)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('设置界面面向用户的文案里不出现男字旁的「他」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  // 只扫字符串字面量，注释不算（注释里保留原话便于追溯）。
  //
  // 口径在 2026-10-24 改过：早期要求「她/他」都为零，是想让界面完全不用
  // 人称代词；后来用户在文案面板里亲手把 15 处「它」改成了「她」，等于
  // 选定了「她」这个写法。规则跟着用户的决定走 —— 现在只禁男字旁的「他」，
  // 「她」是选定写法，「它」留给真正指物的句子（AGENTS.md、事件流、插件）。
  const bad = []
  const re = /(['"`])((?:[^'"`\\\n]|\\.)*)\1/g
  let m
  while ((m = re.exec(src))) {
    // 例外：`其他/其它` 里的「他」是词素（意思是「别的」），不是人称代词。
    const shorn = m[2].replace(/其[他它]/g, '')
    if (/他/.test(shorn)) bad.push(m[2].slice(0, 40))
  }
  assert.deepEqual(bad, [], '面向用户的字符串里不许出现「他」')
})
