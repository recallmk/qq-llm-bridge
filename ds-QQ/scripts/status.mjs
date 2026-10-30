import fs from 'node:fs';
const cfg = JSON.parse(fs.readFileSync(new URL('../qq-bridge/config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const token = fs.readFileSync(new URL('../qq-bridge/control-token.txt', import.meta.url), 'utf8').trim();
const res = await fetch(`http://127.0.0.1:${cfg.control?.port ?? 3102}/status`, { headers: { 'x-qq-token': token }, signal: AbortSignal.timeout(5000) });
if (!res.ok) throw new Error(`status HTTP ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2));
