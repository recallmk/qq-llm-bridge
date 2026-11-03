import path from 'node:path';
import fs from 'node:fs';
import { atomic, readJson, mkdir, hash, fault, dPath } from './io.mjs';
const empty = () => ({ version: 1, tasks: {}, seen: [], notes: [], memories: [], interests: [], ledger: [], connections: {}, reports: [] });
export class State {
  constructor(root) { this.root = mkdir(root); this.file = path.join(root, 'state.json'); this.value = readJson(this.file, empty()); if (this.value.version !== 1) throw fault('STATE_UNREADABLE', '未知社交状态版本'); }
  reload() { this.value = readJson(this.file, empty()); return this.value; }
  save() { atomic(this.file, this.value); }
  report(task, code, message) {
    const id = hash([task?.id || 'service', code, message]);
    if (!this.value.reports.some(r => r.id === id && !r.acknowledgedAt)) this.value.reports.push({ id, taskId: task?.id, code, message, at: new Date().toISOString(), acknowledgedAt: null });
  }
  spent(day, week = null) { return this.value.ledger.filter(r => week ? r.day >= week && r.day < new Date(Date.parse(week + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10) : r.day === day).reduce((sum, r) => sum + r.chargedCny, 0); }
  prune(now, limits) {
    this.value.seen = this.value.seen.filter(r => Date.parse(r.at) > now - limits.seenKeepDays * 86400000);
    this.value.notes = this.value.notes.filter(r => Date.parse(r.expiresAt) > now);
    const backups = path.join(this.root, '.backups');
    if (fs.existsSync(backups)) for (const name of fs.readdirSync(backups)) {
      if (!/^state\.json\./.test(name)) continue;
      const file = dPath(path.join(backups, name));
      if (fs.lstatSync(file).isFile() && fs.statSync(file).mtimeMs < now - 86400000) fs.unlinkSync(file);
    }
    for (const task of Object.values(this.value.tasks)) if (['succeeded','cancelled','failed'].includes(task.status) && Date.parse(task.updatedAt) < now - limits.notesKeepDays * 86400000) task.sources = [];
  }
}
export function transition(task, status, extra = {}) {
  const allowed = { pending: ['running', 'failed', 'cancelled'], running: ['pending', 'draft_complete', 'confirming', 'succeeded', 'failed', 'cancelled'],
    draft_complete: ['pending_publish', 'succeeded', 'failed', 'cancelled'], pending_publish: ['running', 'confirming', 'succeeded', 'failed', 'cancelled'],
    confirming: ['succeeded', 'failed'], failed: ['pending', 'confirming', 'cancelled'], succeeded: [], cancelled: [] };
  if (status !== task.status && !allowed[task.status]?.includes(status)) throw fault('STATE_TRANSITION', '非法任务状态变化：' + task.status + ' -> ' + status);
  task.history ||= []; task.history.push({ from: task.status, to: status, at: new Date().toISOString(), reason: extra.reason || '' });
  Object.assign(task, extra, { status, updatedAt: new Date().toISOString() });
}
