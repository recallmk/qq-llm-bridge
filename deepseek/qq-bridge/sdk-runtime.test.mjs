import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { SdkRuntime, promptContent } from './sdk-runtime.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 1)); } throw new Error('fixture wait timed out'); }
function fixture(config = {}) {
  const requests = [];
  const children = [];
  let onRequest = () => {};
  class Child extends EventEmitter {
    constructor() {
      super(); this.pid = 123; this.exitCode = null; this.stdout = new PassThrough(); this.stderr = new PassThrough();
      this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
        const request = JSON.parse(String(chunk)); requests.push(request);
        queueMicrotask(() => {
          if (request.method === 'initialize') this.reply(request, { serverInfo: { name: 'fixture', version: '1' } });
          else if (request.method === 'shutdown') { this.reply(request, {}); queueMicrotask(() => this.kill()); }
          else onRequest(request, this);
        }); callback();
      } });
    }
    reply(request, result) { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`); }
    event(request, event) { this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: {
      sessionId: request.params.sessionId, requestId: request.params.requestId, event,
    } })}\n`); }
    finish(request, text = '正常回复') {
      this.event(request, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, usage: { inputTokens: 12, outputTokens: 3 } } });
      this.event(request, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    }
    kill() { if (this.exitCode !== null) return; this.exitCode = 0; this.emit('exit', 0, null); }
  }
  const runtime = new SdkRuntime({ bin: 'fixture', cwd: '.', provider: 'fixture', model: 'fixture',
    spawnImpl: () => { const child = new Child(); children.push(child); return child; },
    requestTimeoutMs: 100, cancelTimeoutMs: 100, restartDelayMs: 10, ...config });
  return { runtime, requests, children, handle: (fn) => { onRequest = fn; } };
}

test('SDK correlates turn events and trusts only successful tool results', async () => {
  const f = fixture();
  f.handle((request, child) => {
    child.reply(request, {});
    child.event(request, { type: 'tool/call', data: { name: 'mcp__qq__qq_send_message', callId: 'c1' } });
    child.event(request, { type: 'tool/result', data: { callId: 'c1', message: { content: [{ toolCallId: 'c1', isError: true }] } } });
    child.finish(request);
  });
  try {
    const result = await f.runtime.prompt('qq2-g-10', '你好', 1000, { access: 'chat', contextToken: 'private-capability' });
    assert.equal(result.text, '正常回复'); assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.toolCalls[0].ok, false);
    const request = f.requests.find((r) => r.method === 'session/prompt');
    assert.equal(request.params.contextToken, 'private-capability');
    assert.equal(request.params.contentBlocks[0].text.includes('private-capability'), false);
  } finally { await f.runtime.stop(); }
});

test('SDK delivers actual image blocks beside text and rejects excess or malformed payloads before submission', async () => {
  const f = fixture(); f.handle((request, child) => { child.reply(request, {}); child.finish(request); });
  const image = { mimeType: 'image/png', data: Buffer.from('image-bytes').toString('base64') };
  try {
    await f.runtime.prompt('vision-fixture', '看看图片', 1000, { images: [image] });
    const blocks = f.requests.find(r => r.method === 'session/prompt').params.contentBlocks;
    assert.equal(blocks[0].text, '看看图片');
    assert.equal(blocks[2].type, 'image'); assert.equal(blocks[2].data, image.data); assert.equal(blocks[2].mimeType, 'image/png');
    assert.equal(blocks.some(b => b.data?.startsWith('data:')), false);
    assert.throws(() => promptContent('test', Array(5).fill(image)), /最多/);
    assert.throws(() => promptContent('test', [{ ...image, mimeType: 'image/svg+xml' }]), /不正确/);
    assert.throws(() => promptContent('test', [{ ...image, data: 'not base64' }]), /不正确/);
  } finally { await f.runtime.stop(); }
});

test('SDK accepts current DSH message-level tool receipts and preserves reported failures', async () => {
  const f = fixture();
  f.handle((request, child) => {
    child.reply(request, {});
    for (const [callId, isError] of [['success', false], ['failed', true]]) {
      child.event(request, { type: 'tool/call', data: { name: 'growth_commit', callId } });
      child.event(request, { type: 'tool/result', data: { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError,
        content: [{ type: 'text', text: isError ? '没记下' : '已记下' }] } } });
    }
    child.finish(request);
  });
  try {
    const result = await f.runtime.prompt('fish-fixture', '你好', 1000, { access: 'fish', identity: '此刻的身份' });
    assert.deepEqual(result.toolCalls.map(c => c.ok), [true, false]);
    assert.equal(f.requests.find(r => r.method === 'session/prompt').params.identity, '此刻的身份');
  } finally { await f.runtime.stop(); }
});

test('timeout cancels and drains before next prompt, with late old events ignored', async () => {
  const f = fixture();
  let releaseCancel;
  f.handle((request, child) => {
    if (request.method === 'session/prompt') child.reply(request, {});
    if (request.method === 'session/cancel') releaseCancel = () => child.reply(request, { cancelled: true });
  });
  try {
    const first = f.runtime.prompt('qq2-g-10', '第一轮', 15);
    const rejected = assert.rejects(first, { code: 'REPLY_TIMEOUT' });
    await until(() => releaseCancel);
    const old = f.requests.find((r) => r.method === 'session/prompt');
    const second = f.runtime.prompt('qq2-g-10', '第二轮', 1000);
    await tick();
    assert.equal(f.requests.filter((r) => r.method === 'session/prompt').length, 1);
    releaseCancel(); await rejected;
    await until(() => f.requests.filter((r) => r.method === 'session/prompt').length === 2);
    const next = f.requests.filter((r) => r.method === 'session/prompt')[1];
    f.children[0].finish(old, '过时回复');
    f.children[0].finish(next, '新回复');
    assert.equal((await second).text, '新回复');
  } finally { await f.runtime.stop(); }
});

test('missing prompt ACK triggers cancellation without replaying accepted work', async () => {
  const f = fixture({ requestTimeoutMs: 15 });
  f.handle((request, child) => { if (request.method === 'session/cancel') child.reply(request, { cancelled: true }); });
  try {
    await assert.rejects(f.runtime.prompt('qq2-g-10', '可能已经投递', 1000), { code: 'PROMPT_UNCERTAIN' });
    assert.equal(f.requests.filter((r) => r.method === 'session/prompt').length, 1);
    assert.equal(f.requests.filter((r) => r.method === 'session/cancel').length, 1);
  } finally { await f.runtime.stop(); }
});

test('reset abort signal cancels the remote agent and blocks stale tool work', async () => {
  const f = fixture();
  f.handle((request, child) => child.reply(request, {}));
  const controller = new AbortController();
  let cancelled = false;
  try {
    const pending = f.runtime.prompt('qq2-g-10', '等待', 1000, { signal: controller.signal, onCancel: () => { cancelled = true; } });
    const rejected = assert.rejects(pending, { code: 'CANCELLED' });
    await until(() => f.requests.some((r) => r.method === 'session/prompt'));
    controller.abort(); await rejected;
    assert.equal(cancelled, true);
    assert.equal(f.requests.some((r) => r.method === 'session/cancel'), true);
  } finally { await f.runtime.stop(); }
});

test('unacknowledged cancellation kills the old process before reuse', async () => {
  const f = fixture({ cancelTimeoutMs: 15 });
  f.handle((request, child) => { if (request.method === 'session/prompt') child.reply(request, {}); });
  try {
    await assert.rejects(f.runtime.prompt('qq2-g-10', '等待', 15));
    assert.equal(f.children[0].exitCode, 0);
    assert.equal(f.runtime.status().restarts, 1);
  } finally { await f.runtime.stop(); }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.children.length, 1, 'stop must cancel a scheduled restart');
});
