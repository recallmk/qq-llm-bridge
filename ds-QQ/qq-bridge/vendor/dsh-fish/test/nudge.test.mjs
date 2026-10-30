/**
 * nudge.test.mjs —— 「让她去刷 B 站」按钮（仅本机测试版，2026-10-26 用户 m00928）
 *
 * 这个按钮只做两件事，两件都必须能单独证明：
 *   1. `.dev` 文件在不在决定它出不出现（否则正式版会把这个探针一起带出去）；
 *   2. focus=browse 时**绕过**上网时段与当日上限——不然「验证她到底能不能刷」
 *      会被「今天已经刷过了」挡在门口，一按就是「没叫」，看不出任何东西。
 *
 * 注意：绕过的是**闸门**，不是风控。风控（risk cooldown）照旧生效——
 * 那一条是保护她别把 B 站惹毛，不是产品的功能开关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookBeforeWake } from '../lib/scheduler.js'
import { normalizeConfig } from '../lib/settings.js'
import { devMode } from '../lib/devmode.js'

const cleanup = async (root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

test('forceBrowse：不在上网时段、今天额度也用完了，照样会去取素材', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-nudge-'))
  try {
    const calls = []
    const client = new Proxy({}, {
      get: (_t, k) => (...a) => { calls.push(String(k)); return { ok: false, note: 'stub' } },
    })
    const cfg = normalizeConfig({
      browse: { enabled: true, perDay: 1, window: ['09:00', '10:00'] },
    })
    // 15:00 在时段外；events 里给它一条今天已经刷过的记录，把 perDay 也耗掉。
    const today = '2026-10-23'
    const events = [{ type: 'browse', dateKey: today, at: Date.parse('2026-10-23T10:05:00') }]
    await lookBeforeWake(root, { name: '测试' }, cfg, today, {
      client,
      now: new Date(2026, 9, 23, 15, 0, 0),
      events,
      forceBrowse: true,
    }, () => {})
    assert.ok(calls.length > 0, '按下按钮就该真的去碰 B 站，而不是被时段/配额挡回来')
  } finally { await cleanup(root) }
})

test('同一份配置，没有 forceBrowse 时仍然一次都不发（证明闸门不是被悄悄拆了）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-nudge2-'))
  try {
    const calls = []
    const client = new Proxy({}, {
      get: (_t, k) => (...a) => { calls.push(String(k)); return { ok: false, note: 'stub' } },
    })
    const cfg = normalizeConfig({ browse: { enabled: true, perDay: 1, window: ['09:00', '10:00'] } })
    const out = await lookBeforeWake(root, { name: '测试' }, cfg, '2026-10-23', {
      client,
      now: new Date(2026, 9, 23, 15, 0, 0),
      events: [],
    }, () => {})
    assert.deepEqual(calls, [], '定时唤醒该守的时段，不能被测试按钮顺带放开')
    assert.equal(out.text, '')
  } finally { await cleanup(root) }
})

test('devMode：有 .dev 文件才算本机测试版', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-dev-'))
  const old = process.env.DSH_FISH_DEV
  delete process.env.DSH_FISH_DEV
  try {
    assert.equal(await devMode(root), false, '什么都没有时不该出现测试按钮')
    await writeFile(join(root, '.dev'), '1')
    assert.equal(await devMode(root), true)
  } finally {
    if (old !== undefined) process.env.DSH_FISH_DEV = old
    else delete process.env.DSH_FISH_DEV
    await cleanup(root)
  }
})
