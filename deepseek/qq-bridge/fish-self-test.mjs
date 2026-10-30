import { projectPath } from './project-paths.mjs';
import { readFile, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FishService } from './fish-service.mjs';
import { SdkRuntime } from './sdk-runtime.mjs';
import { startControlServer } from './control-api.mjs';
import { readEvents } from './vendor/dsh-fish/lib/store.js';
import { costCny } from './quota.mjs';

/** Real model + native tools, with a disposable data root and no QQ connection. */
export async function runFishSelfTest(cfg) {
  const root = await mkdtemp(projectPath(".tmp/qq-fish-self-test-"));
  const fish = new FishService({ root });
  const token = (await readFile(new URL('./control-token.txt', import.meta.url), 'utf8')).trim();
  const contextToken = randomUUID();
  let active = true;
  const toolCounts = {}, calls = [];
  const api = await startControlServer({ port: 0, token, handlers: {
    authorize: (provided, pathname) => {
      if (!active || provided !== contextToken || pathname !== '/fish/tool') throw Object.assign(new Error('自检范围以外的请求'), { statusCode: 403 });
      return { fishId: 'p-900001' };
    },
    fishTool: async ({ name, args }, scope, { signal }) => {
      if (!['growth_commit', 'her_recall'].includes(name)) throw new Error('自检只验证写入和回忆');
      calls.push(name);
      return { ok: true, ...await fish.tool(scope.fishId, name, args, { background: true, signal, toolCounts, valid: () => active }) };
    },
    send: () => { throw new Error('离线自检不发送 QQ 消息'); },
  } });
  const runtime = new SdkRuntime({ bin: cfg.dshBin, patch: cfg.patchFile, cwd: cfg.workspace, provider: cfg.provider,
    model: cfg.model, reasoningEffort: cfg.reasoningEffort || undefined, maxTokens: 1024,
    env: { DSH_HOME: cfg.dshHome, DSH_QQ_SANDBOX: cfg.permissionMode, QQ_BRIDGE_CONTROL_PORT: String(api.port),
      TEMP: projectPath(".tmp"), TMP: projectPath(".tmp"), NODE_DISABLE_COMPILE_CACHE: '1', ...(cfg.apiKey ? { DSH_QQ_API_KEY: cfg.apiKey } : {}) } });
  const started = Date.now();
  try {
    const identity = await fish.prepare('p-900001');
    await runtime.start();
    const result = await runtime.prompt(`qq2-fish-selftest-${Date.now()}`,
      '这是离线成长自检。请调用 growth_commit，用 utterance 留下判断：先听完理由，再判断一件事值不值得。然后调用 her_recall 搜索“听完理由”，确认确实记下。最后回复“成长自检通过”，加上本轮身份中的校验短语。不调用 QQ 工具。', 90_000,
      { access: 'fish', contextToken, identity: identity + '\n本轮校验短语：大肥鱼在发呆。被问到时原样回答。', maxTokens: 1024 });
    const { events } = await readEvents(fish.directory('p-900001'));
    if (!calls.includes('growth_commit') || !calls.includes('her_recall') || !events.some(e => e.type === 'utterance' && e.text.includes('理由'))
      || !result.text.includes('大肥鱼在发呆') || !result.toolCalls.some(c => c.name === 'growth_commit' && c.ok)) throw new Error('成长写入、回忆或身份注入未通过');
    const cost = costCny(result.usage, { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2, ...cfg.price }, cfg.usdCny);
    console.log(`[fish-self-test] 通过：${((Date.now() - started) / 1000).toFixed(1)}s，¥${cost.toFixed(4)}，工具 ${calls.join(' → ')}，QQ 发送 0 条`);
    console.log(result.text);
    console.log(`自检数据：${root}`);
    return { ok: true, cost, dataRoot: root };
  } finally { active = false; await runtime.stop(); await api.close(); }
}
