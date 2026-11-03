import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir, dPath, hash, fault, wait, stamp } from './io.mjs';

class Cdp {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map();
    ws.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      const row = this.pending.get(message.id);
      if (row) { this.pending.delete(message.id); clearTimeout(row.timer); if (message.error) row.reject(fault('BROWSER', '浏览器操作未完成')); else row.resolve(message.result); }
    });
    ws.addEventListener('close', () => { for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(fault('NETWORK', '浏览器连接中断')); } this.pending.clear(); });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(fault('NETWORK', '连接浏览器超时')); }, 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(fault('NETWORK', '浏览器连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(fault('NETWORK', '浏览器操作超时')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(fault('NETWORK', '浏览器已断开')); }
    });
  }
  close() { this.ws.close(); }
}
export function profileFor(config, account) {
  return dPath(path.join(config.sharedRoot, 'profiles', account.platform + '-' + hash(account.accountId || config.botId + '-unbound').slice(0, 20)));
}
export class Browser {
  static async open(config, account, { visible = false, signal } = {}) {
    const profile = mkdir(profileFor(config, account)), portFile = path.join(profile, 'DevToolsActivePort');
    let connection, started = false;
    async function attach() {
      try {
        const [port] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        if (!/^\d+$/.test(port)) return;
        const response = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
        const info = await response.json();
        if (!info.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:' + port + '/')) return;
        const conn = await Cdp.connect(info.webSocketDebuggerUrl);
        const { arguments: args } = await conn.call('Browser.getBrowserCommandLine');
        if (!args.includes('--user-data-dir=' + profile)) { conn.close(); throw fault('ACCOUNT_MISMATCH', '浏览器资料目录不符'); }
        return conn;
      } catch (error) { if (error.code === 'ACCOUNT_MISMATCH') throw error; return undefined; }
    }
    connection = await attach();
    if (!connection) {
      signal?.throwIfAborted();
      const temp = mkdir(path.join(profile, '.tmp')), osHome = mkdir(path.join(profile, '.os-home'));
      const output = fs.openSync(dPath(path.join(profile, 'browser.log')), 'a');
      const args = ['--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
        '--enable-automation', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        '--disable-component-update', '--disable-breakpad', '--disable-crash-reporter', '--disable-sync',
        '--disk-cache-dir=' + mkdir(path.join(profile, 'cache')), '--window-size=1280,900'];
      if (!visible) args.push('--headless=new', '--mute-audio');
      args.push('about:blank');
      const child = spawn(config.browser.executable, args, { cwd: profile, detached: true, windowsHide: !visible,
        env: { ...process.env, TEMP: temp, TMP: temp, USERPROFILE: osHome, HOME: osHome,
          APPDATA: mkdir(path.join(osHome, 'AppData', 'Roaming')), LOCALAPPDATA: mkdir(path.join(osHome, 'AppData', 'Local')), NODE_DISABLE_COMPILE_CACHE: '1' },
        stdio: ['ignore', output, output] });
      fs.closeSync(output); child.unref(); child.on('error', () => {});
      for (let n = 0; n < 35 && !connection; n++) { await wait(300, signal); connection = await attach(); }
      if (!connection) throw fault('NETWORK', '独立浏览器未就绪'); started = true;
    }
    const { targetId } = await connection.call('Target.createTarget', { url: 'about:blank' });
    const [port] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
    const target = pages.find(t => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) { connection.close(); throw fault('NETWORK', '无法建立浏览标签页'); }
    const page = await Cdp.connect(target.webSocketDebuggerUrl);
    await page.call('Page.enable'); await page.call('DOM.enable');
    return new Browser({ connection, page, targetId, started, profile, signal });
  }
  constructor(options) { Object.assign(this, options); }
  async evaluate(expression) {
    this.signal?.throwIfAborted();
    const result = await this.page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw fault('BROWSER', '页面结构已变化，操作停止');
    return result.result?.value;
  }
  run(fn, ...args) { return this.evaluate('(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')'); }
  async navigate(url) {
    const u = new URL(url), hosts = ['xiaohongshu.com', 'www.xiaohongshu.com', 'creator.xiaohongshu.com', 'www.douyin.com', 'creator.douyin.com'];
    if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw fault('PATH_DENIED', '只允许明确的平台页面');
    this.signal?.throwIfAborted(); await this.page.call('Page.navigate', { url: u.href });
    for (let n = 0; n < 24; n++) { await wait(350, this.signal); if (await this.evaluate("document.readyState === 'complete'")) break; }
    for (let n = 0; n < 24; n++) { if (await this.evaluate('(document.body?.innerText || \'\').trim().length > 30')) break; await wait(500, this.signal); }
    await wait(1200, this.signal);
    const final = new URL(await this.evaluate('location.href'));
    if (!hosts.includes(final.hostname)) throw fault('AUTH_REQUIRED', '页面离开平台，停止执行');
  }
  snapshot() {
    return this.run(() => {
      const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const fields = [...document.querySelectorAll('input,textarea,[contenteditable=true],[role=textbox]')].map(e => ({
        tag: e.tagName, type: e.type || '', accept: e.accept || '', multiple: !!e.multiple,
        placeholder: e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || '', label: e.getAttribute('aria-label') || '', visible: visible(e) }));
      const controls = [...document.querySelectorAll('button,[role=button],a,label')].filter(visible).map(e => ({
        text: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 100), href: e.href || ''
      })).filter(e => e.text || e.href).slice(0, 180);
      return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 18000), fields, controls };
    });
  }
  clickLabel(labels) {
    return this.run(labels => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const els = [...document.querySelectorAll('button,[role=button],a,label,span,div')].filter(e => visible(e) && !e.disabled &&
        e.getAttribute('aria-disabled') !== 'true' && labels.includes((e.innerText || e.getAttribute('aria-label') || '').trim()));
      const leaf = els.filter(e => !els.some(o => o !== e && e.contains(o)));
      if (leaf.length !== 1) return false; leaf[0].click(); return true;
    }, labels);
  }
  async fill(kind, value) {
    const result = await this.run((kind, value) => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const els = [...document.querySelectorAll('input:not([type=file]),textarea,[contenteditable=true],[role=textbox]')].filter(visible);
      const candidates = els.filter(e => kind === 'title' ? /标题/.test([e.placeholder, e.getAttribute('data-placeholder'), e.getAttribute('aria-label')].join(' ')) :
        (e.isContentEditable || /正文|描述|简介|分享|内容/.test([e.placeholder, e.getAttribute('data-placeholder'), e.getAttribute('aria-label')].join(' '))) && !/标题/.test(e.placeholder || ''));
      if (candidates.length !== 1) return false;
      const e = candidates[0]; e.focus();
      if (e.isContentEditable) { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); }
      else {
        const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
        e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return (e.value || e.innerText || '').replace(/\s/g, '') === value.replace(/\s/g, '');
    }, kind, value);
    if (!result) throw fault('CAPABILITY_UNAVAILABLE', '编辑区域无法唯一定位或输入未确认');
  }
  async upload(files) {
    const { root } = await this.page.call('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await this.page.call('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    const candidates = [];
    for (const nodeId of nodeIds) {
      const { attributes = [] } = await this.page.call('DOM.getAttributes', { nodeId });
      const pairs = Object.fromEntries(Array.from({ length: attributes.length / 2 }, (_, i) => [attributes[i * 2], attributes[i * 2 + 1]]));
      if (/image|png|jpg|jpeg/.test(pairs.accept || '')) candidates.push(nodeId);
    }
    if (candidates.length !== 1) throw fault('CAPABILITY_UNAVAILABLE', '没有唯一且支持图片的上传入口');
    for (const file of files) { dPath(file); if (!fs.statSync(file).isFile()) throw fault('PATH_DENIED', '素材不存在'); }
    await this.page.call('DOM.setFileInputFiles', { nodeId: candidates[0], files }); await wait(3500, this.signal);
  }
  async png(html, file) {
    await this.page.call('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1440, deviceScaleFactor: 1, mobile: false });
    const { frameTree } = await this.page.call('Page.getFrameTree');
    await this.page.call('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await wait(250, this.signal);
    const fits = await this.run(() => { const main=document.querySelector('main'), footer=document.querySelector('footer'); return !!main && !!footer && main.getBoundingClientRect().bottom < footer.getBoundingClientRect().top - 14; });
    if (!fits) throw fault('INVALID_RESULT', '原创图解文字溢出，保留草稿并停止发布');
    const result = await this.page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const target = dPath(file), temporary = dPath(file + '.' + stamp() + '.pending');
    if (fs.existsSync(target)) throw fault('STATE_UNREADABLE', '不可覆盖已存在的不可变图解');
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, Buffer.from(result.data, 'base64')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
  }
  async captureNoteResponses() {
    if (this.noteResponseListener) this.page.ws.removeEventListener('message', this.noteResponseListener);
    this.noteResponses = []; const requests = new Set();
    this.noteResponseListener = async event => {
      let m; try { m = JSON.parse(String(event.data)); } catch { return; }
      if (m.method === 'Network.responseReceived') {
        const r = m.params.response; let u; try { u = new URL(r.url); } catch { return; }
        if (u.hostname === 'creator.xiaohongshu.com' && r.status === 200 && /json/i.test(r.mimeType) && /note|publish|manage/i.test(u.pathname)) requests.add(m.params.requestId);
      }
      if (m.method !== 'Network.loadingFinished' || !requests.delete(m.params.requestId)) return;
      try {
        const r = await this.page.call('Network.getResponseBody', { requestId: m.params.requestId });
        if (r.base64Encoded || r.body.length > 512000) return;
        const data = JSON.parse(r.body); let visited = 0;
        const walk = value => {
          if (!value || typeof value !== 'object' || ++visited > 6000) return;
          if (!Array.isArray(value)) {
            const id = String(value.note_id || value.noteId || value.id || ''), title = value.title || value.display_title;
            const t = value.publish_time || value.publishTime;
            const ms = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
            if (/^[0-9a-f]{24}$/i.test(id) && typeof title === 'string' && ms > 1577836800000 && ms < Date.now() + 60000) this.noteResponses.push({ postId: id, title, publishedAtUTC: new Date(ms).toISOString() });
          }
          for (const v of Object.values(value)) if (typeof v === 'object') walk(v);
        }; walk(data);
      } catch { /* UI JSON is optional evidence; a timeout must not authorize a retry. */ }
    };
    this.page.ws.addEventListener('message', this.noteResponseListener);
    await this.page.call('Network.enable', { maxTotalBufferSize: 4194304, maxResourceBufferSize: 1048576 });
  }
  async close({ keepOpen = false } = {}) {
    if (keepOpen) { this.page.close(); this.connection.close(); return; }
    try { await this.connection.call(this.started ? 'Browser.close' : 'Target.closeTarget', this.started ? {} : { targetId: this.targetId }); } catch {}
    this.page.close(); this.connection.close();
  }
}
