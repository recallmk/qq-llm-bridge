import { projectPath } from './project-paths.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const scopeOk = value => /^[gp]-\d{1,20}$/.test(String(value));
export function imageMime(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.length >= 16 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('不是支持的图片格式');
}
export function qqImageUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || !(host === 'multimedia.nt.qq.com.cn' || host === 'qpic.cn' || host.endsWith('.qpic.cn') || host.endsWith('.qlogo.cn'))) throw new Error('图片地址不是 QQ 图片服务');
  url.protocol = 'https:'; return url.href;
}
export function imageSegments(message) {
  if (!Array.isArray(message)) return [];
  return message.filter(s => s?.type === 'image').slice(0, 4).map(s => ({
    file: String(s.data?.file ?? '').slice(0, 4096), url: String(s.data?.url ?? '').slice(0, 8192),
  }));
}

/** Per-conversation image references; source URLs/paths never enter model text. */
export class QqImages {
  constructor({ root, call, observe, fetchImpl = globalThis.fetch, now = () => Date.now(), enabled = true,
    localRoots = ['napcat', 'data/qq-user', 'QQ/data'].map(p => projectPath(p)), maxImageBytes = 8 * 1024 * 1024, maxCacheBytes = 128 * 1024 * 1024,
    ttlMs = 24 * 60 * 60 * 1000, log = () => {} } = {}) {
    this.root = path.resolve(root); this.call = call; this.observe = observe; this.fetchImpl = fetchImpl; this.now = now; this.enabled = enabled;
    this.localRoots = localRoots.map(p => path.resolve(p)); this.log = log;
    this.maxImageBytes = Math.max(1024, Math.min(8 * 1024 * 1024, Number(maxImageBytes) || 8 * 1024 * 1024));
    this.maxCacheBytes = Math.max(this.maxImageBytes, Math.min(512 * 1024 * 1024, Number(maxCacheBytes) || 128 * 1024 * 1024));
    this.ttlMs = Math.max(60_000, Math.min(7 * 86_400_000, Number(ttlMs) || 86_400_000));
    this.records = null; this.tail = Promise.resolve();
  }
  serial(job) { const result = this.tail.catch(() => {}).then(job); this.tail = result.catch(() => {}); return result; }
  async safe(file) {
    const target = path.resolve(file);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new Error('图片缓存路径越界');
    let parent = target;
    for (;;) {
      try {
        const real = await fs.realpath(parent);
        if (process.platform === 'win32' && /^C:[\\/]/i.test(real)) throw new Error('图片缓存不能保存在 C 盘');
        if (parent.startsWith(`${this.root}${path.sep}`) && !real.toLowerCase().startsWith(`${this.root.toLowerCase()}${path.sep}`)) throw new Error('图片缓存路径越界');
        break;
      } catch (e) { if (e.code !== 'ENOENT') throw e; parent = path.dirname(parent); }
    }
  }
  async ready() {
    if (this.records) return;
    await this.safe(this.root); await fs.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, 'index.json'); await this.safe(file);
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.records) || state.records.some(r => !scopeOk(r.scope)
        || !/^qqimg_[a-f0-9]{24}$/.test(r.id) || !Number.isFinite(r.ts)
        || typeof r.file !== 'string' || typeof r.url !== 'string'
        || (r.blob && !/^[a-f0-9]{64}$/.test(r.blob)))) throw new Error('图片索引格式错误');
      this.records = state.records;
    } catch (e) { if (e.code !== 'ENOENT') throw e; this.records = []; }
    await this.cleanup();
  }
  async save() {
    const file = path.join(this.root, 'index.json'); await this.safe(file); await this.safe(`${file}.tmp`);
    // Fixed temp file is safe here because all index writers share this queue.
    const temp = `${file}.tmp`; await fs.writeFile(temp, JSON.stringify({ version: 1, records: this.records }), { mode: 0o600 }); await fs.rename(temp, file);
  }
  async cleanup() {
    this.records = this.records.filter(r => this.now() - r.ts <= this.ttlMs).slice(-1000);
    const files = [];
    for (const name of await fs.readdir(this.root)) if (/^image-[a-f0-9]{64}\.bin$/.test(name)) {
      const file = path.join(this.root, name); await this.safe(file);
      const stat = await fs.stat(file); files.push({ file, size: stat.size, at: stat.mtimeMs });
    }
    files.sort((a, b) => a.at - b.at); let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const item of files) if (this.now() - item.at > this.ttlMs || total > this.maxCacheBytes) {
      await this.safe(item.file); await fs.unlink(item.file); total -= item.size;
    }
  }
  async captureInner(scope, images, meta) {
    if (!scopeOk(scope)) throw new Error('无效的图片会话');
    const refs = [];
    for (const [index, image] of images.slice(0, 4).entries()) {
      const id = `qqimg_${sha(`${scope}:${meta.messageId ?? this.now()}:${index}:${image.file}:${image.url}`).slice(0, 24)}`;
      if (!this.records.some(r => r.id === id)) this.records.push({ id, scope, messageId: String(meta.messageId ?? ''),
        senderId: String(meta.senderId ?? ''), ts: this.now(), observationId: '', file: String(image.file ?? '').slice(0, 4096), url: String(image.url ?? '').slice(0, 8192) });
      refs.push(id);
    }
    const keep = new Set(this.records.filter(r => r.scope === scope).slice(-40).map(r => r.id));
    this.records = this.records.filter(r => r.scope !== scope || keep.has(r.id));
    return refs;
  }
  capture(scope, images, meta = {}) {
    if (!this.enabled || !images.length) return Promise.resolve([]);
    return this.serial(async () => { await this.ready(); const refs = await this.captureInner(scope, images, meta); await this.cleanup(); await this.save(); return refs; });
  }
  bind(scope, refs, observationId) {
    if (!refs?.length || !observationId || !this.enabled) return Promise.resolve();
    return this.serial(async () => { await this.ready(); for (const r of this.records) if (r.scope === scope && refs.includes(r.id)) r.observationId = observationId; await this.save(); });
  }
  async download(value, signal) {
    let url = qqImageUrl(value);
    for (let n = 0; n < 3; n++) {
      const response = await this.fetchImpl(url, { redirect: 'manual', signal, headers: { 'user-agent': 'QQ-Bridge/1.0', accept: 'image/*' } });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('图片跳转无效'); url = qqImageUrl(new URL(location, url).href); continue;
      }
      if (!response.ok || Number(response.headers.get('content-length')) > this.maxImageBytes) {
        await response.body?.cancel(); throw new Error('图片下载失败或图片过大');
      }
      const parts = []; let size = 0;
      for await (const bytes of response.body ?? []) { size += bytes.length; if (size > this.maxImageBytes) { await response.body?.cancel().catch(() => {}); throw new Error('图片超过大小限制'); } parts.push(bytes); }
      return Buffer.concat(parts);
    }
    throw new Error('图片跳转次数过多');
  }
  async localFile(value) {
    const file = String(value).startsWith('file:') ? fileURLToPath(value) : path.resolve(value);
    const real = await fs.realpath(file);
    if (process.platform === 'win32' && /^C:[\\/]/i.test(real)) throw new Error('不读取其他盘的图片');
    let allowed = false;
    for (const root of this.localRoots) {
      try { const actual = await fs.realpath(root); if (real.toLowerCase().startsWith(`${actual.toLowerCase()}${path.sep}`)) allowed = true; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!allowed) throw new Error('图片不在 QQ 缓存目录');
    const handle = await fs.open(real, 'r');
    try {
      if (!(await handle.stat()).isFile()) throw new Error('图片不是文件');
      const buf = Buffer.alloc(this.maxImageBytes + 1); let total = 0;
      while (total < buf.length) { const { bytesRead } = await handle.read(buf, total, buf.length - total); if (!bytesRead) break; total += bytesRead; }
      if (total > this.maxImageBytes) throw new Error('图片超过大小限制'); return buf.subarray(0, total);
    } finally { await handle.close(); }
  }
  async resolve(record, signal) {
    let bytes;
    if (record.blob) {
      const file = path.join(this.root, `image-${record.blob}.bin`); await this.safe(file);
      try { bytes = await fs.readFile(file); if (bytes.length > this.maxImageBytes || sha(bytes) !== record.blob) throw new Error('图片缓存校验失败'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!bytes && record.url) { try { bytes = await this.download(record.url, signal); } catch { signal?.throwIfAborted(); } }
    if (!bytes && record.file) {
      const result = await this.call('get_image', { file: record.file }); signal?.throwIfAborted();
      if (result?.status === 'ok') {
        const data = result.data ?? {};
        if (data.url) { try { bytes = await this.download(data.url, signal); } catch { signal?.throwIfAborted(); } }
        const local = data.file || data.path;
        if (!bytes && local) bytes = await this.localFile(local);
      }
    }
    signal?.throwIfAborted(); if (!bytes) throw new Error('图片暂时无法读取，请重发原图');
    const mimeType = imageMime(bytes); const blob = sha(bytes);
    if (record.blob !== blob) {
      const file = path.join(this.root, `image-${blob}.bin`); await this.safe(file); await fs.writeFile(file, bytes, { mode: 0o600 }); record.blob = blob;
    }
    return { data: bytes.toString('base64'), mimeType, bytes: bytes.length };
  }
  prepare(scope, messages, { signal } = {}) {
    const visualTurn = messages.some(m => m.imageIds?.length || m.quotedMessageId || /刚才|刚刚|上一张|前面|之前|这张|那张|这个|那个|上面|图片|图里|图中|表情包|照片|截图|对比|比较/.test(m.text ?? ''));
    if (!visualTurn) return Promise.resolve({ images: [], attachedImages: [], warnings: [] });
    if (!this.enabled) return Promise.resolve({ images: [], attachedImages: [], warnings: ['当前未开启图片理解'] });
    return this.serial(async () => {
      await this.ready(); signal?.throwIfAborted();
      let selected = [];
      const add = (ids, kind) => { for (const id of ids ?? []) if (!selected.some(s => s.id === id)) selected.push({ id, kind }); };
      for (const message of messages) add(message.imageIds, 'current');
      for (const message of messages) if (message.quotedMessageId) {
        let quoted = this.records.filter(r => r.scope === scope && r.messageId === String(message.quotedMessageId));
        if (!quoted.length && /^-?\d{1,20}$/.test(String(message.quotedMessageId))) {
          const result = await this.call('get_msg', { message_id: String(message.quotedMessageId) }); signal?.throwIfAborted();
          const data = result?.data;
          const sameScene = scope.startsWith('g-') ? data?.message_type === 'group' && String(data.group_id) === scope.slice(2)
            : data?.message_type === 'private' && String(data.user_id ?? data.sender?.user_id) === scope.slice(2);
          if (result?.status === 'ok' && sameScene) {
            const refs = await this.captureInner(scope, imageSegments(data.message), { messageId: message.quotedMessageId, senderId: data.user_id ?? data.sender?.user_id });
            quoted = this.records.filter(r => refs.includes(r.id));
            if (refs.length && this.observe) {
              const observation = await this.observe(scope, { speakerId: String(data.user_id ?? data.sender?.user_id),
                speakerName: String(data.sender?.card || data.sender?.nickname || ''), messageId: String(message.quotedMessageId), text: '[图片]', imageIds: refs });
              for (const record of quoted) record.observationId = observation?.id ?? '';
            }
          }
        }
        add(quoted.map(r => r.id), 'quoted');
      }
      const text = messages.map(m => m.text).join('\n');
      if ((!selected.length || /对比|比较|上一张|两张|前一张/.test(text)) && /刚才|刚刚|上一张|前面|之前|这张|那张|这个|那个|上面|图片|图里|图中|表情包|照片|截图|对比|比较/.test(text)) {
        const current = new Set(selected.map(s => s.id));
        const recent = this.records.filter(r => r.scope === scope && !current.has(r.id) && this.now() - r.ts <= this.ttlMs).slice(-2);
        add(recent.map(r => r.id), 'recent');
      }
      selected = selected.slice(0, 4);
      const images = [], attachedImages = [], warnings = []; let total = 0;
      for (const item of selected) {
        const record = this.records.find(r => r.id === item.id && r.scope === scope);
        if (!record) { warnings.push('有一张图片的来源已经不在当前会话中，请重发原图'); continue; }
        try {
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)].filter(Boolean));
          const image = await this.resolve(record, deadline); signal?.throwIfAborted();
          if (total + image.bytes > 16 * 1024 * 1024) { warnings.push('本轮图片总大小达到上限，其余图片尚未读取'); break; }
          total += image.bytes; images.push({ data: image.data, mimeType: image.mimeType });
          attachedImages.push({ index: images.length, imageId: record.id, messageId: record.messageId,
            speakerId: record.senderId, ...(record.observationId ? { observationId: record.observationId } : {}),
            at: new Date(record.ts).toISOString(), kind: item.kind, mimeType: image.mimeType });
        } catch { signal?.throwIfAborted(); warnings.push('有一张图片未能读取，不能据此描述内容；需要时请重发原图'); this.log('QQ 图片读取失败（未向模型提供源地址）'); }
      }
      await this.cleanup(); await this.save();
      return { images, attachedImages, warnings };
    });
  }
  async drain() { await this.tail; }
}
