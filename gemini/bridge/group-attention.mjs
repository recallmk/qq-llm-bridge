import { tokensOf } from './vendor/dsh-fish/lib/recall.js';

const defaults = { enabled: true, pauseMs: 6000, maxWaitMs: 20_000, cooldownSeconds: 60,
  maxPerMinute: 3, reviewAfterSeconds: 180, minMessages: 3, contextMessages: 30, minChars: 2, ignorePrefixes: ['/'] };
const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback));
export function attentionConfig(input = {}) {
  const c = { ...defaults, ...input };
  for (const [key, min, max] of [['pauseMs', 1000, 30_000], ['maxWaitMs', 1000, 60_000], ['cooldownSeconds', 5, 3600],
    ['maxPerMinute', 1, 10], ['reviewAfterSeconds', 30, 3600], ['minMessages', 2, 20], ['contextMessages', 10, 60], ['minChars', 1, 100]]) c[key] = bounded(c[key], defaults[key], min, max);
  c.maxWaitMs = Math.max(c.pauseMs, c.maxWaitMs);
  c.ignorePrefixes = Array.isArray(c.ignorePrefixes) ? c.ignorePrefixes.filter(s => typeof s === 'string' && s) : ['/'];
  return c;
}

// This only decides what deserves attention. The model still chooses silence or speech.
// Every eligible message joins a coherent window; no random per-message lottery.
export class GroupAttention {
  constructor(config = {}) { this.config = attentionConfig(config); this.groups = new Map(); }
  state(id) {
    const key = String(id);
    if (!this.groups.has(key)) this.groups.set(key, { pending: [], first: 0, last: 0, reviewedAt: 0,
      evaluated: [], spokeAt: 0, lastPartner: '', lastReply: '', hints: { topics: [], people: [] } });
    return this.groups.get(key);
  }
  quality(text) {
    const plain = String(text).replace(/\[(图片|表情|语音|视频|文件)\]/g, '').trim();
    return [...plain].length >= this.config.minChars && /[\p{L}\p{N}]/u.test(plain)
      && !this.config.ignorePrefixes.some(p => plain.startsWith(p)) && !/^(?:哈+|[嗯哦啊噢]+|[6９9]+|好[的吧]?|收到|晚安|拜拜|谢谢)[!！。～~\s]*$/.test(plain);
  }
  observe(id, message, { direct = false, hints, now = Date.now() } = {}) {
    const s = this.state(id);
    if (hints) s.hints = hints;
    if (direct) { this.reviewed(id, now); return null; }
    if (!this.config.enabled || (!this.quality(message.text) && !message.imageIds?.length)) return null;
    if (!s.pending.length) s.first = now;
    s.last = now; s.pending.push(message);
    if (s.pending.length > this.config.contextMessages) s.pending.shift();
    return this.due(id, now);
  }
  due(id, now = Date.now()) {
    const s = this.state(id); if (!s.pending.length) return null;
    s.evaluated = s.evaluated.filter(t => now - t < 60_000);
    return Math.max(s.reviewedAt + this.config.cooldownSeconds * 1000,
      Math.min(s.last + this.config.pauseMs, s.first + this.config.maxWaitMs),
      s.evaluated.length >= this.config.maxPerMinute ? s.evaluated[0] + 60_000 : 0);
  }
  take(id, { now = Date.now(), busy = false } = {}) {
    const s = this.state(id), due = this.due(id, now);
    if (due === null || now < due) return { messages: [], nextAt: due };
    if (busy) return { messages: [], nextAt: now + this.config.pauseMs };
    const messages = [...s.pending], text = messages.map(m => m.text).join('\n');
    const speakers = new Set(messages.map(m => String(m.qq)));
    const topics = (s.hints.topics ?? []).flatMap(t => tokensOf(t)).filter(t => t.length >= 2 || /^[\u4e00-\u9fff]$/.test(t));
    const reasons = [];
    if (/大肥鱼|肥鱼/.test(text)) reasons.push('提到了你');
    if (s.spokeAt && now - s.spokeAt < 180_000 && (speakers.has(s.lastPartner) || /[?？]|你|鱼/.test(text))) reasons.push('你参与过的话题还在继续');
    if (topics.some(t => text.toLowerCase().includes(t.toLowerCase()))) reasons.push('与已有兴趣或记忆有关');
    if ((s.hints.people ?? []).some(p => speakers.has(String(p))) && /[?？]|我|今天|最近|打算|准备/.test(text)) reasons.push('熟悉的人说起近况');
    if (/[?？]|有没有|怎么回事|大家觉得|你们觉得|有人知道/.test(text)) reasons.push('出现了可以参与的问题');
    if (messages.length >= this.config.minMessages && speakers.size >= 2) reasons.push('积累了一段多人对话');
    if ((!s.reviewedAt || now - s.reviewedAt >= this.config.reviewAfterSeconds * 1000)
      && (messages.length >= 2 || text.length >= 20)) reasons.push('听一听新的近况');
    if (messages.some(m => m.imageIds?.length) && (!s.reviewedAt || now - s.reviewedAt >= this.config.reviewAfterSeconds * 1000)) reasons.push('隔了一阵，看看群里发来的图片');
    s.pending = []; s.first = 0;
    if (!reasons.length) return { messages: [], nextAt: null };
    this.reviewed(id, now);
    return { messages, reasons, nextAt: null };
  }
  reviewed(id, now = Date.now()) {
    const s = this.state(id); s.pending = []; s.first = 0; s.reviewedAt = now;
    s.evaluated = s.evaluated.filter(t => now - t < 60_000); s.evaluated.push(now);
  }
  spoke(id, { partnerId = '', text = '', now = Date.now() } = {}) {
    Object.assign(this.state(id), { spokeAt: now, lastPartner: String(partnerId), lastReply: String(text).slice(0, 300) });
  }
  reset(id) { this.groups.delete(String(id)); }
}
