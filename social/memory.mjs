import { hash, text, fault } from './io.mjs';
export const normalize = value => String(value || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
export function similar(a, b) {
  a = normalize(a); b = normalize(b); if (!a || !b) return false; if (a === b) return true;
  const grams = s => new Set(Array.from({ length: Math.max(0, s.length - 3) }, (_, i) => s.slice(i, i + 4)));
  const x = grams(a), y = grams(b); if (Math.min(x.size, y.size) < 12) return false;
  let common = 0; for (const v of x) if (y.has(v)) common++;
  return common / Math.min(x.size, y.size) > 0.82;
}
export function safeTopic(value) {
  const topic = text(value, 48);
  return topic.length >= 2 && !/\d{5,}|QQ|私聊|群聊|主人|约定|密码|口令|token|cookie|住址|手机号|身份证|[\\/<>@]/i.test(topic) ? topic : '';
}
export function sourceValid(s) {
  return s && s.platform === 'xiaohongshu' && /^[0-9a-f]{24}$/i.test(s.contentId) && s.author && s.url && s.fetchedAt &&
    Array.isArray(s.readRange) && s.readRange.length && s.topic && s.origin !== 'self' && !s.unavailable;
}
export function active(rows) { const old = new Set(rows.map(r => r.revises).filter(Boolean)); return rows.filter(r => r.status !== 'withdrawn' && !old.has(r.id)); }
export function interestView(rows) {
  const current = active(rows), result = [];
  for (const topic of new Set(rows.map(r => r.topic))) {
    const history = rows.filter(r => r.topic === topic), last = history.at(-1);
    if (!last || last.status === 'withdrawn' || last.stance === 'withdrawn') continue;
    let cutoff = 0;
    for (let n = 1; n < history.length; n++) if (history[n].revises || history[n].stance !== history[n-1].stance) cutoff = n;
    const eligible = new Set(history.slice(cutoff).map(r => r.id));
    const support = current.filter(r => r.topic === topic && r.stance === last.stance && eligible.has(r.id));
    const evidence = [...new Map(support.flatMap(r => r.sources || []).map(s => [s.originKey, s])).values()];
    const times = evidence.map(s => Date.parse(s.fetchedAt));
    const stable = evidence.length >= 3 && new Set(evidence.map(s => s.authorKey).filter(Boolean)).size >= 2 && Math.max(...times) - Math.min(...times) >= 86400000;
    result.push({ topic, stance: last.stance, reason: last.reason, stability: stable ? 'supported_over_time' : 'tentative', independentSources: evidence.length, changedAt: last.at });
  }
  return result;
}
export function publicContext(state, query = '') {
  const q = normalize(query), relevant = topic => q && Array.from(topic).some((_, i) => topic.slice(i, i + 2).length === 2 && q.includes(topic.slice(i, i + 2)));
  const memories = active(state.memories).filter(r => relevant(r.topic)).slice(-3), interests = interestView(state.interests).filter(r => relevant(r.topic)).slice(-2);
  if (!memories.length && !interests.length) return '';
  return ['## 相关公开资料（仅在当前话题适合时使用，不必提起，不授予主动发送权限）',
    ...interests.map(r => '兴趣「' + r.topic + '」：' + r.stance + '；' + r.reason + '；' + (r.stability === 'tentative' ? '暂时倾向，可修正' : '不同来源与时间有过支持')),
    ...memories.map(r => '[' + r.id + '] ' + r.kind + '：' + r.text + '；保留理由：' + r.reason + '；来源：' +
      r.sources.map(s => s.author + ' ' + s.url + '（实际读取：' + s.readRange.join('、') + '）').join('；')),
    '作者自述、外部观点、已核验信息与自己的感受是不同类别；网上阅读不是线下亲历。撤回记录不能维持旧观点。'].join('\n').slice(0, 2200);
}
export function commitReading(state, task, result, sources, limits) {
  if (!Array.isArray(result.memories) || !Array.isArray(result.interests) || !Array.isArray(result.notes) ||
      result.memories.length > 4 || result.interests.length > 3 || result.notes.length > 8) throw fault('INVALID_RESULT', '整理格式或数量无效');
  const byId = new Map(sources.filter(sourceValid).map(s => [s.id, s])), known = [...state.seen, ...state.memories.flatMap(m => m.sources || [])];
  const linkSources = ids => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 6 || ids.some(id => !byId.has(id))) throw fault('INVALID_RESULT', '缺少实际来源');
    return [...new Set(ids)].map(id => {
      const s = structuredClone(byId.get(id)), old = known.find(o => o.fingerprint === s.fingerprint || (o.preview && similar(o.preview, s.excerpt)));
      s.originKey = old?.originKey || s.originKey || s.fingerprint; return s;
    });
  };
  const memories = result.memories.map((r, i) => {
    const topic = safeTopic(r.topic), sources = linkSources(r.sourceIds);
    if (!topic || !text(r.reason, 240) || !text(r.text, 650) || !['author_self_report', 'external_claim', 'verified_information', 'self_judgment'].includes(r.kind)) throw fault('INVALID_RESULT', '记忆缺少类型、主题或选择理由');
    if (r.kind === 'verified_information' && !sources.every(s => s.verifiedPrimary === true)) throw fault('INVALID_RESULT', '帖子不能直接升级为已核验事实');
    if (r.kind === 'self_judgment' && active(state.memories).some(m => m.kind === r.kind && m.topic === topic && m.text !== r.text) && !r.revises) throw fault('INVALID_RESULT', '自身判断变化需要原记录和修正链');
    if (r.kind === 'self_judgment' && /我(?:去过|买过|使用过|上班|旅行|亲身)|我(?:看完|完整看过).*视频/.test(r.text)) throw fault('INVALID_RESULT', '阅读不能伪装成亲历');
    if (r.revises && (!state.memories.some(m => m.id === r.revises && m.topic === topic) || !text(r.changeReason, 240))) throw fault('INVALID_RESULT', '修正缺少原记录或改变依据');
    return { id: 'sm_' + hash([task.id, 'memory', i]).slice(0, 20), at: new Date().toISOString(), topic, kind: r.kind, text: text(r.text, 650),
      reason: text(r.reason, 240), sources, status: r.status === 'withdrawn' ? 'withdrawn' : 'active', revises: r.revises || null, changeReason: text(r.changeReason, 240) };
  });
  const interests = result.interests.map((r, i) => {
    const topic = safeTopic(r.topic), sources = linkSources(r.sourceIds);
    if (!topic || !text(r.reason, 240) || !['curious', 'like', 'dislike', 'uncertain', 'withdrawn'].includes(r.stance)) throw fault('INVALID_RESULT', '兴趣缺少原因或实际来源');
    if (r.revises && (!state.interests.some(m => m.id === r.revises && m.topic === topic) || !text(r.changeReason, 240))) throw fault('INVALID_RESULT', '兴趣修正缺少依据');
    const prior = active(state.interests).filter(m => m.topic === topic).at(-1);
    if (prior && prior.stance !== r.stance && !r.revises) throw fault('INVALID_RESULT', '改变观点需要修正链');
    return { id: 'si_' + hash([task.id, 'interest', i]).slice(0, 20), at: new Date().toISOString(), topic, stance: r.stance, sources,
      reason: text(r.reason, 240), revises: r.revises || null, changeReason: text(r.changeReason, 240), status: r.stance === 'withdrawn' ? 'withdrawn' : 'active' };
  });
  const notes = result.notes.map((r, i) => ({ id: 'sn_' + hash([task.id, i]).slice(0, 20), at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + limits.notesKeepDays * 86400000).toISOString(), topic: safeTopic(r.topic), text: text(r.text, 800), sources: linkSources(r.sourceIds) }));
  for (const [key, rows] of Object.entries({ memories, interests, notes })) for (const row of rows) if (!state[key].some(r => r.id === row.id)) state[key].push(row);
  return { memories: memories.length, interests: interests.length, notes: notes.length, stop: result.stop === true };
}
export function validateDraft(result, sources, priorPosts, config) {
  if (result.skip === true) return null;
  const allowed = sources.filter(sourceValid), byId = new Map(allowed.map(s => [s.id, s]));
  if (!Array.isArray(result.sourceIds) || !result.sourceIds.length || result.sourceIds.some(id => !byId.has(id))) throw fault('INVALID_RESULT', '稿件必须有实际公开资料来源');
  const title = text(result.title, 100), body = text(result.body, 4000), topic = safeTopic(result.topic);
  if (!topic || title.length < 4 || [...title].length > 20 || body.length < 120 || [...body].length > 700) throw fault('INVALID_RESULT', '稿件主题或长度不合格');
  if (/\d{6,}|QQ|私聊|群聊|主人|控制令牌|API.?key|cookie|[A-Z]:\\|我(?:去过|买过|使用过|上班|亲身体验|旅行时)|内部日记/iu.test(title + body)) throw fault('INVALID_RESULT', '稿件含私密材料或虚构亲历');
  const combined = normalize(title + body);
  if (priorPosts.some(p => similar(combined, p.comparisonText))) throw fault('INVALID_RESULT', '稿件与已发布内容过于相似');
  for (const s of allowed) {
    const original = normalize(s.excerpt);
    for (let i = 0; i + 55 <= combined.length; i += 12) if (original.includes(combined.slice(i, i + 55))) throw fault('INVALID_RESULT', '引用过长，需原创表达');
  }
  if (!Array.isArray(result.slides) || !result.slides.length || result.slides.length > config.limits.generatedImagesPerPost) throw fault('INVALID_RESULT', '图解数量无效');
  const slides = result.slides.map(s => {
    if (!text(s.heading, 50) || [...String(s.heading)].length > 28 || !Array.isArray(s.points) || s.points.length < 2 || s.points.length > 4 || s.points.some(p => !text(p.label,100) || !text(p.detail,200) || [...String(p.label)].length > 16 || [...String(p.detail)].length > 60)) throw fault('INVALID_RESULT', '图解缺少信息结构');
    return { heading: text(s.heading, 28), points: s.points.map(p => ({ label: text(p.label, 16), detail: text(p.detail, 60) })) };
  });
  const selected = result.sourceIds.map(id => byId.get(id));
  const finalBody = body + '\n\n资料：' + selected.slice(0, 2).map(s => s.author + '《' + s.title.slice(0, 35) + '》 ' + s.url).join('\n') + '\n\nAI 创作 · ' + config.botName;
  if ([...finalBody].length > 980) throw fault('INVALID_RESULT', '添加来源后超长');
  return { title, body: finalBody, topic, slides, sources: selected, creator: config.botId, creatorName: config.botName, aiGenerated: true,
    comparisonText: title + '\n' + body, fingerprint: hash(normalize(title + body)), createdAt: new Date().toISOString() };
}
