import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, stamp } from '../../social/io.mjs';
import { GROUP_CHAT_POLICY } from './conversation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fault = (message, code) => Object.assign(new Error(message), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Each submitted turn owns a CLI/MCP process and an independently verified QQ scope.
export class AntigravityRuntime {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
    this.cancellations = new Map();
    this.draining = new Set();
    this.stopping = false;
    this.available = false;
    // A saved conversation proves history, not this process's live authentication.
    this.authenticated = false;
    this.lastSuccessAt = null;
    this.lastFailure = null;
    this.storePath = path.join(HERE, 'antigravity-sessions.json');
    try {
      const value = JSON.parse(readFileSync(this.storePath, 'utf8').replace(/^\uFEFF/, ''));
      if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object') throw new Error('invalid session store');
      this.saved = value.sessions;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Antigravity 会话映射无法读取，已停止以免覆盖原记录');
      this.saved = {};
    }
  }
  async start() {
    if (this.stopping) throw fault('运行时正在关闭', 'STOPPING');
    this.available = existsSync(this.cfg.bin);
    if (!this.available) throw fault('Antigravity CLI 尚未安装', 'RUNTIME_NOT_STARTED');
    return this;
  }
  status() {
    return { running: this.available && !this.stopping,
      ready: this.authenticated && !this.lastFailure && !this.stopping,
      pid: null, restarts: 0, activeTurns: this.sessions.size,
      closingProcesses: this.draining.size, cachedConversations: Object.keys(this.saved).length,
      lastSuccessAt: this.lastSuccessAt, lastFailure: this.lastFailure };
  }
  save() { atomic(this.storePath, { version: 1, sessions: this.saved }); }
  diagnostic(state, outcome) {
    // No prompts, responses, stderr, credentials or tool arguments.
    try {
      atomic(path.join(HERE, 'runtime-diagnostics', stamp() + '.json'), {
        version: 1, at: new Date().toISOString(), ...outcome,
        protocol: { frames: state.frames, invalidLines: state.invalidLines,
          lastEvent: state.lastEvent, terminalStatus: state.result?.status ?? null,
          responseChars: typeof state.result?.response === 'string' ? state.result.response.length : 0,
          parsedTail: state.parsedTail === true },
        toolCalls: state.toolCalls.map(t => ({ name: t.name.slice(0, 120), ok: t.ok })).slice(-24),
      });
    } catch { /* Diagnostic storage must never drop an otherwise valid reply. */ }
  }
  failure(state) {
    const error = state.result?.error;
    const explicit = typeof error === 'string' ? error : error && typeof error === 'object'
      ? [error.code, error.status, error.message].filter(x => typeof x === 'string').join(' ') : '';
    const authRestored = /authenticated successfully|applyAuthResult/i.test(state.stderr);
    const diagnostic = explicit || (authRestored
      ? state.stderr.replace(/^.*(?:not logged|token source|credential|auth|login|oauth).*$/gmi, '')
      : state.stderr);
    if (/UNAUTHENTICATED|authentication required|not logged|invalid credentials|invalid_grant|unauthori[sz]ed|\b401\b/i.test(diagnostic))
      return fault('Antigravity 登录已失效，需要在本机恢复模型登录。', 'AUTH_REQUIRED');
    if (/RESOURCE_EXHAUSTED|quota.*exceed|rate.?limit|too many requests|\b429\b|额度.*(耗尽|用完)/i.test(diagnostic))
      return fault('Antigravity 订阅额度或请求频率受限，本轮没有自动重试。', 'MODEL_QUOTA');
    if (/deadline exceeded|timed? ?out|connection reset|connection refused|TLS|proxy|unavailable|\b50[234]\b/i.test(diagnostic))
      return fault('Antigravity 网络或服务暂时不可用，本轮没有自动重试。', 'MODEL_NETWORK');
    if (!state.result) return fault('Antigravity 未返回完整的本轮结果，已停止等待；不会自动重发。', 'CLI_PROTOCOL');
    if (['CANCELED', 'INTERRUPTED'].includes(state.result.status))
      return fault('Antigravity 本轮被中断，没有自动重试。', 'PROMPT_UNCERTAIN');
    return fault('Antigravity 本轮返回错误，脱敏原因代码已保存在本机运行记录。', 'MODEL_ERROR');
  }
  async prompt(sessionId, text, timeoutMs = 180_000, options = {}) {
    await this.cancellations.get(sessionId);
    for (const old of this.draining) if (old.sessionId === sessionId) {
      await old.reaping;
      if (!old.closed) throw fault('该会话上一轮进程仍在退出，请稍后再发。', 'RUNTIME_DRAINING');
    }
    await this.start();
    if (options.signal?.aborted) throw fault('本轮已取消', 'CANCELLED');
    if (this.sessions.has(sessionId)) throw new Error('该会话上一轮还没结束');
    if (options.images?.length) throw fault('Antigravity CLI 图片输入尚未接通', 'VISION_UNAVAILABLE');
    const persona = readFileSync(path.join(HERE, 'persona.md'), 'utf8').replace(/^\uFEFF/, '').trim();
    const intro = [persona, options.identity, GROUP_CHAT_POLICY, options.situation, options.qzoneContext].filter(Boolean).join('\n\n');
    const prompt = intro + '\n\n' + text;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (options.jsonOnly) args.push('--disable-slash-commands', '--settings', JSON.stringify({
      useG1Credits: false, allowNonWorkspaceAccess: false,
      permissions: { allow: [], ask: [], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)', 'mcp(*/*)', 'agent(*)'] },
    }));
    const previous = options.persist === false ? undefined : this.saved[sessionId];
    if (previous?.id) args.push('--conversation', previous.id);
    const home = this.cfg.home;
    const env = { ...process.env, USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: path.join(path.dirname(home), '.tmp'), TMP: path.join(path.dirname(home), '.tmp'), NODE_DISABLE_COMPILE_CACHE: '1',
      QQ_TURN_CONTEXT: options.jsonOnly ? '' : options.contextToken ?? '', QQ_TURN_ACCESS: options.access ?? 'chat',
      QQ_TURN_QZONE: options.qzoneAllowed === true ? '1' : '0',
      HTTP_PROXY: this.cfg.proxy, HTTPS_PROXY: this.cfg.proxy, ALL_PROXY: this.cfg.proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1' };
    delete env.ELECTRON_RUN_AS_NODE;
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn(this.cfg.bin, args, { cwd: this.cfg.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { reject(fault('Antigravity CLI 无法启动', 'RUNTIME_NOT_STARTED')); return; }
      let resolveClosed;
      const state = { child, sessionId, options, resolve, reject, settled: false, cancelling: false,
        buffer: '', result: null, conversationId: previous?.id ?? '', toolCalls: [], stderr: '',
        frames: 0, invalidLines: 0, lastEvent: null, closed: false,
        closedPromise: new Promise(r => { resolveClosed = r; }) };
      this.sessions.set(sessionId, state);
      const onAbort = () => { void this.cancelState(state, fault('本轮已取消', 'CANCELLED')); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      state.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      state.timer = setTimeout(() => { void this.cancelState(state, fault('回复超时，旧任务已取消', 'REPLY_TIMEOUT')); }, timeoutMs);
      const consumeLine = line => {
        if (state.settled || state.cancelling) return;
        line = line.replace(/^\uFEFF/, '').trim();
        if (!line) return;
        let event;
        try { event = JSON.parse(line); } catch { state.invalidLines++; return; }
        state.frames++; state.lastEvent = event.event ?? null;
        if (event.event === 'init' && event.conversation_id) state.conversationId = event.conversation_id;
        if (event.event === 'step_update') {
          const s = event.step_update ?? {};
          if (s.step_type === 'tool' && s.state === 'DONE') {
            const name = s.tool_info?.name || s.tool_name;
            if (name) state.toolCalls.push({ name: String(name), ok: !s.tool_info?.error });
          }
          if (options.jsonOnly && s.step_type === 'tool') {
            void this.cancelState(state, fault('社交回合禁止工具调用', 'TOOL_DENIED')); return;
          }
        }
        if (event.event === 'result' && event.result && typeof event.result === 'object') {
          state.result = event.result;
          if (options.jsonOnly && String(state.result.response || '').length > (options.maxOutputChars || 10000)) {
            void this.cancelState(state, fault('社交输出超过应用层文本上限', 'OUTPUT_LIMIT')); return;
          }
          this.finishResult(state);
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (state.settled || state.cancelling) return;
        state.outputChars = (state.outputChars || 0) + chunk.length;
        state.buffer += chunk;
        if (options.jsonOnly && (state.outputChars > (options.maxOutputChars || 10000) * 8
          || state.buffer.length > (options.maxOutputChars || 10000) * 8)) {
          void this.cancelState(state, fault('社交流式输出超过应用层总字符上限', 'OUTPUT_LIMIT')); return;
        }
        let pos;
        while ((pos = state.buffer.indexOf('\n')) >= 0 && !state.settled && !state.cancelling) {
          const line = state.buffer.slice(0, pos); state.buffer = state.buffer.slice(pos + 1);
          consumeLine(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-8000); });
      child.stdin.on('error', () => {});
      child.once('error', () => {
        state.closed = true; resolveClosed(); this.draining.delete(state);
        if (!state.settled && !state.cancelling) {
          const error = fault('Antigravity CLI 无法启动', 'PROMPT_UNCERTAIN');
          this.diagnostic(state, { code: error.code, phase: 'spawn' }); this.settle(state, error);
        }
      });
      child.once('exit', () => { if (state.settled) this.closePipes(state); });
      child.once('close', (code, signal) => {
        state.closed = true; resolveClosed(); this.draining.delete(state);
        if (state.settled || state.cancelling) return;
        if (state.buffer.trim()) { state.parsedTail = true; consumeLine(state.buffer); state.buffer = ''; }
        if (state.settled || state.cancelling) return;
        const error = this.failure(state);
        this.diagnostic(state, { code: error.code, phase: 'exit_without_result', exitCode: code, signal });
        this.settle(state, error);
      });
      const message = { event: 'user', message: { content: prompt } };
      // A terminal result, rather than EOF or process teardown, completes this turn.
      try { child.stdin.write(JSON.stringify(message) + '\n'); }
      catch { void this.cancelState(state, fault('Antigravity 输入管道关闭，本轮不会自动重发。', 'PROMPT_UNCERTAIN')); }
      if (options.signal?.aborted) onAbort();
    });
  }
  finishResult(state) {
    if (state.settled || state.cancelling) return;
    const result = state.result;
    if (result.status !== 'SUCCESS') {
      const error = this.failure(state);
      this.diagnostic(state, { code: error.code, phase: 'terminal_result' });
      this.beginDrain(state); this.settle(state, error); return;
    }
    const id = String(result.conversation_id || state.conversationId || '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      const error = fault('未取得可续接的 Antigravity 会话，本轮不会自动重发。', 'CLI_PROTOCOL');
      this.diagnostic(state, { code: error.code, phase: 'terminal_result' });
      this.beginDrain(state); this.settle(state, error); return;
    }
    try { if (state.options.persist !== false) { this.saved[state.sessionId] = { id }; this.save(); } }
    catch {
      const error = fault('会话映射保存失败，本轮未转发，也不会自动重发。', 'PROMPT_UNCERTAIN');
      this.diagnostic(state, { code: error.code, phase: 'persist' });
      this.beginDrain(state); this.settle(state, error); return;
    }
    this.authenticated = true; this.lastSuccessAt = new Date().toISOString(); this.lastFailure = null;
    const u = result.usage ?? {};
    this.diagnostic(state, { code: 'SUCCESS', phase: 'terminal_result' });
    this.beginDrain(state);
    this.settle(state, null, { text: String(result.response ?? ''), toolCalls: state.toolCalls,
      usage: { inputTokens: Math.max(0, Number(u.input_tokens) || 0), outputTokens: Math.max(0, Number(u.output_tokens) || 0),
        cacheReadTokens: Math.max(0, Number(u.cache_read_tokens) || 0), cacheWriteTokens: 0 } });
  }
  beginDrain(state) {
    if (state.closed || state.reaping) return;
    this.draining.add(state);
    try { state.child.stdin.end(); } catch {}
    state.reaping = (async () => {
      await Promise.race([state.closedPromise, pause(2000)]);
      if (!state.closed) await this.terminate(state);
    })().catch(() => { this.diagnostic(state, { code: 'PROCESS_DRAIN', phase: 'cleanup' }); });
  }
  closePipes(state) {
    state.child.stdin.destroy(); state.child.stdout.destroy(); state.child.stderr.destroy();
  }
  async terminate(state) {
    if (state.closed || !state.child.pid) return;
    if (state.child.exitCode !== null) {
      this.closePipes(state);
      await Promise.race([state.closedPromise, pause(1500)]); return;
    }
    await Promise.race([new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve); killer.once('error', resolve);
    }), pause(1500)]);
    await Promise.race([state.closedPromise, pause(1500)]);
  }
  settle(state, error, value) {
    if (state.settled) return;
    state.settled = true; clearTimeout(state.timer); state.cleanup?.();
    if (this.sessions.get(state.sessionId) === state) this.sessions.delete(state.sessionId);
    if (error) {
      if (error.code !== 'CANCELLED') this.lastFailure = { code: error.code, message: error.message, at: new Date().toISOString() };
      if (error.code === 'AUTH_REQUIRED') this.authenticated = false;
      state.reject(error);
    } else state.resolve(value);
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
      await this.terminate(state);
      this.diagnostic(state, { code: error.code, phase: 'cancel' });
      if (!state.closed) this.beginDrain(state);
      this.settle(state, error);
    })();
    this.cancellations.set(state.sessionId, task);
    void task.finally(() => { if (this.cancellations.get(state.sessionId) === task) this.cancellations.delete(state.sessionId); });
    return task;
  }
  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.sessions.values()].map(state => this.cancelState(state, fault('桥接正在关闭', 'CANCELLED'))));
    await Promise.allSettled([...this.draining].map(state => this.terminate(state)));
  }
}
