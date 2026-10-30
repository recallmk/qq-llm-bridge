/**
 * watch.test.mjs —— `bili_watch` 的计数与拒绝分支。
 *
 * 真的抽帧要联网 + 开 ffmpeg，这里不测；测的是她会踩到的那几条边界：
 * 开关关着、给的不是视频号、额度用完。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { watchedToday, registerWatch } from '../lib/watch.js'
import { appendEvent } from '../lib/store.js'
import { updateConfig } from '../lib/settings.js'

test('watchedToday 只数当天的 watched: 记录，昨天的不算', () => {
  const dk = '2026-10-23'
  const events = [
    { type: 'meta', text: `watched:${dk} BV1` },
    { type: 'meta', text: `watched:${dk} BV2` },
    { type: 'meta', text: 'watched:2026-10-22 BV3' },
    { type: 'utterance', text: 'watched:2026-10-23 不在 meta 里，不算' },
    { type: 'meta', text: 'browse:2026-10-23 BV4' },
  ]
  assert.equal(watchedToday(events, dk), 2)
  assert.equal(watchedToday([], dk), 0)
  assert.equal(watchedToday(null, dk), 0)
})

function fakeCtx() {
  const tools = []
  return {
    tools: { register: (t) => { tools.push(t); return { dispose() {} } } },
    _tools: tools,
  }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fish-watch-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('registerWatch：注册一个叫 bili_watch 的工具，参数是合法 JSON Schema', () => {
  const ctx = fakeCtx()
  registerWatch(ctx, { root: join(tmpdir(), 'dsh-fish-watch-test') })
  assert.equal(ctx._tools.length, 1)
  const t = ctx._tools[0]
  assert.equal(t.name, 'bili_watch')
  assert.equal(t.parameters.type, 'object')
  assert.ok(t.parameters.properties.bvid)
  assert.deepEqual(t.parameters.required, ['bvid'])
  assert.equal(t.output.render.length >= 0, true)
})

test('registerWatch：开关关着时拒，且不暴露"管理员不让看"', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在打不开。')
    assert.doesNotMatch(out.note, /管理员|权限|设置/)
  })
})

test('registerWatch：给的不是视频号就直说，不去联网', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: '不是视频号' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '这不是一个视频号。')
  })
})

test('registerWatch：画面功能关掉时拒，理由与"打不开"分开', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: false } }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '现在看不了画面。')
  })
})

test('registerWatch：额度已经用完时只说"不想看了"，不报数字', async () => {
  await withRoot(async (root) => {
    await updateConfig({ browse: { enabled: true }, video: { enabled: true, perDay: 1 } }, root)
    const { dateKey } = await import('../lib/settings.js')
    const dk = dateKey()
    await appendEvent({ type: 'meta', text: `watched:${dk} BV1xx411c7mD` }, { source: 'system' }, root)
    const ctx = fakeCtx()
    registerWatch(ctx, { root })
    const out = await ctx._tools[0].execute({ bvid: 'BV1ED4y1Y7dc' })
    assert.equal(out.ok, false)
    assert.equal(out.note, '今天不想再看画面了。')
    assert.doesNotMatch(out.note, /\d/)
  })
})
