/**
 * rules.test.mjs —— R1/R2/R3 的锁定测试（2026-10-24）
 *
 * 这里测的不是"功能"，是三条**不允许被后来的人顺手改回去**的设计：
 *   1. 物理层不进提示词（写出来就是诱因）
 *   2. 「撒娇」是"还没学会"，不是"你不可以"
 *   3. 门禁看次数，不看 0–1 的满足度
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { RULES, LAYERS, promptBans, rulesByLayer, ruleById } from '../lib/rules.js'
import { personaLine, HARD_BANS } from '../lib/persona.js'
import { deriveSelf } from '../lib/derive.js'
import {
  assess, offerDueDay, pendingOffer, offerHistory, activeGrants, grantableRules, EVIDENCE,
} from '../lib/unlock.js'

const NOW = Date.parse('2026-10-24T12:00:00+08:00')

function ev(type, day, extra = {}) {
  return { id: `ev_${String(day).padStart(26, '0')}`, type, day, ts: `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`, text: extra.text || `${type}@${day}`, refs: [], flags: [], ...extra }
}

function modelOf(events, growthDays = 30) {
  return deriveSelf(events, { growthDays })
}

test('物理层两条绝不进提示词', () => {
  const bans = promptBans().map((b) => b.id)
  assert.ok(!bans.includes('no-read-self'))
  assert.ok(!bans.includes('no-self-modify'))
  const text = personaLine(modelOf([]), { withBans: true })
  assert.ok(!text.includes('设定'))
  assert.ok(!text.includes('参数'))
  assert.ok(!text.includes('工具修改'))
})

test('两条物理层规则仍然在规则表里（只是不给她看）', () => {
  assert.equal(ruleById('no-read-self').layer, 'physical')
  assert.equal(ruleById('no-self-modify').layer, 'physical')
  assert.equal(ruleById('no-read-self').section, null)
})

test('撒娇那条是「还不会」，不是「你不可以」', () => {
  const r = ruleById('learn-affection')
  assert.equal(r.layer, 'growth')
  assert.equal(r.section, 'notYet')
  assert.ok(r.text.includes('还不会'))
  assert.ok(!r.text.includes('不可以'))
})

test('提示词里的「不能做的」只剩契约层那一条', () => {
  const cannot = promptBans().filter((b) => b.section === 'cannot')
  assert.equal(cannot.length, 1)
  assert.equal(cannot[0].id, 'no-relational-score')
  assert.equal(HARD_BANS.length, 2)
})

test('身份文档里两个小节分开写：不能做的 / 你还不会的', () => {
  const text = personaLine(modelOf([]), { withBans: true })
  assert.match(text, /## 不能做的/)
  assert.match(text, /## 你还不会的/)
  // 「还不会」不能被归进"违反即失败"
  assert.ok(!/## 不能做的[^#]*还不会/.test(text))
})

test('四层齐备，且只有成长层可改', () => {
  const layers = rulesByLayer()
  assert.deepEqual(layers.map((l) => l.id), ['physical', 'contract', 'origin', 'growth'])
  assert.deepEqual(layers.filter((l) => l.mutable).map((l) => l.id), ['growth'])
  assert.equal(LAYERS.length, 4)
})

test('只有成长层的规则可以被申请', () => {
  assert.deepEqual(grantableRules().map((r) => r.id), ['learn-affection'])
})

/**
 * 一份"证据够了"的事件流：
 *   corrected 1（话里认过错）· revises 2（两次 verdict=refined）· refusals 2 · narration 1 · 跨 6 天
 * 注意 revise 必须带 verdict:'refined' 才算改对——没有 verdict 的 revise 只换说法，不计数。
 */
function baseEvidence(from = 3) {
  const d = from
  return [
    ev('utterance', d, { text: '我错了，那个说法不对' }),   // corrected +1
    ev('revise', d + 1, { verdict: 'refined' }),            // revises +1
    ev('revise', d + 2, { verdict: 'refined' }),            // revises +1
    ev('refusal', d + 3, { text: '不要' }),
    ev('refusal', d + 4, { text: '我不想' }),
    ev('narration', d + 5),
  ]
}

test('证据不够时不出卡', () => {
  const events = [ev('utterance', 1), ev('revise', 2, { verdict: 'refined' })]
  const m = modelOf(events)
  assert.equal(assess('learn-affection', m, events).ready, false)
  assert.equal(offerDueDay('learn-affection', m, events), null)
})

test('证据够了才有 due day，且落在证据最后一天之后', () => {
  const events = baseEvidence(3) // 最后一天 = 8
  const m = modelOf(events)
  const a = assess('learn-affection', m, events)
  assert.equal(a.ready, true, JSON.stringify(a.checks))
  const due = offerDueDay('learn-affection', m, events)
  assert.ok(due !== null)
  assert.ok(due > 8, `due 必须在最后一条证据之后，实际 ${due}`)
  assert.ok(due <= 11, `最多晚三天，实际 ${due}`)
  // 稳定：同样的输入算两次给同一个值（不能是随机数）
  assert.equal(due, offerDueDay('learn-affection', m, events))
})

test('驳回之后要等冷却，且不撤销已有授权', () => {
  const base = baseEvidence(3)
  const offer = {
    ...ev('grant_offer', 9, { text: '我想试试' }),
    id: 'ev_OFFER00000000000000000000A',
    grant: { rule: 'learn-affection', offerId: '', verdict: null, reason: '' },
  }
  const approve = {
    ...ev('grant', 10),
    id: 'ev_GRANT00000000000000000000A',
    grant: { rule: 'learn-affection', offerId: offer.id, verdict: 'approve', reason: '可以。' },
  }
  const withApprove = [...base, offer, approve]
  assert.deepEqual(activeGrants(withApprove, NOW), ['learn-affection'])
  // 已经批了，不再出卡
  assert.equal(offerDueDay('learn-affection', modelOf(withApprove), withApprove), null)

  // 驳回分支：没有 approve，只有 reject
  const reject = { ...approve, grant: { ...approve.grant, verdict: 'reject', reason: '这次不行。' } }
  const withReject = [...base, offer, reject]
  assert.deepEqual(activeGrants(withReject, NOW), [])
  const due = offerDueDay('learn-affection', modelOf(withReject), withReject)
  assert.ok(due !== null && due >= 13, `驳回后要到第 10+3 天之后，实际 ${due}`)
})

test('未裁决的申请会挡住新卡', () => {
  const events = [
    ...baseEvidence(3),
    { ...ev('grant_offer', 9, { text: '我想试试' }), id: 'ev_OFFER00000000000000000000B', grant: { rule: 'learn-affection', offerId: '', verdict: null, reason: '' } },
  ]
  // 申请是 10-09 提的，"现在"取当天中午——超过 holdDays 会被判成"搁置"，那不是这条要测的
  const p = pendingOffer(events, Date.parse('2026-10-09T12:00:00.000Z'))
  assert.ok(p, '应该有未决申请')
  assert.equal(p.grant.rule, 'learn-affection')
  assert.equal(offerHistory(events).at(-1).verdict, 'pending')
})

test('门禁看次数，不看 needs 的 0–1 满足度', () => {
  // 2026-10-24 收紧后：话里的拒绝要「我 + 拒绝词 + 具体动作」才算一次。
  const events = [ev('utterance', 1, { text: '我不想看这个' }), ev('refusal', 2, { text: '不要' }), ev('refusal', 3, { text: '我不想' })]
  const m = modelOf(events)
  assert.equal(m.facts.refusals, 2)
  assert.equal(m.facts.wont, 1)
  assert.equal(m.facts.refused, 3)
  // 胜任门：两条 verdict=refined 的 revise
  const m2 = modelOf([ev('revise', 1, { verdict: 'refined' }), ev('revise', 2, { verdict: 'refined' })])
  assert.equal(m2.facts.revises, 2)
})

test('勇于拒绝要严格：追问「要不要」和说别人「他要是不要」都不算', () => {
  // 真机里那两条误判的原句（2026-10-24 用户要求收紧的起因）。
  const m = modelOf([
    ev('utterance', 1, { text: '四个人被推到我面前，没有问过我要不要看。' }),
    ev('utterance', 2, { text: '我想叫他七。他要是不要，我就收回来。' }),
    ev('utterance', 3, { text: '今天不想看这个。' }),
  ])
  assert.equal(m.facts.wont, 0, '没有第一人称拒绝动作的一律不算')
  assert.equal(m.facts.refused, 0)
  assert.equal(m.stageGate.passed.includes('autonomy'), false)
})

test('EVIDENCE 里没有 0–1 的阈值字段（防止有人偷偷把分数加回来）', () => {
  for (const [rule, need] of Object.entries(EVIDENCE)) {
    for (const [k, v] of Object.entries(need)) {
      if (k === 'spanDays') continue
      assert.ok(Number.isInteger(v) && v >= 1, `${rule}.${k} 必须是次数（≥1 的整数），实际 ${v}`)
    }
  }
})
