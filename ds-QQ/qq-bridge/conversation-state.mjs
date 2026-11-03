/** Bounded, scene-local working context. Never used as durable memory evidence. */
const SCENE = /^[gp]-\d{1,20}$/;
const ASK = /[?？]|怎么|如何|为什么|为啥|是否|能否|怎么办|啥意思|什么意思|哪里|哪个|多少|什么时候|帮我|帮忙|请帮|求助|教我|(?:吗|么|对不对|是不是)[。！!\s]*$/u;
const SOLVED = /(?:解决了|搞定了|弄好了|明白了|懂了|知道怎么做了|可以了|能用了|好了谢谢)[。！!~～\s]*$/u;
const CANCELLED = /(?:不用(?:了|回|回答|帮)|不必(?:了|回|回答)|算了|先不聊了|先这样)[。！!~～\s]*$/u;
const clipped = (value, max = 240) => [...String(value ?? '')].slice(0, max).join('');
const finite = value => Number.isFinite(Number(value));
const sourceRef = row => ({ ...(row.observationId ? { observationId: row.observationId } : {}), ...(row.messageId ? { messageId: row.messageId } : {}) });
const sourceIds = value => Array.isArray(value)
  ? [...new Set(value.filter(id => typeof id === 'string' || typeof id === 'number').map(id => clipped(id, 120)).filter(Boolean))].slice(0, 12) : [];
const explicitClosure = (text, status) => !/[?？]/u.test(text)
  && !(status === 'resolved' && /(?:没|未|不|别|并非|不是).{0,6}(?:解决|搞定|弄好|明白|懂|能用|可以)/u.test(text))
  && (status === 'resolved' ? SOLVED.test(text) : status === 'cancelled' && CANCELLED.test(text));

export class ConversationState {
  constructor(store, { now = Date.now, ttlMs = 24 * 60 * 60_000, maxItems = 18, maxScenes = 64 } = {}) {
    Object.assign(this, { store, now });
    this.ttlMs = Math.max(60_000, Math.min(7 * 86_400_000, Number(ttlMs) || 86_400_000));
    this.maxItems = Math.max(6, Math.min(40, Number(maxItems) || 18));
    this.maxScenes = Math.max(1, Math.min(256, Number(maxScenes) || 64));
    const data = store.value;
    if (data?.version !== 1 || !data.scenes || typeof data.scenes !== 'object' || Array.isArray(data.scenes)
      || Object.entries(data.scenes).some(([scope, scene]) => !SCENE.test(scope) || !scene || !Array.isArray(scene.items)
        || !finite(scene.updatedAt) || scene.items.some(row => !row || typeof row.id !== 'string' || !finite(row.at)
          || !['incoming', 'said'].includes(row.kind) || typeof row.text !== 'string' || typeof row.speakerId !== 'string'
          || (!row.observationId && !row.messageId)))) throw new Error('临时话题状态损坏，请恢复备份');
  }
  #scope(scope) {
    if (!SCENE.test(String(scope))) throw new Error('临时话题需要明确的群或私聊场景');
    return String(scope);
  }
  #items(scope, now) {
    return (this.store.value.scenes[scope]?.items ?? []).filter(row => now - row.at < this.ttlMs)
      .map(row => ({ ...row, ...(row.respondedBy ? { respondedBy: [...row.respondedBy] } : {}) }));
  }
  #save(scope, items, now) {
    const scenes = Object.fromEntries(Object.entries(this.store.value.scenes)
      .filter(([key, scene]) => key !== scope && now - scene.updatedAt < this.ttlMs));
    scenes[scope] = { updatedAt: now, items: items.slice(-this.maxItems) };
    const bounded = Object.fromEntries(Object.entries(scenes).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, this.maxScenes));
    this.store.save({ version: 1, scenes: bounded });
  }
  #row(message, kind, now) {
    const observationId = clipped(message.observationId, 120);
    // Incoming batches call their real QQ id replyToMessageId; messageId can be a buffer sequence.
    const messageId = clipped(kind === 'said' ? message.messageId : message.mid || message.replyToMessageId || message.messageId, 100);
    if (!observationId && !messageId) return null;
    const speakerId = kind === 'said' ? 'self' : clipped(message.speakerId ?? message.senderId ?? message.qq, 80);
    if (!speakerId) return null;
    const rawAt = Number(message.ts ?? message.at);
    const at = Number.isFinite(rawAt) && rawAt > 0 ? Math.min(rawAt, now) : now;
    const original = String(message.text ?? ''), text = clipped(original);
    const question = ASK.test(original);
    const explicitQuestion = /[?？]|(?:吗|么|对不对|是不是)[。！!\s]*$/u.test(original)
      || /^(?:请(?:你)?|能不能|可以)?(?:帮我|帮忙|教我|求助)/u.test(original.trim());
    return { id: observationId || `qq:${messageId}`, observationId, messageId, at, kind, speakerId,
      text, ...(message.partnerId ? { partnerId: clipped(message.partnerId, 80) } : {}),
      ...(message.quotedMessageId || (kind === 'said' && message.replyToMessageId)
        ? { respondsToMessageId: clipped(message.quotedMessageId || message.replyToMessageId, 100) } : {}),
      direct: message.direct === true,
      questionStatus: explicitQuestion ? 'unresolved' : 'unknown', question,
      state: 'open', responseState: 'unknown' };
  }
  #relate(items, row, scope) {
    const target = row.respondsToMessageId ? items.find(item => item.messageId === row.respondsToMessageId) : null;
    if (target) {
      row.respondsToSpeakerId = target.speakerId;
      row.respondsToSourceId = target.id;
      if (target.question) {
        target.responseState = 'responded';
        target.respondedBy = [...new Set([...(target.respondedBy ?? []), row.id])].slice(-3);
      }
    } else if (row.kind === 'said' && row.partnerId) row.respondsToSpeakerId = row.partnerId;
    // A delivered answer alone never proves the question has been resolved.
    if (row.kind !== 'incoming' || (!SOLVED.test(row.text) && !CANCELLED.test(row.text))) return;
    let question = target?.question ? target : target?.respondsToSourceId
      ? items.find(item => item.id === target.respondsToSourceId && item.question) : null;
    if (!question && scope.startsWith('p-') && !row.respondsToMessageId) {
      const unresolved = items.filter(item => item.kind === 'incoming' && item.question && item.state !== 'closed'
        && item.speakerId === row.speakerId && row.at - item.at <= 30 * 60_000);
      const last = items.at(-1);
      if (unresolved.length === 1 && last?.kind === 'said' && last.at >= unresolved[0].at
        && last.partnerId === row.speakerId) question = unresolved[0];
    }
    if (!question || question.speakerId !== row.speakerId) return;
    question.state = 'closed';
    question.outcome = CANCELLED.test(row.text) ? 'cancelled' : 'resolved';
    question.questionStatus = question.outcome === 'resolved' ? 'answered' : 'unknown';
    question.closureEvidence = sourceRef(row);
  }
  #turnSources(items, row, message) {
    // Only the bridge supplies the submitted currentMessages IDs to sent().
    // These are same-turn response sources, never evidence that QQ carried a quote,
    // that each question was answered, or that the sender's problem was resolved.
    const observations = new Set(sourceIds(message.inResponseToObservationIds));
    const messages = new Set(sourceIds(message.inResponseToMessageIds));
    const matched = items.filter(item => item.kind === 'incoming'
      && ((item.observationId && observations.has(item.observationId))
        || (item.messageId && messages.has(item.messageId)))).slice(-12);
    if (!matched.length) return;
    row.responseSourceIds = matched.map(item => item.id);
    row.sourceMessageIds = matched.map(item => item.messageId).filter(Boolean);
    row.responseSources = matched.map(item => ({ ...sourceRef(item), speakerId: item.speakerId }));
    for (const item of matched) {
      item.responseState = 'responded';
      item.respondedBy = [...new Set([...(item.respondedBy ?? []), row.id])].slice(-3);
    }
  }
  /** Observe only actual messages from this scene; duplicate sources have no new weight. */
  observe(scope, messages = []) {
    scope = this.#scope(scope);
    const now = this.now(), items = this.#items(scope, now);
    let changed = false;
    for (const message of Array.isArray(messages) ? messages : [messages]) {
      const row = this.#row(message, 'incoming', now);
      if (!row || now - row.at >= this.ttlMs || items.some(item => item.id === row.id
        || (row.messageId && item.messageId === row.messageId))) continue;
      this.#relate(items, row, scope);
      items.push(row); changed = true;
    }
    if (changed) this.#save(scope, items, now);
    return this.context(scope);
  }
  /**
   * Call only for a confirmed delivered part, never a draft or uncertain send.
   * inResponseToObservationIds / inResponseToMessageIds must be supplied by the
   * bridge from this submitted turn, not accepted from model tool arguments.
   */
  sent(scope, message) {
    scope = this.#scope(scope);
    const now = this.now(), items = this.#items(scope, now), row = this.#row(message, 'said', now);
    if (!row || items.some(item => item.id === row.id || (row.messageId && item.messageId === row.messageId))) return;
    this.#relate(items, row, scope);
    this.#turnSources(items, row, message);
    items.push(row);
    this.#save(scope, items, now);
  }
  /** Exact, sourced closure candidates for the memory wrapper; no generic close-all signal. */
  closureHints(scope) {
    scope = this.#scope(scope);
    const items = this.#items(scope, this.now()), hints = [];
    for (const target of items) {
      if (target.kind !== 'incoming' || !target.question || target.state !== 'closed' || !target.observationId
        || target.closureContinuityId || !['resolved', 'cancelled'].includes(target.outcome)) continue;
      const source = items.find(row => row.kind === 'incoming' && row.observationId
        && row.observationId === target.closureEvidence?.observationId && row.id !== target.id);
      if (!source || source.speakerId !== target.speakerId || source.at < target.at
        || !/^\d{1,20}$/.test(source.speakerId) || !explicitClosure(source.text, target.outcome)) continue;
      const quoted = source.respondsToMessageId ? items.find(row => row.messageId === source.respondsToMessageId) : null;
      const relatedQuestions = reply => items.filter(row => row.kind === 'incoming' && row.question
        && (reply?.respondsToSourceId === row.id || reply?.responseSourceIds?.includes(row.id)));
      let exact = quoted?.id === target.id;
      if (!exact && quoted?.kind === 'said') {
        exact = quoted.respondsToSourceId === target.id
          || (relatedQuestions(quoted).length === 1 && relatedQuestions(quoted)[0].id === target.id);
      }
      // Private closure without a quote still needs one precise submitted-turn response chain.
      if (!exact && scope.startsWith('p-') && !source.respondsToMessageId && source.at - target.at <= 30 * 60_000) {
        const sourceIndex = items.findIndex(row => row.id === source.id), reply = items[sourceIndex - 1];
        const questions = relatedQuestions(reply);
        exact = reply?.kind === 'said' && reply.partnerId === source.speakerId
          && questions.length === 1 && questions[0].id === target.id;
      }
      if (!exact) continue;
      hints.push({ status: target.outcome, targetEvidenceIds: [target.observationId],
        targetMessageIds: target.messageId ? [target.messageId] : [], evidenceIds: [source.observationId],
        participantId: source.speakerId });
    }
    return hints.slice(-8);
  }
  /**
   * Mirror an already validated, scene-local continuity-tool result into working context.
   * This is a bridge-only API: model text, invented IDs and generic cancellations do not call it.
   */
  applyContinuityClosure(scope, closure) {
    scope = this.#scope(scope);
    if (!closure || !/^cont_[a-f0-9]{24}$/u.test(String(closure.targetId ?? ''))
      || !['resolved', 'cancelled'].includes(closure.status)
      || (closure.scope !== undefined && closure.scope !== scope)) return { applied: 0 };
    const now = this.now(), items = this.#items(scope, now);
    const originals = new Set(sourceIds(closure.targetEvidenceIds)), originalMessages = new Set(sourceIds(closure.targetMessageIds));
    const evidence = new Set(sourceIds(closure.evidenceIds)), participants = new Set(sourceIds(closure.participants));
    if ((!originals.size && !originalMessages.size) || !evidence.size || !participants.size
      || [...participants].some(id => !/^\d{1,20}$/u.test(id))) return { applied: 0 };
    const candidates = items.filter(row => row.kind === 'incoming'
      && ((row.observationId && originals.has(row.observationId)) || (row.messageId && originalMessages.has(row.messageId))));
    const questions = candidates.filter(row => row.question), target = questions.length === 1
      ? questions[0] : candidates.length === 1 ? candidates[0] : null;
    if (!target || !participants.has(target.speakerId)) return { applied: 0 };
    const sources = items.filter(row => row.kind === 'incoming' && row.observationId && evidence.has(row.observationId)
      && !originals.has(row.observationId) && row.id !== target.id && row.speakerId === target.speakerId && row.at >= target.at);
    const source = sources.at(-1);
    if (!source) return { applied: 0 };
    if (target.closureContinuityId === closure.targetId && target.outcome === closure.status
      && target.closureEvidence?.observationId === source.observationId) return { applied: 0, duplicate: true };
    target.state = 'closed'; target.outcome = closure.status;
    target.questionStatus = target.question && closure.status === 'resolved' && explicitClosure(source.text, 'resolved') ? 'answered' : 'unknown';
    target.closureEvidence = sourceRef(source);
    target.closureSourceIds = sources.map(row => row.observationId).slice(-6);
    target.closureContinuityId = closure.targetId;
    target.closureTargetEvidenceIds = target.observationId ? [target.observationId] : [];
    target.closureRelation = 'validated_continuity';
    this.#save(scope, items, now);
    return { applied: 1, targetId: closure.targetId, status: closure.status };
  }
  /** Budgeted working context only. No private scene is ever read by a group call. */
  context(scope, { maxChars = 2200 } = {}) {
    scope = this.#scope(scope);
    const now = this.now(), items = this.#items(scope, now);
    if (!items.length) return null;
    const limit = Math.max(600, Math.min(4000, Number(maxChars) || 2200));
    const compact = row => ({ source: sourceRef(row), speakerId: row.speakerId, at: new Date(row.at).toISOString(),
      text: clipped(row.text, 170), ...(row.respondsToMessageId ? { respondsToMessageId: row.respondsToMessageId } : {}),
      ...(row.respondsToSpeakerId ? { respondsToSpeakerId: row.respondsToSpeakerId } : {}),
      ...(row.responseSources?.length ? { responseSources: row.responseSources.slice(-3),
        responseSourceIds: row.responseSourceIds.slice(-3), sourceMessageIds: row.sourceMessageIds.slice(-3),
        responseSourceCount: row.responseSources.length } : {}),
      ...((row.question || row.state === 'closed') ? { questionStatus: row.questionStatus, state: row.state,
        responseState: row.responseState, ...(row.respondedBy?.length ? { respondedBy: row.respondedBy.slice(-2) } : {}),
        ...(row.outcome ? { outcome: row.outcome } : {}),
        ...(row.closureEvidence ? { closureEvidence: row.closureEvidence } : {}),
        ...(row.closureSourceIds?.length ? { closureSourceIds: row.closureSourceIds } : {}),
        ...(row.closureContinuityId ? { closureContinuityId: row.closureContinuityId } : {}) } : {}) });
    const result = { scope, expiresAt: new Date(Math.max(...items.map(row => row.at)) + this.ttlMs).toISOString(),
      meaning: '临时线索；responseSources是程序确认的同回合消息来源，不代表真实引用或逐题解答；responded仅代表有关联回复，answered仅代表提问者有来源的解决确认；没有引用的群聊回应对象仍可能未知。',
      pending: items.filter(row => row.question && row.state !== 'closed').slice(-3).map(compact),
      alreadySaid: items.filter(row => row.kind === 'said').slice(-3).map(compact),
      closedTopics: items.filter(row => row.kind === 'incoming' && row.state === 'closed' && row.closureEvidence).slice(-2).map(compact),
      recentTopic: items.filter(row => row.kind === 'incoming').slice(-3).map(compact) };
    while (JSON.stringify(result).length > limit) {
      const arrays = ['recentTopic', 'alreadySaid', 'pending', 'closedTopics'];
      const name = arrays.find(key => result[key].length > 1) ?? arrays.find(key => result[key].length);
      if (!name) break;
      result[name].shift();
    }
    return result;
  }
  status() {
    return { ttlMs: this.ttlMs, maxItems: this.maxItems, trackedScenes: Object.keys(this.store.value.scenes).length };
  }
}
