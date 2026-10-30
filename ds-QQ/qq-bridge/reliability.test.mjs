import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonState, SessionRegistry, MessageDeduper, SendQueue } from './reliability.mjs';
import { targetAllowed, scopeAllows, accessFor } from './qq-policy.mjs';

function memoryFs() {
  const files = new Map();
  return { files,
    readFileSync(file) { if (!files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(file); },
    writeFileSync(file, body) { files.set(file, body); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
}

test('reset mapping survives restart and never reuses a historical reset id', () => {
  const fs = memoryFs();
  let n = 0;
  const load = () => new SessionRegistry(new JsonState('sessions', { version: 1, sessions: {} }, fs), () => `unique-${++n}`);
  const first = load();
  assert.equal(first.get('qq2-g-10'), 'qq2-g-10');
  const reset = first.rotate('qq2-g-10');
  const second = load();
  assert.equal(second.get('qq2-g-10'), reset);
  assert.notEqual(second.rotate('qq2-g-10'), reset);
  assert.equal(fs.files.has('sessions.tmp'), false);
});

test('fresh start also avoids historical base sessions for newly encountered chats after restart', () => {
  const fs = memoryFs();
  let n = 0;
  const load = () => new SessionRegistry(new JsonState('sessions', { version: 1, freshIds: true, sessions: {} }, fs), () => `unique-${++n}`);
  const first = load();
  const group = first.get('qq2-g-10');
  assert.notEqual(group, 'qq2-g-10');
  const second = load();
  assert.equal(second.get('qq2-g-10'), group);
  assert.notEqual(second.get('qq2-p-20'), 'qq2-p-20');
  assert.equal(JSON.parse(fs.files.get('sessions')).freshIds, true);
});

test('damaged or unwritable session mapping fails closed', () => {
  const fs = memoryFs();
  fs.files.set('sessions', '{bad');
  assert.throws(() => new JsonState('sessions', {}, fs), /无法读取/);
  fs.files.delete('sessions');
  const store = new JsonState('sessions', { version: 1, sessions: {} }, fs);
  const sessions = new SessionRegistry(store, () => 'new');
  sessions.get('qq2-g-10');
  fs.renameSync = () => { throw new Error('disk full'); };
  assert.throws(() => sessions.rotate('qq2-g-10'), /disk full/);
  assert.equal(sessions.get('qq2-g-10'), 'qq2-g-10');
});

test('dedup persists, isolates accounts and chats, expires and remains bounded', () => {
  const fs = memoryFs();
  let now = 1000;
  const load = () => new MessageDeduper(new JsonState('seen', { version: 1, entries: [] }, fs), { now: () => now, ttlMs: 100, maxEntries: 3 });
  const first = load();
  assert.equal(first.accept('bot1:g10:message1'), true);
  assert.equal(load().accept('bot1:g10:message1'), false);
  assert.equal(first.accept('bot1:g11:message1'), true);
  assert.equal(first.accept('bot2:g10:message1'), true);
  first.accept('bot1:g10:message2');
  assert.equal(first.entries.size, 3);
  now += 101;
  assert.equal(load().accept('bot1:g10:message1'), true);
});

test('private whitelist fails closed and group switch applies to tool destinations', () => {
  const cfg = { groupsEnabled: false, allowGroups: [], allowUsers: [], ownerQq: ['1'] };
  assert.equal(targetAllowed(cfg, 'group', '10'), false);
  assert.equal(targetAllowed(cfg, 'private', '2'), false);
  assert.equal(targetAllowed(cfg, 'private', '1'), true);
  cfg.groupsEnabled = true;
  const chat = { access: 'chat', type: 'group', id: '10' };
  assert.equal(scopeAllows(cfg, chat, 'group', '10'), true);
  assert.equal(scopeAllows(cfg, chat, 'group', '11'), false);
  assert.equal(scopeAllows(cfg, { access: 'owner' }, 'group', '11'), true);
  assert.equal(accessFor({ isGroup: true, owner: true }), 'chat');
  assert.equal(accessFor({ isGroup: false, owner: true }), 'owner');
});

test('outbox serializes whole batches and counts every actual send against rate limits', async () => {
  let now = 0;
  const log = [];
  const queue = new SendQueue({ intervalMs: 1500, maxPerMinute: 2, globalMaxPerMinute: 10,
    now: () => now, sleep: async (ms) => { now += ms; } });
  const batch = (name, count) => queue.batch('g10', count, async (deliver) => {
    for (let i = 0; i < count; i++) await deliver(async () => { log.push([name, now]); });
  });
  await Promise.all([batch('A', 3), batch('B', 1)]);
  assert.deepEqual(log.map(([name]) => name), ['A', 'A', 'A', 'B']);
  assert.deepEqual(log.map(([, at]) => at), [0, 1500, 60000, 61500]);
  assert.equal(queue.pending, 0);
});

test('outbox observes global rate, queue capacity, cancellation and recovery after errors', async () => {
  let now = 0;
  const log = [];
  const queue = new SendQueue({ intervalMs: 0, maxPerMinute: 10, globalMaxPerMinute: 1,
    maxQueuedMessages: 2, now: () => now, sleep: async (ms) => { now += ms; } });
  await queue.batch('g10', 1, (deliver) => deliver(async () => { log.push(now); }));
  await queue.batch('g11', 1, (deliver) => deliver(async () => { log.push(now); }));
  assert.deepEqual(log, [0, 60000]);
  await assert.rejects(queue.batch('g10', 3, async () => {}), /队列已满/);
  await assert.rejects(queue.batch('g10', 1, (deliver) => deliver(async () => {}), () => false), { code: 'CANCELLED' });
  await assert.rejects(queue.batch('g10', 1, async () => { throw new Error('failure'); }), /failure/);
  assert.equal(await queue.batch('g10', 1, async () => 'recovered'), 'recovered');
  assert.equal(queue.pending, 0);
});
