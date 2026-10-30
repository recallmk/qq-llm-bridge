import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { TOOLS, callTool, createBridgeClient } from './mcp-qq.mjs';
import { fishDefinitions } from './fish-tools.mjs';

const scope = String(process.env.QQ_TURN_CONTEXT ?? '');
const access = String(process.env.QQ_TURN_ACCESS ?? 'chat');
const qzoneAllowed = process.env.QQ_TURN_QZONE === '1';
delete process.env.QQ_TURN_CONTEXT;
if (!scope) throw new Error('缺少桥接绑定的回合授权');

const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const token = readFileSync(new URL('./control-token.txt', import.meta.url), 'utf8').trim();
const client = createBridgeClient({ baseUrl: `http://127.0.0.1:${Number(cfg.control.port)}`, token, contextToken: scope });
const qqTools = TOOLS.filter(t => qzoneAllowed || !['qq_qzone_status', 'qq_post_qzone'].includes(t.name));
const fish = access === 'fish' ? fishDefinitions('unused-schema-only') : new Map();
// Antigravity otherwise discovers tools by asking the model to read generated
// schema files. Those reads are intentionally denied for QQ turns, so expose
// the schemas eagerly while keeping model file access closed.
const definitions = [...qqTools, ...[...fish.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters }))]
  .map(t => ({ ...t, _meta: { 'antigravity/alwaysLoad': true } }));
const names = new Set(definitions.map(t => t.name));

async function dispatch(msg) {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return null;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion ?? '2024-11-05',
    capabilities: { tools: {} }, serverInfo: { name: 'antigravity-qq', version: '1.0.0' } });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: definitions });
  if (method === 'tools/call') {
    try {
      const name = String(params?.name ?? '');
      if (!names.has(name)) throw new Error('本轮没有该工具权限');
      const args = params?.arguments ?? {};
      const value = fish.has(name) ? (await client.fish(name, args)).value : await callTool(name, args, client);
      return ok({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
    } catch (error) {
      return ok({ content: [{ type: 'text', text: `调用失败：${error.message}` }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  const response = await dispatch(msg);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
