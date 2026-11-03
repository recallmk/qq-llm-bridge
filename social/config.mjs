import fs from 'node:fs';
import path from 'node:path';
import { dPath, readJson, fault } from './io.mjs';
import { inWindow } from './time.mjs';
export const PLATFORMS = ['xiaohongshu', 'douyin'];
const hhmm = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export function loadConfig(file, bridgeRoot) {
  const c = readJson(file);
  if (c.version !== 1 || !['deepseek', 'gemini'].includes(c.botId)) throw fault('CONFIG', '社交配置版本或机器人标识无效');
  try { new Intl.DateTimeFormat('en', { timeZone: c.timeZone }).format(); } catch { throw fault('CONFIG', '必须明确有效的 timeZone'); }
  if (!Array.isArray(c.window) || c.window.length !== 2 || !c.window.every(hhmm)) throw fault('CONFIG', '后台窗口无效');
  if (!hhmm(c.browseAt) || !hhmm(c.publish?.at) || !hhmm(c.publish?.retryAt)) throw fault('CONFIG', '固定执行时刻无效');
  if (![c.browseAt, c.publish.at, c.publish.retryAt].every(t => inWindow(t, c.window))) throw fault('CONFIG', '日程不在允许的后台窗口内');
  if (![c.publish.weekday, c.publish.retryWeekday].every(n => Number.isInteger(n) && n >= 1 && n <= 7) || c.publish.retryWeekday <= c.publish.weekday) throw fault('CONFIG', '补发日必须在本周正式发布日之后');
  if (c.publish.fallbackAfter && (!hhmm(c.publish.fallbackAfter) || !inWindow(c.publish.fallbackAfter,c.window))) throw fault('CONFIG','共享配额接替时间无效');
  if (c.publish.creatorRotation && (!Array.isArray(c.publish.creatorRotation) || c.publish.creatorRotation.length !== 2 || new Set(c.publish.creatorRotation).size !== 2 || c.publish.creatorRotation.some(b=>!['deepseek','gemini'].includes(b)))) throw fault('CONFIG','共享账号创作轮换无效');
  if (!Array.isArray(c.accounts) || c.accounts.some(a => !PLATFORMS.includes(a.platform))) throw fault('CONFIG', '平台绑定无效');
  if (c.accounts.some(a => a.accountId && (!a.ownerAuthorized || !a.identityUrl || !a.identityMarker))) throw fault('CONFIG', '绑定账号需要归属授权和可核对标识');
  if (new Set(c.accounts.map(a => a.platform + ':' + (a.accountId || 'unbound'))).size !== c.accounts.length) throw fault('CONFIG', '账号重复绑定');
  for (const [key, max] of Object.entries({ itemsPerPlatform: 8, taskMinutes: 15, modelCallsPerDay: 12, inputTokensPerCall: 32000,
    outputTokensPerCall: 4096, outputCharsPerCall: 24000, imageInputsPerDay: 8, videoSecondsPerDay: 120,
    generatedImagesPerPost: 9, mediaBytesPerPost: 67108864, seenKeepDays: 90, notesKeepDays: 30 })) {
    if (!Number.isFinite(c.limits?.[key]) || c.limits[key] < 0 || c.limits[key] > max) throw fault('CONFIG', '无效处理上限：' + key);
  }
  if (!Number.isInteger(c.limits.itemsPerPlatform) || c.limits.taskMinutes < 1 || c.limits.generatedImagesPerPost < 1) throw fault('CONFIG', '浏览或素材数量无效');
  if (![c.budget?.dailyCny, c.budget?.weeklyCny, c.budget?.sharedBackgroundDailyCny].every(n => Number.isFinite(n) && n >= 0)) throw fault('CONFIG', '费用上限必须为非负数');
  c.dataRoot = dPath(path.join(bridgeRoot, 'social-data')); c.sharedRoot = dPath(c.sharedRoot);
  c.browser.executable = path.resolve(c.browser.executable);
  if (!fs.existsSync(c.browser.executable)) throw fault('CONFIG', '配置的浏览器程序不存在');
  return c;
}
export function accountKey(a) { return a.platform + ':' + a.accountId; }
