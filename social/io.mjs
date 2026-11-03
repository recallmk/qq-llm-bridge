import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
export const fault = (code, message) => Object.assign(new Error(message), { code });
export function dPath(value) {
  const full = path.resolve(value);
  if (!/^D:[\\/]/i.test(full)) throw fault('PATH_DENIED', '社交模块只允许写入 D 盘');
  let parent = full;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  if (!/^D:[\\/]/i.test(fs.realpathSync(parent))) throw fault('PATH_DENIED', '路径重定向到了 D 盘之外');
  return full;
}
export function mkdir(value) { const dir = dPath(value); fs.mkdirSync(dir, { recursive: true }); dPath(dir); return dir; }
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback); throw fault('STATE_UNREADABLE', '无法完整读取本地配置或状态，已停止：' + path.basename(file)); }
}
export function atomic(file, value) {
  file = dPath(file); mkdir(path.dirname(file));
  if (fs.existsSync(file)) fs.copyFileSync(file, dPath(path.join(mkdir(path.join(path.dirname(file), '.backups')), path.basename(file) + '.' + stamp())));
  const tmp = dPath(file + '.' + stamp() + '.tmp'), fd = fs.openSync(tmp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function acquireLock(root, name) {
  const file = dPath(path.join(mkdir(root), hash(name) + '.lock')), token = randomUUID();
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = fs.openSync(file, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = readJson(file);
      if (!Number.isInteger(old.pid) || alive(old.pid)) return null;
      try { fs.renameSync(file, dPath(file + '.stale.' + stamp())); } catch (race) { if (race.code !== 'ENOENT') throw race; }
    }
  }
  if (fd === undefined) return null;
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, nameHash: hash(name), createdAt: new Date().toISOString() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return () => { const current = readJson(file, null); if (current?.token === token) fs.unlinkSync(file); };
}
export const text = (value, max = 800) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
export function cleanError(error) {
  const codes = { AUTH_REQUIRED: '需要用户登录', CHALLENGE: '验证码或安全验证，需要用户完成', ACCOUNT_MISMATCH: '页面账号与绑定账号不一致',
    CAPABILITY_UNAVAILABLE: '当前界面没有核验通过的发布能力', BUDGET: '预算或处理上限不足', BILLING_UNKNOWN: '模型费用或额度尚未核定',
    PAUSED: '已暂停', FOREGROUND: 'QQ 前台优先，稍后恢复', NETWORK: '短暂连接故障', UNCERTAIN: '发布结果不明，等待核对',
    STATE_UNREADABLE: '本地状态无法完整读取，停止执行', PATH_DENIED: '拒绝越界路径', INVALID_RESULT: '模型结果未通过来源或内容校验' };
  return codes[error?.code] || text(error?.message || '未完成', 160).replace(/https?:\/\/\S+/g, '[链接省略]');
}
export const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || fault('FOREGROUND', '让出前台'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || fault('FOREGROUND', '让出前台')); }
  signal?.addEventListener('abort', abort, { once: true });
});
