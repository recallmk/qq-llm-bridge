import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { startControlServer } from './control-api.mjs';

const MASTER = 'fixture-master-token';
const html = await readFile(new URL('./fish-console.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function element() {
  return { value: '', textContent: '', hidden: false, disabled: false, children: [], listeners: {},
    replaceChildren(...values) { this.children = [...values]; }, append(value) { this.children.push(value); },
    addEventListener(event, listener) { this.listeners[event] = listener; } };
}
async function fixture(t, intercept) {
  let clock = Date.now();
  const server = await startControlServer({ port: 0, token: MASTER, now: () => clock, handlers: {
    authorize: () => ({ admin: true }),
    fishAdmin: (operation) => {
      if (operation === 'chats') return { chats: ['g-10', 'p-1'] };
      if (operation === 'inbox') return { rows: [], unread: 0 };
      if (operation === 'diary') return { text: '还没有日记。' };
      if (operation === 'status') return { day: 2, stageName: '信任', eventCount: 5, todayCost: 0,
        refusals: 0, revises: 0, beliefs: [], stances: [], diaryVisible: false,
        companion: { personality: [], memories: 1, observations: 4 },
        settings: { wakesPerDay: 1, window: ['20:00', '23:00'], browse: true, browsePerDay: 1 } };
      return {};
    },
  } });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`, requests = [];
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(m => [m[1], element()]));
  nodes.get('content').hidden = true;
  const browserFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const intercepted = await intercept?.(url, options);
    if (intercepted) return intercepted;
    // Headers browsers attach to a same-origin POST; never read the master token.
    return fetch(base + url, { ...options, headers: { origin: base, 'sec-fetch-site': 'same-origin', ...options.headers } });
  };
  vm.runInNewContext(script, { document: { getElementById: id => nodes.get(id), createElement: element },
    fetch: browserFetch, URLSearchParams, Date }, { filename: 'fish-console.html' });
  const waitFor = async (predicate) => {
    for (let n = 0; n < 300; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Console did not settle: ' + nodes.get('message').textContent);
  };
  return { nodes, requests, waitFor, advance: ms => { clock += ms; }, click: id => nodes.get(id).listeners.click() };
}

test('opening the page fills its token, connects, renews an expired session and reconnects after disconnect', async t => {
  const h = await fixture(t);
  await h.waitFor(() => !h.nodes.get('connect').disabled);
  assert.match(h.nodes.get('message').textContent, /已更新/);
  assert.equal(h.nodes.get('content').hidden, false);
  assert.ok(h.nodes.get('token').value); assert.notEqual(h.nodes.get('token').value, MASTER);
  assert.equal(h.nodes.get('chat').children.length, 2);
  const first = h.nodes.get('token').value;
  h.advance(13 * 60 * 60 * 1000);
  await h.click('refresh');
  assert.notEqual(h.nodes.get('token').value, first);
  assert.match(h.nodes.get('message').textContent, /已更新/);
  assert.equal(h.requests.filter(r => r.url === '/fish/session').length, 2, 'parallel refresh requests share one renewal');
  await h.click('forget');
  assert.equal(h.nodes.get('token').value, ''); assert.equal(h.nodes.get('content').hidden, true);
  await h.click('connect');
  assert.equal(h.nodes.get('content').hidden, false); assert.match(h.nodes.get('message').textContent, /已更新/);
});

test('disconnecting during automatic bootstrap prevents a late response from reconnecting the page', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, async url => { if (url === '/fish/session') await gate; });
  await h.click('forget'); release();
  await h.waitFor(() => !h.nodes.get('connect').disabled);
  assert.equal(h.nodes.get('token').value, ''); assert.equal(h.nodes.get('content').hidden, true);
  assert.match(h.nodes.get('message').textContent, /已断开/);
  assert.equal(h.requests.some(r => r.url.startsWith('/fish/chats')), false);
});

test('manual token input remains usable if automatic bootstrap is unavailable', async t => {
  const h = await fixture(t, async url => url === '/fish/session' ? Response.json({ ok: false, error: 'bootstrap unavailable' }, { status: 403 }) : null);
  await h.waitFor(() => !h.nodes.get('connect').disabled);
  assert.match(h.nodes.get('message').textContent, /自动连接失败/);
  h.nodes.get('token').value = MASTER;
  await h.click('connect');
  assert.equal(h.nodes.get('content').hidden, false); assert.match(h.nodes.get('message').textContent, /已更新/);
});
