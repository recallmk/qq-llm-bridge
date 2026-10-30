/** Bound temporary model history; durable QQ observations and growth records stay intact. */
export class GroupContext {
  constructor(store, registry, { maxTurns = 8, idleMs = 3_600_000 } = {}) {
    Object.assign(this, { store, registry, maxTurns, idleMs });
    if (store.value?.version !== 1 || !store.value.sessions || typeof store.value.sessions !== 'object' || Array.isArray(store.value.sessions)) throw new Error('群短会话状态损坏，请恢复备份');
    for (const [key, row] of Object.entries(store.value.sessions)) {
      if (!/^qq2-g-\d+$/.test(key) || !row || typeof row.sessionId !== 'string' || !row.sessionId.startsWith(key)
        || !Number.isSafeInteger(row.turns) || row.turns < 1 || !Number.isFinite(row.lastAt)) throw new Error('群短会话记录损坏，请恢复备份');
    }
  }
  begin(key, now = Date.now()) {
    const current = this.registry.get(key), previous = this.store.value.sessions[key];
    const rotate = !previous || previous.sessionId !== current || previous.turns >= this.maxTurns || now - previous.lastAt >= this.idleMs;
    const sessionId = rotate ? this.registry.rotate(key) : current;
    const row = { sessionId, turns: rotate ? 1 : previous.turns + 1, lastAt: now };
    this.store.save({ version: 1, sessions: { ...this.store.value.sessions, [key]: row } });
    return { sessionId, previousId: rotate ? current : null, turns: row.turns, rotated: rotate };
  }
  status() { return { maxTurns: this.maxTurns, idleMs: this.idleMs, trackedGroups: Object.keys(this.store.value.sessions).length }; }
}
