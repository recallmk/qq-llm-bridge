import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tokensOf } from './vendor/dsh-fish/lib/recall.js';

const DAY = 86_400_000;
const KINDS = ['person', 'impression', 'episode', 'world', 'self'];
const STANCES = ['favor', 'against', 'mixed', 'undecided'];
const LABELS = { favor: '偏喜欢／赞同', against: '偏不喜欢／不赞同', mixed: '有喜欢的部分，也有保留', undecided: '还在了解' };
const keyOf = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const cut = (s, n) => [...String(s ?? '')].slice(0, n).join('');
const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const numericId = (s) => /^\d{1,20}$/.test(String(s));

// Rebuildable projection: only general topics/stances cross conversation boundaries.
// Repeated tool calls on the same evidence cannot manufacture personality support.
export function derivePersonality(rows, now = Date.now()) {
  const topics = new Map();
  for (const row of [...rows].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const key = keyOf(row.topic);
    if (!key || !STANCES.includes(row.stance)) continue;
    const state = topics.get(key) ?? { topic: row.topic, stable: null, votes: new Map(), seen: new Set(), latest: row.ts };
    state.latest = row.ts;
    for (const evidence of row.support ?? []) {
      if (state.seen.has(evidence.bucket)) continue;
      state.seen.add(evidence.bucket);
      state.votes.set(evidence.bucket, { stance: row.stance, at: evidence.at });
    }
    const scores = Object.fromEntries(STANCES.map(s => [s, 0]));
    const days = Object.fromEntries(STANCES.map(s => [s, new Set()]));
    const at = Date.parse(row.ts);
    for (const vote of state.votes.values()) {
      scores[vote.stance] += 2 ** (-Math.max(0, at - Date.parse(vote.at)) / (90 * DAY));
      days[vote.stance].add(vote.at.slice(0, 10));
    }
    const best = [...STANCES].sort((a, b) => scores[b] - scores[a])[0];
    // Two days and several independent episodes; established preferences have inertia.
    if (scores[best] >= 2.8 && days[best].size >= 2
      && (!state.stable || (best !== state.stable && scores[best] >= scores[state.stable] * 1.35 + 1))) state.stable = best;
    state.candidate = best; state.scores = scores;
    topics.set(key, state);
  }
  return [...topics.values()].map(s => ({ topic: s.topic, stance: s.stable ?? s.candidate,
    settled: Boolean(s.stable), reconsidering: Boolean(s.stable && s.candidate !== s.stable),
    // Salience fades, but mere passage of time never creates a trait or changes its sign.
    salience: Math.max(...Object.values(s.scores)) * 2 ** (-Math.max(0, now - Date.parse(s.latest)) / (90 * DAY)),
    latest: s.latest })).sort((a, b) => Number(b.settled) - Number(a.settled) || b.salience - a.salience);
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
  async safe(file) {
    const expected = path.resolve(file);
    if (!expected.startsWith(`${this.root}${path.sep}`)) throw new Error('记忆路径越界');
    let ancestor = expected;
    for (;;) {
      try {
        const actual = await fs.realpath(ancestor);
        if (process.platform === 'win32' && /^C:[\\/]/i.test(actual)) throw new Error('记忆不能保存在 C 盘');
        // Existing descendants cannot escape through a directory junction or file link.
        if (ancestor.startsWith(`${this.root}${path.sep}`) && !actual.toLowerCase().startsWith(`${this.root.toLowerCase()}${path.sep}`)) throw new Error('记忆路径指向了其他目录');
        break;
      } catch (e) { if (e.code !== 'ENOENT') throw e; ancestor = path.dirname(ancestor); }
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  async read(file) {
    await this.safe(file);
    try {
      const text = await fs.readFile(file, 'utf8');
      if (text && !text.endsWith('\n')) throw new Error('记忆日志尾部不完整，已停止追加');
      return text.split('\n').filter(Boolean).map(line => {
        const row = JSON.parse(line);
        if (row.v !== 1 || typeof row.id !== 'string' || !Number.isFinite(Date.parse(row.ts))) throw new Error('记忆日志版本或格式不正确');
        return row;
      });
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async append(file, row) {
    await this.safe(file);
    const handle = await fs.open(file, 'a');
    try { await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }
  async rows(scope) {
    if (!this.cache.has(scope)) this.cache.set(scope, await this.read(this.file(scope)));
    return this.cache.get(scope);
  }
  async core() {
    this.coreCache ??= await this.read(path.join(this.root, 'core.jsonl'));
    return this.coreCache;
  }
  async publish(rows) {
    const core = await this.core(); const ids = new Set(core.map(r => r.id));
    for (const row of rows.filter(r => r.record === 'memory' && r.kind === 'self')) {
      if (ids.has(row.id)) continue;
      const observations = rows.filter(o => row.evidenceIds.includes(o.id));
      const publicRow = { v: 1, id: row.id, ts: row.ts, topic: row.topic, stance: row.stance,
        support: observations.map(o => ({ bucket: digest(`${o.scope}:${Math.floor(Date.parse(o.ts) / (6 * 3_600_000))}`), at: o.ts })) };
      await this.append(path.join(this.root, 'core.jsonl'), publicRow); core.push(publicRow); ids.add(row.id);
    }
    this.coreHints = derivePersonality(core, this.now().getTime()).slice(0, 12).map(s => s.topic);
  }
  observe(scope, input) {
    return this.serial(async () => {
      const rows = await this.rows(scope);
      const messageId = String(input.messageId ?? '');
      const speakerId = String(input.speakerId ?? '');
      if (!numericId(speakerId) && !['self', 'external'].includes(speakerId)) throw new Error('无效的发言人');
      const cleaned = this.clean(input.text);
      const text = cut(cleaned, 1400).trim();
      if (!text) return null;
      const id = messageId ? `obs_${digest(`${scope}:${speakerId}:${messageId}`)}` : `obs_${randomUUID()}`;
      const prior = rows.find(r => r.id === id);
      if (prior) return prior;
      const row = { v: 1, record: 'observation', id, scope, ts: this.now().toISOString(),
        speakerId, speakerName: cut(this.clean(input.speakerName), 60), messageId, text,
        source: speakerId === 'self' ? 'delivered' : speakerId === 'external' ? 'public_material' : 'chat_message',
        ...(input.imageIds?.length ? { imageIds: input.imageIds.filter(id => /^qqimg_[a-f0-9]{24}$/.test(id)).slice(0, 4) } : {}),
        ...(cleaned.length > text.length ? { truncated: true } : {}) };
      await this.append(this.file(scope), row); rows.push(row); return row;
    });
  }
  remember(scope, args, { valid = () => true } = {}) {
    return this.serial(async () => {
      if (!valid()) throw Object.assign(new Error('记忆回合已结束'), { code: 'CANCELLED' });
      const rows = await this.rows(scope);
      const { kind } = args;
      if (!KINDS.includes(kind)) throw new Error('未知的记忆类别');
      const topic = String(args.topic ?? '').trim(), text = String(args.text ?? '').trim();
      if (!topic || [...topic].length > 40 || !text || [...text].length > 450) throw new Error('主题需 1–40 字，记忆需 1–450 字');
      if (this.clean(topic) !== topic || this.clean(text) !== text) throw new Error('这段材料不能写入记忆');
      const ids = [...new Set(args.evidenceIds ?? [])];
      if (!ids.length || ids.length > 6 || ids.some(id => typeof id !== 'string')) throw new Error('需要 1–6 个真实 observationId');
      const evidence = ids.map(id => rows.find(r => r.id === id && r.record === 'observation'));
      if (evidence.some(r => !r)) throw new Error('来源不存在或属于其他场景，请先查 companion_recall');
      const subjectId = String(args.subjectId ?? '');
      if (['person', 'impression'].includes(kind) && (!numericId(subjectId) || !evidence.some(r => r.speakerId === subjectId))) throw new Error('人物记忆必须指向来源中真实发言的 speakerId');
      if (!['person', 'impression'].includes(kind) && subjectId) throw new Error('只有人物记忆需要 subjectId');
      if (kind === 'self') {
        if (!STANCES.includes(args.stance)) throw new Error('自己的看法需要 stance');
        const names = rows.filter(r => r.record === 'observation' && numericId(r.speakerId)).map(r => r.speakerName).filter(n => n.length >= 2);
        if ([...topic].length > 24 || /[\d\r\n@：:／/\\]|https|主人|群友|私聊|群里|昨天|今天|明天|上次|这次|他说|她说|他家|她家/.test(topic)
          || names.some(name => topic.includes(name))) throw new Error('共享主题只写一般兴趣或观念，不写人物、场景、日期或私事');
      }
      const sameSubject = this.active(rows).filter(r => r.kind === kind && r.subjectId === subjectId);
      const memories = sameSubject.filter(r => keyOf(r.topic) === keyOf(topic));
      const previous = memories.at(-1);
      const revises = String(args.revises ?? '');
      if (revises && !sameSubject.some(r => r.id === revises)) throw new Error('只能修正同场景、同人物、同类别的有效旧记录');
      const duplicate = memories.find(r => keyOf(r.text) === keyOf(text) && r.stance === args.stance && ids.every(id => r.evidenceIds.includes(id)));
      if (duplicate) { await this.publish(rows); return { ok: true, id: duplicate.id, note: '这条已经记过' }; }
      if (previous && kind !== 'self' && !revises) return { ok: false, id: previous.id, note: '已有同主题记忆；先回忆，确有变化时用 revises 指向旧记录' };
      const row = { v: 1, record: 'memory', id: `mem_${randomUUID()}`, scope, ts: this.now().toISOString(),
        kind, topic, text, subjectId, evidenceIds: ids, ...(revises ? { revises } : {}),
        ...(kind === 'self' ? { stance: args.stance } : {}),
        basis: kind === 'person' ? '对方自述' : kind === 'impression' ? '她的印象，可修正' : kind === 'world' ? '材料中的说法，未独立核实' : kind === 'self' ? '她自己的判断' : '根据来源整理的经历' };
      if (!valid()) throw Object.assign(new Error('记忆回合已结束'), { code: 'CANCELLED' });
      await this.append(this.file(scope), row); rows.push(row); await this.publish(rows);
      return { ok: true, id: row.id, note: '已记下；自己的新看法会随不同经历逐步积累' };
    });
  }
  active(rows) {
    const replaced = new Set(rows.filter(r => r.record === 'memory').map(r => r.revises).filter(Boolean));
    return rows.filter(r => r.record === 'memory' && !replaced.has(r.id));
  }
  select(rows, { query = '', subjectId = '', limit = 8, history = false } = {}) {
    const tokens = tokensOf(query).slice(0, 80), now = this.now().getTime();
    const candidates = history ? rows.filter(r => r.record === 'memory') : this.active(rows);
    return candidates.filter(r => !subjectId || r.subjectId === String(subjectId)).map(r => {
      const haystack = `${r.topic} ${r.text}`.toLowerCase();
      const match = tokens.reduce((n, t) => n + (haystack.includes(t) ? Math.min(t.length, 8) : 0), 0);
      return { r, match, score: match * 4 + 1 / (1 + Math.max(0, now - Date.parse(r.ts)) / (14 * DAY)) };
    }).filter(s => !tokens.length || s.match > 0).sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(12, Number(limit) || 8))).map(s => s.r);
  }
  recall(scope, args = {}) {
    return this.serial(async () => {
      const rows = await this.rows(scope); const query = String(args.query ?? '');
      const selected = this.select(rows, args); const wanted = new Set(selected.flatMap(r => r.evidenceIds));
      const tokens = tokensOf(query).slice(0, 80);
      const observations = rows.filter(r => r.record === 'observation' && (!args.subjectId || r.speakerId === String(args.subjectId)))
        .filter(r => wanted.has(r.id) || (!tokens.length || tokens.some(t => r.text.toLowerCase().includes(t))))
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
        .slice(-Math.max(6, Math.min(16, Number(args.limit) || 8)));
      return { memories: selected, observations: observations.map(r => ({ ...r, observationId: r.id })), note: '人物自述、自己的印象、外部说法和自己的看法是不同的材料；只回忆当前场景' };
    });
  }
  context(scope, { query = '', participants = [] } = {}) {
    return this.serial(async () => {
      const rows = await this.rows(scope); await this.publish(rows);
      const personality = derivePersonality(await this.core(), this.now().getTime()).slice(0, 8);
      const related = this.select(rows, { query, limit: 5 });
      const people = this.active(rows).filter(r => ['person', 'impression'].includes(r.kind) && participants.map(String).includes(r.subjectId)).slice(-5);
      const memories = [...new Map([...people, ...related].map(r => [r.id, r])).values()].slice(0, 8);
      const coreText = personality.map(s => `- 关于「${s.topic}」：${LABELS[s.stance]}${s.settled ? '；这是多次经历后留下的倾向' : '；这是初步倾向，还没定下来'}${s.reconsidering ? '；最近也有不同感受，正在重新考虑' : ''}`).join('\n');
      const labels = { person: '对方自述', impression: '对这个人的印象', episode: '共同经历', world: '听说的世界知识', self: '当时自己的看法' };
      const scoped = memories.map(r => `- [${r.id}] ${r.ts.slice(0, 10)} ${labels[r.kind]}${r.subjectId ? `（speakerId=${r.subjectId}）` : ''}：${cut(r.text, 220)}；来源 ${r.evidenceIds.join(', ')}。`);
      this.hints.set(scope, { people: [...new Set(this.active(rows).filter(r => ['person', 'impression'].includes(r.kind)).map(r => r.subjectId))], topics: [...new Set(related.map(r => r.topic))] });
      return ['## 各个聊天里同一个我', coreText || '还没有反复经历后留下的共同偏好，可以慢慢了解。',
        '共同倾向只供相关时参考；不必复述，也不用每次表态。不同场景的旧判断是经历，不要求立刻统一成一种态度。',
        scoped.length ? `## 当前场景里相关的人与事\n${scoped.join('\n')}` : '',
        'companion_recall 可以按主题或 speakerId 回忆当前场景的人、事件和原话；companion_remember 用真实 observationId 留下值得记住的事。',
        'person 只记对方自述，impression 是自己的印象，episode 是经历，world 是材料中的说法，self 才是自己的看法。听到不等于认同。',
        '新认识、重要经历、印象改变或出现反例时可以记下；没有变化就不必写。修改旧认识先回忆，用 revises 保留变化的来由。',
        '自己的共享主题只概括一般兴趣和观念；不要把具体人物或某场聊天的私事写成共同性格。一次感受不急着定性，也不需要靠拒绝、顶嘴或写日记证明成长。',
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
      return { personality: derivePersonality(await this.core(), this.now().getTime()),
        memories: this.active(rows).length, observations: rows.filter(r => r.record === 'observation').length };
    });
  }
  async drain() { await this.tail; }
}

export const COMPANION_TOOL_NAMES = ['companion_remember', 'companion_recall'];
export function companionDefinitions() {
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  return [
    { name: 'companion_remember', description: '记住当前场景中值得保留的人、经历、听说的知识或自己的看法。需要真实 observationId；不是每轮必调。人物自述不等于自己的偏好。纠正同主题旧记忆时先 recall，再带 revises。self 的共享主题只写一般兴趣或观念，自己的新倾向会通过多次不同经历逐渐稳定。',
      parameters: { type: 'object', properties: {
        kind: { type: 'string', enum: KINDS }, topic: { type: 'string', description: '简短主题；self 主题不超过24字，不含具体人物或私事' },
        text: { type: 'string', description: '450字以内；分清来源和自己的理解' }, subjectId: { type: 'string', description: 'person/impression 必填，真实 speakerId；其他类别不填' },
        evidenceIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: '本轮 JSON 或 companion_recall 中真实的 observationId' },
        revises: { type: 'string', description: '被修正的 mem_ 记录 id' }, stance: { type: 'string', enum: STANCES, description: 'self 必填，其他类别不填' },
      }, required: ['kind', 'topic', 'text', 'evidenceIds'], additionalProperties: false }, output },
    { name: 'companion_recall', description: '回忆当前聊天中某个人、主题或共同经历，返回记忆和带 observationId 的原话。history=true 可回看已修正的说法；查不到时不要补写来源。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, subjectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 12 }, history: { type: 'boolean' } }, additionalProperties: false }, output },
  ];
}
