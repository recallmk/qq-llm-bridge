import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tokensOf } from './vendor/dsh-fish/lib/recall.js';

const DAY = 86_400_000;
const KINDS = ['person', 'impression', 'episode', 'world', 'self', 'style'];
const CONTINUITY_TYPES = ['unfinished', 'agreement', 'joke', 'preference'];
const CONTINUITY_STATUSES = ['open', 'resolved', 'expired', 'cancelled'];
const TTL = { unfinished: 7, agreement: 30, joke: 90, preference: 90 };
const STANCES = ['favor', 'against', 'mixed', 'undecided'];
const LABELS = { favor: '偏喜欢／赞同', against: '偏不喜欢／不赞同', mixed: '有喜欢的部分，也有保留', undecided: '还在了解' };
const keyOf = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const digest = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const numericId = s => /^\d{1,20}$/.test(String(s));
const human = r => r?.source === 'chat_message' && numericId(r.speakerId);
const origin = r => human(r) || r?.source === 'public_material';
const cancelled = () => Object.assign(new Error('记忆回合已结束'), { code: 'CANCELLED' });
const EVENT_RELATIONS = ['retelling', 'same_event', 'new_occurrence'];
const IMPORTANT_CUE = /约定|答应|下次|别忘|记住|说好了|不用了|取消|不需要|改口|纠正|说错|其实不是|帮我|能不能帮|求助|怎么办|解决|完成|搞定|以后|更喜欢|不再/;

// Projection is rebuilt from append-only facts. Corrections withdraw the old votes;
// delivered text, diaries and summaries never create another independent event.
export function derivePersonality(rows, now = Date.now()) {
  const withdrawn = new Set(rows.flatMap(r => [r.revises, ...(r.withdraws ?? [])]).filter(Boolean));
  const topics = new Map();
  for (const row of [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (withdrawn.has(row.id)) continue;
    const key = keyOf(row.topic);
    if (!key || !STANCES.includes(row.stance)) continue;
    const state = topics.get(key) ?? { topic: row.topic, votes: new Map(), latest: row.ts, stable: null };
    state.latest = row.ts;
    for (const evidence of row.support ?? []) {
      const event = evidence.eventKey ?? (evidence.bucket ? `legacy:${evidence.bucket}` : '');
      if (!event || !Number.isFinite(Date.parse(evidence.at))) continue;
      // The latest explicit reconsideration replaces the same event's position.
      state.votes.set(event, { stance: row.stance, at: evidence.at });
    }
    const scores = Object.fromEntries(STANCES.map(s => [s, 0]));
    const days = Object.fromEntries(STANCES.map(s => [s, new Set()]));
    for (const vote of state.votes.values()) {
      scores[vote.stance] += 2 ** (-Math.max(0, Date.parse(row.ts) - Date.parse(vote.at)) / (90 * DAY));
      days[vote.stance].add(vote.at.slice(0, 10));
    }
    // Rebuild inertia only from still-valid evidence. A withdrawn position cannot
    // survive merely because it used to have a stable label in a prior projection.
    if (state.stable && ![...state.votes.values()].some(v => v.stance === state.stable)) state.stable = null;
    const best = [...STANCES].sort((a, b) => scores[b] - scores[a])[0];
    if (scores[best] >= 2.8 && days[best].size >= 2 && (!state.stable
      || (best !== state.stable && scores[best] >= scores[state.stable] * 1.35 + 1))) state.stable = best;
    topics.set(key, state);
  }
  return [...topics.values()].map(state => {
    const scores = Object.fromEntries(STANCES.map(s => [s, 0]));
    const days = Object.fromEntries(STANCES.map(s => [s, new Set()]));
    for (const vote of state.votes.values()) {
      scores[vote.stance] += 2 ** (-Math.max(0, now - Date.parse(vote.at)) / (90 * DAY));
      days[vote.stance].add(vote.at.slice(0, 10));
    }
    const best = [...STANCES].sort((a, b) => scores[b] - scores[a])[0];
    return { topic: state.topic, stance: state.stable ?? best, settled: Boolean(state.stable),
      reconsidering: Boolean(state.stable && best !== state.stable),
      salience: scores[best], independentEvents: state.votes.size, latest: state.latest };
  }).filter(s => s.salience > 0).sort((a, b) => Number(b.settled) - Number(a.settled) || b.salience - a.salience);
}

export class CompanionMemory {
  constructor({ root, now = () => new Date(), clean = s => String(s ?? '') }) {
    this.root = path.resolve(root, 'companion'); this.now = now; this.clean = clean;
    this.tail = Promise.resolve(); this.cache = new Map(); this.coreCache = null;
    this.hints = new Map(); this.coreHints = [];
  }
  serial(job) {
    const result = this.tail.catch(() => {}).then(job);
    this.tail = result.catch(() => {}); return result;
  }
  file(scope) {
    if (!/^[gp]-\d{1,20}$/.test(String(scope))) throw new Error('无效的记忆场景');
    return path.join(this.root, 'scopes', `${scope}.jsonl`);
  }
  transactionDirectory(scope) { this.file(scope); return path.join(this.root, 'consolidation', scope); }
  async safe(file) {
    const expected = path.resolve(file);
    if (!expected.startsWith(`${this.root}${path.sep}`)) throw new Error('记忆路径越界');
    let ancestor = expected;
    for (;;) {
      try {
        const actual = await fs.realpath(ancestor);
        if (process.platform === 'win32' && /^C:[\\/]/i.test(actual)) throw new Error('记忆不能保存在 C 盘');
        if (ancestor.startsWith(`${this.root}${path.sep}`) && !actual.toLowerCase().startsWith(`${this.root.toLowerCase()}${path.sep}`)) throw new Error('记忆路径指向了其他目录');
        break;
      } catch (e) { if (e.code !== 'ENOENT') throw e; ancestor = path.dirname(ancestor); }
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  validateRow(row) {
    if (row?.v !== 1 || typeof row.id !== 'string' || !Number.isFinite(Date.parse(row.ts))) throw new Error('记忆日志版本或格式不正确');
    return row;
  }
  async read(file) {
    await this.safe(file);
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text && !text.endsWith('\n')) throw new Error('记忆日志尾部不完整，已停止追加');
      return text.split('\n').filter(Boolean).map(line => this.validateRow(JSON.parse(line)));
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async append(file, row) {
    await this.safe(file);
    const handle = await fs.open(file, 'a');
    try { await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }
  async writeJson(file, value, valid = () => true) {
    await this.safe(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      if (!valid()) throw cancelled();
      await fs.rename(temp, file);
    } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  }
  async consolidationFailure(scope) {
    this.file(scope);
    const file = path.join(this.root, 'consolidation-failures', `${scope}.json`);
    await this.safe(file);
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.v !== 1 || value.scope !== scope || !/^batch_[a-f0-9]{24}$/.test(value.batchId)
        || typeof value.message !== 'string' || value.message.length > 320 || !Number.isFinite(Date.parse(value.ts))) throw new Error('整理失败元数据格式不正确');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  noteConsolidationFailure(scope, batch, error) {
    return this.serial(async () => {
      if (batch?.scope !== scope || !/^batch_[a-f0-9]{24}$/.test(batch?.batchId)) throw new Error('无效的整理失败批次');
      const prior = await this.consolidationFailure(scope);
      const failure = { v: 1, record: 'consolidation_failure', scope, batchId: batch.batchId, ts: this.now().toISOString(),
        attempts: prior?.batchId === batch.batchId ? Math.min(9999, (Number(prior.attempts) || 0) + 1) : 1,
        message: cut(this.clean(error?.message ?? String(error ?? '整理失败')), 160),
        ...(Array.isArray(batch.unprocessedIds) && batch.unprocessedIds.length <= 24 ? { unprocessedIds: batch.unprocessedIds.filter(id => typeof id === 'string') } : {}),
        ...(['important', 'recent', 'backlog'].includes(batch.selection) ? { selection: batch.selection } : {}),
        ...(typeof error?.code === 'string' ? { code: cut(this.clean(error.code), 40) } : {}),
        ...(typeof error?.conflictingMemoryId === 'string' && /^(?:mem|cont)_[a-f0-9-]{24,40}$/.test(error.conflictingMemoryId) ? { conflictingMemoryId: error.conflictingMemoryId } : {}) };
      await this.writeJson(path.join(this.root, 'consolidation-failures', `${scope}.json`), failure);
      return { ok: true, attempts: failure.attempts };
    });
  }
  async rows(scope) {
    if (!this.cache.has(scope)) {
      const rows = await this.read(this.file(scope));
      const dir = this.transactionDirectory(scope);
      let files = [];
      try { files = (await fs.readdir(dir)).filter(f => /^batch_[a-f0-9]{24}\.json$/.test(f)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const file of files.sort()) {
        const filename = path.join(dir, file); await this.safe(filename);
        const transaction = this.validateRow(JSON.parse(await fs.readFile(filename, 'utf8')));
        if (transaction.record !== 'consolidation' || transaction.scope !== scope || `${transaction.id}.json` !== file
          || !Array.isArray(transaction.processedIds) || transaction.processedIds.length > 24
          || new Set(transaction.processedIds).size !== transaction.processedIds.length || transaction.processedIds.some(id => typeof id !== 'string')
          || !Array.isArray(transaction.items) || transaction.items.length > 18) throw new Error('整理进度格式不正确，已停止整理');
        for (const item of transaction.items) {
          this.validateRow(item);
          if (item.scope !== scope || !['memory', 'continuity'].includes(item.record)
            || typeof item.text !== 'string' || typeof item.topic !== 'string'
            || (item.record === 'memory' && (!KINDS.includes(item.kind) || !/^mem_[a-f0-9]{24}$/.test(item.id)))
            || (item.record === 'continuity' && (!CONTINUITY_TYPES.includes(item.type) || !CONTINUITY_STATUSES.includes(item.status)
              || !/^cont_[a-f0-9]{24}$/.test(item.id) || !Number.isFinite(Date.parse(item.expiresAt)) || !Array.isArray(item.participants)))) throw new Error('整理内容越过场景或格式不正确');
          rows.push(item);
        }
        rows.push(transaction);
      }
      const ids = new Set();
      for (const row of rows) { if (ids.has(row.id)) throw new Error('记忆记录标识重复，已停止整理'); ids.add(row.id); }
      const observations = new Set(rows.filter(r => r.record === 'observation').map(r => r.id));
      for (const row of rows.filter(r => r.record === 'consolidation')) {
        if (row.processedIds.some(id => !observations.has(id)) || row.items.some(item => !Array.isArray(item.evidenceIds) || item.evidenceIds.some(id => !observations.has(id)))) throw new Error('整理进度引用了不存在的来源');
      }
      this.cache.set(scope, rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)));
    }
    return this.cache.get(scope);
  }
  async core() {
    this.coreCache ??= await this.read(path.join(this.root, 'core.jsonl'));
    return this.coreCache;
  }
  async publish(rows) {
    const core = await this.core(), ids = new Set(core.map(r => r.id));
    for (const row of rows.filter(r => r.record === 'memory' && r.kind === 'self')) {
      if (ids.has(row.id)) continue;
      const evidence = rows.filter(o => row.evidenceIds.includes(o.id) && origin(o));
      const event = this.memoryEventKey(rows, row);
      // Legacy self records are retained, but self-only evidence adds no vote.
      const publicRow = { v: 1, id: row.id, ts: row.ts, topic: row.topic, stance: row.stance,
        ...(row.revises ? { revises: row.revises } : {}),
        support: event && evidence.length ? [{ eventKey: event, at: evidence[0].ts }] : [] };
      await this.append(path.join(this.root, 'core.jsonl'), publicRow); core.push(publicRow); ids.add(row.id);
    }
    // Old projections did not carry revises. Append withdrawals instead of
    // rewriting either historical file, including after a crash during publish.
    for (const row of rows.filter(r => r.record === 'memory' && r.kind === 'self' && r.revises)) {
      const id = `withdraw_${digest(row.id)}`;
      if (ids.has(id)) continue;
      const withdrawal = { v: 1, id, ts: row.ts, withdraws: [row.revises] };
      await this.append(path.join(this.root, 'core.jsonl'), withdrawal); core.push(withdrawal); ids.add(id);
    }
    this.coreHints = derivePersonality(core, this.now().getTime()).slice(0, 12).map(s => s.topic);
  }
  sourceKey(observation) {
    if (!observation) return '';
    // A QQ message's identity survives being seen in two scenes. Text equality
    // is never source identity: the same meal or preference can happen again.
    return `source_${digest(`${observation.speakerId}:${observation.messageId ? `qq:${observation.messageId}` : `obs:${observation.id}`}`)}`;
  }
  eventKey(_rows, observation) {
    // Quotes provide conversational direction, not proof of a repeated event.
    // Legacy stored keys remain untouched; new derivation uses actual sources.
    return this.sourceKey(observation);
  }
  memoryEventKey(rows, memory) {
    if (memory.eventIdentityVersion === 2) return memory.eventKeys?.[0] ?? '';
    const original = memory.evidenceIds?.map(id => rows.find(r => r.id === id)).find(origin);
    return this.sourceKey(original);
  }
  explicitEventRelation(rows, evidence, args) {
    const relation = String(args.eventRelation ?? ''), sourceId = String(args.eventSourceId ?? args.eventKey ?? '');
    if (relation && !EVENT_RELATIONS.includes(relation)) throw new Error('未知事件关系');
    if (relation === 'new_occurrence') {
      if (sourceId) throw new Error('新发生的经历不能同时沿用旧eventSourceId');
      return null;
    }
    if (!sourceId && !relation) return null;
    if (!sourceId) throw new Error('合并复述需要eventSourceId指向真实原始observationId');
    const original = rows.find(r => r.record === 'observation' && r.id === sourceId && origin(r));
    if (!original) throw new Error('复述指向的原始来源不存在或属于其他场景');
    const current = evidence.filter(origin).filter(r => this.sourceKey(r) !== this.sourceKey(original));
    if (!current.length) return { relation: relation || 'same_event', sourceId, event: this.sourceKey(original) };
    // Compatibility: an old eventKey alone needs actual retelling language.
    if (!relation && !current.some(r => /上次|那次|之前那|前面说的|提过|说过|复述|转述|转发|同一件|刚才那/.test(r.text))) throw new Error('不能只凭相同文字或引用合并事件；需eventRelation及真实原来源');
    const oldDates = new Set(String(original.text).match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}月\d{1,2}日/g) ?? []);
    if (current.some(r => /又一次|再一次|再次发生|重新发生|本次新|新的一次|这次又|今天又|本次发生|这次发生/.test(r.text)
      || (r.ts.slice(0, 10) !== original.ts.slice(0, 10) && /今天|昨天|前天|今早|今晚|这次|本次|又|刚刚|刚才/.test(r.text)
        && !/上次|那次|之前|提过|说过|复述|转述|同一件|那天/.test(r.text))
      || (String(r.text).match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}月\d{1,2}日/g) ?? []).some(date => !oldDates.has(date)))) throw new Error('来源明确说到新的发生或新日期，不能归并为旧事件；用new_occurrence或省略旧事件链接');
    return { relation: relation || 'retelling', sourceId, event: this.sourceKey(original) };
  }
  observe(scope, input) {
    return this.serial(async () => {
      const rows = await this.rows(scope), messageId = String(input.messageId ?? ''), speakerId = String(input.speakerId ?? '');
      if (!numericId(speakerId) && !['self', 'external'].includes(speakerId)) throw new Error('无效的发言人');
      const cleaned = this.clean(input.text), text = cut(cleaned, 1400).trim();
      if (!text) return null;
      const id = messageId ? `obs_${digest(`${scope}:${speakerId}:${messageId}`)}` : `obs_${randomUUID()}`;
      const prior = rows.find(r => r.id === id); if (prior) return prior;
      const row = { v: 1, record: 'observation', id, scope, ts: this.now().toISOString(), speakerId,
        speakerName: cut(this.clean(input.speakerName), 60), messageId, text,
        source: speakerId === 'self' ? 'delivered' : speakerId === 'external' ? 'public_material' : 'chat_message',
        ...(input.quotedMessageId ? { quotedMessageId: String(input.quotedMessageId) } : {}),
        ...(input.imageIds?.length ? { imageIds: input.imageIds.filter(id => /^qqimg_[a-f0-9]{24}$/.test(id)).slice(0, 4) } : {}),
        ...(cleaned.length > text.length ? { truncated: true } : {}) };
      row.sourceKey = this.sourceKey(row); row.eventKey = row.sourceKey; row.eventIdentityVersion = 2;
      await this.append(this.file(scope), row); rows.push(row); return row;
    });
  }
  text(value, max, label, required = false) {
    const text = String(value ?? '').trim();
    if ((required && !text) || [...text].length > max || this.clean(text) !== text) throw new Error(`${label}为空、过长或含不可保留的材料`);
    return text;
  }
  evidence(rows, args) {
    if (!Array.isArray(args.evidenceIds)) throw new Error('需要真实 observationId 数组');
    const ids = [...new Set(args.evidenceIds)];
    if (!ids.length || ids.length > 6 || ids.some(id => typeof id !== 'string')) throw new Error('需要 1–6 个真实 observationId');
    const evidence = ids.map(id => rows.find(r => r.id === id && r.record === 'observation'));
    if (evidence.some(r => !r)) throw new Error('来源不存在或属于其他场景，请先查 companion_recall');
    return { ids, evidence };
  }
  details(args) {
    const details = {};
    for (const field of ['reason', 'context', 'changeReason']) {
      if (args[field] !== undefined) details[field] = this.text(args[field], field === 'context' ? 180 : 240, field);
    }
    for (const field of ['exceptions', 'counterEvidence']) {
      if (args[field] === undefined) continue;
      if (!Array.isArray(args[field]) || args[field].length > 4) throw new Error(`${field}需为最多4条的数组`);
      details[field] = args[field].map(s => this.text(s, 160, field, true));
    }
    return details;
  }
  prepareMemory(scope, rows, args, id = `mem_${randomUUID()}`) {
    const { kind } = args;
    if (!KINDS.includes(kind)) throw new Error('未知的记忆类别');
    const topic = this.text(args.topic, kind === 'self' ? 24 : 40, '主题', true), text = this.text(args.text, 450, '记忆', true);
    const { ids, evidence } = this.evidence(rows, args), subjectId = String(args.subjectId ?? '');
    if (['person', 'impression'].includes(kind) && (!numericId(subjectId) || !evidence.some(r => human(r) && r.speakerId === subjectId))) throw new Error('人物记忆必须有本人在当前场景的真实发言');
    if (kind === 'person' && evidence.some(r => !human(r) || r.speakerId !== subjectId)) throw new Error('人物自述的每条来源必须是该人物本人的真实发言；第三方说法和自己的理解不能混成自述');
    if (!['person', 'impression'].includes(kind) && subjectId) throw new Error('只有人物记忆需要 subjectId');
    if (kind === 'episode' && !evidence.some(human)) throw new Error('共同经历必须有真人消息来源');
    if (kind === 'world' && !evidence.some(origin)) throw new Error('外部说法不能只以自己的回复为来源');
    if (kind === 'style' && (new Set(evidence.filter(human).map(r => this.eventKey(rows, r))).size < 3
      || new Set(evidence.filter(r => r.source === 'delivered').map(r => this.eventKey(rows, r))).size < 3
      || new Set(evidence.map(r => r.ts.slice(0, 10))).size < 2)) throw new Error('表达习惯需要至少三个不同真人互动事件、三条实际表达及两天的样本，仅保留为当前场景的谨慎归纳');
    if (kind === 'self') {
      if (!STANCES.includes(args.stance)) throw new Error('自己的看法需要 stance');
      if (!evidence.some(origin) || !evidence.some(r => r.source === 'delivered')) throw new Error('自身看法需真实外界触发及自己已表达的判断，不能从别人偏好或日记推演');
      const names = rows.filter(human).map(r => r.speakerName).filter(n => n.length >= 2);
      if (/[\d\r\n@：:／/\\]|https|主人|群友|私聊|群里|昨天|今天|明天|上次|这次|他说|她说|他家|她家/.test(topic) || names.some(name => topic.includes(name))) throw new Error('共享主题只写一般兴趣或观念，不写人物、场景、日期或私事');
    }
    const sameSubject = this.active(rows).filter(r => r.kind === kind && r.subjectId === subjectId);
    const memories = sameSubject.filter(r => keyOf(r.topic) === keyOf(topic)), previous = memories.at(-1), revises = String(args.revises ?? '');
    if (revises && !sameSubject.some(r => r.id === revises)) throw new Error('只能修正同场景、同人物、同类别的有效旧记录');
    if (revises && !args.changeReason) throw new Error('修正需说明 changeReason，保留改变认识的依据');
    const duplicate = memories.find(r => keyOf(r.text) === keyOf(text) && r.stance === args.stance && ids.every(id => r.evidenceIds.includes(id)));
    if (duplicate) return { existing: duplicate };
    if (previous && !['self', 'episode'].includes(kind) && !revises) return { existing: previous, conflict: true };
    const triggers = evidence.filter(origin), anchor = triggers.find(human) ?? triggers[0];
    let event = this.eventKey(rows, anchor);
    const relation = this.explicitEventRelation(rows, evidence, args);
    if (kind === 'episode') {
      const priorEvent = rows.find(r => r.record === 'memory' && r.kind === 'episode'
        && (r.id === revises || (args.eventRelation !== 'new_occurrence' && r.evidenceIds.some(id => ids.includes(id) && human(rows.find(o => o.id === id))))));
      // Actual reused human sources or a correction preserve the event. Equal
      // summaries, quoted text and a shared generic reply never merge episodes.
      if (priorEvent) event = this.memoryEventKey(rows, priorEvent);
    }
    if (relation) event = relation.event;
    // Rewording the same judgement without a new concrete episode is not new
    // support. An independent self vote requires an explicitly cited episode.
    const experienceId = String(args.experienceId ?? '');
    const episode = rows.find(r => r.record === 'memory' && r.kind === 'episode' && r.id === experienceId && !new Set(rows.map(m => m.revises)).has(r.id));
    if (kind === 'self') {
      if (experienceId && (!episode || !episode.evidenceIds.some(id => ids.includes(id)))) throw new Error('独立经历必须是有重合真实来源的有效episode记忆');
      if (episode) event = this.memoryEventKey(rows, episode);
      else if (revises) event = this.memoryEventKey(rows, sameSubject.find(r => r.id === revises));
      else if (memories.length && !relation) event = ''; // No invented extra vote without a concrete episode.
    }
    const row = { v: 1, record: 'memory', id, scope, ts: this.now().toISOString(), kind, topic, text, subjectId,
      evidenceIds: ids, provenance: evidence.map(r => ({ observationId: r.id, source: r.source, speakerId: r.speakerId, messageId: r.messageId, at: r.ts })),
      eventKeys: event ? [event] : [], eventIdentityVersion: 2,
      ...(args.eventRelation ? { eventRelation: args.eventRelation } : {}), ...(relation ? { eventSourceId: relation.sourceId } : {}),
      ...(experienceId ? { experienceId } : {}), ...(revises ? { revises } : {}),
      ...(kind === 'self' ? { stance: args.stance } : {}), ...this.details(args),
      basis: kind === 'person' ? '对方自述' : kind === 'impression' ? '她的印象，可修正' : kind === 'world' ? '材料中的说法，未独立核实' : kind === 'self' ? '她自己已表达的判断' : kind === 'style' ? '长期互动中的表达倾向，暂定且仅限当前场景' : '根据真人来源整理的共同经历' };
    return { row };
  }
  remember(scope, args, { valid = () => true } = {}) {
    return this.serial(async () => {
      if (!valid()) throw cancelled();
      const rows = await this.rows(scope), prepared = this.prepareMemory(scope, rows, args);
      if (prepared.existing) {
        await this.publish(rows);
        return { ok: !prepared.conflict, id: prepared.existing.id, note: prepared.conflict ? '已有同主题记忆；确有变化时带revises和changeReason' : '这条已经记过' };
      }
      if (!valid()) throw cancelled();
      await this.append(this.file(scope), prepared.row); rows.push(prepared.row); await this.publish(rows);
      return { ok: true, id: prepared.row.id, note: '已按真实来源记下；新倾向需要不同真实经历，修正会撤回旧支持' };
    });
  }
  active(rows) {
    const replaced = new Set(rows.filter(r => r.record === 'memory').map(r => r.revises).filter(Boolean));
    return rows.filter(r => r.record === 'memory' && !replaced.has(r.id));
  }
  activeContinuity(rows, { history = false } = {}) {
    const all = rows.filter(r => r.record === 'continuity'), replaced = new Set(all.map(r => r.revises).filter(Boolean));
    return all.filter(r => history || (!replaced.has(r.id) && r.status === 'open' && Date.parse(r.expiresAt) > this.now().getTime()))
      .map(r => ({ ...r, effectiveStatus: replaced.has(r.id) ? 'superseded' : r.status === 'open' && Date.parse(r.expiresAt) <= this.now().getTime() ? 'expired' : r.status }));
  }
  prepareContinuity(scope, rows, args, id) {
    const type = String(args.type ?? ''); let status = String(args.status ?? 'open');
    if (!CONTINUITY_TYPES.includes(type) || !CONTINUITY_STATUSES.includes(status)) throw new Error('未知的关系连续性类别或结束状态');
    const topic = this.text(args.topic, 40, '话题', true), text = this.text(args.text, 300, '连续事项', true), { ids, evidence } = this.evidence(rows, args);
    if (!evidence.some(human)) throw new Error('关系连续事项必须有真人原话，不能从自身日记生成约定');
    const revises = String(args.revises ?? '');
    const revised = rows.find(r => r.id === revises && r.record === 'continuity');
    const participants = [...new Set(args.participants ?? revised?.participants ?? evidence.filter(human).map(r => r.speakerId))].map(String);
    if (!participants.length || participants.length > 8 || participants.some(id => !numericId(id)
      || (!evidence.some(r => human(r) && r.speakerId === id) && !revised?.participants.includes(id)))) throw new Error('参与者必须出现在真实来源或被修正事项的来源中');
    const sameMatter = rows.filter(r => r.record === 'continuity' && r.type === type && keyOf(r.topic) === keyOf(topic)
      && r.participants.length === participants.length && r.participants.every(id => participants.includes(id))
      && !rows.some(n => n.record === 'continuity' && n.revises === r.id));
    const previous = sameMatter.filter(r => r.status === 'open' && Date.parse(r.expiresAt) > this.now().getTime()).at(-1);
    if (revises && (!revised || revised.type !== type || keyOf(revised.topic) !== keyOf(topic)
      || revised.participants.length !== participants.length || revised.participants.some(id => !participants.includes(id))
      || !evidence.some(r => human(r) && revised.participants.includes(r.speakerId))
      || rows.some(n => n.record === 'continuity' && n.revises === revised.id))) throw new Error('只能结束或修正当前场景同话题、同参与者的最新连续事项，且需参与者新的真实来源');
    if (previous && !revises) {
      const details = this.details(args), unchanged = Object.entries(details).every(([key, value]) => JSON.stringify(value) === JSON.stringify(previous[key]));
      if (keyOf(previous.text) === keyOf(text) && status === 'open' && unchanged
        && (!args.expiresAt || Date.parse(args.expiresAt) === Date.parse(previous.expiresAt))) return { existing: previous };
      throw Object.assign(new Error('同参与者同话题仍有开放事项；变更或结束需revises指向现有事项'), { code: 'CONTINUITY_CONFLICT', conflictingMemoryId: previous.id });
    }
    if (!revises) {
      // A later, separately evidenced agreement may reopen the same topic. A
      // retelling of the closed matter must retain its historical end state.
      const closed = sameMatter.filter(r => r.status !== 'open' || Date.parse(r.expiresAt) <= this.now().getTime());
      const oldHuman = rows.filter(r => human(r) && closed.some(item => item.evidenceIds.includes(r.id)));
      const oldIds = new Set(oldHuman.map(r => r.id)), oldEvents = new Set(oldHuman.map(r => this.eventKey(rows, r)));
      const freshHuman = evidence.filter(human).some(r => !oldIds.has(r.id) && !oldEvents.has(this.eventKey(rows, r)));
      if (closed.length && !freshHuman) return { existing: closed.at(-1) };
    }
    // Initial backfill may discover that an old matter already ended. It has no
    // prior continuity ID to revise, so preserve its historical closed state.
    const now = this.now(), sourceAt = Math.max(...evidence.filter(human).map(r => Date.parse(r.ts))), maximum = sourceAt + 180 * DAY;
    const expiresAt = args.expiresAt ? new Date(args.expiresAt) : new Date(sourceAt + TTL[type] * DAY);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() > maximum) throw new Error('事项有效期需依据真人原话时间，最长180天；续期必须有新的真实来源');
    if (status === 'open' && expiresAt.getTime() <= now.getTime()) status = 'expired';
    return { row: { v: 1, record: 'continuity', id, scope, ts: now.toISOString(), type, status, topic, text,
      evidenceIds: ids, participants, expiresAt: expiresAt.toISOString(), ...(revises ? { revises } : {}), ...this.details(args) } };
  }
  closureSignal(text, status) {
    return status === 'cancelled'
      ? /不用(?:了|再)|不需要|取消|算了|先不(?:要|做|用|聊)|别(?:再|继续)|停止|停下|不聊了|不做了|撤回|作废|结束/.test(text)
      : /解决了|已解决|完成了|已完成|搞定|弄好了|办好了|修好了|找到了|明白了|没问题了|好了(?:[。！!，,\s]|$)/.test(text);
  }
  continuityClosure(row, target) {
    return { id: row.id, targetId: target.id, status: row.status, evidenceIds: [...row.evidenceIds],
      targetEvidenceIds: [...target.evidenceIds], participants: [...row.participants] };
  }
  continuitySourceTime(rows, matter, seen = new Set()) {
    if (!matter || seen.has(matter.id)) return 0;
    seen.add(matter.id);
    const at = rows.filter(r => human(r) && matter.participants.includes(r.speakerId) && matter.evidenceIds.includes(r.id)).map(r => Date.parse(r.ts));
    if (matter.revises) at.push(this.continuitySourceTime(rows, rows.find(r => r.record === 'continuity' && r.id === matter.revises), seen));
    return Math.max(0, ...at);
  }
  rememberContinuity(scope, args, { valid = () => true, currentObservationIds = [], currentMessageIds = [] } = {}) {
    return this.serial(async () => {
      if (!valid()) throw cancelled();
      const rows = await this.rows(scope), { evidence } = this.evidence(rows, args);
      const observationIds = new Set(currentObservationIds.map(String)), messageIds = new Set(currentMessageIds.map(String).filter(Boolean));
      const current = evidence.filter(r => human(r) && (observationIds.has(r.id) || (r.messageId && messageIds.has(String(r.messageId)))));
      if (!current.length) throw new Error('连续事项更新必须引用桥接确认的本轮真人observationId，历史原话和模型自述不能代替');
      const revises = String(args.revises ?? ''), target = rows.find(r => r.record === 'continuity' && r.id === revises);
      const status = String(args.status ?? 'open');
      if (!['open', 'resolved', 'cancelled'].includes(status)) throw new Error('前台事项只可创建、修正、解决或取消；到期由真实有效期计算');
      if (['resolved', 'cancelled', 'expired'].includes(status) && !target) throw new Error('前台结束事项必须用revises指定唯一真实cont_目标；不能无目标批量关闭');
      if (revises && !target) throw new Error('连续事项目标不存在或属于其他场景');
      const fresh = target ? current.filter(r => target.participants.includes(r.speakerId) && !target.evidenceIds.includes(r.id)
        && Date.parse(r.ts) >= this.continuitySourceTime(rows, target)) : current;
      if (target && !fresh.length) throw new Error('修正事项需参与者本轮新的真人来源，且不能早于该事项最新真人来源；旧取消不能关闭后来的新约定');
      if (['resolved', 'cancelled'].includes(status) && !fresh.some(r => this.closureSignal(r.text, status))) throw new Error('结束或取消需参与者本轮明确的真人结束表述，不能以模型判断替代');
      const normalized = { ...args, type: args.type ?? target?.type, topic: args.topic ?? target?.topic,
        text: args.text ?? target?.text, participants: args.participants ?? target?.participants,
        ...(target && !args.expiresAt ? { expiresAt: target.expiresAt } : {}),
        ...(target && !args.changeReason ? { changeReason: status === 'open' ? '依据参与者本轮原话更新' : '参与者本轮明确结束此事项' } : {}) };
      const id = `cont_${digest(JSON.stringify({ scope, revises, type: normalized.type, topic: normalized.topic, text: normalized.text,
        status, ids: [...args.evidenceIds].sort(), participants: normalized.participants, expiresAt: normalized.expiresAt }))}`;
      const existing = rows.find(r => r.id === id && r.record === 'continuity');
      if (existing) return { ok: true, id, status: existing.status, duplicate: true,
        continuity: this.activeContinuity(rows).slice(-12), ...(target && existing.status !== 'open' ? { closure: this.continuityClosure(existing, target) } : {}) };
      const prepared = this.prepareContinuity(scope, rows, normalized, id);
      if (prepared.existing) return { ok: true, id: prepared.existing.id, status: prepared.existing.status, duplicate: true, continuity: this.activeContinuity(rows).slice(-12) };
      if (!valid()) throw cancelled();
      await this.append(this.file(scope), prepared.row); rows.push(prepared.row);
      return { ok: true, id, status: prepared.row.status, continuity: this.activeContinuity(rows).slice(-12),
        ...(target && prepared.row.status !== 'open' ? { closure: this.continuityClosure(prepared.row, target) } : {}) };
    });
  }
  reconcileContinuityClosures(scope, hints, { valid = () => true } = {}) {
    return this.serial(async () => {
      if (!valid()) throw cancelled();
      const rows = await this.rows(scope), closures = [];
      for (const hint of (Array.isArray(hints) ? hints : []).slice(0, 6)) {
        if (closures.length >= 4 || !valid()) { if (!valid()) throw cancelled(); break; }
        if (!['resolved', 'cancelled'].includes(hint?.status) || !numericId(hint.participantId)) continue;
        const actor = String(hint.participantId), incomingIds = new Set((hint.evidenceIds ?? []).slice(0, 6));
        const evidence = rows.filter(r => incomingIds.has(r.id) && human(r) && r.speakerId === actor && this.closureSignal(r.text, hint.status));
        if (!evidence.length) continue;
        const targetIds = new Set((hint.targetEvidenceIds ?? []).slice(0, 8)), targetMessages = new Set((hint.targetMessageIds ?? []).slice(0, 8).map(String).filter(Boolean));
        if (!targetIds.size && !targetMessages.size) continue;
        const targets = this.activeContinuity(rows).filter(r => r.participants.includes(actor) && r.evidenceIds.some(id => {
          const source = rows.find(o => o.record === 'observation' && o.id === id);
          return targetIds.has(id) || (source?.messageId && targetMessages.has(String(source.messageId)));
        }));
        if (targets.length !== 1) continue; // An ambiguous source never closes several matters.
        for (const target of targets) {
          if (closures.length >= 4) break;
          const ids = evidence.filter(r => !target.evidenceIds.includes(r.id) && Date.parse(r.ts) >= this.continuitySourceTime(rows, target)).map(r => r.id);
          if (!ids.length) continue;
          const id = `cont_${digest(`${scope}:closure:${target.id}:${hint.status}:${ids.sort().join(':')}`)}`;
          const prepared = this.prepareContinuity(scope, rows, { type: target.type, topic: target.topic, text: target.text,
            status: hint.status, revises: target.id, participants: target.participants, expiresAt: target.expiresAt,
            evidenceIds: ids, changeReason: '参与者在已精确关联的后续原话中明确结束此事项' }, id);
          if (!prepared.row) continue;
          if (!valid()) throw cancelled();
          await this.append(this.file(scope), prepared.row); rows.push(prepared.row);
          closures.push(this.continuityClosure(prepared.row, target));
        }
      }
      return { ok: true, closures, continuity: this.activeContinuity(rows).slice(-12) };
    });
  }
  select(rows, { query = '', subjectId = '', limit = 8, history = false } = {}) {
    const tokens = tokensOf(query).slice(0, 80), now = this.now().getTime();
    const candidates = history ? rows.filter(r => r.record === 'memory') : this.active(rows);
    return candidates.filter(r => !subjectId || r.subjectId === String(subjectId)).map(r => {
      const haystack = `${r.topic} ${r.text} ${r.reason ?? ''} ${r.context ?? ''}`.toLowerCase();
      const match = tokens.reduce((n, t) => n + (haystack.includes(t) ? Math.min(t.length, 8) : 0), 0);
      return { r, match, score: match * 4 + 1 / (1 + Math.max(0, now - Date.parse(r.ts)) / (14 * DAY)) };
    }).filter(s => !tokens.length || s.match > 0).sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(12, Number(limit) || 8))).map(s => s.r);
  }
  recall(scope, args = {}) {
    return this.serial(async () => {
      const rows = await this.rows(scope), query = String(args.query ?? ''), selected = this.select(rows, args);
      const continuity = this.activeContinuity(rows, args).filter(r => (!args.subjectId || r.participants.includes(String(args.subjectId)))
        && (!query || tokensOf(query).some(t => `${r.topic} ${r.text}`.toLowerCase().includes(t)))).slice(-8);
      const wanted = new Set([...selected, ...continuity].flatMap(r => r.evidenceIds)), tokens = tokensOf(query).slice(0, 80);
      const observations = rows.filter(r => r.record === 'observation' && (!args.subjectId || r.speakerId === String(args.subjectId)))
        .filter(r => wanted.has(r.id) || (!tokens.length || tokens.some(t => r.text.toLowerCase().includes(t))))
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-Math.max(6, Math.min(16, Number(args.limit) || 8)));
      return { memories: selected, continuity, observations: observations.map(r => ({ ...r, observationId: r.id })), note: '只回忆当前场景；自述、印象、外部说法、自身判断分开。结束和到期事项不作为当前约定，history=true可查历史。' };
    });
  }
  consolidationBatch(scope, { limit = 18, charLimit = 12000, selection = 'backlog' } = {}) {
    return this.serial(async () => {
      const rows = await this.rows(scope), done = new Set(rows.filter(r => r.record === 'consolidation').flatMap(r => r.processedIds));
      const allObservations = rows.filter(r => r.record === 'observation'), pending = allObservations.filter(r => !done.has(r.id));
      if (!['important', 'recent', 'backlog'].includes(selection)) throw new Error('未知的整理选取方式');
      const observations = [], bound = Math.max(1, Math.min(24, Number(limit) || 18)), priorFailure = await this.consolidationFailure(scope);
      let candidates = pending;
      const retryIds = priorFailure?.selection === selection ? priorFailure.unprocessedIds : null;
      if (Array.isArray(retryIds) && retryIds.length && retryIds.every(id => pending.some(r => r.id === id))) candidates = retryIds.map(id => pending.find(r => r.id === id));
      else if (selection === 'recent') candidates = pending.slice(-bound);
      else if (selection === 'important') {
        const important = pending.map((r, index) => ({ index, score: human(r) ? Number(IMPORTANT_CUE.test(r.text)) * 2 + Number(/[？?]/.test(r.text)) : 0 }))
          .filter(r => r.score >= 2).sort((a, b) => b.score - a.score || b.index - a.index)[0];
        if (important) { const start = Math.max(0, important.index - Math.floor(bound / 2)); candidates = pending.slice(start, start + bound); }
      }
      let remaining = Math.max(1600, Math.min(20000, Number(charLimit) || 12000));
      for (const row of candidates) {
        const size = JSON.stringify(row).length;
        if (observations.length >= bound || (observations.length && size > remaining)) break;
        observations.push({ ...row, observationId: row.id }); remaining -= size;
      }
      const unprocessedIds = observations.map(r => r.id);
      let neighbors;
      if (observations.length) {
        const first = allObservations.findIndex(r => r.id === observations[0].id), last = allObservations.findIndex(r => r.id === observations.at(-1).id);
        neighbors = [...allObservations.slice(0, first).filter(r => human(r) || r.source === 'delivered').slice(-3),
          ...allObservations.slice(last + 1).filter(r => human(r) || r.source === 'delivered').slice(0, 3)];
      } else neighbors = allObservations.slice(-6);
      const recentObservations = neighbors.map(r => ({ ...r, observationId: r.id }));
      const participants = new Set([...observations, ...neighbors].filter(human).map(r => r.speakerId));
      const query = cut(observations.map(r => cut(r.text, 400)).join(' '), 2500);
      const conflict = priorFailure?.conflictingMemoryId ? this.active(rows).filter(r => r.id === priorFailure.conflictingMemoryId) : [];
      const continuityConflict = priorFailure?.conflictingMemoryId ? this.activeContinuity(rows).filter(r => r.id === priorFailure.conflictingMemoryId) : [];
      const continuity = [...new Map([...continuityConflict, ...this.activeContinuity(rows).slice(-12)].map(r => [r.id, r])).values()].slice(0, 12);
      const people = this.active(rows).filter(r => participants.has(r.subjectId)).slice(-12).reverse();
      const related = this.select(rows, { query, limit: 12 });
      const memories = [...new Map([...conflict, ...people, ...related, ...this.active(rows).slice(-8).reverse()].map(r => [r.id, r])).values()].slice(0, 20);
      const fingerprint = unprocessedIds.length ? unprocessedIds : [...recentObservations.map(r => r.id), ...continuity.map(r => r.id), ...memories.slice(-3).map(r => r.id)];
      const batchId = `batch_${digest(`${scope}:${fingerprint.join(':')}`)}`;
      return { scope, batchId, selection, observations, unprocessedIds, recentObservations, memories, continuity,
        ...(priorFailure?.batchId === batchId ? { retry: { attempts: priorFailure.attempts, message: priorFailure.message,
          ...(priorFailure.conflictingMemoryId ? { conflictingMemoryId: priorFailure.conflictingMemoryId } : {}) } } : {}),
        remaining: Math.max(0, pending.length - observations.length) };
    });
  }
  commitConsolidation(scope, batch, result, options = {}) {
    const valid = typeof options === 'function' ? options : options.valid ?? (() => true);
    return this.serial(async () => {
      if (!valid()) throw cancelled();
      const rows = await this.rows(scope);
      if (!batch || batch.scope !== scope || !/^batch_[a-f0-9]{24}$/.test(batch.batchId) || !Array.isArray(batch.unprocessedIds)) throw new Error('无效的整理批次');
      const committed = rows.find(r => r.record === 'consolidation' && r.id === batch.batchId);
      if (committed) { await this.publish(rows); return { ok: true, duplicate: true, processed: committed.processedIds.length, memories: committed.items.filter(r => r.record === 'memory').length, continuity: committed.items.filter(r => r.record === 'continuity').length }; }
      if (!result || !Array.isArray(result.memories) || !Array.isArray(result.continuity) || result.memories.length > 10 || result.continuity.length > 8) throw new Error('整理结果需有界的memories和continuity数组，可以都为空');
      const processedIds = [...new Set(batch.unprocessedIds)], batchIds = new Set((batch.observations ?? []).map(r => r.id));
      if (processedIds.length > 24 || processedIds.length !== batch.unprocessedIds.length) throw new Error('整理批次来源重复或超出上限');
      const expectedFingerprint = processedIds.length ? processedIds : [...(batch.recentObservations ?? []).map(r => r.id), ...(batch.continuity ?? []).map(r => r.id), ...(batch.memories ?? []).slice(-3).map(r => r.id)];
      if (batch.batchId !== `batch_${digest(`${scope}:${expectedFingerprint.join(':')}`)}`) throw new Error('整理批次标识与真实来源不匹配');
      const done = new Set(rows.filter(r => r.record === 'consolidation').flatMap(r => r.processedIds));
      if (processedIds.some(id => typeof id !== 'string' || !batchIds.has(id) || !rows.some(r => r.record === 'observation' && r.id === id) || done.has(id))) throw new Error('整理来源缺失或已处理，请重新取得批次');
      const allowedEvidence = new Set([...batchIds, ...(batch.recentObservations ?? []).map(r => r.id)]);
      for (const args of [...result.memories, ...result.continuity]) {
        if (!Array.isArray(args?.evidenceIds) || args.evidenceIds.some(id => !allowedEvidence.has(id)) || !args.evidenceIds.some(id => processedIds.includes(id))) throw new Error('新增整理项只能引用本批及获准背景原话，且至少包含一条本次未整理来源');
      }
      // All validation occurs in memory before the one durable transaction.
      const working = [...rows], items = [], indexedMemories = new Map();
      for (const [index, args] of result.memories.entries()) {
        let resolvedArgs = args;
        if (args.experienceRef !== undefined) {
          const episode = indexedMemories.get(args.experienceRef);
          if (!Number.isInteger(args.experienceRef) || args.experienceRef >= index || episode?.kind !== 'episode') throw new Error('experienceRef需指向本批memories数组中前项episode的零起始索引');
          resolvedArgs = { ...args, experienceId: episode.id };
        }
        const prepared = this.prepareMemory(scope, working, resolvedArgs, `mem_${digest(`${batch.batchId}:memory:${index}`)}`);
        if (prepared.conflict) throw Object.assign(new Error('整理结果覆盖同主题旧记忆，需显式revises或不新增'), { code: 'MEMORY_CONFLICT', conflictingMemoryId: prepared.existing.id });
        const selected = prepared.row ?? prepared.existing; if (selected) indexedMemories.set(index, selected);
        if (prepared.row) { items.push(prepared.row); working.push(prepared.row); }
      }
      for (const [index, args] of result.continuity.entries()) {
        const prepared = this.prepareContinuity(scope, working, args, `cont_${digest(`${batch.batchId}:continuity:${index}`)}`);
        if (prepared.row) { items.push(prepared.row); working.push(prepared.row); }
      }
      const transaction = { v: 1, record: 'consolidation', id: batch.batchId, scope, ts: this.now().toISOString(), processedIds, items };
      const filename = path.join(this.transactionDirectory(scope), `${batch.batchId}.json`);
      await this.writeJson(filename, transaction, valid);
      rows.push(...items, transaction);
      // Core is a repairable projection. Its failure cannot roll back an already
      // durable batch or cause another model call to re-process those sources.
      let projectionPending = false;
      try { await this.publish(rows); } catch { projectionPending = true; }
      return { ok: true, processed: processedIds.length, memories: items.filter(r => r.record === 'memory').length,
        continuity: items.filter(r => r.record === 'continuity').length, projectionPending };
    });
  }
  context(scope, { query = '', participants = [] } = {}) {
    return this.serial(async () => {
      const rows = await this.rows(scope); await this.publish(rows);
      const personality = derivePersonality(await this.core(), this.now().getTime()).slice(0, 8), related = this.select(rows, { query, limit: 5 });
      const people = this.active(rows).filter(r => ['person', 'impression'].includes(r.kind) && participants.map(String).includes(r.subjectId)).slice(-5);
      const memories = [...new Map([...people, ...related].map(r => [r.id, r])).values()].slice(0, 8);
      const coreText = personality.map(s => `- 关于「${s.topic}」：${LABELS[s.stance]}${s.settled ? '；不同真实经历留下的倾向' : '；初步倾向，仍可改变'}${s.reconsidering ? '；也有反例，正在重新考虑' : ''}`).join('\n');
      const labels = { person: '对方自述', impression: '对这个人的印象', episode: '共同经历', world: '听说的世界知识', self: '当时自己的看法', style: '当前场景的表达倾向（暂定）' };
      const scoped = memories.map(r => `- [${r.id}] ${r.ts.slice(0, 10)} ${labels[r.kind]}${r.subjectId ? `（speakerId=${r.subjectId}）` : ''}：${cut(r.text, 220)}${r.reason ? `；理由：${cut(r.reason, 100)}` : ''}${r.context ? `；适用：${cut(r.context, 80)}` : ''}${r.exceptions?.length ? `；例外：${r.exceptions.map(s => cut(s, 60)).join('；')}` : ''}${r.counterEvidence?.length ? `；反例：${r.counterEvidence.map(s => cut(s, 60)).join('；')}` : ''}${r.changeReason ? `；改变依据：${cut(r.changeReason, 100)}` : ''}；来源 ${r.evidenceIds.join(', ')}。`);
      const continuation = this.activeContinuity(rows).filter(r => !participants.length || r.participants.some(id => participants.map(String).includes(id))).slice(-6);
      this.hints.set(scope, { people: [...new Set(this.active(rows).filter(r => ['person', 'impression'].includes(r.kind)).map(r => r.subjectId))], topics: [...new Set(related.map(r => r.topic))] });
      return ['## 各个聊天里同一个我', coreText || '还没有反复经历后留下的共同偏好，可以慢慢了解。',
        '共同倾向只在相关时参考，不必复述或每次表态。历史判断可以改变；已修正判断不再支持当前倾向。',
        scoped.length ? `## 当前场景里相关的人与事\n${scoped.join('\n')}` : '',
        continuation.length ? `## 当前场景仍有效的连续事项\n${continuation.map(r => `- [${r.id}] ${r.type}：${cut(r.text, 220)}；参与者 ${r.participants.join(',')}；有效至 ${r.expiresAt}；来源 ${r.evidenceIds.join(', ')}。`).join('\n')}\n只在下一次合适对话中延续；这些事项不授权主动发消息。解决、撤回或不再适用时记录结束状态。` : '',
        'companion_recall 按主题或speakerId回忆当前场景；companion_remember 用真实observationId保留值得记住的事；companion_continuity 根据本轮真人原话创建、修正或结束具体约定/未完事项，不强制每轮调用。',
        'person只记本人自述；impression是可修正的印象；episode是真实共同经历；world是外部说法；self必须有外界触发和自己已表达的判断。自己说过的话、日记和重复转述不能当作新的独立事实。',
        '记录理由、适用情境、例外和反例；修改旧认识需revises与changeReason。独立经历用已有episode的experienceId和重合原话关联；消息身份、事件身份分开。相同文字、相同偏好、引用旧话不等于同一次发生；另一天又经历一次可形成新的episode。只有明确复述/同一事件时用eventRelation=retelling/same_event及eventSourceId真实原始observationId归并，新发生用new_occurrence且不带旧source。',
        '结束连续事项先定位唯一cont_目标，companion_continuity传revises及status=resolved/cancelled，并引用本轮参与者明确的结束原话；不能用自己的回复、旧取消、无目标的“不要了”批量结束旧事项。',
        'style只在跨日真实互动中谨慎归纳当前场景的表达习惯；不用预设傲娇、毒舌或口头禅。具体人物、私事和表达样本不跨场景共享。一次感受不用急着定性，也不靠拒绝、受伤或写日记证明成长。',
      ].filter(Boolean).join('\n\n');
    });
  }
  attentionHints(scope) {
    const local = this.hints.get(scope) ?? { people: [], topics: [] };
    return { people: local.people, topics: [...new Set([...this.coreHints, ...local.topics])].slice(0, 18) };
  }
  inspect(scope) {
    return this.serial(async () => {
      const rows = await this.rows(scope); await this.publish(rows);
      const done = new Set(rows.filter(r => r.record === 'consolidation').flatMap(r => r.processedIds));
      return { personality: derivePersonality(await this.core(), this.now().getTime()), memories: this.active(rows).length,
        observations: rows.filter(r => r.record === 'observation').length, continuity: this.activeContinuity(rows).length,
        unprocessed: rows.filter(r => r.record === 'observation' && !done.has(r.id)).length };
    });
  }
  async drain() { await this.tail; }
}

export const COMPANION_TOOL_NAMES = ['companion_remember', 'companion_recall', 'companion_continuity'];
export function companionDefinitions() {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  return [
    { name: 'companion_remember', description: '按当前场景真实原话记人、经历、外部说法或自己已表达的看法；不是每轮必调。修正带revises/changeReason。self需真人或外部触发及已发出的自身判断；多次谈同一事件不增加支持。style需跨日真实表达，限当前场景。',
      parameters: { type: 'object', properties: {
        kind: { type: 'string', enum: KINDS }, topic: { type: 'string', description: '简短主题；self仅一般兴趣或观念，不含人物或私事' },
        text: { type: 'string', description: '450字以内，分清来源和自己的理解' }, subjectId: { type: 'string', description: 'person/impression必填，本人真实speakerId' },
        evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: '真实observationId，不能用记忆或日记当来源' },
        revises: { type: 'string', description: '被修正的mem_记录id，修正时同时给changeReason' }, stance: { type: 'string', enum: STANCES },
        reason: { type: 'string' }, context: { type: 'string' }, exceptions: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        counterEvidence: { type: 'array', items: { type: 'string' }, maxItems: 4 }, changeReason: { type: 'string' },
        eventKey: { type: 'string', description: '兼容旧参数；请优先用eventRelation和eventSourceId，单凭相同文字/引用不归并事件' },
        eventRelation: { type: 'string', enum: EVENT_RELATIONS, description: '只有明确复述或同一事件才retelling/same_event；新日期又发生一次用new_occurrence，不带旧source' },
        eventSourceId: { type: 'string', description: 'retelling/same_event需真实原始observationId，当前场景内查到的原来源；new_occurrence不填' },
        experienceId: { type: 'string', description: 'self若确有新的独立经历，给有重合原话来源的有效episode记忆id' },
        experienceRef: { type: 'integer', minimum: 0, description: '仅后台批量整理：指向memories数组中前项episode的零起始索引；前台工具用experienceId' },
      }, required: ['kind', 'topic', 'text', 'evidenceIds'], additionalProperties: false }, output },
    { name: 'companion_continuity', description: '根据本轮真人原话保存或更新当前场景的具体未完事项、明确约定、共同梗、交流偏好。创建需type/topic/text；修正或结束用revises指定唯一cont_目标，结束status=resolved/cancelled且来源有参与者明确结束表述。结束时type/topic/text可省略沿目标。不会主动发消息，不能无目标批量取消。',
      parameters: { type: 'object', properties: {
        type: { type: 'string', enum: CONTINUITY_TYPES }, topic: { type: 'string' }, text: { type: 'string' },
        status: { type: 'string', enum: ['open', 'resolved', 'cancelled'] }, revises: { type: 'string', description: '要修正/解决/取消的真实cont_记录id；结束必填' },
        evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: '必须含本轮程序确认的真人observationId；自身回复、日记和历史取消不能替代当前来源' },
        participants: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
        expiresAt: { type: 'string', description: '可选真实约定有效期ISO时间，最长从真人来源起180天；不填按类别从来源时间计算' },
        reason: { type: 'string' }, context: { type: 'string' }, changeReason: { type: 'string' },
      }, required: ['evidenceIds'], additionalProperties: false }, output },
    { name: 'companion_recall', description: '查当前场景的人、共同经历、有效约定和未完事项及真实observationId；history=true可查已修正/结束历史。找不到来源就不补写。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, subjectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 }, history: { type: 'boolean' } }, additionalProperties: false }, output },
  ];
}
