/**
 * Markdown → QQ 纯文本，以及按句读分段。
 *
 * 迁自 Derpyu520/qq-bridge 的 `src/md-to-plain.js`（MIT）。模型回复里常带
 * `**粗体**`、`# 标题`、``` 围栏 ``` 和 `[文字](链接)`，QQ 不渲染 Markdown，
 * 直接发出去就是一堆符号，所以发送前统一转成纯文本。
 *
 * 纯函数，无 IO、无网络，可直接单测。
 */

/** 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。 */
export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏（内容尾部换行去掉，围栏后的换行自然保留一个分隔）
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里。
  // 候选长度必须有界：`[^\]]*` 在大量 "![" 时每次都要扫到串尾，整体 O(n²)，
  // 会把 QQ 收发/定时器所在的事件循环卡住若干秒。排除换行 + 上限 500 把代价压成常数。
  s = s.replace(/!\[([^\]\n]{0,500})\]\(([^)\s]{1,2000})\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]\n]{1,500})\]\(([^)\s]{1,2000})\)/g, '$1 ($2)');
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  // 单个 * 的斜体有两个条件：① 不跨行（否则行首 `* ` 列表项会被当成一对标记）；
  // ② 开标记后、闭标记前不能是空白，否则 "2 * 3 * 4" 这种乘法式会被整段吃掉。
  s = s.replace(/\*(?!\s)([^*\n]*?[^\s*])\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  s = s.replace(/^\s*\d+\.\s+/gm, (m) => `${m.trim()} `);
  // 表格：丢掉纯分隔行（|---|---|），保留单元格文字
  s = s
    .split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, '')))
    .join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 按长度上限切分（保留换行，且绝不切开 emoji 等代理对）。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const parts = [];
  let rest = String(text ?? '');
  while (rest.length > safeMax) {
    let cut = rest.lastIndexOf('\n', safeMax - 1);
    let eat = 0;
    if (cut <= 0) {
      cut = safeMax; // 硬切
    } else {
      eat = 1; // 换行符保留给前一段，避免拼接后丢换行
    }
    // 切点正好落在代理对中间（emoji 等会变乱码）时前移一个码元
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) {
      // max=1 且开头是 emoji 时至少推进一个完整码点，避免死循环
      const first = rest.charCodeAt(0);
      const second = rest.charCodeAt(1);
      cut = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
      eat = 0;
    }
    parts.push(rest.slice(0, cut + eat));
    rest = rest.slice(cut + eat);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

const TERMINATORS = '。！？!?；;…\n';
const CLOSERS = '”"』」）)】》';

/** 把文本切成句子：句末标点（含换行）后紧跟的引号/括号归到前一句。 */
export function splitSentences(text) {
  const s = String(text ?? '');
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (!TERMINATORS.includes(s[i])) continue;
    let end = i + 1;
    while (end < s.length && CLOSERS.includes(s[end])) end++;
    out.push(s.slice(start, end));
    start = end;
    i = end - 1;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/**
 * 把回复切成若干条 QQ 消息：先按句读打包到 `chunkChars` 以内，
 * 单句超过 `maxChars` 时才硬切（防模型一次吐几千字）。
 *
 * @param {string} text 已经过 {@link mdToPlain} 的纯文本
 * @param {{chunkChars?: number, maxChars?: number}} [opts]
 * @returns {string[]} 至少一条（原文非空时）
 */
export function splitForChat(text, { chunkChars = 600, maxChars = 1200 } = {}) {
  const plain = String(text ?? '').trim();
  if (!plain) return [];
  const chunk = Math.max(80, Math.floor(Number(chunkChars) || 600));
  const hard = Math.max(chunk, Math.floor(Number(maxChars) || 1200));

  const parts = [];
  let cur = '';
  const flush = () => {
    const t = cur.trim();
    if (t) parts.push(t);
    cur = '';
  };
  for (const sentence of splitSentences(plain)) {
    if (cur && (cur + sentence).length > chunk) flush();
    cur += sentence;
    // 单句本身超长：硬切成多条，最后一片留着继续拼后面的句子
    if (cur.length > hard) {
      const pieces = splitForQQ(cur, hard);
      cur = pieces.pop();
      parts.push(...pieces);
    }
  }
  flush();
  return parts.length ? parts : [plain];
}

/** 截断到最多 `max` 个字符，绝不切开代理对（emoji / 生僻字）。 */
export function truncateText(value, max) {
  const s = String(value ?? '');
  const limit = Number.isFinite(Number(max)) ? Math.max(0, Math.floor(Number(max))) : 0;
  if (limit === 0) return '';
  if (s.length <= limit) return s;
  let cut = limit;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  if (cut <= 0) {
    const first = s.charCodeAt(0);
    const second = s.charCodeAt(1);
    cut = first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
  }
  return s.slice(0, cut);
}
