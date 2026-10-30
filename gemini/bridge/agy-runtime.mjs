import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUP_CHAT_POLICY } from './conversation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fault = (message, code) => Object.assign(new Error(message), { code });

// Each turn gets its own CLI and MCP server, so the bridge can bind the real
// QQ identity to a process rather than trusting model-supplied tool arguments.
export class AntigravityRuntime {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this.cancellations = new Map();
    this.stopping = false;
    this.available = false;
    this.authenticated = false;
    this.storePath = path.join(HERE, 'antigravity-sessions.json');
    try {
      const value = JSON.parse(readFileSync(this.storePath, 'utf8').replace(/^\uFEFF/, ''));
      if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object') throw new Error('invalid session store');
      this.saved = value.sessions;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Antigravity 会话映射无法读取，已停止以免覆盖原记录');
      this.saved = {};
    }
    // A persisted mapping is written only after a successful model reply.
    this.authenticated = Object.keys(this.saved).length > 0;
  }
  async start() {
    if (this.stopping) throw fault('运行时正在关闭', 'STOPPING');
    this.available = existsSync(this.cfg.bin);
    if (!this.available) throw fault('Antigravity CLI 尚未安装', 'RUNTIME_NOT_STARTED');
    return this;
  }
  status() {
    return { running: this.available && !this.stopping, ready: this.authenticated && !this.stopping,
      pid: null, restarts: 0, activeTurns: this.sessions.size };
  }
  save() {
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions: this.saved }, null, 2), 'utf8');
    renameSync(tmp, this.storePath);
  }
  async prompt(sessionId, text, timeoutMs = 180_000, options = {}) {
    await this.cancellations.get(sessionId);
    await this.start();
    if (options.signal?.aborted) throw fault('本轮已取消', 'CANCELLED');
    if (this.sessions.has(sessionId)) throw new Error('该会话上一轮还没结束');
    // The documented CLI streaming protocol accepts text blocks only. Do not
    // silently claim that bytes have been delivered to the model.
    if (options.images?.length) throw fault('Antigravity CLI 图片输入尚未接通', 'VISION_UNAVAILABLE');
    const persona = readFileSync(path.join(HERE, 'persona.md'), 'utf8').replace(/^\uFEFF/, '').trim();
    const intro = [persona, options.identity, GROUP_CHAT_POLICY, options.situation, options.qzoneContext].filter(Boolean).join('\n\n');
    const prompt = `${intro}\n\n${text}`;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    const previous = this.saved[sessionId];
    if (previous?.id) args.push('--conversation', previous.id);
    const home = this.cfg.home;
    const env = { ...process.env, USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: path.join(path.dirname(home), '.tmp'), TMP: path.join(path.dirname(home), '.tmp'), NODE_DISABLE_COMPILE_CACHE: '1',
      QQ_TURN_CONTEXT: options.contextToken ?? '', QQ_TURN_ACCESS: options.access ?? 'chat',
      QQ_TURN_QZONE: options.qzoneAllowed === true ? '1' : '0',
      HTTP_PROXY: this.cfg.proxy, HTTPS_PROXY: this.cfg.proxy, ALL_PROXY: this.cfg.proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1' };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(this.cfg.bin, args, { cwd: this.cfg.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (error) { reject(fault('Antigravity CLI 无法启动', 'RUNTIME_NOT_STARTED')); return; }
      const state = { child, sessionId, options, resolve, reject, settled: false, cancelling: false,
        buffer: '', result: null, conversationId: previous?.id ?? '', toolCalls: [], stderr: '' };
      this.sessions.set(sessionId, state);
      const onAbort = () => { void this.cancelState(state, fault('本轮已取消', 'CANCELLED')); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      state.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      state.timer = setTimeout(() => { void this.cancelState(state, fault('回复超时，旧任务已取消', 'REPLY_TIMEOUT')); }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        state.buffer += chunk;
        let pos;
        while ((pos = state.buffer.indexOf('\n')) >= 0) {
          const line = state.buffer.slice(0, pos).trim(); state.buffer = state.buffer.slice(pos + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.event === 'init' && event.conversation_id) state.conversationId = event.conversation_id;
          if (event.event === 'step_update') {
            const s = event.step_update ?? {};
            if (s.step_type === 'tool' && s.state === 'DONE' && s.tool_name) {
              state.toolCalls.push({ name: String(s.tool_name), ok: !s.tool_info?.error });
            }
          }
          if (event.event === 'result') state.result = event.result;
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-4000); });
      child.stdin.on('error', () => {});
      child.once('error', () => this.settle(state, fault('Antigravity CLI 无法启动', 'PROMPT_UNCERTAIN')));
      child.once('close', code => {
        if (state.settled || state.cancelling) return;
        const result = state.result;
        if (code !== 0 || result?.status !== 'SUCCESS') {
          const diagnostic = `${result?.error ?? ''} ${state.stderr}`;
          const message = /auth|login|sign.?in|credential|unauthori[sz]ed/i.test(diagnostic)
            ? 'Antigravity CLI 需要登录，或当前账号暂不可用。' : 'Antigravity 本轮未能完成，请稍后再试。';
          this.settle(state, fault(message, 'PROMPT_UNCERTAIN')); return;
        }
        const id = String(result.conversation_id || state.conversationId || '');
        if (!/^[0-9a-f-]{36}$/i.test(id)) { this.settle(state, fault('未取得可续接的 Antigravity 会话', 'PROMPT_UNCERTAIN')); return; }
        try { this.saved[sessionId] = { id }; this.save(); }
        catch { this.settle(state, fault('会话映射保存失败，本轮未转发', 'PROMPT_UNCERTAIN')); return; }
        this.authenticated = true;
        const u = result.usage ?? {};
        this.settle(state, null, { text: String(result.response ?? ''), toolCalls: state.toolCalls,
          usage: { inputTokens: Math.max(0, Number(u.input_tokens) || 0), outputTokens: Math.max(0, Number(u.output_tokens) || 0),
            cacheReadTokens: Math.max(0, Number(u.cache_read_tokens) || 0), cacheWriteTokens: 0 } });
      });
      const message = { event: 'user', message: { content: prompt } };
      child.stdin.end(`${JSON.stringify(message)}\n`);
    });
  }
  settle(state, error, value) {
    if (state.settled) return;
    state.settled = true; clearTimeout(state.timer); state.cleanup?.();
    if (this.sessions.get(state.sessionId) === state) this.sessions.delete(state.sessionId);
    if (error) state.reject(error); else state.resolve(value);
  }
  cancel(sessionId) {
    const state = this.sessions.get(sessionId);
    return state ? this.cancelState(state, fault('本轮已取消', 'CANCELLED')) : (this.cancellations.get(sessionId) ?? Promise.resolve());
  }
  cancelState(state, error) {
    if (state.cancelling) return this.cancellations.get(state.sessionId) ?? Promise.resolve();
    if (state.settled) return Promise.resolve();
    state.cancelling = true; clearTimeout(state.timer); state.options.onCancel?.();
    const task = (async () => {
      if (state.child.exitCode === null && state.child.pid) {
        await new Promise(resolve => {
          const killer = spawn('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('exit', resolve); killer.once('error', resolve);
        });
        await Promise.race([new Promise(resolve => state.child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
      }
      this.settle(state, error);
    })();
    this.cancellations.set(state.sessionId, task);
    void task.finally(() => { if (this.cancellations.get(state.sessionId) === task) this.cancellations.delete(state.sessionId); });
    return task;
  }
  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.sessions.values()].map(state => this.cancelState(state, fault('桥接正在关闭', 'CANCELLED'))));
  }
}
