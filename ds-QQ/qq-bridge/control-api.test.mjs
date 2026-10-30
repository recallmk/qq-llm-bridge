import test from 'node:test';
import assert from 'node:assert/strict';
import { startControlServer } from './control-api.mjs';

const TOKEN = 'test-token-123';
const handlers = {
  status: () => ({ dsh: { ready: true }, onebot: { connected: true } }),
  groups: () => ({ groups: [{ id: '1', name: '测试群' }] }),
  recent: ({ group, limit }) => ({ messages: [{ group, limit }] }),
  send: (body) => (body.text === 'deny'
    ? { ok: false, error: '目标不在白名单内' }
    : { ok: true, chars: String(body.text ?? '').length }),
};

async function withServer(fn) {
  const srv = await startControlServer({ port: 0, token: TOKEN, handlers });
  try {
    await fn(`http://127.0.0.1:${srv.port}`);
  } finally {
    await srv.close();
  }
}

const auth = { 'x-qq-token': TOKEN };

const consoleHeaders = (base) => ({ origin: base, 'sec-fetch-site': 'same-origin', 'x-qq-console': '1' });

test('local console obtains a scoped token while ordinary control routes still require master authorization', async () => {
  const server = await startControlServer({ port: 0, token: TOKEN, handlers: {
    ...handlers, fishAdmin: (operation) => ({ operation }),
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const bootstrap = await fetch(base+'/fish/session', { method: 'POST', headers: consoleHeaders(base) });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
    const session = await bootstrap.json();
    assert.ok(session.token); assert.notEqual(session.token, TOKEN);
    const headers = { 'x-qq-token': session.token };
    const data = await (await fetch(base+'/fish/chats', { headers })).json();
    assert.equal(data.operation, 'chats');
    assert.equal((await fetch(base+'/fish/chats')).status, 401);
    for (const route of ['/status','/groups','/recent?group=1']) assert.equal((await fetch(base+route, { headers })).status, 403);
    for (const route of ['/send','/fish/tool']) assert.equal((await fetch(base+route, { method: 'POST', headers, body: '{}' })).status, 403);
    assert.equal((await fetch(base+'/fish/settings', { method: 'POST', headers: { ...headers, 'x-qq-context': 'some-turn' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base+'/status', { headers: auth })).status, 200);
  } finally { await server.close(); }
});

test('console bootstrap rejects cross-site pages, rebinding hosts, missing proof and model contexts', async () => {
  await withServer(async base => {
    for (const headers of [{}, { ...consoleHeaders(base), origin: 'https://unrelated.example' },
      { ...consoleHeaders(base), origin: 'null' }, { ...consoleHeaders(base), 'sec-fetch-site': 'cross-site' },
      { ...consoleHeaders(base), 'x-qq-console': '' }, { ...consoleHeaders(base), 'x-qq-context': 'model-turn' },
      { ...consoleHeaders(base), host: 'rebound.example:3102', origin: 'http://rebound.example:3102' }]) {
      const response = await fetch(base+'/fish/session', { method: 'POST', headers });
      assert.equal(response.status, 403); assert.equal(JSON.stringify(await response.json()).includes(TOKEN), false);
    }
    assert.equal((await fetch(base+'/fish/session', { method: 'OPTIONS', headers: { origin: 'https://unrelated.example' } })).status, 405);
    const page = await fetch(base+'/fish');
    assert.equal((await page.text()).includes(TOKEN), false);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

test('console tokens expire while the master token remains usable', async () => {
  let clock=1000;
  const server=await startControlServer({port:0,token:TOKEN,now:()=>clock,handlers:{...handlers,fishAdmin:()=>({})}});
  try {
    const base=`http://127.0.0.1:${server.port}`;
    const issue=async()=> (await fetch(base+'/fish/session',{method:'POST',headers:consoleHeaders(base)})).json();
    const session=await issue(); const headers={'x-qq-token':session.token};
    assert.equal((await fetch(base+'/fish/chats',{headers})).status,200);
    clock=session.expiresAt;
    assert.equal((await fetch(base+'/fish/chats',{headers})).status,401);
    const renewed=await issue(); assert.notEqual(renewed.token,session.token);
    assert.equal((await fetch(base+'/fish/chats',{headers:{'x-qq-token':renewed.token}})).status,200);
    assert.equal((await fetch(base+'/status',{headers:auth})).status,200);
  } finally {await server.close();}
});

test('control api refuses requests without the right token', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: { 'x-qq-token': 'wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: auth })).status, 200);
  });
});

test('status and groups return the handler payload', async () => {
  await withServer(async (base) => {
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    assert.equal(status.ok, true);
    assert.equal(status.dsh.ready, true);
    const groups = await (await fetch(`${base}/groups`, { headers: auth })).json();
    assert.deepEqual(groups.groups, [{ id: '1', name: '测试群' }]);
  });
});

test('recent requires a group and passes the limit through', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/recent`, { headers: auth })).status, 400);
    const r = await (await fetch(`${base}/recent?group=10&limit=3`, { headers: auth })).json();
    assert.deepEqual(r.messages, [{ group: '10', limit: 3 }]);
  });
});

test('send returns the handler result and maps refusal to 403', async () => {
  await withServer(async (base) => {
    const ok = await fetch(`${base}/send`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ target_type: 'group', target_id: '10', text: '你好' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, chars: 2 });

    const denied = await fetch(`${base}/send`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ target_type: 'private', target_id: '10', text: 'deny' }),
    });
    assert.equal(denied.status, 403);
  });
});

test('unknown routes and bad bodies fail cleanly', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
    const bad = await fetch(`${base}/send`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{not json',
    });
    assert.equal(bad.status, 500);
    assert.equal((await bad.json()).ok, false);
  });
});

test('context authorization is enforced before handlers and cannot be supplied in the body', async () => {
  const seen = [];
  const chat = { access: 'chat', type: 'group', id: '10' };
  const server = await startControlServer({ port: 0, token: TOKEN, handlers: {
    ...handlers,
    authorize: (token) => {
      if (token !== 'turn-capability') throw Object.assign(new Error('expired turn'), { statusCode: 403 });
      return chat;
    },
    send: (_body, scope) => { seen.push(scope); return { ok: true }; },
  } });
  try {
    const url = `http://127.0.0.1:${server.port}/send`;
    const denied = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ access: 'owner', contextToken: 'turn-capability' }) });
    assert.equal(denied.status, 403); assert.equal(seen.length, 0);
    const accepted = await fetch(url, { method: 'POST', headers: { ...auth, 'x-qq-context': 'turn-capability' }, body: JSON.stringify({ access: 'owner' }) });
    assert.equal(accepted.status, 200); assert.equal(seen[0], chat);
  } finally { await server.close(); }
});

test('a disconnected tool client aborts pending handler work', async () => {
  let started;
  const handlerStarted = new Promise((resolve) => { started = resolve; });
  let observed;
  const handlerAborted = new Promise((resolve) => { observed = resolve; });
  const server = await startControlServer({ port: 0, token: TOKEN, handlers: {
    ...handlers,
    send: async (_body, _context, { signal }) => {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      observed();
      return { ok: false };
    },
  } });
  try {
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${server.port}/send`, { method: 'POST', headers: auth, body: '{}', signal: controller.signal });
    const rejected = assert.rejects(response, { name: 'AbortError' });
    await handlerStarted; controller.abort();
    await rejected; await handlerAborted;
  } finally { await server.close(); }
});

test('fish console serves no private data without a token and all data routes require authorization', async () => {
  const seen = [];
  const server = await startControlServer({ port: 0, token: TOKEN, handlers: {
    ...handlers,
    authorize: (token, pathname) => {
      if (pathname === '/fish/tool' ? token !== 'fish-turn' : Boolean(token)) throw Object.assign(new Error('not allowed'), { statusCode: 403 });
      return token ? { fishId: 'p-1' } : { admin: true };
    },
    fishTool: (body, scope) => { seen.push({ body, scope }); return { ok: true, value: { ok: true }, identity: 'live identity' }; },
    fishAdmin: (operation, body, scope) => ({ operation, body, admin: scope.admin }),
  } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(base+'/fish');
    assert.equal(page.status, 200);assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const html = await page.text();assert.match(html, /观测台/);assert.equal(html.includes(TOKEN), false);
    assert.equal((await fetch(base+'/fish/status')).status, 401);
    assert.equal((await fetch(base+'/fish/settings', { method: 'POST', headers: { ...auth, 'x-qq-context': 'fish-turn' }, body: '{}' })).status, 403);
    const settings = await (await fetch(base+'/fish/settings', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'p-1', patch: { wakesPerDay: 0 } }) })).json();
    assert.equal(settings.admin, true);assert.equal(settings.body.patch.wakesPerDay, 0);
    const inbox = await (await fetch(base+'/fish/inbox?id=p-1&read=true', { headers: auth })).json();
    assert.equal(inbox.body.read, true);
    assert.equal((await fetch(base+'/fish/tool', { method: 'POST', headers: auth, body: '{}' })).status, 403);
    assert.equal((await fetch(base+'/fish/tool', { method: 'POST', headers: { ...auth, 'x-qq-context': 'fish-turn' }, body: '{"name":"her_recall","args":{"query":"海边"}}' })).status, 200);
    assert.equal(seen.length, 1);assert.equal(seen[0].scope.fishId, 'p-1');
  } finally { await server.close(); }
});
