/**
 * p1.test.mjs —— P1 收尾修复的回归测试
 *
 * 覆盖四件以前没有测试守住的事：
 *   1. rebuild() 真的能从事件流复原（以前只有一句注释声称"由 test 守住"）
 *   2. 日记走 diary/ 而不是事件流（否则 /events 会绕过 diary.visible 泄出去）
 *   3. seen 标记只在"窗口外"写（否则冷落检测永远测不出来）
 *   4. absence 的四种不落库情形 + 落库时带 days
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, rm as rmf } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerCapture } from '../lib/capture.js'
import { readEvents, paths, writeConfig, rebuild, readState } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { assess, detectAbsence, lastSeenAt, lastAbsenceEvent } from '../lib/absence.js'
import { withWake, enterWake, leaveWake, inWake } from '../lib/wakewin.js'

const DAY = 86_400_000

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-p1-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeCtx() {
  const regs = new Map()
  return {
    regs,
    tools: { register: (spec) => { regs.set(spec.name, spec); return () => regs.delete(spec.name) } },
  }
}

// ---------------------------------------------------------------- rebuild

test('rebuild：删掉 state.json 后能完全复原', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    // withWake 里写 = 不算"他来过"，免得顺手多出两条 seen meta 干扰计数
    await withWake(async () => {
      await tool.execute({ type: 'utterance', text: '我不太喜欢吵。' })
      await tool.execute({ type: 'refusal', text: '这个我不想说。' })
    })

    const first = await rebuild(root)
    assert.equal(first.events, 2, '两条事件，没有多余的 seen')
    assert.equal(first.beliefCount, 1)

    // 删掉快照，再复原
    await rmf(paths(root).state, { force: true })
    assert.equal(await readState(root), null)

    const second = await rebuild(root)
    for (const k of ['day', 'stage', 'stageName', 'name', 'beliefCount', 'absenceDays']) {
      assert.deepEqual(second[k], first[k], `${k} 复原后必须一致`)
    }
    assert.ok(second.builtAt, 'builtAt 要写')
    assert.deepEqual(second.needs, first.needs)
  })
})

test('state.json 是派生品：手改它不会改变她的判断', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    await ctx.regs.get('growth_commit').execute({ type: 'utterance', text: '一句普通的话。' })
    await rebuild(root)

    // 伪造一个"好感度爆满"的快照
    await writeFile(paths(root).state, JSON.stringify({ beliefCount: 999, stage: 4 }), 'utf8')

    const { events } = await readEvents(root)
    const m = deriveSelf(events)
    assert.equal(m.beliefCount, 1, '真相源是事件流，快照被改不影响判断')
    assert.notEqual(m.stage, 4)
  })
})

// ---------------------------------------------------------------- 日记

test('日记写进 diary/，不进事件流（否则会绕过可见性设置）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    const out = await tool.execute({ type: 'diary', text: '今天没人来。屋子里很静。' })
    assert.equal(out.ok, true)

    // 文件真的存在
    const raw = await readFile(join(paths(root).diaryDir, `${dateKey()}.md`), 'utf8')
    assert.ok(raw.includes('今天没人来'))

    // 事件流里只有 meta 标记，没有日记正文
    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'meta')
    assert.ok(String(events[0].text).startsWith('diary:'))
    assert.ok(!JSON.stringify(events).includes('屋子里很静'), '日记正文绝不能出现在事件流里')
  })
})

test('日记返回值不暴露写给谁看 / 写在哪', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({ type: 'diary', text: '随便写一句。' })
    const dumped = JSON.stringify(out)
    for (const leak of ['visible', 'diary/', '.dsh-fish', 'root', '给你看']) {
      assert.ok(!dumped.includes(leak), `返回值不应含 ${leak}`)
    }
  })
})

test('日记关掉之后写不进去', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ diary: { enabled: false } }), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({ type: 'diary', text: '想写但关了。' })
    assert.equal(out.ok, false)
    const { events } = await readEvents(root)
    assert.equal(events.length, 0)
  })
})

test('空的日记被拒，不落空文件', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({ type: 'diary', text: '   ' })
    assert.equal(out.ok, false)
  })
})

// ---------------------------------------------------------------- seen

test('窗口外写东西 → 记一条 seen；窗口内不记', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')

    // 窗口内（模拟定时器叫醒她）
    await withWake(async () => {
      await tool.execute({ type: 'utterance', text: '我自己想到的。' })
    })
    let { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 0)
    assert.equal(inWake(), false, 'withWake 退出后窗口必须关掉')

    // 窗口外（他跟她说话）
    await tool.execute({ type: 'utterance', text: '他问我了。' })
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 1)
  })
})

test('withWake 抛异常也把窗口关上', async () => {
  enterWake()
  enterWake()
  leaveWake()
  assert.equal(inWake(), true)
  leaveWake()
  assert.equal(inWake(), false)
  leaveWake()
  assert.equal(inWake(), false, '减到 0 以下要夹住')

  await assert.rejects(() => withWake(async () => { throw new Error('boom') }))
  assert.equal(inWake(), false)
})

// ---------------------------------------------------------------- absence

function seenEvent(ms) {
  return { id: 'ev_x', type: 'meta', text: `seen:${new Date(ms).toISOString()}`, ts: new Date(ms).toISOString() }
}

test('absence：从没联系过（刚装）不判冷落', () => {
  const a = assess([], Date.now(), { afterDays: 2 })
  assert.equal(a.absent, false)
  assert.equal(a.reason, 'no-contact-yet')
})

test('absence：没到阈值不判，到了就判', () => {
  const now = Date.now()
  const ev = [seenEvent(now - 1 * DAY)]
  assert.equal(assess(ev, now, { afterDays: 2 }).reason, 'within-threshold')
  assert.equal(assess(ev, now, { afterDays: 1 }).absent, true)
})

test('absence：同一次冷落不重复写；他回来之后才算结束', () => {
  const now = Date.now()
  const seenAt = now - 5 * DAY
  const abs = { id: 'ev_a', type: 'absence', text: '他有 3 天没出现。', days: 3, ts: new Date(now - 2 * DAY).toISOString() }

  // seen 早于 absence → 还是同一次冷落
  assert.equal(assess([seenEvent(seenAt), abs], now, { afterDays: 2 }).reason, 'already-recorded')

  // seen 晚于 absence → 他回来了
  const laterSeen = now - 1 * DAY
  assert.equal(assess([seenEvent(laterSeen), abs], now, { afterDays: 2 }).reason, 'returned')
})

test('detectAbsence 落库时带上按毫秒算的 days', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ absenceAfterDays: 2 }), root)
    const now = Date.now()

    // 手工塞一条 4 天前的 seen（走 appendEvent 会被打上当前 ts，这里直接写文件）
    const line = JSON.stringify({ ...seenEvent(now - 4 * DAY), id: 'ev_01J0000000000000000000000A', day: 1, stage: 1, source: 'system', refs: [], verdict: null, confidence: 0.5, flags: [] })
    const { mkdir, appendFile } = await import('node:fs/promises')
    await mkdir(root, { recursive: true })
    await appendFile(paths(root).events, line + '\n', 'utf8')

    const r = await detectAbsence(root, { now })
    assert.equal(r.written, true)
    assert.ok(r.days >= 3, `应该算出 3–4 天，实际 ${r.days}`)

    const { events } = await readEvents(root)
    const abs = lastAbsenceEvent(events)
    assert.ok(abs, '必须落一条 absence')
    assert.equal(abs.type, 'absence')
    assert.equal(abs.source, 'system')
    assert.equal(abs.days, r.days, 'days 必须写进事件')

    // 第二次调用不重复写
    const r2 = await detectAbsence(root, { now: now + 1000 })
    assert.equal(r2.written, false)
    assert.equal((await readEvents(root)).events.filter((e) => e.type === 'absence').length, 1)
  })
})

test('deriveSelf 优先用 absence.days，不用 day 差', async () => {
  // 同一天里写两条 absence，day 差为 0 —— 只有 days 字段能救
  const now = Date.now()
  const seed = { id: 'ev_01J0000000000000000000000S', type: 'seed', text: '起点。', ts: new Date(now - 10 * DAY).toISOString(), day: 1, stage: 1 }
  const abs = {
    id: 'ev_01J0000000000000000000001A',
    type: 'absence',
    text: '他有 6 天没出现。',
    days: 6,
    day: 11,
    stage: 1,
    ts: new Date(now - 1 * DAY).toISOString(),
    refs: [], verdict: null, confidence: 0.5, flags: [], source: 'system',
  }
  const m = deriveSelf([seed, abs])
  assert.equal(m.absenceDays, 6, 'days 字段优先于 day 差（day 差会算成 0）')
})

test('lastSeenAt 取最大的 seen 时刻', () => {
  const now = Date.now()
  const evs = [seenEvent(now - 3 * DAY), seenEvent(now - 1 * DAY), seenEvent(now - 2 * DAY)]
  const at = lastSeenAt(evs)
  assert.equal(at, Date.parse(new Date(now - 1 * DAY).toISOString()))
})
