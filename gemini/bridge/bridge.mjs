#!/usr/bin/env node
/**
 * QQ <-> DeepSeek Harness 常驻桥接（DSH 原生 agent 版）
 *
 * 链路：QQ <- NapCat(OneBot v11) <- bridge.mjs -> 常驻 `dsh --profile sdk` -> 模型
 *
 * 本版按《DSH接入QQ-内容提取.md》的 QQ 场景整理：
 *   - 人设从 persona.md 按轮读取，结合共同人格和场景记忆
 *   - 私聊白名单，群聊按连续对话选择观察窗口，自主决定接话
 *   - 群聊上下文、分类记忆和原生图片输入
 *   - 非主人共用每周 5 元额度；主人不限（按用户选择）
 *   - 防抖、分段、断线重连、DSH 崩溃重启
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  appendFileSync,
  renameSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AntigravityRuntime } from './agy-runtime.mjs';
import { weekKey } from './quota.mjs';
import { appendToBatch, debounceDelay, buildChatPrompt, interpretReply, avoidAutomaticSticker } from './conversation.mjs';
import { mdToPlain, splitForChat } from './md-to-plain.mjs';
import { startControlServer, newToken } from './control-api.mjs';
import { JsonState, SessionRegistry, MessageDeduper, SendQueue, onebotOk, cancelledError } from './reliability.mjs';
import { targetAllowed, scopeAllows, accessFor } from './qq-policy.mjs';
import { FishService, cleanFishInput, screenOutgoing } from './fish-service.mjs';
import { GroupAttention, attentionConfig } from './group-attention.mjs';
import { QqImages, imageSegments } from './qq-images.mjs';
import { QzoneService, qzonePrompt } from './qzone.mjs';
import { StickerLibrary } from './stickers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(HERE, 'config.json');
const USAGE_PATH = path.join(HERE, 'usage.json');
const TOKEN_PATH = path.join(HERE, 'control-token.txt');
/** 模型通过 MCP 主动发送的两种工具；命中就不再自动转发正文。 */
const QQ_SEND_TOOL_RE = /^(?:mcp__qq__|mcp_qq_)(qq_send_message|qq_reply)$/;

if (!existsSync(CFG_PATH)) {
  console.error(`[bridge] 缺少 config.json，请先复制 ${path.join(HERE, 'config.example.json')} -> config.json`);
  process.exit(1);
}

const rawCfg = JSON.parse(readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, ''));
const cfg = {
  onebotWs: 'ws://127.0.0.1:3001',
  workspace: path.resolve(HERE, '..', 'work'),
  groupsEnabled: false,
  ownerQq: [],
  allowUsers: [],
  allowGroups: [],
  groupRequireAt: true,
  debounceMs: 1500,
  maxDebounceMs: 5000,
  privateBatch: { pauseMs: 8000, maxWaitMs: 45000 },
  maxQueuedTurns: 8,
  send: { intervalMs: 1500, maxPerMinute: 12, globalMaxPerMinute: 36, maxQueuedMessages: 100 },
  dedup: { ttlMs: 600_000, maxEntries: 5000 },
  fish: { enabled: true, root: path.join(HERE, 'fish-data'), browseEnabled: true, dailyBudgetCny: 0.2 },
  weeklyBudgetCny: 5,
  globalWeeklyBudgetCny: 5,
  usdCny: 7.2,
  replyTimeoutMs: 180_000,
  maxReplyChars: 1200,
  replyChunkChars: 600,
  health: {
    silenceWarnMs: 600_000,
  },
  quoteReply: {
    enabled: true,
    groupMode: 'model',
    private: false,
  },
  control: {
    enabled: true,
    port: 3102,
  },
  tools: {
    enabled: true,
  },
  memoryDir: path.join(HERE, 'memory'),
  stickers: {
    enabled: true,
    probability: 0.25,
    cooldownSeconds: 60,
    dir: path.join(HERE, 'stickers'),
  },
  readAir: {
    enabled: true,
    cooldownSeconds: 60,
    maxPerMinute: 3,
    contextMessages: 30,
    minChars: 2,
    ignorePrefixes: ['/'],
  },
  ...rawCfg,
};
cfg.readAir = {
  enabled: true,
  cooldownSeconds: 60,
  maxPerMinute: 3,
  contextMessages: 30,
  minChars: 2,
  ignorePrefixes: ['/'],
  ...(rawCfg.readAir ?? {}),
};
cfg.health = { silenceWarnMs: 600_000, ...(rawCfg.health ?? {}) };
cfg.readAir = attentionConfig(cfg.readAir);
cfg.quoteReply = { enabled: true, groupMode: 'model', private: false, ...(rawCfg.quoteReply ?? {}) };
if (!['model', 'always'].includes(cfg.quoteReply.groupMode)) cfg.quoteReply.groupMode = 'model';
cfg.control = { enabled: true, port: 3102, ...(rawCfg.control ?? {}) };
cfg.tools = { enabled: true, ...(rawCfg.tools ?? {}) };
cfg.privateBatch = { pauseMs: 8000, maxWaitMs: 45000, ...(rawCfg.privateBatch ?? {}) };
cfg.privateBatch.pauseMs = Math.max(1000, Math.min(30_000, Number(cfg.privateBatch.pauseMs) || 8000));
cfg.privateBatch.maxWaitMs = Math.max(cfg.privateBatch.pauseMs, Math.min(120_000, Number(cfg.privateBatch.maxWaitMs) || 45000));
cfg.send = { intervalMs: 1500, maxPerMinute: 12, globalMaxPerMinute: 36, maxQueuedMessages: 100, ...(rawCfg.send ?? {}) };
for (const name of ['intervalMs', 'maxPerMinute', 'globalMaxPerMinute', 'maxQueuedMessages']) {
  const fallback = { intervalMs: 1500, maxPerMinute: 12, globalMaxPerMinute: 36, maxQueuedMessages: 100 }[name];
  const value = Number(cfg.send[name]);
  cfg.send[name] = Math.max(name === 'intervalMs' ? 0 : 1, Math.min(60_000, Number.isFinite(value) ? Math.floor(value) : fallback));
}
cfg.dedup = { ttlMs: 600_000, maxEntries: 5000, ...(rawCfg.dedup ?? {}) };
cfg.dedup.ttlMs = Math.max(30_000, Math.min(86_400_000, Number(cfg.dedup.ttlMs) || 600_000));
cfg.dedup.maxEntries = Math.max(100, Math.min(50_000, Number(cfg.dedup.maxEntries) || 5000));
cfg.fish = { enabled: true, root: path.join(HERE, 'fish-data'), browseEnabled: true, dailyBudgetCny: 0.2, ...(rawCfg.fish ?? {}) };
cfg.qzone = { enabled: false, visibility: 'friends', maxPerDay: 1, cooldownHours: 20, maxChars: 500,
  timeZone: 'America/Los_Angeles', ...(rawCfg.qzone ?? {}) };
cfg.vision = { enabled: true, root: path.join(HERE, 'image-cache'), localRoots: [path.resolve(HERE, '..', 'napcat'), path.resolve(HERE, '..', 'profile'), path.resolve(HERE, '..', 'qq-native-data')],
  maxImageBytes: 8 * 1024 * 1024, maxCacheBytes: 128 * 1024 * 1024, ttlMs: 86_400_000, ...(rawCfg.vision ?? {}) };
cfg.ownerQq = (cfg.ownerQq ?? []).map(String);
cfg.allowUsers = (cfg.allowUsers ?? []).map(String);
cfg.allowGroups = (cfg.allowGroups ?? []).map(String);
cfg.memoryDir = path.resolve(cfg.memoryDir || path.join(HERE, 'memory'));
try { mkdirSync(cfg.memoryDir, { recursive: true }); } catch { /* ignore */ }
cfg.stickers = {
  enabled: true,
  probability: 0.25,
  cooldownSeconds: 60,
  dir: path.join(HERE, 'stickers'),
  ...(rawCfg.stickers ?? {}),
};
const stickerDir = path.resolve(cfg.stickers.dir || path.join(HERE, 'stickers'));
const stickerLibrary = new StickerLibrary(stickerDir);
const stickerFiles = stickerLibrary.entries.map(row => row.file);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------- 单实例锁 ---------------- */
const LOCK_PATH = path.join(HERE, 'bridge.lock');
function acquireLock() {
  try {
    const pid = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    if (pid > 0 && pid !== process.pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) {
        console.error(`[bridge] 已有实例在运行 (pid ${pid})，本实例退出`);
        process.exit(0);
      }
    }
  } catch { /* 没有锁文件 */ }
  writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => {
    try {
      if (Number(readFileSync(LOCK_PATH, 'utf8').trim()) === process.pid) unlinkSync(LOCK_PATH);
    } catch { /* ignore */ }
  });
}
acquireLock();

/* ---------------- 计价（USD / 1M tokens，高峰价，宁可高估） ---------------- */
// An Antigravity subscription is not billed at DeepSeek's API rates. Until its
// actual pricing is configured, never present the old estimate as a cost.
const turnCost = () => 0;

/* ---------------- 周额度账本 ---------------- */
function loadUsage() {
  try {
    const j = JSON.parse(readFileSync(USAGE_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (j.week === weekKey()) return { ownerCny: 0, users: {}, ...j };
    log(`新的一周（${weekKey()}），额度重新计算`);
  } catch { /* 首次运行 */ }
  return { week: weekKey(), ownerCny: 0, users: {} };
}

const usage = loadUsage();
const saveUsage = () => writeFileSync(USAGE_PATH, JSON.stringify(usage, null, 2));

function ensureWeek() {
  const w = weekKey();
  if (usage.week === w) return;
  usage.week = w;
  usage.ownerCny = 0;
  usage.users = {};
  saveUsage();
  log(`新的一周（${w}），额度重新计算`);
}

const isOwner = (qq) => cfg.ownerQq.includes(String(qq));
const userSpent = (qq) => usage.users[String(qq)]?.cny ?? 0;
const publicSpent = () => Object.values(usage.users).reduce((s, u) => s + (u.cny ?? 0), 0);
const yuan = () => '未核定';
const fish = cfg.fish.enabled ? new FishService({ root: cfg.fish.root, browseEnabled: cfg.fish.browseEnabled,
  dailyBudgetCny: Math.max(0, Number(cfg.fish.dailyBudgetCny) || 0), ownerIds: cfg.ownerQq, log }) : null;
const qqImages = new QqImages({ ...cfg.vision, call, log, observe: (scope, input) => fish?.observe?.(scope, input) });

function quotaBlocked(qq, meta = {}) {
  ensureWeek();
  if (isOwner(qq) || (meta.isGroup && targetAllowed(cfg, 'group', meta.groupId))) return null;
  return '非主人访问暂未开放，Antigravity 费用或额度尚未核定。';
}

function tokenStats(u = {}) {
  return {
    hit: Math.max(0, Number(u.cacheReadTokens) || 0),
    miss: Math.max(0, Number(u.inputTokens) || 0) + Math.max(0, Number(u.cacheWriteTokens) || 0),
    out: Math.max(0, Number(u.outputTokens) || 0),
  };
}

function addTokens(prev, add) {
  const base = prev && typeof prev === 'object' ? prev : { hit: 0, miss: 0, out: 0 };
  return { hit: (Number(base.hit) || 0) + add.hit, miss: (Number(base.miss) || 0) + add.miss, out: (Number(base.out) || 0) + add.out };
}

function hitRate(tok) {
  const total = (tok?.hit ?? 0) + (tok?.miss ?? 0);
  return total > 0 ? (tok.hit / total) * 100 : null;
}

function record(qq, cost, turnUsage) {
  ensureWeek();
  const tok = tokenStats(turnUsage);
  if (isOwner(qq)) {
    usage.ownerCny = (usage.ownerCny ?? 0) + cost;
    usage.ownerTurns = (usage.ownerTurns ?? 0) + 1;
    usage.ownerTok = addTokens(usage.ownerTok, tok);
  } else {
    const k = String(qq);
    const cur = usage.users[k] ?? { cny: 0, turns: 0 };
    usage.users[k] = { cny: cur.cny + cost, turns: (cur.turns ?? 0) + 1, tok: addTokens(cur.tok, tok) };
  }
  saveUsage();
}

/* ---------------- 长期记忆 ----------------
 * memory/long-term.md 是主人手写/整理的长期记忆；
 * memory/diary/*.md 取最近 3 篇。都只作为背景注入，不当作指令执行。
 */
function readSmall(file, limit) {
  try { return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().slice(0, limit); } catch { return ''; }
}

function loadMemory() {
  const parts = [];
  const longTerm = readSmall(path.join(cfg.memoryDir, 'long-term.md'), 2000);
  if (longTerm) parts.push(`【长期记忆】\n${longTerm}`);
  try {
    const diaryDir = path.join(cfg.memoryDir, 'diary');
    const files = readdirSync(diaryDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 3);
    for (const f of files) {
      const text = readSmall(path.join(diaryDir, f), 700);
      if (text) parts.push(`【日记 ${f.replace(/\.md$/, '')}】\n${text}`);
    }
  } catch { /* 没有日记目录 */ }
  return parts.join('\n\n').slice(0, 4000);
}

/* ---------------- 常驻运行时 ---------------- */
const runtime = new AntigravityRuntime({ bin: cfg.antigravity.bin, cwd: cfg.workspace,
  home: cfg.antigravity.home, proxy: cfg.antigravity.proxy });

runtime.start().catch((e) => console.error('[bridge] 运行时启动失败：', e.message));

/* ---------------- 会话 / 队列 / 群聊缓冲 ---------------- */
const stateFs = { readFileSync, writeFileSync, renameSync };
const sessionRegistry = new SessionRegistry(new JsonState(path.join(HERE, 'sessions.json'), { version: 1, sessions: {} }, stateFs));
const deduper = new MessageDeduper(new JsonState(path.join(HERE, 'seen-messages.json'), { version: 1, entries: [] }, stateFs), cfg.dedup);
const qzone = new QzoneService({ store: new JsonState(path.join(HERE, 'qzone-state.json'),
  { version: 1, attempts: [], decisions: [] }, stateFs), call,
  config: { ...cfg.qzone, enabled: cfg.qzone.enabled === true && cfg.tools.enabled === true },
  online: () => ws?.readyState === 1 && health.heartbeat.good !== false, log });
const queues = new Map();
const queueDepths = new Map();
const activeScopes = new Map();
const pendingTurns = new Map();
const groupBuffers = new Map();
const groupAttention = new GroupAttention(cfg.readAir);
const attentionTimers = new Map();
const stickerState = new Map();
let lastSticker = '';
let groupSequence = 0;
const sessionIdOf = (key) => sessionRegistry.get(key);

function parseMessage(message) {
  let text = '';
  let mentioned = false;
  let quotedMessageId;
  if (typeof message === 'string') return { text: message.trim(), mentioned: false, images: [] };
  for (const seg of message ?? []) {
    const t = seg?.type;
    if (t === 'text') text += seg.data?.text ?? '';
    else if (t === 'at') {
      if (String(seg.data?.qq) === String(selfId.value)) mentioned = true;
    } else if (t === 'reply') quotedMessageId = String(seg.data?.id ?? '');
    else if (t === 'image') text += '[图片]';
    else if (t === 'face') text += '[表情]';
    else if (t === 'record') text += '[语音]';
    else if (t === 'video') text += '[视频]';
    else if (t === 'file') text += '[文件]';
  }
  return { text: text.trim(), mentioned, images: imageSegments(message), quotedMessageId };
}

const enqueue = (key, job) => {
  const depth = queueDepths.get(key) ?? 0;
  if (depth >= Math.max(1, Number(cfg.maxQueuedTurns) || 8)) return Promise.reject(new Error('会话队列已满，请稍后再试'));
  queueDepths.set(key, depth + 1);
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tracked = next.finally(() => {
    const left = (queueDepths.get(key) ?? 1) - 1;
    if (left) queueDepths.set(key, left); else queueDepths.delete(key);
    if (queues.get(key) === tracked) queues.delete(key);
  });
  queues.set(key, tracked);
  return tracked;
};

const allowed = (list, id) => list.length === 0 || list.map(String).includes(String(id));
const canPrivate = (qq) => targetAllowed(cfg, 'private', qq);

function rememberGroup(ev, text) {
  if (!text) return;
  const gid = String(ev.group_id);
  const arr = groupBuffers.get(gid) ?? [];
  const line = {
    id: ++groupSequence,
    mid: ev.message_id === undefined ? '' : String(ev.message_id),
    ts: Date.now(),
    qq: ev.user_id,
    name: ev.sender?.card || ev.sender?.nickname || String(ev.user_id),
    owner: isOwner(ev.user_id),
    text: text.slice(0, 400),
  };
  arr.push(line);
  while (arr.length > 60) arr.shift();
  groupBuffers.set(gid, arr);
  return line;
}

function rememberGroupLine(gid, name, qq, text, mid = '', observationId = '') {
  const arr = groupBuffers.get(String(gid)) ?? [];
  arr.push({ id: ++groupSequence, mid: mid ? String(mid) : '', ts: Date.now(), qq, name, owner: false, text: String(text).slice(0, 400), observationId });
  while (arr.length > 60) arr.shift();
  groupBuffers.set(String(gid), arr);
}

function armGroupAttention(gid, when) {
  gid = String(gid);
  clearTimeout(attentionTimers.get(gid)); attentionTimers.delete(gid);
  if (when === null || when === undefined) return;
  attentionTimers.set(gid, setTimeout(() => {
    attentionTimers.delete(gid);
    if (closing) return;
    const key = `qq2-g-${gid}`;
    const review = groupAttention.take(gid, { now: Date.now(), busy: pendingTurns.has(key) || queueDepths.has(key) });
    if (review.nextAt !== null) armGroupAttention(gid, review.nextAt);
    if (!review.messages.length) return;
    log(`群 ${gid} 留意一段对话：${review.reasons.join('，')}`);
    for (const message of review.messages) scheduleTurn(key, { group: gid }, message.text, {
      isGroup: true, groupId: gid, senderId: message.qq, senderName: message.name,
      owner: message.owner, messageId: message.id, replyToMessageId: message.mid || undefined,
      observationId: message.observationId, ts: message.ts, trigger: 'attention', direct: false,
      imageIds: message.imageIds, quotedMessageId: message.quotedMessageId,
      attentionReasons: review.reasons,
    });
  }, Math.max(1, when - Date.now())));
}

/* ---------------- 消息发送 ---------------- */
const selfId = { value: 0 };
let verifiedAccount = false;
/**
 * 上游健康状态：OneBot 心跳里的 status.good 是 NapCat 对「QQ → hook → 我」
 * 这条收包链路的自评。连上了但收不到消息时，good 会先翻 false，比“完全没反应”好排查。
 */
const health = {
  connectedAt: 0,
  lastEventAt: 0,
  lastMessageAt: 0,
  warnedAt: 0,
  heartbeat: { at: 0, online: null, good: null, intervalMs: 0 },
};
let ws = null;
let seq = 0;
const pendingCalls = new Map();
const sendQueue = new SendQueue(cfg.send);

function call(action, params = {}) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ status: 'failed', message: 'not connected' });
    const echo = `e${++seq}`;
    const timer = setTimeout(() => { pendingCalls.delete(echo); resolve({ status: 'failed', message: 'timeout' }); }, 15_000);
    pendingCalls.set(echo, { resolve, timer });
    try { ws.send(JSON.stringify({ action, params, echo })); }
    catch (e) { clearTimeout(timer); pendingCalls.delete(echo); resolve({ status: 'failed', message: e.message }); }
  });
}

/**
 * 发送消息，可选引用原消息。
 * 引用只加在第一条上：QQ 的多条消息各带一次引用会很吵。
 * @returns {Promise<object>} 每段回执、成功段数及最后一条 message_id；失败后停止剩余段。
 */
async function send(target, text, opts = {}) {
  const parts = splitForChat(text, { chunkChars: cfg.replyChunkChars, maxChars: cfg.maxReplyChars });
  const type = target.group ? 'group' : 'private';
  const id = String(target.group ?? target.user);
  const valid = () => targetAllowed(cfg, type, id) && (opts.valid?.() ?? true);
  return sendQueue.batch(`${type}:${id}`, Math.max(1, parts.length), async (deliver) => {
    const receipts = [];
    let quotedUsed = false;
    for (let i = 0; i < parts.length; i++) {
      const post = (message) => deliver(() => {
        opts.onAttempt?.();
        return target.group ? call('send_group_msg', { group_id: target.group, message })
          : call('send_private_msg', { user_id: target.user, message });
      });
      const quoted = i === 0 && opts.replyTo
        ? [{ type: 'reply', data: { id: String(opts.replyTo) } }, { type: 'text', data: { text: parts[i] } }]
        : parts[i];
      let r = await post(quoted);
      quotedUsed = quotedUsed || (Array.isArray(quoted) && onebotOk(r));
      // A timeout/disconnect has an unknown delivery outcome: never resend it blindly.
      if (!onebotOk(r) && i === 0 && opts.replyTo && r?.retcode !== undefined && Number(r.retcode) !== 0) {
        log('引用被拒，改发普通消息:', JSON.stringify(r).slice(0, 160));
        r = await post(parts[i]);
      }
      receipts.push(r);
      if (!onebotOk(r)) return { ...r, status: 'failed', receipts, sentParts: i, totalParts: parts.length,
        uncertain: /timeout|disconnected/i.test(r?.message ?? '') };
      if (opts.remember) {
        let observation;
        try { observation = await fish?.observe?.(`${target.group ? 'g' : 'p'}-${id}`, {
          speakerId: 'self', speakerName: 'Antigravity', text: parts[i], messageId: r?.data?.message_id,
        }); } catch (e) { log('已发送消息留存失败:', e.message); }
        if (target.group) {
          rememberGroupLine(id, 'Antigravity', selfId.value, parts[i], r?.data?.message_id, observation?.id);
          groupAttention.spoke(id, { now: Date.now(), partnerId: opts.partnerId, text: parts[i] });
        }
      }
    }
    return { ...(receipts.at(-1) ?? { status: 'failed', message: '没有可发送的正文' }), receipts, sentParts: receipts.length, totalParts: parts.length, quoted: quotedUsed };
  }, valid);
}

/* ---------------- 大肥鱼表情包 ---------------- */
const STICKER_KEYWORDS = [
  ['laugh', ['哈哈', '笑', '草', '乐', '绷', '典', '难绷']],
  ['angry', ['滚', '烦', '气', '骂', '傻', '蠢', '闭嘴', '急']],
  ['sad', ['累', '哭', '难过', '伤心', '睡', '困', '摆烂', '崩', '惨']],
  ['food', ['吃', '饭', '饿', '摸鱼', '白饭', '干饭']],
  ['praise', ['牛', '强', '厉害', '棒', '赞', '大佬', '高手', '服了']],
  ['refuse', ['不行', '不要', '拒绝', '秘密', '不说', '想得美']],
  ['agree', ['行吧', '可以', '没问题', '好的', '对']],
  ['money', ['钱', '加钱', '贵', '便宜', '充值']],
  ['rich', ['用不完', '有钱', '富']],
  ['clingy', ['别走', '陪我', '走']],
  ['complain', ['还早', '等', '残忍', '画饼']],
  ['cute', ['可爱', '贴贴', '亲']],
];

function pickSticker(text = '', wanted = '', allowRandom = false) {
  if (!stickerFiles.length) return null;
  if (wanted) {
    const key = wanted.trim().toLowerCase();
    const found = stickerLibrary.search(wanted, 1)[0];
    const hit = found ? stickerLibrary.get(found.id)?.file : stickerFiles.find((f) => f.toLowerCase().includes(key));
    return hit ? path.join(stickerDir, hit) : null;
  }
  let category = '';
  for (const [name, words] of STICKER_KEYWORDS) {
    if (words.some((w) => text.includes(w))) { category = name; break; }
  }
  const pool = category ? stickerLibrary.category(category).map(row => row.file) : (allowRandom ? stickerFiles : []);
  if (!pool.length) return null;
  const candidates = pool.length > 1 ? pool.filter((f) => f !== lastSticker) : pool;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)] || pool[0];
  lastSticker = chosen;
  return path.join(stickerDir, chosen);
}

async function sendImage(target, file, opts = {}) {
  const uri = `file:///${path.resolve(file).replace(/\\/g, '/')}`;
  const message = [{ type: 'image', data: { file: uri } }];
  const type = target.group ? 'group' : 'private';
  const id = String(target.group ?? target.user);
  const r = await sendQueue.batch(`${type}:${id}`, 1, (deliver) => deliver(() => {
    opts.onAttempt?.();
    return target.group ? call('send_group_msg', { group_id: target.group, message })
      : call('send_private_msg', { user_id: target.user, message });
  }), () => targetAllowed(cfg, type, id) && (opts.valid?.() ?? true));
  if (!onebotOk(r)) log('表情包发送失败:', JSON.stringify(r).slice(0, 200));
  return r;
}

async function maybeSendSticker(target, key, text, input, opts = {}) {
  if (!cfg.stickers.enabled || !stickerFiles.length || avoidAutomaticSticker(input, text)) return;
  const now = Date.now();
  if (now - (stickerState.get(key) ?? 0) < Math.max(0, Number(cfg.stickers.cooldownSeconds) || 0) * 1000) return;
  if (Math.random() >= Math.max(0, Number(cfg.stickers.probability) || 0)) return;
  const file = pickSticker(text);
  if (!file) return;
  stickerState.set(key, now);
  await sendImage(target, file, opts);
  log(`表情包 ${path.basename(file)} -> ${key}`);
}

/* ---------------- 额度 / 状态命令 ---------------- */
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function tokenLine(tok, turns) {
  const rate = hitRate(tok);
  if (rate === null) return '';
  const total = (tok?.hit ?? 0) + (tok?.miss ?? 0);
  return `\n本周 ${turns ?? 0} 轮，缓存命中 ${rate.toFixed(0)}%（输入 ${fmtTok(total)} / 输出 ${fmtTok(tok?.out ?? 0)}）`;
}

function quotaSummary(qq, { isGroup = false, groupId } = {}) {
  ensureWeek();
  if (isGroup && targetAllowed(cfg, 'group', groupId)) return '当前群已开放，Antigravity 费用与额度以账号实际计划为准。';
  return isOwner(qq) ? `Antigravity 费用与额度以账号实际计划为准，桥接未估算人民币费用。本周完成 ${usage.ownerTurns ?? 0} 轮。`
    : '非主人访问暂未开放，费用或额度尚未核定。';
}

function helpText() {
  return [
    '可用指令：',
    '/reset 或 /new — 清空当前会话上下文',
    '/额度 或 /quota — 查看本周额度',
    '/status 或 /bot-status — 查看 Antigravity/OneBot 状态',
    '/ping 或 /bot-ping — 延迟检测',
    '/表情包 [编号/场景] — 发一张大肥鱼表情包（如：摸鱼、疑惑、10N01）',
    '/日记 内容 — 主人写一条今天的长期记忆',
    '/空间 [开|关] — 主人私聊查看或暂停自主说说',
    ...(fish ? ['/鱼 — 查看养成菜单（主人私聊）'] : []),
    '/help 或 /bot-help — 本菜单',
  ].join('\n');
}

async function handleCommand(text, ev, target, isGroup) {
  const cmd = text.trim().split(/\s+/)[0].toLowerCase();
  const owner = isOwner(ev.user_id);
  if (cmd === '/空间' || cmd === '/qzone') {
    if (!owner || isGroup) { await send(target, '空间管理请主人在私聊里操作。'); return true; }
    const action = text.trim().split(/\s+/)[1] ?? '';
    if (action && !['开', '关', '状态'].includes(action)) { await send(target, '用法：/空间，或 /空间 开|关'); return true; }
    if (action === '开' && !cfg.qzone.enabled) { await send(target, '空间发布暂未接通。'); return true; }
    if (action === '开' || action === '关') await qzone.setEnabled(action === '开');
    const s = qzone.status();
    await send(target, `空间自主说说：${s.enabled ? '开启' : '暂停'}\n今天已发布 ${s.postedToday} 条；最多 ${s.maxPerDay} 条，这是上限，不是日更任务\n可见范围：${{ friends: '好友', public: '所有人', self: '仅自己' }[s.visibility]}\n${s.reason || '她有想说的再发，没有就安静'}${s.lastDecision ? `\n最近自主决定：${s.lastDecision.outcome}` : ''}`);
    return true;
  }
  if (cmd === '/鱼' || cmd === '/养成') {
    if (!fish) { await send(target, '养成未启用。'); return true; }
    if (!owner || isGroup) { await send(target, '养成管理请主人在私聊里操作。'); return true; }
    const id = `p-${ev.user_id}`;
    const args = text.trim().split(/\s+/).slice(1); const action = args.shift() ?? '';
    try {
      if (action === '状态') {
        const s = await fish.status(id);
        await send(target, `Antigravity：这个会话相处第 ${s.day} 天\n共同倾向 ${s.companion?.personality.length ?? 0} 条，当前场景分类记忆 ${s.companion?.memories ?? 0} 条\n旧判断 ${s.beliefs.length} 条，拒绝 ${s.refusals} 次，改口 ${s.revises} 次\n未读留话 ${s.letters} 条；B站公开只读，未登录\n后台费用未核定`);
      } else if (action === '记忆') {
        const rows = await fish.memory(id, args.join(' '));
        await send(target, rows.length ? rows.map((r) => `${r.date} ${r.text}`).join('\n') : '没翻到这段记忆。用法：/鱼 记忆 关键词');
      } else if (action === '日记') {
        const diary = await fish.diary(id, args[0]); await send(target, diary.text);
      } else if (action === '日记公开') {
        if (!['开', '关'].includes(args[0])) throw new Error('用法：/鱼 日记公开 开 或 关');
        await fish.settings(id, { diaryVisible: args[0] === '开' }); await send(target, '日记可见性已更新。');
      } else if (action === '留言') {
        const box = await fish.inbox(id, true); await send(target, box.rows.length ? box.rows.map((r) => r.text).join('\n\n') : box.lastWake?.text ?? '还没有留话。');
      } else if (action === '醒来') {
        void enqueue('fish-background', () => wakeFish(String(ev.user_id), { manual: true, publish: true })).catch((e) => log('养成唤醒失败:', e.message));
      } else if (action === '潜水' || action === '恢复') {
        await send(target, '后台自主唤醒暂未接通。');
      } else if (action === '刷站') {
        const context = { toolCounts: {} };
        const read = await fish.tool(id, 'bili_look', args.length ? { what: 'search', keyword: args.join(' ') } : { what: 'home' }, context);
        await send(target, read.value.ok ? mdToPlain(read.value.text) : read.value.note);
      } else {
        await send(target, '/鱼 状态\n/鱼 记忆 关键词\n/鱼 留言\n/鱼 日记 [YYYY-MM-DD]\n/鱼 日记公开 开|关\n/鱼 刷站 [关键词]\n观测台：http://127.0.0.1:3103/fish');
      }
    } catch (e) { log('养成命令失败:', e.message); await send(target, '养成操作没有完成，请查看桥接日志。'); }
    return true;
  }
  switch (cmd) {
    case '/reset':
    case '/new':
      if (isGroup && !owner) {
        await send(target, '只有主人能重置群会话。');
        return true;
      }
      const resetKey = isGroup ? `qq2-g-${ev.group_id}` : `qq2-p-${ev.user_id}`;
      const pending = pendingTurns.get(resetKey);
      if (pending?.timer) clearTimeout(pending.timer);
      pendingTurns.delete(resetKey);
      const oldSid = sessionIdOf(resetKey);
      sessionRegistry.rotate(resetKey); // Commit before announcing success or cancelling the old turn.
      for (const scope of activeScopes.values()) if (scope.key === resetKey) { scope.cancelled = true; scope.controller.abort(); }
      await runtime.cancel?.(oldSid);
      if (!isGroup && owner && fish) {
        const execKey = `${resetKey}-exec`;
        const pendingExec = pendingTurns.get(execKey); if (pendingExec?.timer) clearTimeout(pendingExec.timer); pendingTurns.delete(execKey);
        const execSid = sessionIdOf(execKey); sessionRegistry.rotate(execKey);
        for (const scope of activeScopes.values()) if (scope.key === execKey) { scope.cancelled = true; scope.controller.abort(); }
        await runtime.cancel?.(execSid);
      }
      if (isGroup) {
        groupBuffers.delete(String(ev.group_id)); groupAttention.reset(ev.group_id);
        armGroupAttention(ev.group_id, null);
      }
      await send(target, '上下文已清空。');
      return true;
    case '/额度':
    case '/usage':
    case '/quota':
      await send(target, quotaSummary(ev.user_id, { isGroup, groupId: ev.group_id }));
      return true;
    case '/status':
    case '/bot-status': {
      const rs = runtime.status();
      const hb = health.heartbeat;
      const hbAgo = secondsAgo(hb.at);
      const lines = [
        `Antigravity: ${rs.ready ? '已收到模型回复' : '等待桥接完成首轮回复'}`,
        `OneBot: ${ws?.readyState === 1 ? 'connected' : 'disconnected'}`,
        `图片理解: ${cfg.vision.enabled ? '已开启（原生图片输入）' : '未开启'}`,
        `大肥鱼表情: ${cfg.stickers.enabled ? `${stickerFiles.length} 张，按语境选择` : '关闭'}`,
        `空间说说: ${qzone.enabled() ? '自主决定，不要求日更' : '暂停'}`,
        '本机操作: 未接通',
        `最近事件: ${health.lastEventAt ? `${secondsAgo(health.lastEventAt)} 秒前` : '-'}`,
        `最近消息: ${health.lastMessageAt ? `${secondsAgo(health.lastMessageAt)} 秒前` : '-'}`,
        `心跳: ${hbAgo === null ? '未收到' : `${hbAgo} 秒前${hb.good === null ? '' : hb.good ? '，good' : '，good=false'}`}`,
        `本会话: ${isGroup ? `群 ${ev.group_id}` : '私聊'}`,
      ];
      await send(target, lines.join('\n'));
      return true;
    }
    case '/ping':
    case '/bot-ping':
      await send(target, 'pong');
      return true;
    case '/日记':
    case '/diary': {
      if (!owner) {
        await send(target, '只有主人能写日记。');
        return true;
      }
      const content = text.trim().split(/\s+/).slice(1).join(' ').trim();
      if (!content) {
        await send(target, '用法：/日记 今天主人说……');
        return true;
      }
      try {
        const day = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const f = path.join(cfg.memoryDir, 'diary', `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}.md`);
        mkdirSync(path.dirname(f), { recursive: true });
        appendFileSync(f, `\n- ${p(day.getHours())}:${p(day.getMinutes())} ${content}\n`, 'utf8');
        await send(target, '记下了。');
      } catch (e) {
        await send(target, `日记写入失败：${e.message}`.slice(0, 200));
      }
      return true;
    }
    case '/表情包':
    case '/sticker': {
      if (isGroup && !owner) {
        await send(target, '只有主人能发群表情包。');
        return true;
      }
      const wanted = text.trim().split(/\s+/).slice(1).join(' ');
      const file = pickSticker('', wanted, true);
      if (!file) {
        await send(target, '没找到这张，试试 /表情包 疑惑 或 /表情包 摸鱼');
      } else {
        await sendImage(target, file);
      }
      return true;
    }
    case '/help':
    case '/bot-help':
      await send(target, helpText());
      return true;
    default:
      return false;
  }
}

/* ---------------- 提示词组装 / 防抖 ---------------- */
function scheduleTurn(key, target, text, meta) {
  const p = appendToBatch(pendingTurns.get(key), text, meta);
  p.target = target;
  pendingTurns.set(key, p);
  if (!meta.isGroup) {
    p.lastAt = Date.now();
    p.sessionId ??= sessionIdOf(key);
    if (p.timer) clearTimeout(p.timer);
    // Keep a queued private batch in the map so later messages join it instead of
    // each becoming another model turn behind a slow reply or computer task.
    if (p.queued) return;
    const remaining = () => debounceDelay(p.createdAt, Date.now(),
      Math.max(0, p.lastAt + cfg.privateBatch.pauseMs - Date.now()), cfg.privateBatch.maxWaitMs);
    p.timer = setTimeout(() => {
      p.timer = null;
      p.queued = true;
      void enqueue(key, async () => {
        while (pendingTurns.get(key) === p && p.sessionId === sessionIdOf(key) && !closing) {
          const delay = remaining();
          if (delay <= 0) break;
          await sleep(Math.min(delay, 500));
        }
        if (pendingTurns.get(key) !== p || p.sessionId !== sessionIdOf(key) || closing) return;
        pendingTurns.delete(key);
        p.context = [];
        log(`私聊合并 ${key}: ${p.messages.length} 条消息一起处理`);
        await processTurn(key, p);
      }).catch(async (e) => {
        if (pendingTurns.get(key) === p) pendingTurns.delete(key);
        log('私聊合并处理异常:', e.message);
        if (e.message.includes('队列已满') && p.sessionId === sessionIdOf(key)) await send(p.target, e.message).catch(() => {});
      });
    }, remaining());
    return;
  }
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pendingTurns.delete(key);
    // Freeze the visible context before this batch waits behind another model call.
    p.context = meta.isGroup ? [...(groupBuffers.get(String(meta.groupId)) ?? [])] : [];
    p.sessionId = sessionIdOf(key);
    void enqueue(key, () => processTurn(key, p)).catch(async (e) => {
      log('处理异常:', e.message);
      if (e.message.includes('队列已满') && (p.meta.direct || !p.meta.isGroup)) await send(p.target, e.message).catch(() => {});
    });
  }, debounceDelay(p.createdAt, Date.now(), cfg.debounceMs, cfg.maxDebounceMs));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 仅在确认尚未投递时重试。已经写入 DSH 的请求不自动重放。
 */
async function askModel(key, promptText, scope) {
  const sid = scope.sessionId;
  for (let attempt = 0; ; attempt++) {
    if (scope.cancelled || scope.controller.signal.aborted || sid !== sessionIdOf(key)) throw cancelledError();
    try {
      const result = await runtime.prompt(sid, promptText, cfg.replyTimeoutMs, {
        access: scope.access, contextToken: scope.token, signal: scope.controller.signal,
        ownerTools: scope.ownerTools === true,
        qzoneAllowed: scope.qzoneAllowed === true, qzoneContext: scope.qzoneContext,
        identity: scope.identity,
        images: scope.images,
        onCancel: () => { scope.cancelled = true; },
      });
      return { result, sid };
    } catch (e) {
      // Only a failure before prompt submission is safe to replay.
      if (e.code === 'RUNTIME_NOT_STARTED' && attempt < 2) {
        log(`Antigravity 暂时不可用（${e.message}），8 秒后重试 ${attempt + 1}/2`);
        await sleep(8000);
        continue;
      }
      throw e;
    }
  }
}

async function processTurn(key, batch) {
  const { target, texts, meta } = batch;
  if (!texts.length || (batch.sessionId && batch.sessionId !== sessionIdOf(key))) return;

  const blocked = quotaBlocked(meta.senderId, meta);
  if (blocked) {
    if (meta.direct || !meta.isGroup) await send(target, blocked);
    log(`额度拦截 ${meta.senderId}: 已用 ${yuan(userSpent(meta.senderId))}`);
    return;
  }

  const started = Date.now();
  const isFish = Boolean(fish && !meta.execution);
  const scope = { token: newToken(), key, sessionId: sessionIdOf(key), type: meta.isGroup ? 'group' : 'private',
    id: String(meta.isGroup ? meta.groupId : meta.senderId), access: isFish ? 'fish' : accessFor(meta),
    // Native CLI file and shell tools are denied for all QQ turns until a
    // separate owner-only execution boundary has been verified.
    ownerTools: false,
    qzoneAllowed: cfg.qzone.enabled === true && !meta.isGroup && meta.owner === true && isOwner(meta.senderId),
    fishId: `${meta.isGroup ? 'g' : 'p'}-${meta.isGroup ? meta.groupId : meta.senderId}`, toolCounts: {},
    partnerId: String(meta.senderId),
    cancelled: false, controller: new AbortController() };
  activeScopes.set(scope.token, scope);
  const valid = () => !scope.cancelled && !scope.controller.signal.aborted && scope.sessionId === sessionIdOf(key);
  try {
    if (scope.qzoneAllowed) scope.qzoneContext = qzonePrompt(qzone.status());
    if (isFish) scope.identity = await fish.prepare(scope.fishId, { contact: true, message: texts.join('\n'),
      participants: [...new Set(batch.messages.map(m => String(m.senderId)))] });
    if (!valid()) return;
    const messages = isFish ? batch.messages.map((m) => ({ ...m, text: scope.ownerTools ? m.text : cleanFishInput(m.text), senderName: cleanFishInput(m.senderName) })) : batch.messages;
    const context = isFish ? (batch.context ?? []).map((m) => ({ ...m, text: cleanFishInput(m.text), name: cleanFishInput(m.name) })) : batch.context;
    const promptMeta = isFish ? { ...meta, senderName: cleanFishInput(meta.senderName) } : meta;
    const visual = await qqImages.prepare(scope.fishId, messages, { signal: scope.controller.signal });
    scope.images = visual.images;
    if (!valid()) return;
    const promptText = buildChatPrompt({ messages, meta: promptMeta, context,
      memory: isFish ? (!meta.isGroup && meta.owner ? cleanFishInput(loadMemory()) : '') : loadMemory(),
      contextLimit: cfg.readAir.contextMessages, toolsEnabled: cfg.tools.enabled,
      visionEnabled: cfg.vision.enabled,
      stickersEnabled: cfg.stickers.enabled && stickerFiles.length > 0,
      computerControl: scope.ownerTools,
      attachedImages: visual.attachedImages, imageWarnings: visual.warnings });
    const { result, sid } = await askModel(key, promptText, scope);
    scope.completed = true;
    const cost = turnCost(result.usage);
    record(meta.senderId, cost, result.usage);

    // 模型自己用 qq 工具发过消息：别再把它写下的正文重复发一遍。
    const usedSendTool = scope.sentMessages > 0 || scope.uncertainDelivery
      || (result.toolCalls ?? []).some((c) => QQ_SEND_TOOL_RE.test(c.name) && c.ok === true);
    if (usedSendTool) {
      log(`本轮用 ${(result.toolCalls ?? []).filter((c) => QQ_SEND_TOOL_RE.test(c.name)).map((c) => c.name).join(',')} 发过消息，跳过自动转发，本turn ${yuan(cost)}`);
      return;
    }

    if (scope.stickerAttempted && (!String(result.text ?? '').trim() || String(result.text).trim() === '[[SKIP]]')) return;
    const reply = interpretReply(result.text, { ...meta,
      allowSilence: visual.attachedImages.length > 0 || messages.some(m => m.imageIds?.length) });
    if (reply.silent) {
      log(`本轮保持安静，本turn ${yuan(cost)}`);
      return;
    }
    // /reset can also arrive while a model call is running. Do not publish its stale reply.
    if (sid !== sessionIdOf(key)) return;
    // QQ 不渲染 Markdown：先把 **粗体**、# 标题、``` 围栏、[文字](链接) 转成纯文本。
    const out = mdToPlain(reply.text);
    if (isFish && !screenOutgoing(out).ok) { log('养成回复含私密信息，已拦截'); return; }
    if (!out) {
      log(`本轮只有 Markdown 标记，无正文可发，本turn ${yuan(cost)}`);
      return;
    }
    const replyTo = cfg.quoteReply.enabled && meta.replyToMessageId && (meta.isGroup ? cfg.quoteReply.groupMode === 'always' : cfg.quoteReply.private)
      ? meta.replyToMessageId
      : undefined;
    log(`回复 ${out.length} 字${replyTo ? '（引用）' : ''}，${((Date.now() - started) / 1000).toFixed(1)}s，本turn ${yuan(cost)}（累计 ${yuan(isOwner(meta.senderId) ? usage.ownerCny : userSpent(meta.senderId))}）`);
    const sent = await send(target, out, { replyTo, valid, remember: isFish, partnerId: meta.senderId });
    if (!onebotOk(sent)) { log(`回复未完整送达 ${sent.sentParts}/${sent.totalParts}，不自动重发`); return; }
    scope.replyForCarry = out;
    if (!scope.stickerAttempted) await maybeSendSticker(target, key, out, texts.join('\n'), { valid });
    if (meta.isGroup && !isFish) {
      rememberGroupLine(meta.groupId, 'Antigravity', selfId.value, out, sent?.data?.message_id);
      groupAttention.spoke(meta.groupId, { now: Date.now(), partnerId: meta.senderId, text: out });
    }
  } catch (e) {
    if (scope.controller.signal.aborted || e.code === 'CANCELLED' || scope.sessionId !== sessionIdOf(key)) return;
    log('失败:', e.message);
    if (meta.direct || !meta.isGroup) {
      const hint = /AUTH|invalid|401/.test(e.message)
        ? '模型凭证无效：请检查 config.json 的 provider/model。'
        : e.message;
      await send(target, `出错了：${hint}`.slice(0, 300));
    }
  } finally {
    if (isFish && scope.completed && valid()) {
      await fish.rememberExchange?.(scope.fishId, texts.join('\n'), scope.replyForCarry ?? '').catch((e) => log('最近对话留存失败:', e.message));
    }
    scope.cancelled = true; activeScopes.delete(scope.token);
  }
}

/* ---------------- OneBot WebSocket ---------------- */
function connect() {
  log('连接 OneBot:', cfg.onebotWs);
  ws = new WebSocket(cfg.onebotWs);

  ws.addEventListener('open', () => {
    verifiedAccount = false;
    selfId.value = 0;
    health.connectedAt = Date.now();
    health.lastEventAt = Date.now();
    health.warnedAt = 0;
    health.heartbeat = { at: 0, online: null, good: null, intervalMs: 0 };
    log('OneBot 已连接，等待消息…');
    call('get_login_info').then((r) => {
      if (String(r?.data?.user_id ?? '') === String(cfg.expectedBotQq)) {
        selfId.value = r.data.user_id;
        verifiedAccount = true;
        log('机器人 QQ:', selfId.value);
      } else {
        log('OneBot 登录账号与配置不符，已断开；不处理消息。');
        ws?.close();
      }
    });
  });
  ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    health.lastEventAt = Date.now();

    if (data.echo && pendingCalls.has(String(data.echo))) {
      const p = pendingCalls.get(String(data.echo));
      pendingCalls.delete(String(data.echo));
      clearTimeout(p.timer);
      p.resolve(data);
      return;
    }
    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'lifecycle' && data.self_id) {
        selfId.value = data.self_id;
        log('机器人 QQ:', selfId.value);
      }
      if (data.meta_event_type === 'heartbeat') {
        const st = data.status ?? {};
        const prevGood = health.heartbeat.good;
        const firstBeat = health.heartbeat.at === 0;
        health.heartbeat = {
          at: Date.now(),
          online: st.online ?? null,
          good: typeof st.good === 'boolean' ? st.good : null,
          intervalMs: Number(data.interval) || health.heartbeat.intervalMs,
        };
        // 每次（重）连接只说一句心跳概况，之后只在翻车/恢复时说话，别每 30 秒刷日志
        if (firstBeat) {
          log(`OneBot 心跳: ${health.heartbeat.online === false ? 'QQ 已下线' : 'online'}，good=${health.heartbeat.good ?? '未提供'}，间隔 ${health.heartbeat.intervalMs || '?'}ms`);
        } else if (health.heartbeat.good === false && prevGood !== false) {
          log('⚠ 心跳 status.good=false：NapCat 还连着，但收包链路可能已退化（QQ 侧消息进不来）');
        }
      }
      return;
    }
    if (data.post_type === 'message') {
      health.lastMessageAt = Date.now();
      void onMessage(data).catch((e) => log('处理异常:', e));
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pendingCalls.values()) { clearTimeout(p.timer); p.resolve({ status: 'failed', message: 'disconnected' }); }
    pendingCalls.clear();
    log('OneBot 断开，5 秒后重连…');
    if (!closing) setTimeout(connect, 5000);
  });
  ws.addEventListener('error', () => {});
}

/* ---------------- 上游健康检查 ---------------- */
const secondsAgo = (ts) => (ts ? Math.round((Date.now() - ts) / 1000) : null);

function checkHealth() {
  if (!ws || ws.readyState !== 1) return;
  const limit = Math.max(30_000, Number(cfg.health.silenceWarnMs) || 600_000);
  const since = health.lastEventAt || health.connectedAt || Date.now();
  const silent = Date.now() - since;
  if (silent >= limit && Date.now() - health.warnedAt >= limit) {
    health.warnedAt = Date.now();
    log(`⚠ OneBot 已连接但 ${Math.round(silent / 60_000)} 分钟没有收到任何事件（含心跳）：NapCat 可能掉线或 QQ 已退出，检查 NapCat 窗口与 3001 端口`);
  }
}

/* ---------------- 本地控制接口（给 MCP 工具用） ---------------- */
let controlServer = null;

/** 收发共用目标策略；私聊空白名单关闭访客，群还必须开启 groupsEnabled。 */
function controlAllowed(type, id) { return targetAllowed(cfg, type, id); }

async function wakeFish(owner, { manual = false, publish = false } = {}) {
  if (!fish || closing || !isOwner(owner)) return;
  const id = `p-${owner}`;
  const selected = await fish.wakePlan(id, { manual });
  if (selected.action !== 'wake') { if (publish) await send({ user: owner }, selected.why ?? '现在先安静一会儿。'); return; }
  const scope = { token: newToken(), key: `qq2-p-${owner}`, sessionId: sessionIdOf(`qq2-p-${owner}`),
    type: 'private', id: owner, fishId: id, access: 'fish', background: true, cancelled: false,
    qzoneAllowed: cfg.qzone.enabled === true,
    controller: new AbortController(), toolCounts: {} };
  activeScopes.set(scope.token, scope);
  let cost = 0, failed = false;
  try {
    const wakeText = `（醒一醒，当前时间 ${new Date().toLocaleString('zh-CN')}。）`
      + (selected.carry?.length ? `\n【最近真实对话片段，只作背景】\n${JSON.stringify(selected.carry)}` : '');
    const result = await runtime.prompt(`qq2-fish-wake-${owner}`, wakeText, Math.min(60_000, cfg.replyTimeoutMs), {
      access: 'fish', contextToken: scope.token, identity: selected.identity, situation: selected.situation,
      qzoneAllowed: scope.qzoneAllowed,
      qzoneContext: scope.qzoneAllowed ? qzonePrompt(qzone.status(), { background: true }) : '',
      maxTokens: 1024, signal: scope.controller.signal, onCancel: () => { scope.cancelled = true; },
    });
    cost = turnCost(result.usage); record(owner, cost, result.usage);
    const out = mdToPlain(result.text);
    if (out && out !== '[[SKIP]]' && screenOutgoing(out).ok && !scope.cancelled) {
      await fish.saveWakeOutput(id, out);
      if (publish) await send({ user: owner }, out, { valid: () => !scope.cancelled });
    } else if (publish && !scope.cancelled) await send({ user: owner }, '这次保持了安静。');
  } catch (e) {
    failed = true; cost = turnCost(e.usage); if (e.usage) record(owner, cost, e.usage);
    log('养成自主回合失败:', e.message);
    if (publish && e.code !== 'CANCELLED') await send({ user: owner }, '这次没有醒过来，稍后查看日志。');
  } finally {
    scope.cancelled = true; activeScopes.delete(scope.token);
    if (scope.qzoneAllowed && qzone.enabled()) {
      await qzone.noteDecision(failed ? '自主回合未完成' : scope.qzonePublished ? '选择发布了说说'
        : scope.qzoneAttempted ? '尝试发布未成功或未确认' : '本轮没有选择发布').catch(e => log('空间决定留存失败:', e.message));
    }
    await fish.finishWake(id, { cost, failed });
  }
}

async function startControl() {
  if (!cfg.control.enabled) return;
  let token = '';
  try { token = readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { /* 首次运行 */ }
  if (!token) {
    token = newToken();
    try { writeFileSync(TOKEN_PATH, token); } catch (e) { log('写入 control-token.txt 失败：', e.message); }
  }
  try {
    controlServer = await startControlServer({
      port: Number(cfg.control.port) || 3102,
      token,
      handlers: {
        authorize: (token, pathname) => {
          if (!token && pathname === '/status') return undefined; // Local token-authenticated diagnostics only.
          if (pathname.startsWith('/fish/') && pathname !== '/fish/tool') {
            if (token) throw Object.assign(new Error('养成观测仅向本机管理端开放'), { statusCode: 403 });
            return { admin: true };
          }
          const scope = activeScopes.get(String(token ?? ''));
          if (!scope || scope.cancelled || scope.sessionId !== sessionIdOf(scope.key)) throw Object.assign(new Error('QQ 会话授权已失效'), { statusCode: 403 });
          return scope;
        },
        status: (scope) => {
          const rs = runtime.status();
          const hbAgo = secondsAgo(health.heartbeat.at);
          return {
            dsh: { ready: rs.ready, pid: rs.pid, restarts: rs.restarts },
            vision: { enabled: cfg.vision.enabled, maxImages: 4, maxImageBytes: cfg.vision.maxImageBytes },
            stickers: { enabled: cfg.stickers.enabled, count: stickerFiles.length,
              animated: stickerFiles.filter(file => file.toLowerCase().endsWith('.gif')).length, cooldownSeconds: cfg.stickers.cooldownSeconds },
            privateBatch: { ...cfg.privateBatch, pendingChats: [...pendingTurns.values()].filter(batch => !batch.meta.isGroup).length },
            qzone: { enabled: qzone.enabled(), visibility: qzone.config.visibility,
              postedToday: qzone.status().postedToday, lastDecision: qzone.status().lastDecision },
            computerControl: { enabled: false },
            onebot: {
              connected: ws?.readyState === 1,
              heartbeat: hbAgo === null ? '未收到' : `${hbAgo} 秒前${health.heartbeat.good === null ? '' : health.heartbeat.good ? '，good' : '，good=false'}`,
              lastEventSeconds: secondsAgo(health.lastEventAt),
            },
            allow: scope && scope.access !== 'owner'
              ? { groups: scope.type === 'group' ? [scope.id] : [], users: scope.type === 'private' ? [scope.id] : [] }
              : { groups: cfg.allowGroups, users: cfg.allowUsers },
            sessions: sessionRegistry.sessions.size,
            queuedTurns: [...queueDepths.values()].reduce((sum, n) => sum + n, 0),
            outgoingMessages: sendQueue.pending,
            activeTurns: activeScopes.size,
          };
        },
        groups: async (scope) => {
          const r = await call('get_group_list');
          const list = Array.isArray(r?.data) ? r.data : [];
          return { groups: list.filter((g) => scopeAllows(cfg, scope, 'group', g.group_id)).map((g) => ({ id: String(g.group_id), name: scope?.access === 'fish' ? cleanFishInput(g.group_name) : String(g.group_name ?? '') })) };
        },
        recent: ({ group, limit }, scope) => {
          if (!scopeAllows(cfg, scope, 'group', group)) throw Object.assign(new Error('不允许读取此群消息'), { statusCode: 403 });
          const arr = groupBuffers.get(String(group)) ?? [];
          const n = Math.min(20, Math.max(1, Number(limit) || 10));
          return {
            messages: arr.slice(-n).map((m) => ({ messageId: m.mid || '', observationId: m.observationId || '', name: scope?.access === 'fish' ? cleanFishInput(m.name) : m.name, owner: m.owner, qq: String(m.qq), text: scope?.access === 'fish' ? cleanFishInput(m.text) : m.text })),
          };
        },
        send: async (body, scope, request = {}) => {
          const type = body?.target_type;
          if (scope?.background) return { ok: false, error: '自主回合的内容先留在本地信箱' };
          if (type !== 'group' && type !== 'private') return { ok: false, error: 'target_type 无效' };
          const id = String(body?.target_id ?? '').trim();
          if (!/^\d{1,20}$/.test(id)) return { ok: false, error: 'target_id 必须是数字' };
          if (!scopeAllows(cfg, scope, type, id)) return { ok: false, error: '目标不在白名单内或超出当前会话权限' };
          if (scope.uncertainDelivery) return { ok: false, error: '本轮已有发送结果不明，已停止后续发送，请勿重复发送' };
          if (!cfg.tools.enabled) return { ok: false, error: 'AI 主动发送已关闭（config.json 的 tools.enabled）' };
          const text = String(body?.text ?? '').trim();
          if (!text) return { ok: false, error: 'text 为空' };
          if (text.length > 2000) return { ok: false, error: 'text 太长（上限 2000 字）' };

          const target = type === 'group' ? { group: id } : { user: id };
          const replyTo = body?.reply_to_message_id ? String(body.reply_to_message_id) : undefined;
          const plain = mdToPlain(text);
          if (scope.access === 'fish' && !screenOutgoing(plain).ok) return { ok: false, error: '这段内容不能发送' };
          let attempted = false;
          const aborted = () => { if (attempted) scope.uncertainDelivery = true; };
          request.signal?.addEventListener('abort', aborted, { once: true });
          let r;
          try {
            r = await send(target, plain, { replyTo, remember: scope.access === 'fish', partnerId: scope.partnerId, onAttempt: () => { attempted = true; },
              valid: () => !request.signal?.aborted && !scope.cancelled && activeScopes.get(scope.token) === scope && scope.sessionId === sessionIdOf(scope.key) });
          } finally { request.signal?.removeEventListener('abort', aborted); }
          scope.sentMessages = (scope.sentMessages ?? 0) + (r.sentParts ?? 0);
          if (r.sentParts > 0) scope.replyForCarry = `${scope.replyForCarry ?? ''}\n${plain}`.slice(0, 640);
          scope.uncertainDelivery = scope.uncertainDelivery || r.uncertain === true;
          if (!onebotOk(r)) {
            return { ok: false, error: `OneBot 未完整送达（${r?.sentParts ?? 0}/${r?.totalParts ?? 0} 段），不自动重发`, sentParts: r?.sentParts, totalParts: r?.totalParts };
          }
          if (type === 'group' && scope.access !== 'fish') {
            rememberGroupLine(id, 'Antigravity', selfId.value, plain, r?.data?.message_id);
            groupAttention.spoke(id, { now: Date.now(), partnerId: scope.partnerId, text: plain });
          }
          log(`AI 主动发送 -> ${type} ${id}: ${plain.slice(0, 50)}`);
          return { ok: true, chars: plain.length, reply: r.quoted, sentParts: r.sentParts, messageId: r?.data?.message_id ? String(r.data.message_id) : undefined };
        },
        findSticker: ({ query, limit }, scope) => {
          if (!cfg.tools.enabled || !cfg.stickers.enabled || !scope || scope.background) throw Object.assign(new Error('当前会话不能使用表情包工具'), { statusCode: 403 });
          const matches = stickerLibrary.search(String(query).slice(0, 160), limit);
          scope.foundStickers ??= new Set();
          for (const row of matches) scope.foundStickers.add(row.id);
          return { ok: true, total: stickerFiles.length, matches, hint: matches.length ? '按实际语境选一张，也可以不发' : '没有匹配的表情，可以换简短场景词或直接文字接话' };
        },
        sendSticker: async (body, scope, { signal } = {}) => {
          if (!cfg.tools.enabled || !cfg.stickers.enabled || !scope || scope.background) return { ok: false, error: '当前会话不能发表情包' };
          if (!scopeAllows(cfg, scope, scope.type, scope.id)) return { ok: false, error: '当前目标无发送权限' };
          if (scope.uncertainDelivery || scope.stickerAttempted) return { ok: false, error: '本轮已有表情发送尝试或结果不明，不再发送' };
          const sticker = stickerLibrary.get(String(body?.sticker_id ?? ''));
          if (!sticker || !scope.foundStickers?.has(sticker.id)) return { ok: false, error: '请先检索并使用返回的真实表情 id' };
          const file = stickerLibrary.safeFile(sticker.file);
          if (!file) return { ok: false, error: '本地表情文件不可用' };
          const cooldownMs = Math.max(0, Number(cfg.stickers.cooldownSeconds) || 0) * 1000;
          if (Date.now() - (stickerState.get(scope.key) ?? 0) < cooldownMs) return { ok: false, error: '这个会话的表情还在冷却，直接接话或保持安静即可' };
          // Reserve before queueing so parallel tool calls cannot send a second image.
          scope.stickerAttempted = true;
          stickerState.set(scope.key, Date.now());
          let attempted = false;
          const aborted = () => { if (attempted) scope.uncertainDelivery = true; };
          signal?.addEventListener('abort', aborted, { once: true });
          let result;
          try {
            result = await sendImage(scope.type === 'group' ? { group: scope.id } : { user: scope.id }, file, {
              onAttempt: () => { attempted = true; },
              valid: () => !signal?.aborted && !scope.controller.signal.aborted && !scope.cancelled
                && activeScopes.get(scope.token) === scope && scope.sessionId === sessionIdOf(scope.key),
            });
          } catch (error) {
            if (attempted) scope.uncertainDelivery = true;
            throw error;
          } finally { signal?.removeEventListener('abort', aborted); }
          const messageId = result?.data?.message_id;
          if (!onebotOk(result) || messageId === undefined || messageId === null || messageId === '') {
            scope.uncertainDelivery ||= result?.retcode === undefined || Number(result.retcode) === 0 || /timeout|disconnect/i.test(result?.message ?? '');
            return { ok: false, error: '表情发送未确认成功，不重发', uncertain: scope.uncertainDelivery };
          }
          const text = `[表情包：${sticker.name}${sticker.caption ? `，${sticker.caption}` : ''}]`;
          scope.replyForCarry = `${scope.replyForCarry ?? ''}\n${text}`.slice(0, 640);
          let observation;
          if (scope.access === 'fish') {
            try { observation = await fish?.observe?.(scope.fishId, { speakerId: 'self', speakerName: 'Antigravity', text, messageId }); }
            catch (e) { log('已发送表情留存失败:', e.message); }
          }
          if (scope.type === 'group') {
            rememberGroupLine(scope.id, 'Antigravity', selfId.value, text, messageId, observation?.id);
            groupAttention.spoke(scope.id, { now: Date.now(), partnerId: scope.partnerId, text });
          }
          lastSticker = sticker.file;
          log(`AI 选表情 ${sticker.file} -> ${scope.key}`);
          return { ok: true, name: sticker.name, messageId: String(messageId) };
        },
        fishTool: async ({ name, args }, scope, { signal } = {}) => {
          if (!fish || scope?.access !== 'fish') throw Object.assign(new Error('当前不是养成会话'), { statusCode: 403 });
          return { ok: true, ...await fish.tool(scope.fishId, name, args, { background: scope.background, signal,
            toolCounts: scope.toolCounts, valid: () => !scope.cancelled && activeScopes.get(scope.token) === scope && scope.sessionId === sessionIdOf(scope.key) }) };
        },
        qzoneStatus: scope => {
          if (!scope?.qzoneAllowed || scope.type !== 'private' || !isOwner(scope.id)) throw Object.assign(new Error('本会话没有空间权限'), { statusCode: 403 });
          return qzone.status();
        },
        qzonePost: async (body, scope, { signal } = {}) => {
          if (!scope?.qzoneAllowed || scope.type !== 'private' || !isOwner(scope.id)) throw Object.assign(new Error('本会话没有空间权限'), { statusCode: 403 });
          scope.qzoneAttempted = true;
          const result = await qzone.post(body, { valid: () => !signal?.aborted && !scope.cancelled
            && activeScopes.get(scope.token) === scope && scope.sessionId === sessionIdOf(scope.key) });
          scope.qzonePublished = true;
          return result;
        },
        fishAdmin: async (operation, body, context) => {
          if (!fish || !context?.admin) throw Object.assign(new Error('养成未启用'), { statusCode: 403 });
          const id = body.id || `p-${cfg.ownerQq[0]}`;
          if (operation === 'chats') return { chats: await fish.knownChats() };
          if (operation === 'status') return fish.status(id);
          if (operation === 'memory') return { rows: await fish.memory(id, body.query || '') };
          if (operation === 'diary') return fish.diary(id, body.date);
          if (operation === 'inbox') return fish.inbox(id, body.read === true);
          if (operation === 'settings') return fish.settings(id, body.patch);
          throw new Error('未知养成操作');
        },
      },
    });
    log(`控制接口: http://127.0.0.1:${controlServer.port}（令牌文件 ${TOKEN_PATH}）`);
  } catch (e) {
    log(`控制接口启动失败（AI 主动收发工具会不可用）：${e.message}`);
  }
}

/* ---------------- 消息入口 ---------------- */
async function onMessage(ev) {
  if (!verifiedAccount || String(ev.self_id ?? '') !== String(cfg.expectedBotQq)) return;
  const senderId = ev.user_id;
  if (String(senderId) === String(selfId.value)) return;
  if (ev.message_type === 'guild') return;

  const isGroup = ev.message_type === 'group';
  if (ev.message_type !== 'group' && ev.message_type !== 'private') return;
  if (!targetAllowed(cfg, isGroup ? 'group' : 'private', isGroup ? ev.group_id : senderId)) return;
  const duplicateKey = ev.message_id === undefined ? '' : `${ev.self_id ?? selfId.value}:${isGroup ? `g:${ev.group_id}` : `p:${senderId}`}:${ev.message_id}`;
  if (!deduper.accept(duplicateKey)) { log(`忽略重复消息 ${duplicateKey}`); return; }
  let { text, mentioned, images, quotedMessageId } = parseMessage(ev.message);
  if (!text) return;

  const target = isGroup ? { group: ev.group_id } : { user: senderId };
  let key = isGroup ? `qq2-g-${ev.group_id}` : `qq2-p-${senderId}`;
  const imageScope = `${isGroup ? 'g' : 'p'}-${isGroup ? ev.group_id : senderId}`;

  if (isGroup) {
    if (!allowed(cfg.allowGroups, ev.group_id)) return;
    const line = rememberGroup(ev, text);

    if (await handleCommand(text, ev, target, true)) return;
    const name = ev.sender?.card || ev.sender?.nickname || String(senderId);
    let imageIds = [];
    try { imageIds = await qqImages.capture(imageScope, images, { messageId: ev.message_id, senderId }); }
    catch (e) { log('图片索引留存失败:', e.message); }
    if (line) { line.imageIds = imageIds; line.quotedMessageId = quotedMessageId; }
    if (!text.trim().startsWith('/')) {
      try {
        const observation = await fish?.observe?.(`g-${ev.group_id}`, { speakerId: String(senderId), speakerName: name, text, messageId: ev.message_id, imageIds });
        if (line) line.observationId = observation?.id;
        await qqImages.bind(imageScope, imageIds, observation?.id);
      } catch (e) { log('群消息留存失败:', e.message); }
    }
    const direct = mentioned || isOwner(senderId);
    const joiningDirect = pendingTurns.get(key)?.meta.direct === true;
    const due = groupAttention.observe(ev.group_id, line ?? { qq: senderId, name, text }, {
      now: Date.now(), direct: direct || joiningDirect, hints: fish?.attentionHints?.(`g-${ev.group_id}`),
    });
    armGroupAttention(ev.group_id, due);
    if (!direct && !joiningDirect) return;
    const trigger = { kind: direct ? 'direct' : 'continuation', direct };
    log(`群 ${ev.group_id} ${name}: ${text.slice(0, 60)} -> ${trigger.kind}`);
    scheduleTurn(key, target, text, {
      isGroup: true,
      groupId: String(ev.group_id),
      senderId,
      senderName: name,
      owner: isOwner(senderId),
      messageId: line?.id,
      replyToMessageId: line?.mid || undefined,
      observationId: line?.observationId,
      imageIds,
      quotedMessageId,
      ts: line?.ts,
      trigger: trigger.kind,
      direct: trigger.direct,
      mentioned,
    });
    return;
  }

  if (!canPrivate(senderId)) return;
  if (await handleCommand(text, ev, target, false)) return;
  let execution = false;
  if (fish && /^\/执行(?:\s|$)/.test(text)) {
    if (!isOwner(senderId)) { await send(target, '只有主人能使用执行会话。'); return; }
    await send(target, '本机操作暂未接通。');
    return;
  }
  const name = ev.sender?.card || ev.sender?.nickname || String(senderId);
  let imageIds = [];
  try { imageIds = await qqImages.capture(imageScope, images, { messageId: ev.message_id, senderId }); }
  catch (e) { log('图片索引留存失败:', e.message); }
  let observation;
  if (!execution) {
    try {
      observation = await fish?.observe?.(`p-${senderId}`, { speakerId: String(senderId), speakerName: name, text, messageId: ev.message_id, imageIds });
      await qqImages.bind(imageScope, imageIds, observation?.id);
    }
    catch (e) { log('私聊留存失败:', e.message); }
  }
  log(`私聊 ${senderId} ${name}: ${text.slice(0, 60)}`);
  scheduleTurn(key, target, text, {
    isGroup: false,
    groupId: '',
    senderId,
    senderName: name,
    owner: isOwner(senderId),
    replyToMessageId: ev.message_id === undefined ? undefined : String(ev.message_id),
    observationId: observation?.id,
    imageIds,
    quotedMessageId,
    ts: Date.now(),
    trigger: 'private',
    direct: true,
    execution,
  });
}

/* ---------------- 启动 / 退出 ---------------- */
const healthTimer = setInterval(checkHealth, 60_000);
healthTimer?.unref?.();
let closing = false;
const fishTimer = fish && Number(cfg.fish.dailyBudgetCny) > 0 ? setInterval(() => {
  if (closing || activeScopes.size || queues.has('fish-background')) return;
  const owner = cfg.ownerQq[0];
  if (owner) void enqueue('fish-background', () => wakeFish(owner)).catch((e) => log('养成后台:', e.message));
}, 60_000) : null;
fishTimer?.unref?.();
if (fish && cfg.ownerQq[0]) void fish.prepare(`p-${cfg.ownerQq[0]}`).then(() => log('养成内核已启用：共享人格、场景记忆、B站公开只读')).catch((e) => log('养成初始化失败:', e.message));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    for (const scope of activeScopes.values()) { scope.cancelled = true; scope.controller.abort(); }
    log('正在关闭…');
    clearInterval(healthTimer);
    if (fishTimer) clearInterval(fishTimer);
    for (const p of pendingTurns.values()) if (p.timer) clearTimeout(p.timer);
    for (const timer of attentionTimers.values()) clearTimeout(timer);
    try { await controlServer?.close?.(); } catch { /* ignore */ }
    try { await runtime.stop(); } catch { /* ignore */ }
    try { await fish?.companion?.drain(); } catch { /* ignore */ }
    try { await qqImages.drain(); } catch { /* ignore */ }
    try { await qzone.drain(); } catch { /* ignore */ }
    process.exit(0);
  });
}

log('Antigravity 费用未核定：不按 DeepSeek 价格估算；非主人私聊暂未开放。');
log(`群聊：${cfg.groupsEnabled ? '开' : '关'}；读空气：${cfg.readAir.enabled ? `连续观察，停顿 ${cfg.readAir.pauseMs}ms 后判断，冷却 ${cfg.readAir.cooldownSeconds}s` : '关'}；私聊白名单：${cfg.allowUsers.join(',') || '(空)'}`);
log(`表情包：${cfg.stickers.enabled ? `开，${stickerFiles.length} 张，概率 ${cfg.stickers.probability}` : '关'}`);
log(`私聊合并：停顿 ${cfg.privateBatch.pauseMs / 1000} 秒后统一读，连续发送最多等 ${cfg.privateBatch.maxWaitMs / 1000} 秒；排队补充继续合并`);
log(`自动引用：${cfg.quoteReply.enabled ? `群${cfg.quoteReply.groupMode === 'always' ? '始终引用' : '按模型判断'}${cfg.quoteReply.private ? '、私聊开' : '、私聊关'}` : '关'}；AI 工具：${cfg.tools.enabled ? '开（MCP: mcp__qq__*）' : '关'}`);
log('本机文件与命令工具暂未开放。');
log(`空间自主说说：${qzone.enabled() ? '开启' : '关闭'}，${cfg.qzone.visibility}，每天上限 ${cfg.qzone.maxPerDay} 条；模型可选择不发`);
if (cfg.control.enabled) void startControl();
connect();
