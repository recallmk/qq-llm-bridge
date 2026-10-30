import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const IMAGE_EXT = /\.(png|gif|webp|jpe?g)$/i;
const EMOTIONS = {
  laugh: ['开心', '大笑'], angry: ['生气'], sad: ['难过', '哭', '疲惫'],
  food: ['吃', '饭', '饿', '馋', '奶茶', '零食'], praise: ['赞同', '感谢', '庆祝', '恭喜', '打CALL'],
  refuse: ['拒绝'], agree: ['赞同'], money: ['求财', '红包', '穷', '钱'], rich: ['发财', '撒钱'],
  clingy: ['安慰', '蹭蹭', '陪', '理理我'], complain: ['无语', '疲惫'], cute: ['喜欢', '害羞', '卖萌'],
};
const normal = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();

/** Local images only. The model receives descriptions and opaque IDs, never file paths or arbitrary URLs. */
export class StickerLibrary {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.entries = [];
    let catalog = [];
    try { catalog = JSON.parse(readFileSync(path.join(this.dir, 'catalog.json'), 'utf8')).entries ?? []; } catch {}
    const byFile = new Map((Array.isArray(catalog) ? catalog : []).filter(row => row && typeof row.file === 'string').map(row => [row.file, row]));
    let files = [];
    try { files = readdirSync(this.dir).filter(file => IMAGE_EXT.test(file)).sort(); } catch {}
    for (const file of files) {
      if (!this.safeFile(file)) continue;
      const row = byFile.get(file);
      this.entries.push({ file, id: row?.id || `legacy-${path.parse(file).name}`,
        name: String(row?.name || path.parse(file).name).slice(0, 100), code: String(row?.code || ''),
        emotion: String(row?.emotion || file.split('_')[0]).slice(0, 30),
        tags: Array.isArray(row?.tags) ? row.tags.map(t => String(t).slice(0, 50)).slice(0, 16) : (EMOTIONS[file.split('_')[0]] ?? []),
        use: String(row?.use || '').slice(0, 240), caption: String(row?.caption || '').slice(0, 240),
        description: String(row?.description || '').slice(0, 500), direction: String(row?.direction || '').slice(0, 100) });
    }
  }
  safeFile(file) {
    if (typeof file !== 'string' || path.basename(file) !== file || !IMAGE_EXT.test(file)) return null;
    try {
      const root = realpathSync(this.dir), resolved = realpathSync(path.join(root, file));
      const relative = path.relative(root, resolved);
      const info = statSync(resolved);
      return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && info.isFile()
        && info.size > 0 && info.size <= 8 * 1024 * 1024 ? resolved : null;
    } catch { return null; }
  }
  get(id) { return this.entries.find(row => row.id === id); }
  search(query = '', limit = 8) {
    const q = normal(query).slice(0, 160);
    const count = Math.min(12, Math.max(1, Number(limit) || 8));
    if (!q) return [];
    const terms = q.split(/[\s，。！？、;；,!?]+/u).filter(Boolean);
    const grams = [...new Set(terms.flatMap(term => {
      const chars = Array.from(term);
      return chars.length > 2 ? chars.slice(0, -1).map((char, i) => char + chars[i + 1]) : [];
    }))];
    const scored = this.entries.map(row => {
      const id = normal(row.id), name = normal(row.name), code = normal(row.code);
      const primary = normal([row.name, row.emotion, ...row.tags, row.caption].join(' '));
      const scene = normal(row.use);
      let score = [id, name, code, normal(row.file)].includes(q) ? 1000 : 0;
      if (id.includes(q) || name.includes(q)) score += 30;
      for (const term of terms) {
        if (primary.includes(term)) score += term.length > 1 ? 12 : 1;
        if (scene.includes(term)) score += term.length > 1 ? 5 : 0;
      }
      for (const gram of grams) {
        if (primary.includes(gram)) score += 2;
        else if (scene.includes(gram)) score += 1;
      }
      return { row, score };
    });
    return scored.filter(hit => hit.score >= 4).sort((a, b) => b.score - a.score).slice(0, count).map(({ row }) => this.describe(row));
  }
  describe(row) {
    const { file, ...publicInfo } = row;
    return publicInfo;
  }
  category(name) {
    const words = EMOTIONS[name] ?? [];
    return this.entries.filter(row => row.file.startsWith(`${name}_`)
      || words.some(word => [row.emotion, ...row.tags].some(tag => tag.includes(word))));
  }
}
