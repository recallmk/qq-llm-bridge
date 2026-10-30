import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, callTool, handleMessage } from './mcp-qq.mjs';

function fakeBridge() {
  const sent = [];
  return {
    sent,
    status: async () => ({
      dsh: { ready: true },
      onebot: { connected: true, heartbeat: '5 秒前，good', lastEventSeconds: 5 },
      allow: { groups: [], users: ['100000001'] },
    }),
    groups: async () => ({ groups: [{ id: '123', name: '测试群' }] }),
    recent: async (group, limit) => ({
      messages: [{ messageId: '99', name: '甲', text: `群${group} 最近 ${limit} 条`, owner: false }],
    }),
    send: async (payload) => {
      sent.push(payload);
      return { ok: true, chars: payload.text.length, reply: Boolean(payload.reply_to_message_id) };
    },
  };
}

test('the tool list exposes the five qq tools with schemas', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'qq_list_groups', 'qq_recent_messages', 'qq_reply', 'qq_send_message', 'qq_status',
  ]);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 10);
  }
});

test('initialize advertises tools and a stable server name', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, fakeBridge());
  assert.equal(res.result.serverInfo.name, 'qq-bridge');
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.ok(res.result.capabilities.tools);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeBridge()), null);
});

test('tools/call runs the tool and returns text content', async () => {
  const bridge = fakeBridge();
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, bridge);
  assert.equal(list.result.tools.length, TOOLS.length);

  const status = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_status', arguments: {} } }, bridge);
  assert.equal(status.result.isError, undefined);
  assert.match(status.result.content[0].text, /DSH: ready/);

  const groups = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'qq_list_groups', arguments: {} } }, bridge);
  assert.match(groups.result.content[0].text, /123 测试群/);

  const recent = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'qq_recent_messages', arguments: { group_id: '123', limit: 5 } } }, bridge);
  assert.match(recent.result.content[0].text, /\[99\] 甲: 群123 最近 5 条/);
});

test('sending goes through the bridge and reports the quote', async () => {
  const bridge = fakeBridge();
  const res = await handleMessage({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'qq_send_message', arguments: { target_type: 'group', target_id: '123', text: '在的', reply_to_message_id: '99' } },
  }, bridge);
  assert.deepEqual(bridge.sent, [{ target_type: 'group', target_id: '123', text: '在的', reply_to_message_id: '99' }]);
  assert.match(res.result.content[0].text, /已发送到群 123/);
  assert.match(res.result.content[0].text, /已引用原消息/);
});

test('bad arguments come back as a tool error instead of throwing', async () => {
  const bridge = fakeBridge();
  const badType = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'qq_send_message', arguments: { target_type: 'guild', target_id: '1', text: 'x' } } }, bridge);
  assert.equal(badType.result.isError, true);
  assert.match(badType.result.content[0].text, /target_type/);

  const badId = await handleMessage({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'qq_reply', arguments: { group_id: 'abc', message_id: '1', text: 'x' } } }, bridge);
  assert.equal(badId.result.isError, true);
  assert.equal(bridge.sent.length, 0);
});

test('unknown methods are rejected as JSON-RPC errors', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, fakeBridge());
  assert.equal(res.error.code, -32601);
});

test('callTool validates text length before touching the bridge', async () => {
  const bridge = fakeBridge();
  await assert.rejects(() => callTool('qq_send_message', { target_type: 'group', target_id: '1', text: 'x'.repeat(2000) }, bridge), /太长/);
  assert.equal(bridge.sent.length, 0);
});
