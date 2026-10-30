import { projectPath } from './project-paths.mjs';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FishService } from './fish-service.mjs';
import { SdkRuntime } from './sdk-runtime.mjs';
import { startControlServer } from './control-api.mjs';
import { buildChatPrompt } from './conversation.mjs';
import { costCny } from './quota.mjs';

/** Actual DSH/tool round trips, isolated test records and zero QQ sends. */
export async function runCompanionSelfTest(cfg) {
  const root = await mkdtemp(projectPath(".tmp/qq-companion-self-test-"));
  const fish = new FishService({ root });
  const token = (await readFile(new URL('./control-token.txt', import.meta.url), 'utf8')).trim();
  const contextToken = randomUUID(), calls = [], details = [], counts = {};
  let active = true;
  const api = await startControlServer({ port: 0, token, handlers: {
    authorize: (provided, pathname) => {
      if (!active || provided !== contextToken || pathname !== '/fish/tool') throw Object.assign(new Error('自检范围以外'), { statusCode: 403 });
      return { fishId: 'p-900001' };
    },
    fishTool: async ({ name, args }, scope, { signal }) => {
      if (!['companion_remember', 'companion_recall'].includes(name)) throw new Error('这里只验证分类记忆');
      calls.push(name);
      try {
        const response = await fish.tool(scope.fishId, name, args, { signal, toolCounts: counts, valid: () => active });
        details.push({ name, args, value: response.value });
        return { ok: true, ...response };
      } catch (e) { details.push({ name, args, error: e.message }); throw e; }
    },
    send: () => { throw new Error('离线自检不发送 QQ'); },
  } });
  const runtime = new SdkRuntime({ bin: cfg.dshBin, patch: cfg.patchFile, cwd: cfg.workspace, provider: cfg.provider,
    model: cfg.model, reasoningEffort: cfg.reasoningEffort || undefined, maxTokens: 1600,
    env: { DSH_HOME: cfg.dshHome, DSH_QQ_SANDBOX: cfg.permissionMode, QQ_BRIDGE_CONTROL_PORT: String(api.port),
      TEMP: projectPath(".tmp"), TMP: projectPath(".tmp"), NODE_DISABLE_COMPILE_CACHE: '1', ...(cfg.apiKey ? { DSH_QQ_API_KEY: cfg.apiKey } : {}) } });
  let cost = 0;
  const started = Date.now();
  try {
    const obs = await fish.observe('p-900001', { speakerId: '900001', speakerName: '测试林舟', messageId: '1001', text: '我喜欢黑咖啡。' });
    const first = await fish.tool('p-900001', 'companion_remember', { kind: 'person', topic: '饮品喜好',
      subjectId: '900001', text: '测试林舟自述喜欢黑咖啡', evidenceIds: [obs.id] });
    const next = await fish.observe('p-900001', { speakerId: '900001', speakerName: '测试林舟', messageId: '1002', text: '我现在不喝黑咖啡了，改喝热茶。' });
    const identity = await fish.prepare('p-900001', { message: '饮品喜好', participants: ['900001'] });
    await runtime.start();
    const meta = { isGroup: false, senderId: '900001', senderName: '测试林舟', direct: true, observationId: next.id };
    const prompt = buildChatPrompt({ messages: [{ ...meta, text: next.text }], meta });
    const result = await runtime.prompt(`qq2-companion-selftest-${Date.now()}`, `${prompt}\n\n离线集成验证：先用 companion_recall 查“饮品喜好”，再用 companion_remember 修正这位发言人的饮品喜好，revises 指向翻到的旧记忆、evidenceIds 使用本轮 observationId。然后记一条自己的初步看法：主题“慢慢了解”，stance=favor，说明更喜欢通过持续相处认识人，来源仍指向本轮。最后只回复“分类记忆自检通过”。不调用 QQ 或其他工具。`, 90_000,
      { access: 'fish', contextToken, identity, maxTokens: 1600 });
    const remembered = await fish.companion.recall('p-900001', { subjectId: '900001' });
    await writeFile(`${root}/integration-result.json`, JSON.stringify({ details, result }, null, 2));
    const revised = remembered.memories.find(r => r.revises === first.value.id && r.text.includes('热茶'));
    const otherIdentity = await fish.prepare('g-900002');
    if (!revised || !calls.includes('companion_recall') || calls.filter(n => n === 'companion_remember').length < 2
      || !otherIdentity.includes('慢慢了解') || /黑咖啡|热茶|测试林舟/.test(otherIdentity)
      || !result.toolCalls.some(c => c.name === 'companion_remember' && c.ok)) throw new Error('分类记忆、修正、共同人格或场景隔离未通过');
    const restarted = new FishService({ root });
    const retained = await restarted.companion.recall('p-900001', { subjectId: '900001' });
    if (retained.memories[0]?.id !== revised.id) throw new Error('重启后未恢复修正记忆');
    cost = costCny(result.usage, { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2, ...cfg.price }, cfg.usdCny);
    console.log(`[companion-self-test] 通过：${((Date.now() - started) / 1000).toFixed(1)}s，¥${cost.toFixed(4)}，工具 ${calls.join(' → ')}，QQ 发送 0 条`);
    console.log('已验证：真实模型调用、旧认识修正、共享一般倾向、跨场景隔离、重启恢复。');
    console.log(`自检数据：${root}`);
    return { ok: true, cost, dataRoot: root };
  } finally { active = false; await runtime.stop(); await api.close(); }
}
