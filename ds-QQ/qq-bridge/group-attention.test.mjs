import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupAttention, attentionConfig } from './group-attention.mjs';

const start = Date.parse('2026-10-28T12:00:00Z');
const msg = (qq, text) => ({ qq, name: `成员${qq}`, text });
test('continuous conversation waits for a pause and a busy stream has bounded latency', () => {
  const a = new GroupAttention();
  assert.equal(a.observe('10', msg('1', '今天的电影怎么样？'), { now: start }), start + 6000);
  a.observe('10', msg('2', '结尾挺意外的'), { now: start + 5000 });
  assert.equal(a.take('10', { now: start + 6000 }).messages.length, 0);
  assert.equal(a.take('10', { now: start + 11_000 }).messages.length, 2);
  a.observe('20', msg('1', '电影怎么样？'), { now: start });
  for (let n = 1; n < 5; n++) a.observe('20', msg('2', '我再想想结尾'), { now: start + n * 4500 });
  assert.equal(a.due('20', start + 18_000), start + 20_000);
  assert.equal(a.take('20', { now: start + 20_000 }).messages.length, 5);
});
test('learned interests and relationship context draw attention without forcing an answer', () => {
  const a = new GroupAttention();
  a.reviewed('10', start);
  a.observe('10', msg('2', '又看到一只猫'), { now: start + 60_000, hints: { topics: ['猫'], people: [] } });
  const result = a.take('10', { now: start + 66_000 });
  assert.ok(result.reasons.includes('与已有兴趣或记忆有关'));
  assert.equal(result.messages.length, 1);
  a.observe('10', msg('2', '最近准备搬家'), { now: start + 130_000, hints: { people: ['2'], topics: [] } });
  assert.ok(a.take('10', { now: start + 136_000 }).reasons.includes('熟悉的人说起近况'));
});
test('cooldown, per-minute ceiling and in-flight requests preserve the latest coherent window', () => {
  const a = new GroupAttention({ cooldownSeconds: 5, maxPerMinute: 1 });
  a.observe('10', msg('2', '这是什么？'), { now: start });
  assert.equal(a.take('10', { now: start + 6000, busy: true }).nextAt, start + 12_000);
  assert.equal(a.take('10', { now: start + 12_000 }).messages.length, 1);
  a.observe('10', msg('2', '还有这个问题？'), { now: start + 13_000 });
  assert.equal(a.due('10', start + 19_000), start + 72_000);
  assert.equal(a.take('10', { now: start + 72_000 }).messages.length, 1);
});
test('acknowledgements, commands and image placeholders do not create model turns', () => {
  const a = new GroupAttention();
  for (const text of ['好的', '谢谢', '哈哈哈', '[图片]', '/status']) assert.equal(a.observe('10', msg('2', text), { now: start }), null);
  assert.equal(a.take('10', { now: start + 6000 }).messages.length, 0);
  a.observe('10', msg('2', '先前的问题？'), { now: start });
  a.observe('10', msg('3', '@大肥鱼 看这个'), { direct: true, now: start + 1000 });
  assert.equal(a.take('10', { now: start + 60_000 }).messages.length, 0, 'direct turn consumes an older pending window');
  a.reset('10'); assert.equal(a.state('10').reviewedAt, 0);
});
test('disabled ambient observation still allows direct turns and invalid configuration stays bounded', () => {
  const a = new GroupAttention({ enabled: false });
  assert.equal(a.observe('10', msg('2', '怎么回事？'), { now: start }), null);
  const c = attentionConfig({ pauseMs: 0, maxWaitMs: -1, maxPerMinute: 500, ignorePrefixes: null });
  assert.equal(c.pauseMs, 1000); assert.equal(c.maxWaitMs, 1000); assert.equal(c.maxPerMinute, 10);
});
