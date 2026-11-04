import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, stamp, dPath } from '../../social/io.mjs';
import { GROUP_CHAT_POLICY } from './conversation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fault = (message, code) => Object.assign(new Error(message), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const transportCause = text => {
  if (/\bEOF\b/i.test(text)) return 'EOF';
  if (/ECONNRESET|connection reset|forcibly closed/i.test(text)) return 'CONNECTION_RESET';
  if (/ECONNREFUSED|connection refused|actively refused/i.test(text)) return 'CONNECTION_REFUSED';
  if (/no such host|ENOTFOUND|EAI_AGAIN|name resolution/i.test(text)) return 'DNS';
  if (/deadline exceeded|timed? ?out|timeout/i.test(text)) return 'TIMEOUT';
  if (/TLS|certificate/i.test(text)) return 'TLS';
  if (/proxy|unavailable|\b50[234]\b/i.test(text)) return 'NETWORK_UNAVAILABLE';
  return null;
};

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
    this.lastWarning = null;
    this.lastStartupRetry = null;
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
      lastSuccessAt: this.lastSuccessAt, lastFailure: this.lastFailure, lastWarning: this.lastWarning, lastStartupRetry: this.lastStartupRetry };
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
        submission: { queuedToCli: state.promptQueued === true, initSeen: state.initSeen === true,
          inputObserved: Number.isInteger(state.inputStep), startupAttempt: state.options.startupAttempt ?? 0 },
        failure: state.failureInfo ?? null,
        verification: state.currentReplyVerification ?? null,
        verificationFailure: state.verificationFailure ?? null,
        toolCalls: state.toolCalls.map(t => ({ name: t.name.slice(0, 120), ok: t.ok })).slice(-24),
      });
    } catch { /* Diagnostic storage must never drop an otherwise valid reply. */ }
  }
  conversationHead(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '')) return null;
    let db;
    try {
      const file = dPath(path.join(this.cfg.home, '.gemini', 'antigravity-cli', 'conversations', id + '.db'));
      db = new DatabaseSync(file, { readOnly: true });
      const head = db.prepare('SELECT max(idx) AS idx FROM steps').get().idx;
      return Number.isInteger(head) ? head : -1;
    } catch { return null; }
    finally { db?.close(); }
  }
  startupFailure(state, explicit) {
    // A known CLI eligibility rejection precedes conversation/model submission.
    // A queued stdin line alone is not proof of submission or proof that replay is safe.
    const line = [explicit, ...state.stderr.split(/\r?\n/)]
      .find(s => /eligibility check failed/i.test(s));
    const reason = transportCause(line ?? '');
    if (!line || !reason || /UNAUTHENTICATED|invalid_grant|unauthorized|\b401\b|quota|RESOURCE_EXHAUSTED|\b429\b|not supported|not eligible|safety|blocked/i.test(line)) return null;
    const unchanged = Number.isInteger(state.initialStepHead)
      && this.conversationHead(state.resumedConversationId) === state.initialStepHead;
    const safe = state.result?.status === 'ERROR' && state.frames === 1 && state.invalidLines === 0
      && !state.initSeen && state.inputStep === null && state.steps.size === 0 && state.toolCalls.length === 0
      && !String(state.result.response ?? '').trim() && unchanged;
    state.failureInfo = { phase: 'eligibility', reason, safeToRetry: safe, conversationHeadUnchanged: unchanged };
    return safe ? Object.assign(fault('Antigravity 启动连接中断（' + reason + '），本轮尚未进入模型。', 'MODEL_STARTUP_NETWORK'),
      { phase: 'eligibility', reason, safeToRetry: true }) : null;
  }
  async promptWithStartupRetry(sessionId, text, timeoutMs = 180_000, options = {}) {
    const deadline = Date.now() + timeoutMs;
    let retryRecord;
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw fault('本轮已取消', 'CANCELLED');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fault('回复总等待时间已用完，没有重发。', 'REPLY_TIMEOUT');
      try {
        const result = await this.prompt(sessionId, text, remaining, { ...options, startupAttempt: attempt });
        if (retryRecord) retryRecord.recoveredAt = new Date().toISOString();
        return result;
      } catch (error) {
        const delayMs = 2000;
        if (attempt >= 1 || error.code !== 'MODEL_STARTUP_NETWORK' || error.safeToRetry !== true
          || deadline - Date.now() < delayMs + 1000 || options.signal?.aborted) throw error;
        retryRecord = { at: new Date().toISOString(), attempt: attempt + 1, maxRetries: 1,
          delayMs, phase: error.phase, reason: error.reason, recoveredAt: null };
        this.lastStartupRetry = retryRecord;
        try { options.onStartupRetry?.({ ...retryRecord }); } catch { /* Status/logging cannot drop a safe recovery. */ }
        try { await delay(delayMs, undefined, { signal: options.signal }); }
        catch { throw fault('本轮已取消', 'CANCELLED'); }
      }
    }
  }
  failure(state) {
    const error = state.result?.error;
    const explicit = typeof error === 'string' ? error : error && typeof error === 'object'
      ? [error.code, error.status, error.message].filter(x => typeof x === 'string').join(' ') : '';
    const startup = this.startupFailure(state, explicit);
    if (startup) return startup;
    const authRestored = /authenticated successfully|applyAuthResult/i.test(state.stderr);
    const diagnostic = explicit || (authRestored
      ? state.stderr.replace(/^.*(?:not logged|token source|credential|auth|login|oauth).*$/gmi, '')
      : state.stderr);
    const fail = (message, code, reason) => {
      state.failureInfo ??= { phase: state.initSeen ? 'model_or_protocol' : 'startup',
        reason, safeToRetry: false };
      return Object.assign(fault(message, code), { phase: state.failureInfo.phase,
        reason: state.failureInfo.reason, safeToRetry: false });
    };
    if (/UNAUTHENTICATED|authentication required|not logged|invalid credentials|invalid_grant|unauthori[sz]ed|\b401\b/i.test(diagnostic))
      return fail('Antigravity 登录已失效，需要在本机恢复模型登录。', 'AUTH_REQUIRED', 'AUTHENTICATION');
    if (/RESOURCE_EXHAUSTED|quota.*exceed|rate.?limit|too many requests|\b429\b|额度.*(耗尽|用完)/i.test(diagnostic))
      return fail('Antigravity 订阅额度或请求频率受限，本轮没有自动重试。', 'MODEL_QUOTA', 'QUOTA');
    if (/failed to construct executor:.*unknown model key|unknown model key .*model not found/i.test(diagnostic)) {
      state.failureInfo = { phase: 'executor_initialization', reason: 'MODEL_METADATA_UNAVAILABLE', safeToRetry: false };
      return fail('Antigravity 未取得当前模型配置，本轮没有生成回复，未自动重发。', 'MODEL_METADATA', 'MODEL_METADATA_UNAVAILABLE');
    }
    const transport = state.failureInfo?.reason || transportCause(diagnostic);
    if (transport)
      return fail('Antigravity 网络或服务连接中断（' + transport + '），本轮未自动重发。', 'MODEL_NETWORK', transport);
    if (!state.result) return fail('Antigravity 未返回完整的本轮结果，已停止等待；不会自动重发。', 'CLI_PROTOCOL', 'MISSING_RESULT');
    if (['CANCELED', 'INTERRUPTED'].includes(state.result.status))
      return fail('Antigravity 本轮被中断，没有自动重试。', 'PROMPT_UNCERTAIN', 'INTERRUPTED');
    return fail('Antigravity 本轮返回错误，脱敏原因代码已保存在本机运行记录。', 'MODEL_ERROR', 'UNCLASSIFIED_PROVIDER_ERROR');
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
    if (options.jsonOnly || options.noTools) args.push('--disable-slash-commands', '--settings', JSON.stringify({
      useG1Credits: false, allowNonWorkspaceAccess: false,
      permissions: { allow: [], ask: [], deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)', 'mcp(*/*)', 'agent(*)'] },
    }));
    const previous = options.persist === false ? undefined : this.saved[sessionId];
    const initialStepHead = this.conversationHead(previous?.id);
    if (previous?.id) args.push('--conversation', previous.id);
    const home = this.cfg.home;
    const env = { ...process.env, USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      TEMP: path.join(path.dirname(home), '.tmp'), TMP: path.join(path.dirname(home), '.tmp'), NODE_DISABLE_COMPILE_CACHE: '1',
      QQ_TURN_CONTEXT: options.jsonOnly || options.noTools ? '' : options.contextToken ?? '', QQ_TURN_ACCESS: options.access ?? 'chat',
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
        resumedConversationId: previous?.id ?? '', inputStep: null, steps: new Map(),
        initialStepHead, initSeen: false, promptQueued: false,
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
        if (event.event === 'init') { state.initSeen = true; if (event.conversation_id) state.conversationId = event.conversation_id; }
        if (event.event === 'step_update') {
          const s = event.step_update ?? {};
          if (Number.isInteger(s.step_index) && (!s.conversation_id || s.conversation_id === state.conversationId)) {
            const row = state.steps.get(s.step_index) ?? { index: s.step_index, text: '', doneText: '', error: false };
            row.type = s.step_type; row.state = s.state; row.error ||= Boolean(s.tool_info?.error || s.error);
            if (s.step_type === 'user_input') state.inputStep = Math.max(state.inputStep ?? -1, s.step_index);
            if (s.step_type === 'agent_response' && typeof s.text_delta === 'string') {
              row.text += s.text_delta; if (s.state === 'DONE') row.doneText = s.text_delta;
            }
            state.steps.set(s.step_index, row);
          }
          if (s.step_type === 'tool' && s.state === 'DONE') {
            const name = s.tool_info?.name || s.tool_name;
            if (name) state.toolCalls.push({ name: String(name), ok: !s.tool_info?.error });
          }
          if ((options.jsonOnly || options.noTools) && s.step_type === 'tool') {
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
      try { child.stdin.write(JSON.stringify(message) + '\n'); state.promptQueued = true; }
      catch { void this.cancelState(state, fault('Antigravity 输入管道关闭，本轮不会自动重发。', 'PROMPT_UNCERTAIN')); }
      if (options.signal?.aborted) onAbort();
    });
  }
  recoverableToolWarning(row) {
    // Only local pre-action rejections. Unknown errors and uncertain deliveries stay fatal.
    if (row.step_type !== 132 || ![4, 7].includes(row.status) || !row.error_details?.length) return null;
    const detail = Buffer.from(row.error_details).toString('utf8');
    const payload = Buffer.from(row.step_payload ?? []).toString('utf8');
    if (payload.includes('mcp_qq_qq_send_sticker') || payload.includes('mcp__qq__qq_send_sticker')) {
      if (detail.includes('调用失败：请先检索并使用返回的真实表情 id')
        || detail.includes('调用失败：sticker_id 无效，请先检索')) return 'STICKER_SELECTION_REJECTED';
      if (detail.includes('调用失败：这个会话的表情还在冷却，直接接话或保持安静即可')) return 'STICKER_COOLDOWN';
      if (detail.includes('调用失败：本地表情文件不可用')) return 'STICKER_FILE_UNAVAILABLE';
    }
    if (payload.includes('list_resources') && payload.includes('xhs')
      && (detail.includes('server xhs is not allowed in this context') || detail.includes('unknown tool: "list_resources"')))
      return 'RESOURCE_SERVER_UNAVAILABLE';
    return null;
  }
  completedReplyWithToolWarnings(state, id) {
    // Verify the reply independently of known, nonfatal tool rejections; never grant a denied action.
    // JSON/social tasks still require provider SUCCESS.
    const reject = reason => { state.verificationFailure = reason; return null; };
    if (state.options.jsonOnly) return reject('AUTOMATION_REQUIRES_SUCCESS');
    if (!state.resumedConversationId || id !== state.resumedConversationId || id !== state.conversationId
      || !Number.isInteger(state.inputStep) || !/^[0-9a-f-]{36}$/i.test(id)) return reject('CONVERSATION_OR_INPUT_UNVERIFIED');
    if (typeof state.result.response !== 'string' || !state.result.response.trim()) return reject('NO_FINAL_TEXT');
    const current = [...state.steps.values()].filter(s => s.index >= state.inputStep);
    const final = current.filter(s => s.type === 'agent_response').sort((a, b) => b.index - a.index)[0];
    if (!final || final.index <= state.inputStep || final.state !== 'DONE' || final.error) return reject('REPLY_STEP_INCOMPLETE');
    const response = state.result.response.trim().replace(/\r\n/g, '\n');
    if (![final.text, final.doneText].some(s => s.trim().replace(/\r\n/g, '\n') === response)) return reject('REPLY_TEXT_MISMATCH');
    if (current.some(s => s.index > final.index && s.type !== 'checkpoint')) return reject('WORK_AFTER_REPLY');
    let db;
    try {
      const file = dPath(path.join(this.cfg.home, '.gemini', 'antigravity-cli', 'conversations', id + '.db'));
      db = new DatabaseSync(file, { readOnly: true });
      const newest = db.prepare('SELECT max(idx) AS idx FROM steps').get().idx;
      if (newest !== Math.max(...current.map(s => s.index))) return reject('DATABASE_STEP_MISMATCH');
      const rows = db.prepare('SELECT idx, step_type, status, error_details, step_payload FROM steps WHERE idx>=?').all(state.inputStep);
      const warnings = [];
      for (const row of rows) {
        if (row.status === 3 && !row.error_details?.length) continue;
        const code = this.recoverableToolWarning(row);
        if (!code) return reject('CURRENT_STEP_FAILED_OR_INCOMPLETE');
        warnings.push({ step: row.idx, code });
      }
      const warningSteps = new Set(warnings.map(w => w.step));
      const databaseSteps = new Set(rows.map(r => r.idx));
      for (const step of current) {
        if (!databaseSteps.has(step.index)) return reject('STREAM_STEP_NOT_IN_DATABASE');
        // Some CLI releases omit the final update for a rejected tool; its DB terminal state is authoritative.
        if (warningSteps.has(step.index) && step.type === 'tool') continue;
        if (step.state !== 'DONE' || step.error) return reject('STREAM_STEP_INCOMPLETE');
      }
      const older = db.prepare('SELECT idx FROM steps WHERE idx<? AND length(error_details)>0').all(state.inputStep);
      if (!older.length && !warnings.length) return reject('ERROR_WITHOUT_KNOWN_TOOL_CAUSE');
      const raw = state.result.error;
      const reason = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
      if (/UNAUTHENTICATED|invalid_grant|unauthorized|authentication|required.*login|quota|RESOURCE_EXHAUSTED|429|deadline|timeout|timed out|network|connection|unavailable|CANCELED|INTERRUPTED|safety|filter|blocked/i.test(reason))
        return reject('TERMINAL_FAILURE_NOT_RECOVERABLE');
      return { code: warnings.length ? 'COMPLETED_REPLY_WITH_TOOL_WARNINGS' : 'HISTORICAL_CONVERSATION_ERROR',
        inputStep: state.inputStep, responseStep: final.index, verifiedSteps: rows.length,
        historicalErrorSteps: older.map(r => r.idx).slice(-20), toolWarnings: warnings };
    } catch { return reject('DATABASE_UNAVAILABLE'); }
    finally { db?.close(); }
  }
  finishResult(state) {
    if (state.settled || state.cancelling) return;
    const result = state.result;
    const id = String(result.conversation_id || state.conversationId || '');
    const compatibility = result.status === 'ERROR' ? this.completedReplyWithToolWarnings(state, id) : null;
    state.currentReplyVerification = compatibility;
    if (result.status !== 'SUCCESS' && !compatibility) {
      const error = this.failure(state);
      this.diagnostic(state, { code: error.code, phase: 'terminal_result' });
      this.beginDrain(state); this.settle(state, error); return;
    }
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
    this.lastWarning = compatibility ? { code: compatibility.code, message: compatibility.toolWarnings.length ? '本轮文字已核验；可选工具未完成或已降级，未扩大权限。' : 'CLI保留历史错误标记，本轮回复已按步骤和数据库核验。', at: this.lastSuccessAt } : null;
    const u = result.usage ?? {};
    this.diagnostic(state, { code: compatibility ? (compatibility.toolWarnings.length ? 'VERIFIED_REPLY_WITH_TOOL_WARNINGS' : 'VERIFIED_REPLY_WITH_HISTORICAL_ERROR') : 'SUCCESS', phase: 'terminal_result' });
    this.beginDrain(state);
    this.settle(state, null, { text: String(result.response ?? ''), toolCalls: state.toolCalls,
      providerStatus: result.status, completionWarning: compatibility?.code ?? null,
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
      if (error.code !== 'CANCELLED') this.lastFailure = { code: error.code, message: error.message, phase: error.phase ?? null,
        reason: error.reason ?? null, safeToRetry: error.safeToRetry === true, at: new Date().toISOString() };
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
