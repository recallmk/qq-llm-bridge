import { projectPath } from './project-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CompanionMemory, derivePersonality } from './companion-memory.mjs';
import { FishService } from './fish-service.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(projectPath(".tmp/companion-test-"));
  t.after(async () => {
    const actual = await fs.realpath(root);
    if (!actual.toLowerCase().startsWith('e:\\ds\\.tmp\\companion-test-')) throw new Error('unexpected fixture path');
    await fs.rm(actual, { recursive: true, force: true });
  });
  let clock = Date.parse('2026-10-28T08:00:00Z');
  const now = () => new Date(clock);
  const memory = new CompanionMemory({ root, now });
  return { root, memory, now, advance: (ms) => { clock += ms; } };
}
const person = { kind: 'person', topic: '电影喜好', text: '林舟自述喜欢恐怖片', subjectId: '1' };

test('real source ids survive restart, deduplicate replay, and never cross conversations', async t => {
  const { root, memory, now } = await fixture(t);
  const obs = await memory.observe('p-1', { speakerId: '1', speakerName: '林舟', text: '我喜欢恐怖片', messageId: '101' });
  assert.equal((await memory.observe('p-1', { speakerId: '1', text: '重复投递', messageId: '101' })).id, obs.id);
  const saved = await memory.remember('p-1', { ...person, evidenceIds: [obs.id] });
  await assert.rejects(memory.remember('g-10', { ...person, evidenceIds: [obs.id] }), /其他场景/);
  const restarted = new CompanionMemory({ root, now });
  const recall = await restarted.recall('p-1', { query: '恐怖片' });
  assert.equal(recall.memories[0].id, saved.id); assert.equal(recall.observations[0].observationId, obs.id);
  assert.equal(recall.observations.length, 1);
  assert.deepEqual((await restarted.recall('g-10', { query: '恐怖片' })).memories, []);
  assert.doesNotMatch(await restarted.context('g-10', { query: '林舟 恐怖片', participants: ['1'] }), /林舟|喜欢恐怖片/);
  assert.deepEqual((await restarted.inspect('p-1')).personality, [], 'somebody else’s preference never becomes her own');
});
test('corrections retain old events and evidence while retrieval favors the revised account', async t => {
  const { memory } = await fixture(t);
  const first = await memory.observe('g-10', { speakerId: '1', speakerName: '林舟', text: '我喜欢恐怖片', messageId: '1' });
  const before = await memory.remember('g-10', { ...person, evidenceIds: [first.id] });
  const second = await memory.observe('g-10', { speakerId: '1', speakerName: '林舟', text: '现在不太看恐怖片了，我更喜欢纪录片', messageId: '2' });
  const args = { ...person, text: '林舟现在更喜欢纪录片', evidenceIds: [second.id] };
  assert.equal((await memory.remember('g-10', args)).ok, false);
  await assert.rejects(memory.remember('g-10', { ...args, revises: 'mem_missing' }), /同场景/);
  const after = await memory.remember('g-10', { ...args, topic: '电影偏好', revises: before.id });
  const active = await memory.recall('g-10', { subjectId: '1' });
  assert.equal(active.memories.length, 1); assert.equal(active.memories[0].id, after.id);
  const history = await memory.recall('g-10', { subjectId: '1', history: true });
  assert.equal(history.memories.length, 2);
  assert.equal(history.observations.length, 2);
  const file = await fs.readFile(memory.file('g-10'), 'utf8');
  assert.match(file, /我喜欢恐怖片/); assert.match(file, new RegExp(before.id));
});
test('shared self has one core, several episodes to settle, and no raw private story', async t => {
  const { memory, advance } = await fixture(t);
  for (let n = 0; n < 3; n++) {
    const scope = n === 1 ? 'g-10' : 'p-1';
    const obs = await memory.observe(scope, { speakerId: '1', speakerName: '林舟', text: `私有经历${n}：一起聊了猫`, messageId: String(n) });
    await memory.remember(scope, { kind: 'self', topic: '猫', text: `经历${n}让我对猫更感兴趣`, stance: 'favor', evidenceIds: [obs.id] });
    if (n === 0) assert.equal((await memory.inspect(scope)).personality[0].settled, false);
    advance(18 * 3_600_000);
  }
  const core = (await memory.inspect('g-20')).personality;
  assert.equal(core[0].settled, true); assert.equal(core[0].stance, 'favor');
  const other = await memory.context('g-20');
  assert.match(other, /猫/); assert.doesNotMatch(other, /私有经历|林舟|经历0让我/);
  const global = await fs.readFile(path.join(memory.root, 'core.jsonl'), 'utf8');
  assert.doesNotMatch(global, /林舟|私有经历|p-1|g-10|obs_/);
});
test('repeating or paraphrasing one episode cannot manufacture a stable trait', async t => {
  const { memory } = await fixture(t);
  const obs = await memory.observe('p-1', { speakerId: '1', text: '聊到猫', messageId: '1' });
  const args = { kind: 'self', topic: '猫', text: '我喜欢猫', stance: 'favor', evidenceIds: [obs.id] };
  const first = await memory.remember('p-1', args);
  assert.equal((await memory.remember('p-1', args)).id, first.id);
  for (let n = 0; n < 5; n++) await memory.remember('p-1', { ...args, text: `我有点喜欢猫${n}` });
  const core = (await memory.inspect('p-1')).personality;
  assert.equal(core[0].settled, false);
});
test('established views can reconsider and change after sufficient contrary experiences', async t => {
  const { memory, advance, now } = await fixture(t);
  for (let n = 0; n < 3; n++) {
    const obs = await memory.observe('p-1', { speakerId: '1', text: `聊到快节奏游戏 ${n}`, messageId: String(n) });
    await memory.remember('p-1', { kind: 'self', topic: '快节奏游戏', text: '玩得挺开心', stance: 'favor', evidenceIds: [obs.id] });
    advance(18 * 3_600_000);
  }
  for (let n = 3; n < 10; n++) {
    const obs = await memory.observe('p-1', { speakerId: '1', text: `讨论快节奏游戏让我觉得累 ${n}`, messageId: String(n) });
    await memory.remember('p-1', { kind: 'self', topic: '快节奏游戏', text: '慢慢觉得太累了', stance: 'against', evidenceIds: [obs.id] });
    if (n === 3) assert.equal((await memory.inspect('p-1')).personality[0].stance, 'favor');
    advance(18 * 3_600_000);
  }
  assert.equal((await memory.inspect('g-20')).personality[0].stance, 'against');
  const rows = await memory.core();
  assert.equal(derivePersonality(rows, now().getTime() + 100 * 86_400_000)[0].stance, 'against', 'time alone does not invent a different preference');
});
test('person evidence binds identity; private topics and fabricated ids are rejected', async t => {
  const { memory } = await fixture(t);
  const obs = await memory.observe('g-10', { speakerId: '2', speakerName: '阿冬', text: '阿冬说他喜欢猫', messageId: '1' });
  await assert.rejects(memory.remember('g-10', { ...person, evidenceIds: [obs.id] }), /真实发言/);
  for (const topic of ['阿冬的猫', '主人昨天手术', '联系12345678', '群友的事情']) await assert.rejects(memory.remember('g-10', {
    kind: 'self', topic, text: '对这件事的看法', stance: 'favor', evidenceIds: [obs.id],
  }), /共享主题/);
  await assert.rejects(memory.remember('g-10', { ...person, evidenceIds: ['obs_fake'] }), /来源不存在/);
  await assert.rejects(memory.remember('../p-1', { ...person, evidenceIds: [obs.id] }), /无效/);
});
test('cancelled writes and incomplete logs fail closed without erasing old bytes', async t => {
  const { memory, root } = await fixture(t);
  const obs = await memory.observe('p-1', { speakerId: '1', text: '我喜欢恐怖片', messageId: '1' });
  await assert.rejects(memory.remember('p-1', { ...person, evidenceIds: [obs.id] }, { valid: () => false }), { code: 'CANCELLED' });
  const file = memory.file('p-1'); await fs.appendFile(file, '{"interrupted":');
  const before = await fs.readFile(file, 'utf8');
  const restarted = new CompanionMemory({ root });
  await assert.rejects(restarted.observe('p-1', { speakerId: '1', text: '后续消息' }), /尾部不完整/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('FishService wires new native tools into identity and keeps evidence after reconstruction', async t => {
  const { root, now } = await fixture(t);
  const service = new FishService({ root, now, ownerIds: ['1'] });
  const obs = await service.observe('p-1', { speakerId: '1', speakerName: '林舟', text: '我喜欢恐怖片', messageId: '1' });
  const identity = await service.prepare('p-1', { contact: true, message: '我喜欢恐怖片', participants: ['1'] });
  assert.match(identity, /companion_remember/);
  const saved = await service.tool('p-1', 'companion_remember', { ...person, evidenceIds: [obs.id] });
  assert.equal(saved.value.ok, true); assert.match(saved.identity, /林舟自述喜欢恐怖片/);
  const other = await service.prepare('g-10', { message: '喜欢什么', participants: ['1'] });
  assert.doesNotMatch(other, /林舟/);
  assert.doesNotMatch(other, /你存在了|你目前没有任何自己的判断|不要因为他是这么说的就改口/);
  const recalled = await service.tool('p-1', 'companion_recall', { subjectId: '1' });
  assert.equal(recalled.value.memories[0].id, saved.value.id);
  const next = await service.observe('p-1', { speakerId: '1', speakerName: '林舟', text: '现在更喜欢纪录片', messageId: '2' });
  const revised = await service.tool('p-1', 'companion_remember', { ...person, topic: '电影偏好',
    text: '林舟自述现在更喜欢纪录片', revises: saved.value.id, evidenceIds: [next.id] });
  assert.equal(revised.value.ok, true, 'a generated memory UUID must not be mistaken for a credential');
  await assert.rejects(service.tool('p-1', 'companion_remember', { ...person, text: 'password=secret',
    revises: revised.value.id, evidenceIds: [next.id] }), /私密信息/);
  assert.equal((await service.status('p-1')).companion.memories, 1);
});
