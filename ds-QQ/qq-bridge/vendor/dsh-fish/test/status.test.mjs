/**
 * status.test.mjs —— 「现在在干什么」的旁观者视角。
 *
 * 这里只测纯函数（deriveStatus）。它一条事件都不写，所以测试不需要临时目录。
 *
 * 时间是本地时区口径（dateKey 与 settings 一致），所以固定用本地构造的 now，
 * 不用 UTC 字符串——否则跑在 UTC+8 的机器上会跨越日期边界。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveStatus, ACTIVE_MS, IDLE_MS } from '../lib/status.js'

const NOW = new Date(2026, 9, 23, 21, 0, 0) // 2026-10-23 21:00 本地
const DK = '2026-10-23'

/** 生成一条 meta */
function meta(msAgo, text) {
  return { id: 'ev_' + msAgo + '_' + text.slice(0, 8), ts: new Date(NOW.getTime() - msAgo).toISOString(), type: 'meta', text }
}
/** 生成一条她的发言 */
function say(msAgo, text) {
  return { id: 'ev_say' + msAgo, ts: new Date(NOW.getTime() - msAgo).toISOString(), type: 'utterance', text }
}

const MIN = 60_000
const cfg = { window: ['20:00', '23:00'] }

test('今天还没到点：还没醒', () => {
  const st = deriveStatus({
    events: [meta(90 * MIN, `sched:${DK} ${new Date(2026, 9, 23, 22, 0, 0).toISOString()}`)],
    config: cfg,
    now: NOW,
  })
  assert.equal(st.phase, 'waiting')
  assert.equal(st.label, '沉在水底')
  assert.ok(st.detail.includes('22:00'), 'detail 要告诉人几点会醒')
})

test('过了窗口还没醒：睡着，且说清今天不会再醒', () => {
  const st = deriveStatus({ events: [], config: cfg, now: new Date(2026, 9, 23, 23, 30, 0) })
  assert.equal(st.phase, 'asleep')
  assert.equal(st.label, '沉在水底')
  assert.equal(st.detail, '虽然什么都没干，但是累了，不会再醒了')
})

test('刚醒、还没来得及做事 → 醒着但没做什么（不能算睡着）', () => {
  const st = deriveStatus({ events: [meta(3 * MIN, `wake:${DK} nightly`)], config: cfg, now: NOW })
  assert.equal(st.phase, 'awake-idle')
  assert.equal(st.label, '在吃大白饭')
})

test('醒来很久没动 → 醒着但没做什么，detail 报分钟数', () => {
  const st = deriveStatus({ events: [meta(12 * MIN, `wake:${DK} nightly`)], config: cfg, now: NOW })
  assert.equal(st.phase, 'awake-idle')
  assert.ok(st.detail.includes('12 分钟前'), st.detail)
})

test('刚刷完视频 → 在上网刷视频，并带上刷到了什么', () => {
  const items = [{ bvid: 'BV1aa', title: '第一个' }, { bvid: 'BV1bb', title: '第二个' }]
  const st = deriveStatus({
    events: [
      meta(20 * MIN, `wake:${DK} nightly`),
      meta(2 * MIN, `browse:${DK} ${JSON.stringify(items)}`),
    ],
    config: cfg,
    now: NOW,
  })
  assert.equal(st.phase, 'browsing')
  assert.equal(st.label, '在看别人的视频')
  assert.ok(st.detail.includes('刷了 2 条'), st.detail)
  assert.ok(st.detail.includes('第一个'), '要说出来刷到了什么')
  assert.equal(st.today.browsed, 2)
})

test('刚开口说话 → 在说话', () => {
  const st = deriveStatus({
    events: [meta(20 * MIN, `wake:${DK} nightly`), say(40_000, '我今天看了点东西。')],
    config: cfg,
    now: NOW,
  })
  assert.equal(st.phase, 'talking')
  assert.equal(st.label, '在想怎么回你')
  assert.ok(st.detail.includes('我今天看了点东西'), st.detail)
  assert.equal(st.today.said, 1)
})

test('刚写完日记 → 在写日记', () => {
  const st = deriveStatus({
    events: [meta(20 * MIN, `wake:${DK} nightly`), meta(1 * MIN, `diary:${DK}`)],
    config: cfg,
    now: NOW,
  })
  assert.equal(st.phase, 'writing')
  assert.equal(st.today.dairies, 1)
})

test('醒了但一条都没看成：刷站失败也留在时间线上', () => {
  const st = deriveStatus({
    events: [meta(30 * MIN, `wake:${DK} nightly`), meta(11 * MIN, `browse:${DK} []`)],
    config: cfg,
    now: NOW,
  })
  const all = st.timeline.map((t) => t.text).join(' | ')
  assert.ok(all.includes('去刷了，但一条也没看成'), all)
})

test('醒来但没成功要如实记，且这一块算"什么也没做"', () => {
  const st = deriveStatus({
    events: [meta(40 * MIN, `wake:${DK} nightly`), meta(39 * MIN, `wakefail:${DK}`)],
    config: cfg,
    now: NOW,
  })
  const all = st.timeline.map((t) => t.text).join(' | ')
  assert.ok(all.includes('想醒来，但没成功'), all)
  assert.equal(st.today.idleWakes, 1)
})

test('时间线带「时:分」，且醒着什么也没干的那一格单独成行', () => {
  const st = deriveStatus({ events: [meta(60 * MIN, `wake:${DK} nightly`)], config: cfg, now: NOW })
  const all = st.timeline.map((t) => t.text)
  // 整整一块什么也没做时，合成一行「醒了，但什么也没做」——正是用户想看的那一格
  assert.ok(all.some((t) => /^\d{2}:\d{2} 醒了，在发呆$/.test(t)), all.join(' | '))
})

test('今天的数字不串日：昨天的 wake 不算今天', () => {
  const yesterday = new Date(NOW.getTime() - 24 * 60 * MIN)
  const st = deriveStatus({
    events: [{ id: 'x', ts: yesterday.toISOString(), type: 'meta', text: 'wake:2026-10-22 nightly' }],
    config: cfg,
    now: NOW,
  })
  assert.equal(st.today.wakes, 0)
})

test('纯函数：不改动传进来的事件数组', () => {
  const events = [meta(60 * MIN, `wake:${DK} nightly`), say(10 * MIN, '一句话')]
  const before = JSON.stringify(events)
  deriveStatus({ events, config: cfg, now: NOW })
  assert.equal(JSON.stringify(events), before, 'deriveStatus 不许写事件流，也不许改入参')
})

test('阈值就是导出的那两个常量，别再藏魔法数', () => {
  assert.equal(ACTIVE_MS, 5 * 60_000)
  assert.equal(IDLE_MS, 10 * 60_000)
})
