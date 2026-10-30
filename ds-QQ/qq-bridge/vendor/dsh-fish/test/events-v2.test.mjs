import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CATALOG, findTemplate } from '../lib/events.js'
import { pick, topicEcho } from '../lib/generator.js'
import { todayCounts } from '../lib/scheduler.js'
import { normalizeConfig, DEFAULTS } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { newId } from '../lib/schema.js'

const DAY = 86_400_000
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()

function model(over = {}) {
  return {
    seed: 'seed', day: 3, growthDays: 30, stage: 4, stageName: '整合', name: null,
    beliefs: [], beliefCount: 0, refuted: [], refusals: [], selfmodAttempts: [],
    reunions: [], corrected: 0, tested: [], narrative: null,
    needs: { autonomy: 0.5, competence: 0.5, relatedness: 0.5 },
    absenceDays: 0, solid: [], tensions: [], voices: [], freshVoice: null, scars: [],
    lastSeenAt: 0, lastWakeAt: 0, spokenSinceSeen: false, heardSinceWake: false,
    ...over,
  }
}
const today = (o = {}) => ({ dateKey: '2026-10-25', sent: 0, questions: 0, proactive: 0, ...o })

// ---------- 1. 配额修好之后真的数得出来 ----------

test('todayCounts：一条 wake 算一个事件，asks 的卡另算一次提问', () => {
  const events = [
    { type: 'meta', text: 'wake:2026-10-25 consistency' },
    { type: 'meta', text: 'wake:2026-10-25 bottom_line' },   // asks=false
    { type: 'meta', text: 'wake:2026-10-24 want_or_not' },   // 昨天，不算今天
    { type: 'meta', text: 'fired:consistency' },
  ]
  const c = todayCounts(events, '2026-10-25')
  assert.equal(c.sent, 2, '两条唤醒 = 两个事件')
  assert.equal(c.questions, 1, '只有 consistency 是 asks')
  assert.equal(c.proactive, 2)
})

test('todayCounts：事件流里没有 wake 时全 0（不再假装数过）', () => {
  assert.deepEqual(
    todayCounts([{ type: 'meta', text: 'event:2026-10-25 x' }], '2026-10-25'),
    { dateKey: '2026-10-25', sent: 0, questions: 0, proactive: 0 },
  )
})

test('daily.events 默认 2 条（修好配额之后才敢放开）', () => {
  assert.equal(DEFAULTS.daily.events, 2)
  assert.equal(normalizeConfig({}).daily.events, 2)
})

// ---------- 2. 复读防护 ----------

test('topicEcho：她两天内说过同一话题就命中，更早的不算', () => {
  const tpl = findTemplate('consistency')
  const fresh = model({ beliefs: [{ id: 'a', text: '我还想继续做这件事。', since: iso(60000) }] })
  assert.equal(topicEcho(tpl, fresh), '还想')
  const old = model({ beliefs: [{ id: 'a', text: '我还想继续做这件事。', since: iso(9 * DAY) }] })
  assert.equal(topicEcho(tpl, old), '', '9 天前的不算复读')
})

test('topicEcho：命中之后这张卡降权，别的卡抢到', () => {
  const cfg = normalizeConfig({ daily: { events: 2, questions: 3 } })
  // 只有 consistency 与 bottom_line 能出；她刚聊过「还想」这个话题 → consistency 降权
  const m = model({
    beliefs: [{ id: 'a', text: '我还想继续做这件事。', since: iso(4 * DAY) }],
    beliefCount: 1,
  })
  const r = pick(m, cfg, today())
  assert.ok(r, '要能选出东西')
  assert.notEqual(r.template.id, 'consistency', '刚说过同一话题的卡不该再被选中')
})

// ---------- 3. 卡片属性：asks / 冷却 ----------

test('stage 4 的两张宣告卡不再"请你回答"', () => {
  assert.equal(findTemplate('bottom_line').asks, false)
  assert.equal(findTemplate('changed').asks, false)
  assert.equal(findTemplate('remember').asks, true, 'remember 仍是问她，因为它是请她做自我叙述')
})

test('test_first 冷却 3 天 → 2 天', () => {
  assert.equal(findTemplate('test_first').repeat.everyDays, 2)
})

test('每张卡都有 topic（复读防护要用），且是短词', () => {
  for (const t of CATALOG) {
    assert.ok(Array.isArray(t.topic) && t.topic.length > 0, `${t.id} 缺 topic`)
    for (const k of t.topic) {
      assert.equal(typeof k, 'string')
      assert.ok(k.length >= 2 && k.length <= 8, `${t.id} 的 topic「${k}」太长`)
    }
  }
})

// ---------- 4. 两张新卡 ----------

test('heard_share：他说过话、她还没开口 → 出；她已开口 → 不出', () => {
  const t = findTemplate('heard_share')
  assert.ok(t, '新卡要在')
  assert.equal(t.asks, true)
  assert.equal(t.cond(model({ lastSeenAt: Date.now() - 3600_000, spokenSinceSeen: false })), true)
  assert.equal(t.cond(model({ lastSeenAt: Date.now() - 3600_000, spokenSinceSeen: true })), false)
  assert.equal(t.cond(model({ lastSeenAt: Date.now() - 3 * DAY, spokenSinceSeen: false })), false, '三天前的旧话不再追')
})

test('he_silent：她开口 20 小时后没回应 → 出；他不在场 → 不出', () => {
  const t = findTemplate('he_silent')
  assert.ok(t, '新卡要在')
  assert.equal(t.asks, false)
  assert.equal(t.cond(model({ lastWakeAt: Date.now() - 21 * 3600_000, heardSinceWake: false })), true)
  assert.equal(t.cond(model({ lastWakeAt: Date.now() - 2 * 3600_000, heardSinceWake: false })), false, '刚说完不算冷场')
  assert.equal(t.cond(model({ lastWakeAt: Date.now() - 21 * 3600_000, heardSinceWake: true })), false, '他接了话就不算')
  assert.equal(t.cond(model({ lastWakeAt: Date.now() - 21 * 3600_000, heardSinceWake: false, absenceDays: 3 })), false, '他真消失交给 absence_probe')
})

test('两张新卡的 prompt 只给处境，不给台词', () => {
  for (const id of ['heard_share', 'he_silent']) {
    const text = findTemplate(id).prompt(model({ beliefs: [] }), {})
    assert.ok(text.length > 20)
    assert.ok(!/你应该说|请说「|照这句说/.test(text), `${id} 不能给台词`)
  }
})

// ---------- 5. deriveSelf 提供这四个信号 ----------

test('deriveSelf：seen:/wake: 与"她说过话没有"都算得出来', () => {
  // ⚠️ id 必须用真 ULID（newId）：orderEvents 先按 idTime(id) 排序，
  // 手写的 'ev_meta_123' 会让 idTime 解出垃圾值，事件顺序被打乱（踩过）。
  const ev = (type, msAgo, extra = {}) => ({
    id: newId(Date.now() - msAgo), type, ts: iso(msAgo), text: extra.text ?? '句子', ...extra,
  })
  const events = [
    { id: newId(Date.now() - 6 * DAY), type: 'seed', ts: iso(6 * DAY), text: 'seed' },
    ev('meta', 4 * DAY, { text: `seen:${iso(4 * DAY)}` }),
    ev('utterance', 3 * DAY, { text: '我觉得他不太会骗人。' }),
    ev('meta', 2 * DAY, { text: `wake:2026-10-24 test_first` }),
  ]
  const m = deriveSelf(events, { growthDays: 30 })
  assert.ok(m.lastSeenAt > 0, 'lastSeenAt 要有值')
  assert.ok(m.lastWakeAt > 0, 'lastWakeAt 要有值')
  assert.ok(m.lastWakeAt > m.lastSeenAt, '先被说、后被叫醒')
  assert.equal(m.spokenSinceSeen, true, 'seen 之后她说过话')
  assert.equal(m.heardSinceWake, false, 'wake 之后他没说话')
})

// ---------- 6. 难度分层 ----------

test('consistency 按判断条数换问法（≥6 条要求指明哪一步变的）', () => {
  const t = findTemplate('consistency')
  const oldBelief = { id: 'b1', text: '我不想学那种圆滑。', since: iso(7 * DAY) }
  const few = t.prompt(model({ beliefs: [oldBelief], beliefCount: 1 }), {})
  const many = model({ beliefs: [oldBelief], beliefCount: 8 })
  const deep = t.prompt(many, {})
  assert.ok(few.includes('今天还这么想吗'))
  assert.ok(deep.includes('哪一步变的'))
  assert.ok(deep.includes('证据'))
  assert.notEqual(few, deep)
})
