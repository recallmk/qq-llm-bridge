import * as nativeFs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Missing files are normal; damaged state must never silently revive an old session. */
export class JsonState {
  constructor(file, initial, fs = nativeFs) {
    this.file = file;
    this.fs = fs;
    try { this.value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`状态文件无法读取，请恢复备份：${file} (${e.message})`);
      this.value = initial;
    }
  }
  save(value) {
    const body = JSON.stringify(value, null, 2);
    const tmp = `${this.file}.tmp`;
    this.fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    this.fs.renameSync(tmp, this.file);
    this.value = value;
  }
}

export class SessionRegistry {
  constructor(store, makeId = randomUUID) {
    this.store = store;
    this.makeId = makeId;
    const data = store.value;
    if (data?.version !== 1 || (data.freshIds !== undefined && typeof data.freshIds !== 'boolean')
      || !data.sessions || typeof data.sessions !== 'object' || Array.isArray(data.sessions)
      || Object.entries(data.sessions).some(([key, id]) => !/^qq2-(?:g-\d+|p-\d+(?:-exec)?)$/.test(key)
        || typeof id !== 'string' || !(id === key || id.startsWith(`${key}-r`)))) {
      throw new Error('会话映射格式错误；为避免恢复旧上下文，已停止加载');
    }
    this.sessions = new Map(Object.entries(data.sessions));
    this.freshIds = data.freshIds === true;
  }
  get(key) {
    if (!this.sessions.has(key)) this.#commit(key, this.freshIds ? `${key}-r${this.makeId()}` : key);
    return this.sessions.get(key);
  }
  rotate(key) { return this.#commit(key, `${key}-r${this.makeId()}`); }
  #commit(key, id) {
    const next = new Map(this.sessions);
    next.set(key, id);
    this.store.save({ version: 1, ...(this.freshIds ? { freshIds: true } : {}), sessions: Object.fromEntries(next) });
    this.sessions = next;
    return id;
  }
}

export class MessageDeduper {
  constructor(store, { ttlMs = 600_000, maxEntries = 5000, now = Date.now } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    if (store.value?.version !== 1 || !Array.isArray(store.value.entries)
      || store.value.entries.some((e) => !Array.isArray(e) || typeof e[0] !== 'string' || !Number.isFinite(e[1]))) {
      throw new Error('消息去重记录格式错误');
    }
    this.entries = new Map(store.value.entries);
  }
  accept(key) {
    if (!key) return true; // Some OneBot implementations do not supply message_id.
    const now = this.now();
    const seen = this.entries.get(key);
    if (seen !== undefined && now - seen < this.ttlMs) return false;
    const next = new Map([...this.entries].filter(([, at]) => now - at < this.ttlMs));
    next.set(key, now);
    while (next.size > this.maxEntries) next.delete(next.keys().next().value);
    this.store.save({ version: 1, entries: [...next] });
    this.entries = next;
    return true;
  }
}

export const onebotOk = (r) => r?.status === 'ok' && (r.retcode === undefined || r.retcode === 0);
export const cancelledError = () => Object.assign(new Error('本轮已取消'), { code: 'CANCELLED' });

/** One serialized outbox for text, split replies, tool sends and images. Counts actual attempts. */
export class SendQueue {
  constructor({ intervalMs = 1500, maxPerMinute = 12, globalMaxPerMinute = 36,
    maxQueuedMessages = 100, now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { intervalMs, maxPerMinute, globalMaxPerMinute, maxQueuedMessages, now, sleep });
    this.tail = Promise.resolve();
    this.pending = 0;
    this.lastAt = null;
    this.globalTimes = [];
    this.targetTimes = new Map();
  }
  batch(key, count, job, valid = () => true) {
    if (this.pending + count > this.maxQueuedMessages) return Promise.reject(new Error('发送队列已满，请稍后再试'));
    this.pending += count;
    const run = this.tail.then(async () => {
      const deliver = async (post) => {
        for (;;) {
          if (!valid()) throw cancelledError();
          const now = this.now();
          this.globalTimes = this.globalTimes.filter((t) => now - t < 60_000);
          const times = (this.targetTimes.get(key) ?? []).filter((t) => now - t < 60_000);
          for (const [target, old] of this.targetTimes) if (!old.some((t) => now - t < 60_000)) this.targetTimes.delete(target);
          this.targetTimes.set(key, times);
          const wait = Math.max(0,
            this.lastAt === null ? 0 : this.lastAt + this.intervalMs - now,
            times.length >= this.maxPerMinute ? times[0] + 60_000 - now : 0,
            this.globalTimes.length >= this.globalMaxPerMinute ? this.globalTimes[0] + 60_000 - now : 0);
          if (wait > 0) { await this.sleep(Math.min(wait, 1000)); continue; }
          if (!valid()) throw cancelledError();
          this.lastAt = now;
          times.push(now);
          this.globalTimes.push(now);
          return post();
        }
      };
      return job(deliver);
    });
    const result = run.finally(() => { this.pending -= count; });
    this.tail = result.catch(() => {});
    return result;
  }
}
