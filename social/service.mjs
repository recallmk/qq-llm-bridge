import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, accountKey } from './config.mjs';
import { State, transition } from './state.mjs';
import { atomic, readJson, mkdir, acquireLock, hash, fault, cleanError, text } from './io.mjs';
import { localParts, weekOf, inWindow, nextSlot } from './time.mjs';
import { Browser } from './browser.mjs';
import { platformFor } from './xiaohongshu.mjs';
import { interestView, active, safeTopic, sourceValid, commitReading, publicContext, validateDraft, similar } from './memory.mjs';
import { renderAssets } from './assets.mjs';
import { planningPrompt, readingPrompt, draftingPrompt } from './prompts.mjs';

const terminal = status => ['succeeded', 'cancelled'].includes(status);
const gates = new Set(['AUTH_REQUIRED', 'CHALLENGE', 'ACCOUNT_MISMATCH', 'CAPABILITY_UNAVAILABLE']);
export class SocialService {
  constructor({ bridgeRoot, model, isForegroundBusy, seedTopics = async () => [], otherBackgroundSpent = async () => 0, notifyAdmin = null, log = () => {} }) {
    this.bridgeRoot = bridgeRoot; this.configFile = path.join(bridgeRoot, 'social.config.json');
    Object.assign(this, { model, isForegroundBusy, seedTopics, otherBackgroundSpent, notifyAdmin, log });
    this.config = loadConfig(this.configFile, bridgeRoot); this.store = new State(this.config.dataRoot);
    this.busy = false; this.closing = false; this.controller = null; this.timer = null; this.lastError = '';
  }
  reload() { this.config = loadConfig(this.configFile, this.bridgeRoot); return this.config; }
  shared(account) {
    const root = mkdir(path.join(this.config.sharedRoot, 'accounts', hash(accountKey(account)).slice(0, 28)));
    const file = path.join(root, 'publication-ledger.json');
    const value = readJson(file, { version: 1, accountId: account.accountId, platform: account.platform, timeZone: this.config.timeZone, attempts: [], posts: [] });
    if (value.version !== 1 || value.timeZone !== this.config.timeZone || value.accountId !== account.accountId) throw fault('CONFIG', '共享账号的时区或标识不一致，暂停发布');
    return { root, file, value };
  }
  day() { return localParts(new Date(), this.config.timeZone).day; }
  spentToday() { return this.store.spent(this.day()); }
  context(query) { return publicContext(this.store.value, query); }
  start() {
    this.timer = setInterval(() => { void this.tick().catch(error => { this.lastError = cleanError(error); this.log('社交后台：', this.lastError); }); }, 15000);
    this.timer.unref?.(); return this;
  }
  yieldToForeground() { if (this.controller && !this.committing) this.controller.abort(fault('FOREGROUND', 'QQ 前台优先')); }
  async stop() { this.closing = true; clearInterval(this.timer); this.controller?.abort(fault('PAUSED', '服务关闭')); await this.running?.catch(() => {}); }
  checkpoint(task) {
    this.controller?.signal.throwIfAborted();
    const c = this.reload(), now = localParts(new Date(), c.timeZone), controls = readJson(path.join(c.dataRoot, 'controls.json'), { cancelDraftIds: [] });
    if (!c.enabled || (task.kind === 'browse' ? c.browsePaused : c.publishPaused && task.status !== 'confirming')) throw fault('PAUSED', '对应任务已暂停');
    if (controls.cancelDraftIds.includes(task.id)) throw fault('CANCELLED', '待发草稿已取消');
    if (!inWindow(now.time, c.window)) throw fault('PAUSED', '等待允许的后台时段');
    if (this.isForegroundBusy()) throw fault('FOREGROUND', 'QQ 前台优先');
    if (task.elapsedMs + Date.now() - this.startedAt >= c.limits.taskMinutes * 60000) throw fault('BUDGET', '任务已达到15分钟累计执行上限');
  }
  addTask(kind, period, account = null, retrySlot = false) {
    const id = 'social_' + hash([this.config.botId, kind, period, account ? accountKey(account) : 'all']).slice(0, 28);
    if (!this.store.value.tasks[id]) this.store.value.tasks[id] = { id, botId: this.config.botId, kind, period, accountKey: account ? accountKey(account) : null,
      status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), elapsedMs: 0, networkAttempts: 0, retrySlot, sources: [], accountProgress: {} };
    return this.store.value.tasks[id];
  }
  schedule() {
    const c = this.config, now = localParts(new Date(), c.timeZone), week = weekOf(now.day), tasks = Object.values(this.store.value.tasks);
    const cancelled = readJson(path.join(c.dataRoot, 'controls.json'), { cancelDraftIds: [] }).cancelDraftIds;
    for (const t of tasks) {
      if (cancelled.includes(t.id) && !terminal(t.status) && t.status !== 'confirming') { transition(t, 'cancelled', { reason: '管理员取消未提交草稿' }); continue; }
      if (t.kind === 'browse' && t.period < now.day && !terminal(t.status) && t.status !== 'confirming') transition(t, 'cancelled', { reason: '仅补当日一次，不追赶历史天数' });
      if (t.kind === 'publish' && t.period < week && !terminal(t.status) && t.status !== 'confirming') transition(t, 'cancelled', { reason: '自然周已结束，旧稿留档，不自动移到下周重发' });
    }
    if (inWindow(now.time, c.window) && now.time >= c.browseAt && !c.browsePaused) this.addTask('browse', now.day);
    const primary = now.weekday === c.publish.weekday && now.time >= c.publish.at;
    const retry = now.weekday === c.publish.retryWeekday && now.time >= c.publish.retryAt;
    if (inWindow(now.time, c.window) && !c.publishPaused && (primary || retry)) for (const a of c.accounts.filter(a => a.enabled && a.ownerAuthorized && a.accountId)) {
      const t = this.addTask('publish', week, a, retry);
      if (retry && t.status === 'failed' && !t.retryConsumed) { t.retryConsumed = true; transition(t, 'pending', { reason: '本周一次固定补发机会', networkAttempts: 0 }); }
    }
    this.store.prune(Date.now(), c.limits);
  }
  async tick() {
    if (this.busy || this.closing) return;
    this.reload(); if (!this.config.enabled) return;
    const release = acquireLock(path.join(this.config.dataRoot, 'locks'), 'worker:' + this.config.botId);
    if (!release) return;
    this.busy = true;
    try {
      this.store.reload();
      for (const t of Object.values(this.store.value.tasks)) if (t.status === 'running') {
        transition(t, t.kind === 'publish' && t.publishIntent ? 'pending' : 'pending', { reason: '服务重启，按持久化进度恢复' });
      }
      const beforeSchedule = hash(this.store.value);
      this.schedule(); if (hash(this.store.value) !== beforeSchedule) this.store.save();
      if (this.isForegroundBusy() || !inWindow(localParts(new Date(), this.config.timeZone).time, this.config.window)) return;
      await this.flushReports();
      const candidates = Object.values(this.store.value.tasks).filter(t => !terminal(t.status) &&
        (t.status !== 'failed' || t.retryAt && Date.parse(t.retryAt) <= Date.now()) && (!t.retryAt || Date.parse(t.retryAt) <= Date.now()));
      candidates.sort((a, b) => (a.status === 'confirming' ? -1 : b.status === 'confirming' ? 1 : a.kind === 'browse' ? -1 : 1));
      const task = candidates.find(t => !(t.kind === 'browse' ? this.config.browsePaused : this.config.publishPaused) || t.status === 'confirming');
      if (!task) return;
      this.running = this.run(task); await this.running;
    } finally { this.busy = false; release(); }
  }
  async flushReports() {
    if (!this.notifyAdmin || this.isForegroundBusy()) return;
    const reports = this.store.value.reports.filter(r => !r.noticeState && !r.acknowledgedAt);
    const byDay = this.store.value.reports.filter(r => r.noticeState && localParts(new Date(r.at), this.config.timeZone).day === this.day());
    if (!reports.length || byDay.length >= 2) return;
    const selected = reports.slice(-3);
    for (const r of selected) r.noticeState = 'delivery_intent_saved'; this.store.save();
    try {
      const delivered = await this.notifyAdmin({ botName: this.config.botName, reports: selected.map(r => ({ code: r.code, taskId: r.taskId, message: r.message })) });
      for (const r of selected) r.noticeState = delivered ? 'delivered' : 'uncertain_no_automatic_resend';
    } catch { for (const r of selected) r.noticeState = 'uncertain_no_automatic_resend'; }
    this.store.save();
  }
  async run(task) {
    this.currentTask = task; this.controller = new AbortController(); this.startedAt = Date.now(); this.committing = false;
    const deadline = setTimeout(() => this.controller?.abort(fault('BUDGET', '任务时间上限')), Math.max(1, this.config.limits.taskMinutes * 60000 - task.elapsedMs));
    const priority = setInterval(() => { if (this.isForegroundBusy()) this.yieldToForeground(); }, 500);
    try {
      this.checkpoint(task);
      if (task.status !== 'confirming' && task.status !== 'draft_complete' && task.status !== 'pending_publish') transition(task, 'running');
      this.store.save();
      if (task.kind === 'browse') await this.browse(task); else await this.publish(task);
    } catch (error) {
      const reason = cleanError(error); task.reason = reason; task.code = error.code || 'FAILED';
      if (task.status === 'confirming') {
        // An intent may already have reached the platform. Never turn it into a retryable publish.
        this.store.report(task, 'UNCERTAIN', reason); task.retryAt = new Date(Date.now() + 30 * 60000).toISOString();
      } else if (error.code === 'CANCELLED') transition(task, 'cancelled', { reason });
      else if (['FOREGROUND', 'PAUSED', 'DEFERRED'].includes(error.code)) {
        if (task.status === 'running') transition(task, 'pending', { reason });
        task.retryAt = new Date(Date.now() + 60000).toISOString();
      } else if (error.code === 'NETWORK' && ++task.networkAttempts <= 3) {
        if (task.status === 'running') transition(task, 'pending', { reason });
        task.retryAt = new Date(Date.now() + [60000, 300000, 900000][task.networkAttempts - 1]).toISOString();
      } else {
        transition(task, 'failed', { reason, retryAt: null }); this.store.report(task, error.code || 'FAILED', reason);
      }
      this.log('社交任务 ' + task.id + '：' + reason);
    } finally {
      clearTimeout(deadline); clearInterval(priority);
      task.elapsedMs += Date.now() - this.startedAt; this.currentTask = null; this.controller = null; this.committing = false; this.store.save();
    }
  }
  async callModel(task, prompt) {
    this.checkpoint(task); const c = this.config, state = this.store.value, day = this.day(), week = weekOf(day);
    if (!c.billing.known) throw fault('BILLING_UNKNOWN', '模型计费尚未核定');
    const included = c.billing.mode === 'subscription_quota' && c.billing.extraCredits === false;
    if (Buffer.byteLength(prompt, 'utf8') + 4000 > c.limits.inputTokensPerCall) throw fault('BUDGET', '本次资料输入超过保守输入预算');
    const today = state.ledger.filter(r => r.day === day);
    if (today.some(r => r.chargedCny > r.reservedCny)) throw fault('BUDGET', '今日已有费用超出预留，停止新增请求');
    if (today.length >= c.limits.modelCallsPerDay) throw fault('BUDGET', '今日模型请求上限已用完');
    const reserve = included ? 0 : (c.limits.inputTokensPerCall * c.billing.inputPerMillion + c.limits.outputTokensPerCall * c.billing.outputPerMillion) / 1e6;
    const other = await this.otherBackgroundSpent();
    if (!included && (this.store.spent(day) + reserve > c.budget.dailyCny || this.store.spent(day, week) + reserve > c.budget.weeklyCny ||
      other + this.store.spent(day) + reserve > c.budget.sharedBackgroundDailyCny)) throw fault('BUDGET', '费用预留超过每日、每周或共享后台预算');
    const row = { id: 'charge_' + hash([task.id, state.ledger.length, Date.now()]).slice(0, 24), taskId: task.id, day,
      at: new Date().toISOString(), billing: included ? 'included_subscription_no_extra_credits' : 'metered',
      reservedCny: reserve, chargedCny: reserve, actualCny: null, estimatedCny: null, costBasis: included ? 'included_subscription_request_counter' : 'configured_rates_times_reported_usage', status: 'reserved', tokenHardCap: !included };
    state.ledger.push(row); this.store.save();
    try {
      const result = await this.model(prompt, { signal: this.controller.signal, maxTokens: c.limits.outputTokensPerCall,
        maxOutputChars: c.limits.outputCharsPerCall, subscriptionOnly: included, taskId: task.id });
      row.usage = result.usage || null;
      row.estimatedCny = included ? null : Math.max(0, Number(result.costCny ?? reserve));
      row.chargedCny = included ? 0 : row.estimatedCny; row.status = 'completed'; row.completedAt = new Date().toISOString();
      if (!included && row.chargedCny > reserve) this.store.report(task, 'COST_OVERRUN', '本次实际费用超过保守预留，今日停止新增社交模型任务');
      this.store.save();
      if (text(result.text, c.limits.outputCharsPerCall + 1).length > c.limits.outputCharsPerCall) throw fault('INVALID_RESULT', '模型文本超出上限');
      this.checkpoint(task);
      return JSON.parse(String(result.text || '').trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, ''));
    } catch (error) {
      if (row.status === 'reserved') { row.status = 'uncertain_charged_at_reservation'; row.reason = error.code || 'MODEL_FAILED'; this.store.save(); }
      if (error instanceof SyntaxError) throw fault('INVALID_RESULT', '模型没有返回完整 JSON');
      throw error;
    }
  }
  async ensurePlan(task) {
    if (task.plan) return;
    const seeds = (await this.seedTopics()).map(safeTopic).filter(Boolean).slice(0, 6);
    const result = await this.callModel(task, planningPrompt(this.config.botName, interestView(this.store.value.interests).slice(-6), seeds));
    if (!Array.isArray(result.queries) || result.queries.length > 2 || result.queries.filter(q => q.exploration).length > 1) throw fault('INVALID_RESULT', '选题格式无效');
    task.plan = { reason: text(result.reason, 300), queries: result.queries.map(q => ({ topic: safeTopic(q.topic), question: text(q.question, 120), exploration: q.exploration === true })).filter(q => q.topic) };
    this.store.save();
  }
  async withAccount(account, fn, mode = 'publish') {
    const savedConnection = readJson(path.join(this.shared(account).root, 'connection.json'), {});
    if (savedConnection[mode]?.status === 'paused') throw fault(savedConnection[mode].code || 'AUTH_REQUIRED', savedConnection[mode].reason || '对应平台任务已暂停，请重新检查登录');
    const release = acquireLock(path.join(this.config.sharedRoot, 'locks'), 'account:' + accountKey(account));
    if (!release) throw fault('FOREGROUND', '共享账号正在被另一个机器人或登录操作使用');
    let browser;
    try { browser = await Browser.open(this.config, account, { signal: this.controller?.signal }); return await fn(platformFor(browser, account), browser); }
    catch (error) {
      if (gates.has(error.code)) {
        const file = path.join(this.shared(account).root, 'connection.json'), connection = readJson(file, {});
        connection[mode] = { status: 'paused', code: error.code, reason: cleanError(error), at: new Date().toISOString() }; atomic(file, connection);
      }
      throw error;
    }
    finally { await browser?.close(); release(); }
  }
  async browse(task) {
    const accounts = this.config.accounts.filter(a => a.enabled && a.ownerAuthorized && a.accountId);
    if (!accounts.length) throw fault('CONFIG', '尚无明确绑定的账号');
    if (accounts.every(a => readJson(path.join(this.shared(a).root, 'connection.json'), {}).browse?.status === 'paused')) throw fault('AUTH_REQUIRED', '浏览端已暂停，需用户完成登录并检查连接');
    await this.ensurePlan(task);
    for (const a of accounts) {
      if (task.accountProgress[accountKey(a)] === 'done') continue;
      await this.withAccount(a, async api => {
        const connection = await api.verifyConsumer(); this.store.value.connections[accountKey(a)] = { ...this.store.value.connections[accountKey(a)], browse: { status: 'ready', ...connection } };
        await this.collect(task, a, api);
      }, 'browse');
      task.accountProgress[accountKey(a)] = 'done'; this.store.save();
    }
    if (!task.analyzed && task.sources.filter(sourceValid).length) {
      const own = this.store.value;
      const result = await this.callModel(task, readingPrompt(task.sources.filter(sourceValid), active(own.memories).slice(-6), active(own.interests).slice(-6)));
      task.readingResult = commitReading(own, task, result, task.sources, this.config.limits); task.analyzed = true;
    }
    transition(task, 'succeeded', { result: { actuallyRead: task.sources.filter(s => !s.unavailable).length, unavailable: task.sources.filter(s => s.unavailable).length,
      selectedMemories: task.readingResult?.memories || 0, interestChanges: task.readingResult?.interests || 0, reason: task.sources.length ? '按实际读取范围完成' : '没有合适选题或可读取材料，允许提前结束' } });
    task.retryAt = null;
  }
  async collect(task, account, api, targeted = false) {
    const state = this.store.value, today = this.day(), max = this.config.limits.itemsPerPlatform;
    const shared = this.shared(account).value;
    const alreadyToday = state.seen.filter(s => s.day === today && s.platform === account.platform).length;
    let remaining = Math.max(0, max - alreadyToday), bad = 0;
    if (targeted) remaining = Math.min(3, remaining);
    for (const query of task.plan?.queries || []) {
      if (!remaining) break;
      this.checkpoint(task);
      const rows = await api.search(query.topic + ' ' + query.question, remaining);
      for (const row of rows) {
        this.checkpoint(task);
        const id = row.originalUrl.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)?.[1];
        if (!id || state.seen.some(s => s.platform === account.platform && s.contentId === id)) { if (++bad >= 3) break; continue; }
        const source = await api.read(row, query.topic, shared.posts);
        const duplicate = state.seen.find(s => s.fingerprint === source.fingerprint || s.preview && similar(s.preview, source.excerpt));
        source.originKey = duplicate?.originKey || source.fingerprint;
        if (duplicate || source.origin === 'self') { source.unavailable = true; source.unavailableReason = duplicate ? 'same_or_reposted_evidence' : 'own_account_content'; }
        task.sources.push(source);
        state.seen.push({ platform: source.platform, contentId: source.contentId, at: source.fetchedAt, day: today, taskId: task.id,
          fingerprint: source.fingerprint, originKey: source.originKey, author: source.author, preview: source.excerpt.slice(0, 400), unavailable: !!source.unavailable });
        this.store.save(); remaining--;
        bad = source.unavailable || !source.excerpt ? bad + 1 : 0;
        if (bad >= 3 || !remaining) break;
      }
      if (bad >= 3) break;
    }
  }
  async publish(task) {
    const account = this.config.accounts.find(a => accountKey(a) === task.accountKey && a.enabled && a.ownerAuthorized);
    if (!account) throw fault('CONFIG', '发布账号绑定已撤销');
    const rotation = this.config.publish.creatorRotation || ['deepseek', 'gemini'];
    const preferred = rotation[Math.abs(Math.floor(Date.parse(task.period + 'T00:00:00Z') / 604800000)) % rotation.length];
    const clock = localParts(new Date(), this.config.timeZone);
    if (task.status !== 'confirming' && preferred !== this.config.botId && clock.time < (this.config.publish.fallbackAfter || '21:40')) throw fault('DEFERRED', '本周优先由另一位创作者完成；21:40后可接替未完成的共享配额');
    await this.withAccount(account, async (api, browser) => {
      let shared = this.shared(account);
      const uncertain = shared.value.attempts.find(a => a.stage === 'confirming');
      if (uncertain && uncertain.taskId !== task.id) throw fault('UNCERTAIN', '共用账号有发布结果待确认，暂停新帖子');
      if (shared.value.posts.some(p => p.week === task.period && p.timeZone === this.config.timeZone)) {
        transition(task, 'succeeded', { result: { sharedQuotaSatisfied: true, posts: shared.value.posts.filter(p => p.week === task.period).map(p => ({ creator: p.creator, url: p.url })) } }); return;
      }
      if (task.status === 'confirming' || uncertain?.taskId === task.id) {
        if (task.status !== 'confirming') transition(task, 'confirming');
        await this.confirm(task, api, shared); return;
      }
      await api.capability();
      if (!task.draft) {
        const recentReadCache = Object.values(this.store.value.tasks).filter(t => t.kind === 'browse' && Date.parse(t.updatedAt) > Date.now() - this.config.limits.notesKeepDays * 86400000).flatMap(t => t.sources || []);
        let sources = [...task.sources, ...recentReadCache, ...this.store.value.notes.flatMap(n => n.sources || []), ...active(this.store.value.memories).flatMap(m => m.sources || [])];
        sources = [...new Map(sources.filter(sourceValid).map(s => [s.id, s])).values()].sort((a,b)=>Date.parse(a.fetchedAt)-Date.parse(b.fetchedAt)).slice(-4);
        if (!sources.length && !task.targetedAttempted) {
          await this.ensurePlan(task); await api.verifyConsumer();
          task.targetedAttempted = true; this.store.save(); await this.collect(task, account, api, true);
          sources = task.sources.filter(sourceValid);
        }
        if (!sources.length) throw fault('NO_MATERIAL', '当周缺乏合格公开素材；定向阅读也没有可用内容');
        const result = await this.callModel(task, draftingPrompt(this.config.botName, sources, interestView(this.store.value.interests), shared.value.posts.slice(-4).map(p => ({ topic: p.topic, summary: p.comparisonText.slice(0, 160) }))));
        const draft = validateDraft(result, sources, shared.value.posts, this.config);
        if (!draft) throw fault('NO_MATERIAL', '创作者判断本周素材不足以形成有价值原创内容');
        this.checkpoint(task); task.draft = await renderAssets(browser, this.config, task, draft);
        transition(task, 'draft_complete'); this.store.save(); transition(task, 'pending_publish'); this.store.save();
      } else if (task.status === 'running') transition(task, 'draft_complete');
      if (task.status === 'draft_complete') transition(task, 'pending_publish');
      this.checkpoint(task);
      await api.prepare(task.draft); this.checkpoint(task);
      shared = this.shared(account);
      if (shared.value.posts.some(p => p.week === task.period) || shared.value.attempts.some(a => a.stage === 'confirming')) throw fault('UNCERTAIN', '共享账号的发布状态已变化，重新核对');
      const intent = { taskId: task.id, creator: this.config.botId, accountId: account.accountId, platform: account.platform, timeZone: this.config.timeZone,
        week: task.period, fingerprint: task.draft.fingerprint, materialFingerprint: task.draft.materialFingerprint, title: task.draft.title,
        submittedAt: new Date().toISOString(), stage: 'confirming' };
      shared.value.attempts.push(intent); atomic(shared.file, shared.value);
      task.publishIntent = intent; transition(task, 'confirming'); this.store.save();
      this.committing = true;
      try { task.submitResponse = await api.submit(); this.store.save(); }
      catch (error) {
        if (error.code === 'CAPABILITY_UNAVAILABLE') { intent.stage = 'not_submitted'; atomic(shared.file, shared.value); transition(task, 'failed', { reason: cleanError(error) }); }
        throw error;
      } finally { this.committing = false; }
      await this.confirm(task, api, shared);
    });
  }
  async confirm(task, api, shared) {
    if (!task.draft || !task.publishIntent) throw fault('UNCERTAIN', '缺少原始不可变草稿或发布意图，不重发');
    const receipt = await api.confirm(task.draft, task.publishIntent.submittedAt);
    if (!receipt.confirmed) { task.retryAt = new Date(Date.now() + 30 * 60000).toISOString(); this.store.report(task, 'UNCERTAIN', '已发布列表尚未提供可核对的帖子ID与发布时间，未计入配额，不重发'); return; }
    const confirmedWeek = weekOf(localParts(new Date(receipt.confirmedAt), this.config.timeZone).day);
    const attemptWeek = weekOf(localParts(new Date(task.publishIntent.submittedAt), this.config.timeZone).day);
    const post = { ...receipt, accountId: shared.value.accountId, platform: shared.value.platform, timeZone: this.config.timeZone,
      week: receipt.publishedAtUTC ? weekOf(localParts(new Date(receipt.publishedAtUTC), this.config.timeZone).day) : confirmedWeek === attemptWeek ? confirmedWeek : null, weekBasis: receipt.publishedAtUTC ? 'official_ui_response_timestamp' : confirmedWeek === attemptWeek ? 'submission_and_confirmation_in_same_natural_week' : 'needs_exact_platform_timestamp',
      publishedAt: receipt.publishedAtUTC || receipt.publishedAtRaw, publishedAtBasis: receipt.publishedAtUTC ? 'official_ui_response_timestamp' : 'platform_displayed_raw_time_timezone_unspecified',
      taskId: task.id, creator: this.config.botId, topic: task.draft.topic, fingerprint: task.draft.fingerprint, materialFingerprint: task.draft.materialFingerprint,
      comparisonText: task.draft.comparisonText };
    const current = this.shared({ platform: shared.value.platform, accountId: shared.value.accountId });
    if (!current.value.posts.some(p => p.postId === post.postId)) current.value.posts.push(post);
    const attempt = current.value.attempts.find(a => a.taskId === task.id); if (attempt) attempt.stage = 'confirmed';
    atomic(current.file, current.value);
    transition(task, 'succeeded', { result: { postId: post.postId, url: post.url, creator: post.creator, publishedAt: post.publishedAt, week: post.week }, retryAt: null });
  }
  async status() {
    const c = this.config, now = new Date(), day = localParts(now, c.timeZone).day;
    return { botId: c.botId, botName: c.botName, enabled: c.enabled, busy: this.busy, timeZone: c.timeZone, window: c.window,
      schedule: { browse: { at: c.browseAt, next: nextSlot(now, c.timeZone, c.browseAt) },
        publish: { weekday: c.publish.weekday, at: c.publish.at, next: nextSlot(now, c.timeZone, c.publish.at, c.publish.weekday) },
        retry: { weekday: c.publish.retryWeekday, at: c.publish.retryAt, next: nextSlot(now, c.timeZone, c.publish.retryAt, c.publish.retryWeekday) } },
      switches: { browsePaused: c.browsePaused, publishPaused: c.publishPaused },
      budget: { ...c.budget, billing: c.billing.mode || 'metered', extraCredits: c.billing.extraCredits ?? null,
        chargedTodayCny: this.store.spent(day), modelCallsToday: this.store.value.ledger.filter(r => r.day === day).length, limits: c.limits,
        tokenHardCapSupported: c.billing.mode !== 'subscription_quota', subscriptionActualCny: c.billing.mode === 'subscription_quota' ? null : undefined },
      interests: interestView(this.store.value.interests), memories: active(this.store.value.memories),
      interestHistory: this.store.value.interests.slice(-30), memoryHistory: this.store.value.memories.slice(-30),
      tasks: Object.values(this.store.value.tasks).slice(-40).reverse().map(({ sources, plan, history, ...t }) => ({ ...t, actualSourceCount: sources?.length || 0, plan, history: history?.slice(-8) })),
      accounts: c.accounts.map(a => ({ platform: a.platform, accountId: a.accountId, enabled: a.enabled, ...this.store.value.connections[accountKey(a)],
        ...readJson(path.join(this.shared(a).root, 'connection.json'), {}), posts: this.shared(a).value.posts.slice(-15) })),
      reports: this.store.value.reports.filter(r => !r.acknowledgedAt).slice(-30), lastError: this.lastError };
  }
  async inspectAccounts() {
    if (this.busy) throw fault('FOREGROUND', '后台正在运行，请空闲时检查连接');
    const release = acquireLock(path.join(this.config.dataRoot, 'locks'), 'worker:' + this.config.botId);
    if (!release) throw fault('FOREGROUND', '服务正在保存状态');
    this.busy = true; const results = [];
    try {
      for (const a of this.config.accounts.filter(a => a.enabled && a.ownerAuthorized)) {
        const unlock = acquireLock(path.join(this.config.sharedRoot, 'locks'), 'account:' + accountKey(a));
        if (!unlock) throw fault('FOREGROUND', '共享账号正在使用');
        let browser; const result = { accountId: a.accountId, platform: a.platform };
        try {
          browser = await Browser.open(this.config, a); const api = platformFor(browser, a);
          for (const [mode, check] of [['browse', () => api.verifyConsumer()], ['publish', () => api.capability()]]) {
            try { result[mode] = { status: 'ready', ...await check() }; }
            catch (error) { result[mode] = { status: 'paused', code: error.code, reason: cleanError(error), at: new Date().toISOString() }; }
          }
          atomic(path.join(this.shared(a).root, 'connection.json'), result); results.push(result);
        } finally { await browser?.close(); unlock(); }
      }
      return { ok: true, accounts: results };
    } finally { this.busy = false; release(); }
  }
  async control(command) {
    if (command.action === 'check-connection') return this.inspectAccounts();
    const release = acquireLock(path.join(this.config.dataRoot, 'locks'), 'admin');
    if (!release) throw fault('FOREGROUND', '另一个管理操作正在保存');
    try {
      const c = readJson(this.configFile), name = command.action;
      if (['pause-browse', 'resume-browse', 'pause-publish', 'resume-publish'].includes(name)) {
        c[name.endsWith('browse') ? 'browsePaused' : 'publishPaused'] = name.startsWith('pause'); atomic(this.configFile, c);
        if (name.startsWith('pause') && this.currentTask?.kind === (name.endsWith('browse') ? 'browse' : 'publish')) this.controller?.abort(fault('PAUSED', '管理员暂停了对应任务'));
      } else if (name === 'budget') {
        for (const key of ['dailyCny', 'weeklyCny', 'sharedBackgroundDailyCny']) if (command[key] !== undefined) {
          if (!Number.isFinite(command[key]) || command[key] < 0 || command[key] > 100) throw fault('CONFIG', '预算应在0至100元之间'); c.budget[key] = command[key];
        }
        atomic(this.configFile, c);
      } else if (name === 'cancel-draft') {
        const t = this.store.value.tasks[command.taskId];
        if (!t || t.kind !== 'publish' || ['confirming', 'succeeded'].includes(t.status)) throw fault('CONFIG', '只能取消尚未提交发布的草稿；结果待确认的帖子必须先核对');
        const file = path.join(this.config.dataRoot, 'controls.json'), controls = readJson(file, { cancelDraftIds: [] });
        if (!controls.cancelDraftIds.includes(t.id)) controls.cancelDraftIds.push(t.id);
        atomic(file, controls); if (this.currentTask?.id === t.id) this.controller?.abort(fault('CANCELLED', '管理员取消待发草稿'));
      } else throw fault('CONFIG', '未知管理操作');
      this.reload(); return { ok: true };
    } finally { release(); }
  }
}
