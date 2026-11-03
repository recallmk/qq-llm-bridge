import { hash, fault, wait, text } from './io.mjs';
import { normalize } from './memory.mjs';

const CREATOR = 'https://creator.xiaohongshu.com/';
const PUBLISH = 'https://creator.xiaohongshu.com/publish/publish?from=homepage&target=image';
const MANAGER = 'https://creator.xiaohongshu.com/new/note-manager';
const CONSUMER = 'https://www.xiaohongshu.com/';
export function detectGate(snapshot) {
  if (/请完成(?:安全)?验证|拖动.*滑块|验证码验证|访问频次异常|操作频繁|安全验证中/.test(snapshot.text)) throw fault('CHALLENGE', '平台要求用户完成验证');
  if (/\/login(?:[/?]|$)/.test(snapshot.url) || /短信登录|扫码登录/.test(snapshot.text) && !/笔记管理|小红书账号/.test(snapshot.text)) throw fault('AUTH_REQUIRED', '小红书登录失效');
}
async function ready(browser, pattern, count = 16) {
  for (let n = 0; n < count; n++) {
    const s = await browser.snapshot(); detectGate(s);
    if (pattern.test(s.text)) return s;
    await wait(500, browser.signal);
  }
  throw fault('CAPABILITY_UNAVAILABLE', '页面未出现预期的已核验入口');
}
export class Xiaohongshu {
  constructor(browser, account) { this.browser = browser; this.account = account; this.myUserId = null; }
  async verifyCreator() {
    await this.browser.navigate(CREATOR);
    const s = await ready(this.browser, /小红书账号\s*[:：]\s*[A-Za-z0-9_]{3,}/);
    const match = s.text.match(/小红书账号\s*[:：]\s*([A-Za-z0-9_-]+)/);
    if (match?.[1] !== this.account.accountId) throw fault('ACCOUNT_MISMATCH', '创作服务平台当前账号不符');
    return { accountId: match[1], creatorLoggedIn: true, verifiedAt: new Date().toISOString(), creatorUrl: s.url.split('?')[0] };
  }
  async verifyConsumer() {
    await this.browser.navigate(CONSUMER);
    let own;
    for (let n = 0; n < 12 && !own; n++) {
      const s = await this.browser.snapshot(); detectGate(s);
      own = await this.browser.run(() => [...document.querySelectorAll('a[href*="/user/profile/"]')].filter(e =>
        /^(我|我的|个人主页)$/.test((e.innerText || '').trim())).map(e => e.href)[0] || null);
      if (!own) await wait(500, this.browser.signal);
    }
    if (!own || new URL(own).hostname !== 'www.xiaohongshu.com') throw fault('AUTH_REQUIRED', '浏览端需要单独完成官方登录');
    await this.browser.navigate(own);
    const s = await ready(this.browser, /小红书号|小红书账号/);
    const match = s.text.match(/小红书(?:号|账号)\s*[:：]\s*([A-Za-z0-9_-]+)/);
    if (match?.[1] !== this.account.accountId) throw fault('ACCOUNT_MISMATCH', '浏览端当前账号不符');
    if (this.account.identityUrl && new URL(this.account.identityUrl).pathname !== '/' && new URL(own).pathname !== new URL(this.account.identityUrl).pathname) throw fault('ACCOUNT_MISMATCH', '浏览端稳定主页标识与绑定记录不一致');
    this.myUserId = new URL(own).pathname.split('/').filter(Boolean).at(-1);
    return { accountId: match[1], consumerLoggedIn: true, myUserId: this.myUserId, verifiedAt: new Date().toISOString() };
  }
  async capability() {
    const identity = await this.verifyCreator();
    await this.browser.navigate(PUBLISH);
    const s = await ready(this.browser, /上传图片/);
    const inputs = s.fields.filter(f => f.type === 'file' && /jpg|jpeg|png/.test(f.accept));
    if (inputs.length !== 1 || !inputs[0].multiple) throw fault('CAPABILITY_UNAVAILABLE', '当前账号没有已核验的多图上传入口');
    return { ...identity, format: 'original_image_note', imageUpload: true, accept: inputs[0].accept,
      publisherUrl: PUBLISH, managerUrl: MANAGER, editorAfterUpload: 'verify_at_natural_schedule', finalPublish: 'not_executed' };
  }
  async search(topic, limit) {
    await this.browser.navigate('https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(topic) + '&source=web_explore_feed');
    await wait(1600, this.browser.signal); const snapshot = await this.browser.snapshot(); detectGate(snapshot);
    const rows = await this.browser.run(limit => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      return [...document.querySelectorAll('a[href*="/explore/"],a[href*="/discovery/item/"]')].filter(visible).map(e => ({
        originalUrl: e.href, title: (e.innerText || e.getAttribute('title') || '').trim().slice(0, 160)
      })).filter(r => /\/(?:explore|discovery\/item)\/[0-9a-f]{24}/i.test(r.originalUrl)).slice(0, limit * 3);
    }, limit);
    return [...new Map(rows.map(r => [r.originalUrl.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)?.[1], r])).values()].slice(0, limit);
  }
  async read(row, topic, ownPosts = []) {
    const contentId = row.originalUrl.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)?.[1];
    if (!contentId) throw fault('PATH_DENIED', '不是允许的笔记链接');
    await this.browser.navigate(row.originalUrl);
    await wait(1500, this.browser.signal); const snapshot = await this.browser.snapshot(); detectGate(snapshot);
    const data = await this.browser.run(() => {
      const titleNode = document.querySelector('#detail-title'), desc = document.querySelector('#detail-desc');
      const authorNode = document.querySelector('.author-container .username,.author-wrapper .username,.author .username,.author-container a.name');
      const authorLink = document.querySelector('.author-container a[href*="/user/profile/"],.author-wrapper a[href*="/user/profile/"],.author a[href*="/user/profile/"]');
      const excerpt = (desc?.innerText || '').trim();
      const video = !!document.querySelector('video');
      const captions = [...document.querySelectorAll('video')].flatMap(v => [...v.textTracks].flatMap(t => [...(t.activeCues || [])].map(c => c.text))).join('\n');
      return { title: (titleNode?.innerText || '').trim(), excerpt: excerpt.slice(0, 420), truncated: excerpt.length > 420,
        author: (authorNode?.innerText || authorLink?.innerText || '').trim(), authorUrl: authorLink?.href || '',
        video, captions: captions.slice(0, 120) };
    });
    const base = { id: 'src_' + hash(['xiaohongshu', contentId]).slice(0, 20), platform: 'xiaohongshu', contentId,
      url: 'https://www.xiaohongshu.com/explore/' + contentId, originalUrl: row.originalUrl, fetchedAt: new Date().toISOString(), topic,
      author: text(data.author, 120), authorUrl: data.authorUrl, title: text(data.title || row.title, 120), readRange: [] };
    if (base.title) base.readRange.push('title');
    if (data.excerpt) base.readRange.push(data.video ? 'video_description_excerpt' : 'body_excerpt');
    if (data.captions) base.readRange.push('active_captions_excerpt');
    base.excerpt = text([data.excerpt, data.captions].filter(Boolean).join('\n'), 2600);
    base.fingerprint = hash(normalize(base.title + base.excerpt));
    base.originKey = base.fingerprint; base.origin = 'external';
    const authorId = data.authorUrl.match(/\/user\/profile\/([^/?]+)/)?.[1];
    base.authorKey = authorId || null;
    if (authorId && authorId === this.myUserId || ownPosts.some(p => p.postId === contentId || p.fingerprint === base.fingerprint)) base.origin = 'self';
    if (!base.author || !base.readRange.length || /笔记暂时无法浏览|内容不存在|内容已删除/.test(snapshot.text)) {
      base.unavailable = true; base.unavailableReason = !base.author ? 'author_not_readable' : 'content_unavailable';
    }
    // Never infer visual understanding from a video element or an image URL.
    base.visualProcessed = false; return base;
  }
  async prepare(draft) {
    await this.capability();
    await this.browser.upload(draft.assets.map(a => a.file));
    await ready(this.browser, /填写标题|添加标题|正文|描述|分享.*(故事|想法)/, 30);
    await this.browser.fill('title', draft.title);
    await this.browser.fill('body', draft.body);
    const s = await this.browser.snapshot(); detectGate(s);
    if (/作品声明|添加声明/.test(s.text)) {
      await this.browser.clickLabel(['作品声明', '添加声明']); await wait(400, this.browser.signal);
      const declaration = await this.browser.run(() => {
        const labels = [...document.querySelectorAll('label,[role=checkbox],[role=radio]')].filter(e => e.getClientRects().length &&
          /^(内容由AI生成|AI辅助创作|内容由人工智能生成|使用AI生成内容)$/.test((e.innerText || '').replace(/\s/g, '')));
        if (labels.length !== 1) return false;
        const e = labels[0], input = e.querySelector('input');
        if (!(input?.checked || e.getAttribute('aria-checked') === 'true')) e.click();
        return !!(input?.checked || e.getAttribute('aria-checked') === 'true');
      });
      if (!declaration) throw fault('CAPABILITY_UNAVAILABLE', 'AI 声明控件无法确认，未发布');
    }
    const valid = await this.browser.run((title, body) => {
      const all = [...document.querySelectorAll('input:not([type=file]),textarea,[contenteditable=true]')].map(e => (e.value || e.innerText || '').replace(/\s/g, ''));
      return all.includes(title.replace(/\s/g, '')) && all.includes(body.replace(/\s/g, ''));
    }, draft.title, draft.body);
    if (!valid) throw fault('CAPABILITY_UNAVAILABLE', '最终编辑内容未确认');
    return { prepared: true, aiDisclosure: 'AI 创作 included in body', at: new Date().toISOString() };
  }
  async submit() {
    // This is the only publishing click. The caller MUST persist an intent and take the shared account lock first.
    if (!await this.browser.clickLabel(['发布'])) throw fault('CAPABILITY_UNAVAILABLE', '没有唯一可用的最终发布按钮');
    await wait(4000, this.browser.signal);
    const s = await this.browser.snapshot(); detectGate(s);
    return { platformReturnedSuccess: /发布成功/.test(s.text), at: new Date().toISOString() };
  }
  async confirm(draft, attemptedAt) {
    await this.verifyCreator(); await this.browser.captureNoteResponses(); await this.browser.navigate(MANAGER);
    await ready(this.browser, /已发布/);
    if (!await this.browser.clickLabel(['已发布'])) throw fault('CAPABILITY_UNAVAILABLE', '不能唯一定位已发布列表');
    await wait(1800, this.browser.signal);
    let result = await this.browser.run(title => {
      const exact = [...document.querySelectorAll('a,span,div,p')].filter(e => e.getClientRects().length && (e.innerText || '').trim() === title);
      const leaves = exact.filter(e => !exact.some(o => o !== e && e.contains(o)));
      if (leaves.length !== 1) return null;
      let card = leaves[0];
      for (let n = 0; n < 6 && card; n++, card = card.parentElement) {
        const str = card.innerText || '', link = card.querySelector('a[href*="/explore/"],a[href*="/discovery/item/"]');
        const time = str.match(/20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}日?\s+\d{1,2}:\d{2}(?::\d{2})?/);
        const id = link?.href?.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{24})/i)?.[1] ||
          card.getAttribute('data-note-id') || card.getAttribute('data-id');
        if (time && /^[0-9a-f]{24}$/i.test(id || '') && str.length < 3000) return { postId: id, publishedAtRaw: time[0], title, publicationState: 'listed_under_published_tab' };
      }
      return null;
    }, draft.title);
    const uiEvidence = await this.browser.run(title => {
      const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const exact = [...document.querySelectorAll('a,span,div,p')].filter(e => visible(e) && (e.innerText || '').trim() === title);
      const leaves = exact.filter(e => !exact.some(o => o !== e && e.contains(o)));
      const tabs = [...document.querySelectorAll('span,div,[role=tab]')].filter(e => visible(e) && (e.innerText || '').trim() === '已发布');
      return { uniqueTitle: leaves.length === 1, selectedPublished: tabs.some(e => [e,e.parentElement].some(n => n && (n.getAttribute('aria-selected') === 'true' || /(^|[-_\s])active([-_\s]|$)|selected/.test(n.className || '')))) };
    }, draft.title);
    const responseNotes = [...new Map((this.browser.noteResponses || []).filter(r => r.title === draft.title).map(r => [r.postId, r])).values()];
    if (uiEvidence.uniqueTitle && uiEvidence.selectedPublished && responseNotes.length === 1) result = { ...result, ...responseNotes[0], publishedAtRaw: result?.publishedAtRaw || responseNotes[0].publishedAtUTC, publicationState: 'published_tab_unique_title_and_official_ui_response' };
    if (!uiEvidence.uniqueTitle || !uiEvidence.selectedPublished) return { confirmed: false, reason: 'published_tab_or_title_not_unique' };
    if (!result) return { confirmed: false, reason: 'published_list_has_no_unique_id_and_time' };
    return { confirmed: true, ...result, url: 'https://www.xiaohongshu.com/explore/' + result.postId,
      confirmedAt: new Date().toISOString(), attemptedAt };
  }
}
export function platformFor(browser, account) {
  if (account.platform !== 'xiaohongshu') throw fault('CAPABILITY_UNAVAILABLE', '用户已决定暂不接入抖音');
  return new Xiaohongshu(browser, account);
}
