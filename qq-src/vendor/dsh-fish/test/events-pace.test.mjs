import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findTemplate, isSpent, paceScale, scaledEveryDays, absenceThreshold, staleAfter,
} from '../lib/events.js'
import { pick } from '../lib/generator.js'
import { gapSinceLastWake, gapSqueeze } from '../lib/scheduler.js'
import { CATALOG } from '../lib/events.js'

const DAY = 86_400_000
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()

function model(over = {}) {
  return {
    seed: 'seed', day: 3, growthDays: 30, stage: 4, stageName: '整合', name: null,
    beliefs: [], beliefCount: 0, refuted: [], refusals: [], selfmodAttempts: [],
    reunions: [], corrected: 0, tested: [], narrative: null,
    needs: { autonomy: 0.5, competence: 0.2, relatedness: 0.5 },
    absenceDays: 0, solid: [], tensions: [], voices: [], freshVoice: null, scars: [],
    lastSeenAt: 0, lastWakeAt: 0, spokenSinceSeen: false, heardSinceWake: false,
    ...over,
  }
}
const today = (o = {}) => ({ dateKey: '2026-10-25', sent: 0, questions: 0, proactive: 0, ...o })
const fired = (id, daysAgo) => new Map([[id, { id, count: 1, lastAt: Date.now() - daysAgo * DAY }]])

// ---------- 成长期缩放 ----------

test('paceScale：30 天不变，7 天缩短，180 天放宽，非法值回落 1', () => {
  assert.equal(paceScale(30), 1)
  assert.ok(paceScale(7) < 0.6, `7 天应该明显缩短，实际 ${paceScale(7)}`)
  assert.ok(paceScale(180) > 2, `180 天应该明显放宽，实际 ${paceScale(180)}`)
  assert.equal(paceScale(undefined), 1)
  assert.equal(paceScale('abc'), 1)
  // 两端夹紧，别把 7 天压成 0
  assert.ok(paceScale(1) >= 0.45)
  assert.ok(paceScale(9999) <= 2.5)
})

test('scaledEveryDays：同一张卡在不同成长期下的冷却不同，且至少 1 天', () => {
  const tpl = findTemplate('comeback') // everyDays: 21
  assert.equal(scaledEveryDays(tpl, 30), 21)
  assert.ok(scaledEveryDays(tpl, 7) < 21)
  assert.ok(scaledEveryDays(tpl, 180) > 21)
  const fast = findTemplate('test_first') // everyDays: 2
  assert.equal(scaledEveryDays(fast, 7), 1, '短成长期里 2 天要压到 1 天')
  assert.equal(scaledEveryDays({ id: 'x' }, 30), 0, '没有 repeat 的卡返回 0')
})

test('isSpent 用缩放后的冷却：7 天成长期里 21 天的卡 10 天就能再出', () => {
  const tpl = findTemplate('comeback')
  const need = scaledEveryDays(tpl, 7)
  assert.ok(isSpent(tpl, fired('comeback', need - 1), { growthDays: 7 }), '还没到冷却，应该拦')
  assert.equal(isSpent(tpl, fired('comeback', need + 1), { growthDays: 7 }), false, '过了冷却，应该放')
  // 同样的历史，30 天成长期下仍在冷却中
  assert.ok(isSpent(tpl, fired('comeback', need + 1), { growthDays: 30 }))
})

test('isSpent 接受 squeeze：空档补偿后冷却按比例缩短', () => {
  const tpl = findTemplate('comeback')
  const need = scaledEveryDays(tpl, 30) // 21 天
  assert.ok(isSpent(tpl, fired('comeback', Math.floor(need / 2) + 1), { growthDays: 30 }), '正常冷却内')
  assert.equal(
    isSpent(tpl, fired('comeback', Math.floor(need / 2) + 1), { growthDays: 30, squeeze: 0.5 }),
    false,
    '空档补偿后应该可以出',
  )
  // squeeze 传垃圾值不应崩，也不能变成 0 冷却
  assert.doesNotThrow(() => isSpent(tpl, fired('comeback', 1), { growthDays: 30, squeeze: null }))
})

// ---------- 久别门槛随成长期缩放 ----------

test('absenceThreshold：7 天里 2 天算久别，180 天里要更久', () => {
  assert.equal(absenceThreshold(30), 2)
  assert.equal(absenceThreshold(7), 2)
  assert.ok(absenceThreshold(180) >= 4, `180 天门槛应更久，实际 ${absenceThreshold(180)}`)
})

test('absence_probe 的 cond 跟着成长期走，不写死 2 天', () => {
  const tpl = findTemplate('absence_probe')
  // 3 天没来：30 天成长期算久别；180 天成长期还不算
  assert.equal(tpl.cond(model({ absenceDays: 3, growthDays: 30 })), true)
  assert.equal(tpl.cond(model({ absenceDays: 3, growthDays: 180 })), false)
})

test('absence_probe 允许问「去哪了」（2026-10-25 用户改）', () => {
  const tpl = findTemplate('absence_probe')
  const p = tpl.prompt(model({ absenceDays: 4 }))
  assert.match(p, /问他去哪了/, '应该把「问不问」交给她')
  assert.doesNotMatch(p, /不是问他去哪了/, '旧写法在替她选反应，不许再出现')
  assert.match(p, /4 天/, '要把天数带进去')
})

test('comeback 不要求她「去查」（她没有联网与读文件工具）', () => {
  const tpl = findTemplate('comeback')
  const p = tpl.prompt(model())
  assert.doesNotMatch(p, /自己去查/, '她没有搜索/读文件能力，这个指令做不到')
  assert.match(p, /记下|记住/, '改成核对她自己记下的东西')
})

// ---------- 空档期 ----------

test('gapSinceLastWake：没有唤醒记录返回 0，有则给天数差', () => {
  assert.equal(gapSinceLastWake([]), 0)
  const events = [
    { type: 'meta', text: 'wake:2026-10-20 why_here', ts: iso(4 * DAY) },
    { type: 'meta', text: 'wake:2026-10-22 changed', ts: iso(2 * DAY) },
    { type: 'utterance', text: '嗯', ts: iso(1 * DAY) },
  ]
  const gap = gapSinceLastWake(events)
  assert.ok(gap > 1.9 && gap < 2.1, `应约 2 天，实际 ${gap}`)
  // 非唤醒的 meta 不算
  assert.equal(gapSinceLastWake([{ type: 'meta', text: 'fired:test_first', ts: iso(5 * DAY) }]), 0)
})

test('gapSqueeze：短空档不补偿，2 天以上减半，4 天以上更狠', () => {
  assert.equal(gapSqueeze(0), 1)
  assert.equal(gapSqueeze(1), 1)
  assert.equal(gapSqueeze(2), 0.5)
  assert.equal(gapSqueeze(3.9), 0.5)
  assert.equal(gapSqueeze(4), 0.35)
  assert.equal(gapSqueeze(null), 1)
})

test('pick 把 growthDays 与 squeeze 传给 isSpent（源码级守门）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../lib/generator.js', import.meta.url), 'utf8')
  assert.match(src, /isSpent\(t, fired, \{ now, growthDays: model\.growthDays, squeeze: opts\.squeeze \}\)/)
  const sched = fs.readFileSync(new URL('../lib/scheduler.js', import.meta.url), 'utf8')
  assert.match(sched, /gapSqueeze\(gapSinceLastWake\(events\)\)/)
  assert.equal((sched.match(/squeeze: gapSqueeze\(/g) || []).length, 2, '自动唤醒与手动唤醒都要补偿')
})

test('成长期设成 7 天时，一天最多该出几张卡不会变成两张撞脸', () => {
  // 同一批卡在 7 天成长期下冷却都被压到 1–3 天，不应出现 0 天（等于无限重复）
  for (const t of CATALOG) {
    if (!t.repeat?.everyDays) continue
    assert.ok(scaledEveryDays(t, 7) >= 1, `${t.id} 冷却被压到 0 天`)
  }
})

test('staleAfter：7 天里 2 天就算旧判断，180 天里放宽到 12 天', () => {
  assert.equal(staleAfter(30), 5)
  assert.equal(staleAfter(7), 2)
  assert.ok(staleAfter(180) >= 10, `180 天应放宽，实际 ${staleAfter(180)}`)
})

test('consistency 的「旧判断」门槛跟着成长期走', () => {
  const tpl = findTemplate('consistency')
  const since = new Date(Date.now() - 3 * DAY).toISOString()
  const m = model({ beliefs: [{ text: '我记得', since }], beliefCount: 1, growthDays: 7 })
  // 3 天前的一句判断：7 天成长期里已经算旧（门槛 2 天）
  assert.equal(tpl.cond(m), true)
  // 同样 3 天，在 30 天成长期里还没到 5 天门槛
  assert.equal(tpl.cond(model({ beliefs: [{ text: '我记得', since }], beliefCount: 1, growthDays: 30 })), false)
  assert.match(tpl.prompt(m), /3 天前/)
})
