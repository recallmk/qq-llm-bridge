import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fault = (message, code) => Object.assign(new Error(message), { code });

export function promptContent(text, images = []) {
  if (!Array.isArray(images) || images.length > 4) throw new Error('单轮最多接收 4 张图片');
  let bytes = 0;
  const blocks = [{ type: 'text', text: String(text) }];
  for (const [index, image] of images.entries()) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image?.mimeType)
      || typeof image?.data !== 'string' || !image.data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      || image.data.length % 4 !== 0) throw new Error('图片内容或格式不正确');
    bytes += Buffer.byteLength(image.data, 'base64');
    if (bytes > 16 * 1024 * 1024) throw new Error('本轮图片总大小超过 16 MiB');
    blocks.push({ type: 'text', text: `【附图 ${index + 1}】` }, { type: 'image', data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}

export class SdkRuntime {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.ready = null;
    this.readyFlag = false;
    this.stopping = false;
    this.seq = 0;
    this.buffer = '';
    this.pending = new Map();
    this.sessions = new Map();
    this.cancellations = new Map();
    this.restarts = 0;
    this.failures = 0;
    this.restartTimer = null;
  }
  start() {
    if (this.stopping) return Promise.reject(fault('运行时正在关闭', 'STOPPING'));
    if (!this.ready) { clearTimeout(this.restartTimer); this.ready = this.#boot(); }
    return this.ready;
  }
  async #boot() {
    this.readyFlag = false;
    const { bin, patch, cwd, provider, model, reasoningEffort, maxTokens, env } = this.cfg;
    const argv = ['--profile', 'sdk'];
    if (patch) argv.push('--patch', patch);
    const isWin = process.platform === 'win32';
    const child = (this.cfg.spawnImpl ?? spawn)(isWin ? `"${bin}"` : bin, argv, {
      cwd, shell: isWin, windowsHide: true, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => { if (this.child === child) this.#onData(data); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      for (const line of data.split('\n')) if (line.trim()) console.error('[dsh]', line.trim());
    });
    child.once('exit', (code, sig) => this.#onExit(child, code, sig));
    child.once('error', (error) => this.#onExit(child, null, error.message));
    child.stdin.on('error', () => {});
    try {
      const info = await this.#request('initialize', { cwd, provider, model,
        ...(reasoningEffort ? { reasoningEffort } : {}), ...(maxTokens ? { maxTokens } : {}) }, this.cfg.initializeTimeoutMs ?? 60_000);
      this.readyFlag = true;
      this.failures = 0;
      console.log(`[dsh] ready: ${info.serverInfo.name} ${info.serverInfo.version} (${provider}/${model})`);
      return this;
    } catch (error) { await this.#kill(child); throw error; }
  }
  #onExit(child, code, signal) {
    if (this.child !== child) return;
    this.readyFlag = false;
    this.child = null;
    this.ready = null;
    console.error(`[dsh] 进程退出 code=${code} signal=${signal}`);
    const error = fault(`运行时已退出 (code=${code})`, 'RUNTIME_EXITED');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const state of this.sessions.values()) this.#settle(state, error);
    this.sessions.clear();
    if (this.stopping) return;
    this.restarts++;
    const delay = this.cfg.restartDelayMs ?? Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    console.error(`[dsh] ${delay}ms 后重启`);
    this.restartTimer = setTimeout(() => { this.start().catch((e) => console.error('[dsh] 重启失败:', e.message)); }, delay);
  }
  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && message.method === undefined) {
        const p = this.pending.get(message.id);
        if (!p) continue;
        this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Object.assign(new Error(message.error.message ?? 'JSON-RPC error'), { code: message.error.code }));
        else p.resolve(message.result);
      } else if (message.method === 'session.event') this.#event(message.params);
    }
  }
  #event({ sessionId, requestId, event } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s || s.settled || s.cancelling || s.requestId !== requestId) return;
    if (event?.type === 'tool/call') {
      const name = String(event.data?.name ?? '');
      if (name) s.toolCalls.push({ name, callId: String(event.data?.callId ?? ''), ok: false });
    } else if (event?.type === 'tool/result') {
      const message = event.data?.message ?? {};
      const block = message.content?.[0] ?? {};
      const callId = String(message.toolCallId ?? message.source?.callId ?? block.toolCallId ?? event.data?.callId ?? '');
      const rec = s.toolCalls.find((c) => c.callId && c.callId === callId);
      if (rec) rec.ok = !(event.data?.error || message.isError || block.isError);
    } else if (event?.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) s.text += `${s.text ? '\n' : ''}${text}`;
      if (event.data?.usage) for (const key of Object.keys(s.usage)) s.usage[key] += Math.max(0, Number(event.data.usage[key]) || 0);
    } else if (event?.type === 'turn/end') {
      const reason = event.data?.reason ?? {};
      let error;
      if (reason.kind === 'error') error = Object.assign(new Error(reason.error?.message ?? '模型调用失败'), reason.error);
      else if (reason.kind === 'aborted' || reason.kind === 'interrupted') error = fault('本轮被中断', 'CANCELLED');
      this.#settle(s, error);
    }
  }
  #settle(s, error) {
    if (s.settled) return;
    s.settled = true; clearTimeout(s.timer); s.cleanup?.();
    if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
    if (error) s.reject(Object.assign(error, { usage: s.usage }));
    else s.resolve({ text: s.text, usage: s.usage, toolCalls: s.toolCalls });
  }
  #request(method, params, timeoutMs = 30_000) {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(fault('运行时未启动', 'RUNTIME_NOT_STARTED'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(fault(`请求超时: ${method}`, 'RPC_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
          if (!error || !this.pending.has(id)) return;
          clearTimeout(timer); this.pending.delete(id); reject(error);
        });
      } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  status() {
    const running = Boolean(this.child && this.child.exitCode === null);
    return { running, ready: running && this.readyFlag, pid: this.child?.pid ?? null, restarts: this.restarts, activeTurns: this.sessions.size };
  }
  async prompt(sessionId, text, timeoutMs = 180_000, options = {}) {
    const contentBlocks = promptContent(text, options.images);
    await this.cancellations.get(sessionId);
    await this.start();
    if (options.signal?.aborted) throw fault('本轮已取消', 'CANCELLED');
    if (this.sessions.has(sessionId)) throw new Error('该会话上一轮还没结束');
    return new Promise((resolve, reject) => {
      const s = { sessionId, requestId: randomUUID(), resolve, reject, text: '', settled: false, cancelling: false,
        toolCalls: [], options, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      this.sessions.set(sessionId, s);
      s.timer = setTimeout(() => { void this.#cancelState(s, fault('回复超时，旧任务已取消', 'REPLY_TIMEOUT')); }, timeoutMs);
      const onAbort = () => { void this.#cancelState(s, fault('本轮已取消', 'CANCELLED')); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      s.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      this.#request('session/prompt', { sessionId, requestId: s.requestId,
        access: ['owner', 'fish'].includes(options.access) ? options.access : 'chat', contextToken: options.contextToken ?? '',
        ownerTools: options.ownerTools === true,
        qzoneAllowed: options.qzoneAllowed === true,
        ...(options.qzoneContext ? { qzoneContext: options.qzoneContext } : {}),
        ...(options.identity ? { identity: options.identity } : {}),
        ...(options.situation ? { situation: options.situation } : {}),
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        contentBlocks }, this.cfg.requestTimeoutMs ?? 30_000).catch((error) => {
        if (!s.settled) void this.#cancelState(s, Object.assign(error, { code: 'PROMPT_UNCERTAIN' }));
      });
    });
  }
  cancel(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? this.#cancelState(s, fault('本轮已取消', 'CANCELLED')) : (this.cancellations.get(sessionId) ?? Promise.resolve());
  }
  #cancelState(s, error) {
    if (s.cancelling) return this.cancellations.get(s.sessionId) ?? Promise.resolve();
    if (s.settled) return Promise.resolve();
    s.cancelling = true; clearTimeout(s.timer); s.options.onCancel?.();
    const task = (async () => {
      try { await this.#request('session/cancel', { sessionId: s.sessionId, requestId: s.requestId }, this.cfg.cancelTimeoutMs ?? 10_000); }
      catch {
        try { await this.#kill(this.child); }
        catch (fatal) { error = fatal; } // start() now fails closed; still settle the caller exactly once.
      }
      finally { this.#settle(s, error); }
    })();
    this.cancellations.set(s.sessionId, task);
    void task.then(() => { if (this.cancellations.get(s.sessionId) === task) this.cancellations.delete(s.sessionId); }, (e) => console.error('[dsh] 取消失败:', e.message));
    return task;
  }
  async #kill(child) {
    if (!child || this.child !== child) return;
    if (process.platform === 'win32' && !this.cfg.spawnImpl) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('exit', resolve); killer.once('error', resolve);
      });
    } else { try { child.kill(); } catch { /* exited */ } }
    if (this.child === child) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(2000)]);
    if (this.child === child) { this.stopping = true; throw new Error('无法终止旧 DSH 任务；已停止接收新任务'); }
  }
  async stop() {
    this.stopping = true; clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    try { await this.#request('shutdown', undefined, 3000); } catch { /* force below */ }
    if (this.child === child) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(300)]);
    await this.#kill(child);
  }
}
