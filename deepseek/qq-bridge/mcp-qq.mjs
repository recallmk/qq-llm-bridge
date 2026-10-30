#!/usr/bin/env node
/**
 * 给 DSH agent 用的 QQ MCP 工具服务器（stdio，行分隔 JSON-RPC）。
 *
 * 由 `@deepseek-ai/dsh-mcp-client` 作为子进程拉起，工具名会变成
 * `mcp__qq__qq_status` 这样。所有动作都转给桥接的本地控制接口，
 * 白名单、日志、群缓冲仍由桥接统一执行。
 *
 * 环境是干净的（mcp-client 会删掉 DSH_ 前缀与含 TOKEN 的环境变量），所以令牌从文件读。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(HERE, 'config.json');
const TOKEN_PATH = path.join(HERE, 'control-token.txt');
const MAX_TEXT = 1800;

export const TOOLS = [
  {
    name: 'qq_find_sticker',
    description: '按当前语境、情绪或动作查找本地大肥鱼表情包。返回真实 sticker_id（id）、画面、台词和适用场景。想配图时再查，不必每轮用。',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: '简短场景词，例如：无语、被窝偷笑、疑惑、开饭、给你心心、摸鱼、晚安' },
      limit: { type: 'integer', minimum: 1, maximum: 12, description: '返回数量，默认8' },
    }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'qq_send_sticker',
    description: '向当前 QQ 会话发送一张已检索到的大肥鱼表情包。只能使用 qq_find_sticker 返回的真实 id，不接受路径、URL 或其他目标。每轮最多一张，受会话冷却限制。可只发表情，也可在最终正文自然补一句；不要重复发图，不发代码或文件路径。',
    inputSchema: { type: 'object', properties: {
      sticker_id: { type: 'string', description: 'qq_find_sticker 返回的 id，例如 fish-10N01' },
    }, required: ['sticker_id'], additionalProperties: false },
  },
  {
    name: 'qq_qzone_status',
    description: '查看空间发布是否可用、今天是否发过、冷却以及最近三条说说，供自己判断是否值得发布。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'qq_post_qzone',
    description: '可选：把自己确实想分享的想法发成 QQ 空间说说。没有日更任务，可以连续多天不发。先看 qq_qzone_status 避免重复；只接受纯文字，默认好友可见。失败或结果不明不要重发。',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: '说说正文，默认最多500字；不是私聊回复或聊天记录' },
      reason: { type: 'string', description: '可选，简短说明此刻为什么想发，仅记录在本地，不进入说说正文' },
    }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'qq_status',
    description: '查看 QQ 桥接自身状态：DSH 是否就绪、OneBot 是否连接、心跳与最近事件时间、当前白名单。只读，随时可调。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'qq_list_groups',
    description: '列出机器人加入的 QQ 群（群号 + 群名），用来确认能往哪个群发言。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'qq_recent_messages',
    description: '读取某个群最近的消息（含真实 message_id 与发言人），比当前这一轮看到的背景更多。只读；message_id 可直接用于 qq_reply。',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '群号' },
        limit: { type: 'number', description: '最多几条，默认 10，上限 20' },
      },
      required: ['group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_send_message',
    description: '主动往某个群或私聊发一条 QQ 消息。只允许白名单内的群/好友。用于本轮想发多条、或想发到别处；发完后本轮的正文留空，别再重复发。',
    inputSchema: {
      type: 'object',
      properties: {
        target_type: { type: 'string', enum: ['group', 'private'], description: 'group=群聊，private=私聊' },
        target_id: { type: 'string', description: '群号或 QQ 号' },
        text: { type: 'string', description: '要发送的纯文本（不要 Markdown）' },
        reply_to_message_id: { type: 'string', description: '可选：引用这条消息（QQ 消息 id）' },
      },
      required: ['target_type', 'target_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_reply',
    description: '需要指明对象时，选择引用群里的某条消息；普通接话不必引用。可直接用本轮 JSON 中的 groupId 和真实 messageId；回复旧消息时也可用 qq_recent_messages 查询。发完后本轮正文留空。',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '群号' },
        message_id: { type: 'string', description: '被引用消息的 id' },
        text: { type: 'string', description: '回复正文（纯文本）' },
      },
      required: ['group_id', 'message_id', 'text'],
      additionalProperties: false,
    },
  },
];

/** HTTP 客户端：所有动作都转给桥接的本地控制接口。 */
export function createBridgeClient({ baseUrl, token, contextToken = '', signal, fetchImpl = globalThis.fetch }) {
  async function call(method, pathname, body) {
    const res = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: { 'x-qq-token': token, ...(contextToken ? { 'x-qq-context': contextToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || data.ok === false) throw new Error(data.error || `桥接返回 ${res.status}（桥接在运行吗？）`);
    return data;
  }
  return {
    status: () => call('GET', '/status'),
    groups: () => call('GET', '/groups'),
    recent: (group, limit) => call('GET', `/recent?group=${encodeURIComponent(group)}&limit=${encodeURIComponent(limit)}`),
    send: (payload) => call('POST', '/send', payload),
    findSticker: (query, limit) => call('GET', `/stickers/search?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`),
    sendSticker: (payload) => call('POST', '/stickers/send', payload),
    fish: (name, args) => call('POST', '/fish/tool', { name, args }),
    qzoneStatus: () => call('GET', '/qzone/status'),
    qzonePost: (payload) => call('POST', '/qzone/post', payload),
  };
}

const str = (v) => (v === undefined || v === null ? '' : String(v));

function requireText(args) {
  const text = str(args?.text).trim();
  if (!text) throw new Error('text 不能为空');
  if (text.length > MAX_TEXT) throw new Error(`text 太长（${text.length} 字，上限 ${MAX_TEXT}）`);
  return text;
}

function requireId(value, label) {
  const id = str(value).trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error(`${label} 必须是数字 QQ 号/群号`);
  return id;
}

/** 执行一个工具，返回给模型看的文本。 */
export async function callTool(name, args, bridge) {
  switch (name) {
    case 'qq_find_sticker':
      return JSON.stringify(await bridge.findSticker(str(args?.query).slice(0, 160), Math.min(12, Math.max(1, Number(args?.limit) || 8))));
    case 'qq_send_sticker': {
      const id = str(args?.sticker_id).trim();
      if (!id || id.length > 160) throw new Error('sticker_id 无效，请先检索');
      const result = await bridge.sendSticker({ sticker_id: id });
      return `已向当前会话发送表情包：${result.name}，message_id=${result.messageId}。本轮不再发图；想只用表情接话可把正文留空，需要补一句就直接输出文字。`;
    }
    case 'qq_qzone_status':
      return JSON.stringify(await bridge.qzoneStatus());
    case 'qq_post_qzone': {
      const result = await bridge.qzonePost({ text: requireText(args), reason: str(args?.reason).slice(0, 240) });
      return `已发布 QQ 空间说说，tid=${result.tid}，${result.chars} 字，可见范围 ${result.visibility}。这不是 QQ 私聊或群聊消息。`;
    }
    case 'qq_status': {
      const s = await bridge.status();
      return [
        `DSH: ${s.dsh?.ready ? 'ready' : '未就绪'}`,
        `OneBot: ${s.onebot?.connected ? 'connected' : 'disconnected'}`,
        `心跳: ${s.onebot?.heartbeat ?? '未收到'}`,
        `最近事件: ${s.onebot?.lastEventSeconds ?? '-'} 秒前`,
        `白名单群: ${s.allow?.groups?.length ? s.allow.groups.join(',') : '(所有群)'}`,
        `白名单私聊: ${s.allow?.users?.length ? s.allow.users.join(',') : '(空)'}`,
      ].join('\n');
    }
    case 'qq_list_groups': {
      const r = await bridge.groups();
      const list = Array.isArray(r.groups) ? r.groups : [];
      if (!list.length) return '没有取到群列表（NapCat 可能未登录或没有加群）。';
      return list.map((g) => `${g.id} ${g.name ?? ''}`.trim()).join('\n');
    }
    case 'qq_recent_messages': {
      const group = requireId(args?.group_id, 'group_id');
      const limit = Math.min(20, Math.max(1, Number(args?.limit) || 10));
      const r = await bridge.recent(group, limit);
      const list = Array.isArray(r.messages) ? r.messages : [];
      if (!list.length) return `群 ${group} 目前没有缓存到消息。`;
      return list
        .map((m) => `[${m.messageId || '-'}] ${m.name}${m.owner ? '(主人)' : ''}${m.observationId ? ` [observationId=${m.observationId}]` : ''}: ${m.text}`)
        .join('\n');
    }
    case 'qq_send_message': {
      const type = str(args?.target_type);
      if (type !== 'group' && type !== 'private') throw new Error('target_type 只能是 group 或 private');
      const targetId = requireId(args?.target_id, 'target_id');
      const text = requireText(args);
      const replyTo = str(args?.reply_to_message_id).trim() || undefined;
      if (replyTo && !/^\d{1,20}$/.test(replyTo)) throw new Error('reply_to_message_id 必须是消息 id（数字/字符串）');
      const r = await bridge.send({ target_type: type, target_id: targetId, text, reply_to_message_id: replyTo });
      return `已发送到${type === 'group' ? `群 ${targetId}` : `私聊 ${targetId}`}（${r.chars ?? text.length} 字）${r.reply ? '，已引用原消息' : ''}。本轮正文留空即可。`;
    }
    case 'qq_reply': {
      const group = requireId(args?.group_id, 'group_id');
      const messageId = str(args?.message_id).trim();
      if (!/^\d{1,20}$/.test(messageId)) throw new Error('message_id 必须是数字消息 id');
      const text = requireText(args);
      const r = await bridge.send({ target_type: 'group', target_id: group, text, reply_to_message_id: messageId });
      return `已引用群 ${group} 的消息 ${messageId} 回复（${r.chars ?? text.length} 字）。本轮正文留空即可。`;
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

/**
 * 处理一条 JSON-RPC 消息。
 * @returns {object|null} 需要回写的响应；通知（无 id）返回 null。
 */
export async function handleMessage(msg, bridge) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'qq-bridge', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const text = await callTool(name, params?.arguments ?? {}, bridge);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `调用失败：${e.message}` }], isError: true } };
    }
  }
  if (isNotification) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function loadRuntime() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 用默认值 */ }
  const port = Number(cfg?.control?.port) || 3102;
  const token = existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, 'utf8').trim() : '';
  return { baseUrl: `http://127.0.0.1:${port}`, token };
}

async function main() {
  const { baseUrl, token } = loadRuntime();
  if (!token) {
    process.stderr.write('[mcp-qq] 缺少 control-token.txt：桥接启动后会生成，请先启动桥接再重启 DSH\n');
  }
  const bridge = createBridgeClient({ baseUrl, token });
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // 串行处理：stdin 关闭时 for-await 会把还没回完的调用处理完，不会丢响应。
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let msg;
    try { msg = JSON.parse(text); } catch { continue; }
    const response = await handleMessage(msg, bridge);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stderr.write(`[mcp-qq] ${e.message}\n`);
    process.exit(1);
  });
}
