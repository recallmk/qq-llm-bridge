import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SocialService } from './service.mjs';
import { Browser } from './browser.mjs';
import { acquireLock, fault, cleanError } from './io.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), at = args.indexOf('--bot'), bot = at >= 0 ? args[at + 1] : '';
if (!['deepseek', 'gemini'].includes(bot)) { console.error('Usage: node social/cli.mjs <status|connection|login|pause-browse|resume-browse|pause-publish|resume-publish|cancel-draft|budget> --bot <deepseek|gemini>'); process.exit(2); }
const bridgeRoot = path.join(repo, bot === 'deepseek' ? 'ds-QQ/qq-bridge' : 'gemini-QQ/bridge');
const service = new SocialService({ bridgeRoot, model: async () => { throw fault('DENIED', '管理CLI永不调用模型或触发浏览/发布任务'); }, isForegroundBusy: () => false });
const option = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
try {
  let result;
  if (args[0] === 'status') result = await service.status();
  else if (args[0] === 'connection') result = await service.inspectAccounts();
  else if (args[0] === 'login') {
    const a = service.config.accounts.find(a => a.platform === (option('platform') || 'xiaohongshu') && a.enabled);
    if (!a) throw fault('CONFIG', '找不到明确绑定的账号');
    const unlock = acquireLock(path.join(service.config.sharedRoot, 'locks'), 'account:' + a.platform + ':' + a.accountId);
    if (!unlock) throw fault('FOREGROUND', '对应账号正在被后台使用');
    let browser;
    try { browser = await Browser.open(service.config, a, { visible: true }); await browser.navigate(option('surface') === 'browse' ? 'https://www.xiaohongshu.com/' : 'https://creator.xiaohongshu.com/');
      result = { ok: true, accountId: a.accountId, message: '请用户自行完成登录，然后运行 connection 核对；未自动执行任何验证或登录表单' };
    } finally { await browser?.close({ keepOpen: true }); unlock(); }
  } else {
    const command = { action: args[0] };
    if (command.action === 'cancel-draft') command.taskId = option('task');
    if (command.action === 'budget') for (const [flag, key] of [['daily', 'dailyCny'], ['weekly', 'weeklyCny'], ['shared-daily', 'sharedBackgroundDailyCny']]) if (option(flag) !== undefined) command[key] = Number(option(flag));
    result = await service.control(command);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(JSON.stringify({ ok: false, code: error.code || 'FAILED', error: cleanError(error) })); process.exitCode = 1; }
