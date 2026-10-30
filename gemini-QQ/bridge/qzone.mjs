import { createHash, randomUUID } from 'node:crypto';
import { mdToPlain } from './md-to-plain.mjs';
import { looksLikeSecret } from './vendor/dsh-fish/lib/guard.js';

const hash = text => createHash('sha256').update(text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()).digest('hex');
const error = message => Object.assign(new Error(message), { statusCode: 403 });
const STATES = ['pending', 'posted', 'failed', 'uncertain'];

/** One durable outbox for Qzone. Reserve before IO; never replay an ambiguous publication. */
export class QzoneService {
  constructor({ store, call, online, config = {}, now = () => new Date(), log = () => {} }) {
    this.store = store; this.call = call; this.online = online; this.now = now; this.log = log;
    this.config = { enabled: true, visibility: 'friends', maxPerDay: 1, cooldownHours: 20,
      maxChars: 500, timeZone: 'America/Los_Angeles', ...config };
    if (!['friends', 'public', 'self'].includes(this.config.visibility)) throw Error('空间可见范围配置错误');
    this.config.maxPerDay = Math.max(1, Math.min(3, Math.floor(Number(this.config.maxPerDay) || 1)));
    this.config.cooldownHours = Math.max(1, Math.min(168, Number(this.config.cooldownHours) || 20));
    this.config.maxChars = Math.max(20, Math.min(2000, Number(this.config.maxChars) || 500));
    this.clock = new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const data = store.value;
    if (data?.version !== 1 || (data.enabled !== undefined && typeof data.enabled !== 'boolean')
      || !Array.isArray(data.attempts) || !Array.isArray(data.decisions)
      || data.attempts.some(r => !/^qz_[a-f0-9-]{36}$/.test(r.id) || !Number.isFinite(Date.parse(r.at))
        || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !STATES.includes(r.state) || typeof r.text !== 'string' || !/^[a-f0-9]{64}$/.test(r.hash))
      || data.decisions.some(r => !Number.isFinite(Date.parse(r.at)) || typeof r.outcome !== 'string')) throw Error('空间发布账本损坏，已停止加载，不能静默重发');
    this.tail = Promise.resolve();
  }
  day(at = this.now()) {
    const parts = Object.fromEntries(this.clock.formatToParts(at).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  enabled() { return this.config.enabled === true && this.store.value.enabled !== false; }
  status() {
    const data = this.store.value, day = this.day(), now = this.now().getTime();
    const today = data.attempts.filter(r => r.day === day);
    const last = data.attempts.at(-1);
    const nextAt = last ? Date.parse(last.at) + this.config.cooldownHours * 3_600_000 : 0;
    const reason = !this.enabled() ? '空间发布已暂停' : !this.online() ? 'QQ 上游未在线'
      : today.length >= this.config.maxPerDay ? '今天已经尝试过发布，不再重复' : now < nextAt ? '距离上一次发布尝试还在冷却中' : '';
    return { enabled: this.enabled(), ready: !reason, reason, day, timeZone: this.config.timeZone,
      visibility: this.config.visibility, maxPerDay: this.config.maxPerDay, maxChars: this.config.maxChars,
      attemptsToday: today.length, postedToday: today.filter(r => r.state === 'posted').length,
      ...(nextAt > now ? { nextAfter: new Date(nextAt).toISOString() } : {}),
      recent: data.attempts.slice(-3).reverse().map(({ at, text, state, tid }) => ({ at, text, state, ...(tid ? { tid } : {}) })),
      lastDecision: data.decisions.at(-1) ?? null };
  }
  serial(job) { const result = this.tail.then(job); this.tail = result.catch(() => {}); return result; }
  setEnabled(enabled) {
    return this.serial(() => { this.store.save({ ...this.store.value, enabled: enabled === true }); return this.status(); });
  }
  post(args, { valid = () => true } = {}) {
    return this.serial(async () => {
      if (!valid()) throw error('本轮已取消');
      const status = this.status();
      if (!status.ready) throw error(status.reason);
      if (typeof args?.text !== 'string') throw error('说说正文不能为空');
      const text = mdToPlain(args.text).trim();
      if (!text || [...text].length > this.config.maxChars) throw error(`说说正文应为 1–${this.config.maxChars} 字`);
      const reason = String(args.reason ?? '').trim().slice(0, 240);
      if (looksLikeSecret(text).hit || looksLikeSecret(reason).hit) throw error('内容含账号凭证，不能发布');
      const fingerprint = hash(text);
      if (this.store.value.attempts.some(r => r.hash === fingerprint)) throw error('同样的内容已经尝试发布过，不重复发送');
      const entry = { id: `qz_${randomUUID()}`, at: this.now().toISOString(), day: this.day(),
        text, reason, hash: fingerprint, state: 'pending' };
      // Persistence failure prevents publication. A crash after this point keeps the reservation.
      this.store.save({ ...this.store.value, attempts: [...this.store.value.attempts, entry] });
      let response;
      try {
        if (!valid()) throw error('本轮已取消，尚未发布');
        response = await this.call('send_qzone_msg', { content: text,
          ugc_right: { friends: 4, public: 1, self: 64 }[this.config.visibility] });
      } catch { response = { status: 'failed', message: '发布过程未返回明确结果' }; }
      const tid = response?.data?.tid;
      const posted = response?.status === 'ok' && (response.retcode === undefined || response.retcode === 0)
        && typeof tid === 'string' && tid.trim().length > 0;
      const uncertain = !posted && (response?.status === 'ok' || response?.retcode === undefined);
      let detail = String(response?.message || response?.wording || (response?.status === 'ok' ? '未返回有效 tid' : '未收到明确发布回执')).slice(0, 240);
      detail = looksLikeSecret(detail).hit ? '上游返回了含敏感字段的错误，已隐藏' : detail.replace(/https?:\/\/\S+/g, '[上游链接]');
      const result = { ...entry, state: posted ? 'posted' : uncertain ? 'uncertain' : 'failed',
        ...(posted ? { tid: tid.trim() } : { error: detail, ...(Number.isFinite(response?.retcode) ? { retcode: response.retcode } : {}) }), completedAt: this.now().toISOString() };
      // Record an actual receipt even if the requesting turn was cancelled during IO.
      this.store.save({ ...this.store.value, attempts: this.store.value.attempts.map(r => r.id === entry.id ? result : r) });
      this.log(`空间说说: ${result.state}，${[...text].length} 字${posted ? `，tid=${result.tid}` : `；${detail}；不自动重发`}`);
      if (!posted) throw error(uncertain ? '空间发布结果不明，请先查看空间；不会自动重发' : '空间接口拒绝了发布；本次已记录，不自动重试');
      return { ok: true, tid: result.tid, visibility: this.config.visibility, chars: [...text].length };
    });
  }
  noteDecision(outcome) {
    return this.serial(() => this.store.save({ ...this.store.value,
      decisions: [...this.store.value.decisions, { at: this.now().toISOString(), day: this.day(), outcome }] }));
  }
  async drain() { await this.tail; }
}

export function qzonePrompt(status, { background = false } = {}) {
  return [
    '你可以自己决定要不要用 qq_post_qzone 发一条 QQ 空间说说。它是向空间发布，不是给主人发私聊。',
    '这是一种可选表达，不是每日任务或打卡；没有想说的就不发，连续几天不发也正常。不要因为工具可用、到点醒来或“今天还没发”而凑内容，也不要询问主人今天要不要发。',
    '内容可以是相处和公开见闻带来的自己的想法、兴趣、吐槽或顺手的一句话，长短自然。不默认写日记总结、成长汇报或聊天记录，不照搬私聊/群聊原话与别人的私事，不把自己的推测写成发图者或群友的经历。',
    '需要发时先用 mcp__qq__qq_qzone_status 看近期已发内容，避免重复，随后调用 mcp__qq__qq_post_qzone；只有工具返回真实 tid 才算发布成功。失败或结果不明时不要换写法重试。',
    background ? '本轮由后台自主唤醒，发不发都由你判断；最终正文只留本地信箱，不另外通知主人。没有内容可只输出 [[SKIP]]。' : '普通聊天照常接话，只有自己确实有想分享的内容或主人明确提出时才考虑空间。',
    `【程序确认的空间状态】${JSON.stringify(status)}`,
  ].join('\n');
}
