import { cancelledError } from './reliability.mjs';

/** Bound provider pressure while keeping capacity and queue priority for private chats. */
export class ModelGate {
  constructor({ maxRunning = 3, maxGroups = 2, maxWaiting = 64 } = {}) {
    Object.assign(this, { maxRunning, maxGroups, maxWaiting });
    this.running = 0;
    this.groups = 0;
    this.privateRunning = 0;
    this.waiters = [];
    this.sequence = 0;
  }
  status() { return { running: this.running, groups: this.groups, privateRunning: this.privateRunning, waiting: this.waiters.length, maxRunning: this.maxRunning, maxGroups: this.maxGroups }; }
  acquire({ kind = 'group', priority = 1, signal, valid = () => true } = {}) {
    if (signal?.aborted || !valid()) return Promise.reject(cancelledError());
    if (this.waiters.length >= this.maxWaiting) return Promise.reject(new Error('模型等候队列已满，请稍后再试'));
    return new Promise((resolve, reject) => {
      const waiter = { kind, priority, sequence: this.sequence++, signal, valid, resolve, reject };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        signal?.removeEventListener('abort', waiter.abort);
        reject(cancelledError());
        this.pump();
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }
  pump() {
    const rank = row => typeof row.priority === 'function' ? row.priority() : row.priority;
    this.waiters.sort((a, b) => rank(a) - rank(b) || a.sequence - b.sequence);
    for (let index = 0; index < this.waiters.length;) {
      const w = this.waiters[index];
      if (w.signal?.aborted || !w.valid()) {
        this.waiters.splice(index, 1);
        w.signal?.removeEventListener('abort', w.abort);
        w.reject(cancelledError());
        continue;
      }
      if (this.running >= this.maxRunning) break;
      if ((w.kind !== 'private' && this.running - this.privateRunning >= this.maxRunning - 1)
        || (w.kind === 'group' && this.groups >= this.maxGroups) || (w.kind === 'background' && this.running > 0)) { index++; continue; }
      this.waiters.splice(index, 1);
      w.signal?.removeEventListener('abort', w.abort);
      this.running++;
      if (w.kind === 'group') this.groups++;
      if (w.kind === 'private') this.privateRunning++;
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        this.running--;
        if (w.kind === 'group') this.groups--;
        if (w.kind === 'private') this.privateRunning--;
        this.pump();
      });
    }
  }
}
