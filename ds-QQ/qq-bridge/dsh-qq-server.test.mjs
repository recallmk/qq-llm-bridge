import test from 'node:test';
import assert from 'node:assert/strict';
import { QQResumeServer } from './dsh-qq-server.js';
import { CHAT_TOOL_NAMES, FISH_CHAT_TOOL_NAMES } from './qq-policy.mjs';

function fixture({ resume = false, failure } = {}) {
  const restrictions = [];
  const prompts = [];
  const cancels = [];
  let idle = Promise.resolve();
  let agent;
  const setup = async (options) => {
    agent = { id: String(options.sessionId ?? options.resumeSessionId),
      session: { id: String(options.sessionId ?? options.resumeSessionId) },
      followup: (message) => prompts.push(message),
      cancel: (cause) => cancels.push(cause), whenIdle: () => idle };
    await options.setup({ tools: { restrict: (mask) => restrictions.push(mask) } }, agent);
    return { agent, dispose: async () => {} };
  };
  const ctx = { on: () => () => {}, agents: {
    get: () => agent,
    resume: async (options) => {
      if (failure) throw failure;
      if (!resume) throw new Error('session not found');
      return setup(options);
    }, create: setup,
  } };
  const server = new QQResumeServer(ctx, { notify() {} });
  server.initialized = true;
  const prompt = (access = 'chat', requestId = 'request-1') => server.handleRequest('session/prompt', {
    sessionId: access === 'owner' ? 'qq2-p-1' : 'qq2-g-10', requestId, access, contextToken: 'not-visible-to-model',
    contentBlocks: [{ type: 'text', text: '你好' }],
  });
  return { server, restrictions, prompts, cancels, prompt, setIdle: (value) => { idle = value; } };
}

test('new chat agents hide local tools before first prompt and reject execution bypasses', async () => {
  const f = fixture();
  await f.prompt();
  assert.deepEqual(f.restrictions, [{ allow: CHAT_TOOL_NAMES }]);
  assert.equal(f.prompts.length, 1);
  assert.equal(JSON.stringify(f.prompts).includes('not-visible-to-model'), false);
  const agent = { session: { id: 'qq2-g-10' } };
  assert.match(f.server.toolDenied({ agent, name: 'pwsh' }), /只允许聊天/);
  assert.match(f.server.toolDenied({ agent, name: 'run_code' }), /只允许聊天/);
  assert.equal(f.server.toolDenied({ agent, name: 'mcp__qq__qq_reply' }), undefined);
  assert.match(f.server.toolDenied({ agent: { session: { id: 'unknown' } }, name: 'pwsh' }), /失效/);
});

test('resumed chat sessions receive the same restrictions; owner private retains tools', async () => {
  const resumed = fixture({ resume: true });
  await resumed.prompt();
  assert.deepEqual(resumed.restrictions, [{ allow: CHAT_TOOL_NAMES }]);
  const owner = fixture({ resume: true });
  await owner.prompt('owner');
  assert.equal(owner.restrictions.length, 0);
  assert.equal(owner.server.toolDenied({ agent: { session: { id: 'qq2-p-1' } }, name: 'pwsh' }), undefined);
});

test('cancel revokes tools immediately and acknowledges only after agent quiescence', async () => {
  const f = fixture();
  await f.prompt();
  let finish;
  f.setIdle(new Promise((resolve) => { finish = resolve; }));
  let acknowledged = false;
  const cancelled = f.server.handleRequest('session/cancel', { sessionId: 'qq2-g-10', requestId: 'request-1' })
    .then((value) => { acknowledged = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(acknowledged, false);
  assert.match(f.server.toolDenied({ agent: { session: { id: 'qq2-g-10' } }, name: 'mcp__qq__qq_send_message' }), /失效/);
  finish();
  assert.deepEqual(await cancelled, { cancelled: true });
  assert.deepEqual(f.cancels, [{ kind: 'user' }]);
});

test('session load and setup errors never fall back to a new unrestricted agent', async () => {
  const f = fixture({ failure: new Error('disk corrupt') });
  await assert.rejects(f.prompt(), /disk corrupt/);
  assert.equal(f.server.sessions.size, 0);
  assert.equal(f.prompts.length, 0);
});

test('growth sessions expose the real growth tool names and cannot read or modify local state', async () => {
  const f = fixture(); await f.prompt('fish');
  assert.deepEqual(f.restrictions, [{ allow: FISH_CHAT_TOOL_NAMES }]);
  const agent = { session: { id: 'qq2-g-10' } };
  for (const name of ['growth_commit', 'her_recall', 'her_leave', 'bili_look', 'companion_remember', 'companion_recall', 'mcp__qq__qq_reply']) assert.equal(f.server.toolDenied({ agent, name }), undefined);
  for (const name of ['pwsh', 'read_file', 'bili_speak', 'bili_watch', 'run_code']) assert.match(f.server.toolDenied({ agent, name }), /只允许聊天/);
  const owner = fixture(); await owner.prompt('owner');
  assert.match(owner.server.toolDenied({ agent: { session: { id: 'qq2-p-1' } }, name: 'growth_commit' }), /只用于养成/);
});
