import test from 'node:test'
import assert from 'node:assert/strict'

import { extractBvid, parseWatchIntent, watchHint } from '../lib/intent.js'
import { renderSelfDoc } from '../lib/selfdoc.js'
import { deriveSelf } from '../lib/derive.js'

const BV = 'BV1ED4y1Y7dc'

test('抠得出 BV 号', () => {
  assert.equal(extractBvid(`你看这个 https://www.bilibili.com/video/${BV}`), BV)
  assert.equal(extractBvid(`就 ${BV} 这条`), BV)
  assert.equal(extractBvid('没有链接'), '')
})

test('没有视频就什么都不说', () => {
  const r = parseWatchIntent('今天好累')
  assert.equal(r.hasVideo, false)
  assert.equal(r.intent, 'none')
  assert.equal(watchHint(r), '')
})

test('明确要求 → must', () => {
  for (const s of [`必须看 ${BV}`, `帮我看一下 ${BV}`, `一定要看 ${BV}`, `你看一下这个 ${BV}`, `看完告诉我 ${BV}`]) {
    assert.equal(parseWatchIntent(s).intent, 'must', s)
  }
})

test('只是在问她 → maybe', () => {
  for (const s of [`可以看看 ${BV}`, `要不要看这个 ${BV}`, `有没有兴趣 ${BV}`, `你愿意看吗 ${BV}`]) {
    assert.equal(parseWatchIntent(s).intent, 'maybe', s)
  }
})

test('收回要求 → none', () => {
  for (const s of [`不用看了 ${BV}`, `算了别看了 ${BV}`, `没必要看 ${BV}`]) {
    const r = parseWatchIntent(s)
    assert.equal(r.intent, 'none', s)
    assert.equal(r.why, 'negated')
  }
})

test('只丢一条链接、什么都没说 → 不是要求', () => {
  const r = parseWatchIntent(`${BV}`)
  assert.equal(r.intent, 'maybe')
  assert.equal(r.why, 'bare')
})

test('短链认得出来，但不假装知道是哪条', () => {
  const r = parseWatchIntent('看看 https://b23.tv/abcd123')
  assert.equal(r.hasVideo, true)
  assert.equal(r.bvid, '')
  assert.equal(r.linkOnly, true)
})

test('递给她的那行：要求看 vs 可以自己定，措辞不同', () => {
  const must = watchHint(parseWatchIntent(`必须看 ${BV}`))
  assert.match(must, /先看，再回他/)
  assert.match(must, new RegExp(BV))

  const maybe = watchHint(parseWatchIntent(`可以看看 ${BV}`))
  assert.match(maybe, /没有一定让你看/)
  assert.match(maybe, /直接问他/)
  // 不能替他做决定
  assert.doesNotMatch(maybe, /先看，再回他/)
})

test('身份档里写着这两档的区别', () => {
  const model = deriveSelf([], { growthDays: 30 })
  const withBrowse = renderSelfDoc(model, { browse: true })
  assert.match(withBrowse, /他有时会丢一条视频给我/)
  assert.match(withBrowse, /那只是问我/)
  const noBrowse = renderSelfDoc(model, { browse: false })
  assert.doesNotMatch(noBrowse, /他有时会丢一条视频给我/)
})
