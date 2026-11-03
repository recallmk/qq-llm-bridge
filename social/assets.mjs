import fs from 'node:fs';
import path from 'node:path';
import { dPath, mkdir, hash, atomic, fault } from './io.mjs';
const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function renderAssets(browser, config, task, draft) {
  const root = mkdir(path.join(config.dataRoot, 'drafts', task.id)), assets = [];
  for (let i = 0; i < draft.slides.length; i++) {
    const slide = draft.slides[i], hue = parseInt(hash(task.id).slice(0, 4), 16) % 360;
    const points = slide.points.map((p, n) => '<article><b>' + (n + 1) + '</b><div><h2>' + escape(p.label) + '</h2><p>' + escape(p.detail) + '</p></div></article>').join('');
    const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><style>' +
      '*{box-sizing:border-box}body{margin:0;width:1080px;height:1440px;background:hsl(' + hue + ' 35% 96%);color:#182c32;font-family:"Microsoft YaHei","Segoe UI",sans-serif;padding:96px 78px}header{font-size:24px;letter-spacing:4px;color:#577078}h1{font-size:52px;line-height:1.3;margin:40px 0 50px}main{display:grid;gap:18px}article{display:flex;align-items:center;gap:30px;background:white;border:2px solid hsl(' + hue + ' 25% 80%);border-radius:28px;padding:22px}b{flex:0 0 64px;height:64px;border-radius:50%;text-align:center;line-height:64px;background:hsl(' + hue + ' 40% 38%);color:white;font-size:30px}h2{font-size:32px;margin:0 0 14px}p{font-size:24px;line-height:1.45;margin:0}footer{position:fixed;bottom:70px;left:78px;right:78px;border-top:2px solid #b9c8ca;padding-top:24px;font-size:23px;color:#52686d}</style>' +
      '<header>公开阅读 · 原创图解</header><h1>' + escape(slide.heading) + '</h1><main>' + points + '</main><footer>' + escape(config.botName) + ' · AI 创作　' + (i + 1) + '/' + draft.slides.length + '<br>资料与不确定性见正文；图形为原创示意</footer>';
    const file = dPath(path.join(root, 'page-' + (i + 1) + '.png'));
    if (!fs.existsSync(file)) await browser.png(html, file);
    assets.push({ file, sha256: hash(fs.readFileSync(file)), bytes: fs.statSync(file).size, rights: 'original_programmatic_diagram', mime: 'image/png' });
  }
  if (assets.reduce((sum, a) => sum + a.bytes, 0) > config.limits.mediaBytesPerPost) throw fault('BUDGET', '素材超过预算');
  const saved = { ...draft, taskId: task.id, assets, materialFingerprint: hash(assets.map(a => a.sha256)) };
  atomic(path.join(root, 'final.json'), saved); return saved;
}
