import { projectPath } from './project-paths.mjs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SdkRuntime } from './sdk-runtime.mjs';
import { FishService } from './fish-service.mjs';
import { QqImages } from './qq-images.mjs';
import { visionFixture } from './vision-fixture.mjs';
import { startControlServer } from './control-api.mjs';
import { buildChatPrompt } from './conversation.mjs';
import { costCny } from './quota.mjs';

/** Real account vision and memory tools; only NapCat's file lookup is simulated. */
export async function runVisionSelfTest(cfg) {
  const root = await mkdtemp(projectPath(".tmp/qq-vision-self-test-"));
  const image = visionFixture(), file = path.join(root, 'source.png'); await writeFile(file, image.bytes);
  const fish = new FishService({ root: path.join(root, 'fish') });
  let fileLookups = 0, active = true; const scope = 'p-900003', calls = [], toolCounts = {}, contextToken = randomUUID();
  const imageConfig = { root: path.join(root, 'images'), localRoots: [root],
    call: async action => { if (action !== 'get_image') throw new Error('Only file lookup is simulated'); fileLookups++; return { status: 'ok', data: { file } }; } };
  const store = new QqImages(imageConfig);
  const ids = await store.capture(scope, [{ file: 'opaque-qq-image-id', url: '' }], { messageId: '7001', senderId: '900003' });
  const observation = await fish.observe(scope, { speakerId: '900003', speakerName: '测试发言人', messageId: '7001', text: '[图片]', imageIds: ids });
  await store.bind(scope, ids, observation.id);
  const master = (await readFile(new URL('./control-token.txt', import.meta.url), 'utf8')).trim();
  const api = await startControlServer({ port: 0, token: master, handlers: {
    authorize: (token, pathname) => {
      if (!active || token !== contextToken || pathname !== '/fish/tool') throw Object.assign(new Error('自检范围外的请求'), { statusCode: 403 });
      return { fishId: scope };
    },
    fishTool: async ({ name, args }, current, { signal }) => {
      if (!['companion_remember', 'companion_recall'].includes(name)) throw new Error('自检仅验证视觉经历记忆');
      calls.push(name); return { ok: true, ...await fish.tool(current.fishId, name, args, { signal, toolCounts, valid: () => active }) };
    },
    send: () => { throw new Error('离线自检不发送 QQ'); },
  } });
  const runtime = new SdkRuntime({ bin: cfg.dshBin, patch: cfg.patchFile, cwd: cfg.workspace, provider: cfg.provider,
    model: cfg.model, reasoningEffort: cfg.reasoningEffort || undefined, maxTokens: 1000,
    env: { DSH_HOME: cfg.dshHome, DSH_QQ_SANDBOX: cfg.permissionMode, QQ_BRIDGE_CONTROL_PORT: String(api.port),
      TEMP: projectPath(".tmp"), TMP: projectPath(".tmp"), NODE_DISABLE_COMPILE_CACHE: '1', ...(cfg.apiKey ? { DSH_QQ_API_KEY: cfg.apiKey } : {}) } });
  const started = Date.now(), sessionId = `qq2-vision-selftest-${Date.now()}`; let totalCost = 0;
  const charge = result => { totalCost += costCny(result.usage, { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2, ...cfg.price }, cfg.usdCny); };
  const parse = result => JSON.parse(result.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
  try {
    const meta = { isGroup: false, senderId: '900003', senderName: '测试发言人', observationId: observation.id, imageIds: ids, direct: true, replyToMessageId: '7001' };
    const messages = [{ ...meta, text: '[图片] 这张图中的四位数字和最左边色块颜色是什么？' }];
    const visual = await store.prepare(scope, messages);
    const identity = await fish.prepare(scope, { message: messages[0].text, participants: ['900003'] });
    const first = await runtime.prompt(sessionId, buildChatPrompt({ messages, meta, attachedImages: visual.attachedImages })
      + '\n离线集成自检：先实际读图，再用 companion_remember 保存一条 episode，记录实际看到的数字和左侧颜色，evidenceIds 使用这张图片的 observationId。最后只返回 JSON {"code":"四位数字","color":"左侧颜色中文名"}。数字保留前导零。不调用其他工具。',
    90_000, { access: 'fish', contextToken, identity, images: visual.images, maxTokens: 1000 });
    charge(first); const answer = parse(first);
    const memory = await fish.companion.recall(scope, { limit: 8 });
    await writeFile(path.join(root, 'first-result.json'), JSON.stringify({ result: first, expected: { code: image.code, color: image.color }, memory }, null, 2));
    if (answer.code !== image.code || !String(answer.color).includes(image.color[0])
      || !memory.memories.some(r => r.kind === 'episode' && r.text.includes(image.code) && r.evidenceIds.includes(observation.id))) throw new Error('原生识图或视觉经历记忆未通过');
    const restarted = new QqImages(imageConfig);
    const followup = [{ ...meta, imageIds: [], text: '刚才那张图最右边的色块是什么颜色？' }];
    const recalled = await restarted.prepare(scope, followup);
    if (recalled.images.length !== 1 || fileLookups !== 1 || recalled.attachedImages[0].imageId !== ids[0]) throw new Error('图片上下文或重启缓存恢复未通过');
    const next = await runtime.prompt(sessionId, buildChatPrompt({ messages: followup, meta, attachedImages: recalled.attachedImages })
      + '\n继续离线自检：只返回 JSON {"rightColor":"最右边颜色中文名"}，不调用工具。',
    90_000, { access: 'fish', contextToken, identity: await fish.prepare(scope), images: recalled.images, maxTokens: 300 });
    charge(next);
    if (!String(parse(next).rightColor).includes(image.rightColor[0])) throw new Error('回看原图未通过');
    console.log(`[vision-self-test] 通过：${((Date.now() - started) / 1000).toFixed(1)}s，¥${totalCost.toFixed(4)}，QQ 发送 0 条`);
    console.log('已验证：真实登录通道读随机数字／色块、视觉经历来源、缓存重启恢复、刚才那张图的追问。');
    console.log(`自检数据：${root}`);
    return { ok: true, cost: totalCost, dataRoot: root };
  } finally { active = false; await runtime.stop(); await api.close(); }
}
