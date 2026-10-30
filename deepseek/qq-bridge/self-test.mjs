#!/usr/bin/env node
import { projectPath } from './project-paths.mjs';
/**
 * 离线自检：不连 QQ、不发消息，只验证「桥接 → 常驻 DSH → 模型」这条链路。
 *
 * 用法：
 *   node self-test.mjs                 # 默认问一句，打印回复与花费
 *   node self-test.mjs --prompt "你好"  # 自定义提示词
 *   node self-test.mjs --fish          # 成长写入、回忆和身份注入，不发送 QQ
 *   node self-test.mjs --companion     # 分类记忆、认识修正、共同人格和重启恢复
 *   node self-test.mjs --vision        # 原生识图、视觉经历与图片追问，不发 QQ
 *
 * 注意：它会在同一个 DSH_HOME 下再起一个 `dsh --profile sdk` 子进程。
 * 桥接正在运行时可能有 profile 锁冲突，排查“QQ 上没反应”时建议先停桥接再跑。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SdkRuntime } from './sdk-runtime.mjs';
import { costCny } from './quota.mjs';
import { mdToPlain } from './md-to-plain.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(HERE, 'config.json');
if (!existsSync(cfgPath)) {
  console.error(`[self-test] 缺少 ${cfgPath}`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
const cfg = {
  dshBin: projectPath("DeepSeek-Harness/resources/runtime/cli/bin/dsh.cmd"),
  patchFile: path.join(HERE, 'qq.patch.yml'),
  dshHome: projectPath(".dsh"),
  workspace: projectPath("work"),
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: '',
  apiKey: '',
  permissionMode: 'workspace-write',
  usdCny: 7.2,
  ...raw,
};

const argv = process.argv.slice(2);
if (argv.includes('--vision')) {
  try { await (await import('./vision-self-test.mjs')).runVisionSelfTest(cfg); }
  catch (e) { console.error(`[vision-self-test] 失败：${e.message}`); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
if (argv.includes('--companion')) {
  try { await (await import('./companion-self-test.mjs')).runCompanionSelfTest(cfg); }
  catch (e) { console.error(`[companion-self-test] 失败：${e.message}`); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
const promptFlag = argv.indexOf('--prompt');
const question = promptFlag >= 0
  ? argv.slice(promptFlag + 1).join(' ').trim() || '你好'
  : '这是桥接自检，请用一句话回答：你现在能正常工作吗？';

const PRICE = { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2, ...(cfg.price ?? {}) };
const yuan = (v) => `¥${v.toFixed(4)}`;
const t0 = Date.now();

const runtime = new SdkRuntime({
  bin: cfg.dshBin,
  patch: existsSync(cfg.patchFile) ? cfg.patchFile : undefined,
  cwd: cfg.workspace,
  provider: cfg.provider,
  model: cfg.model,
  reasoningEffort: cfg.reasoningEffort || undefined,
  env: {
    ...(cfg.apiKey ? { DSH_QQ_API_KEY: cfg.apiKey } : {}),
    DSH_QQ_SANDBOX: cfg.permissionMode,
    DSH_HOME: cfg.dshHome,
    TEMP: projectPath(".tmp"),
    TMP: projectPath(".tmp"),
  },
});

async function main() {
  if (argv.includes('--fish')) {
    const { runFishSelfTest } = await import('./fish-self-test.mjs');
    await runFishSelfTest(cfg);
    return;
  }
  console.log(`[1/3] 启动 DSH（${cfg.provider}/${cfg.model}）…`);
  await runtime.start();
  console.log(`[2/3] 投递自检消息：${question.slice(0, 60)}`);
  const result = await runtime.prompt('qq2-selftest', question, 180_000);
  const reply = mdToPlain(result.text);
  const cost = costCny(result.usage, PRICE, cfg.usdCny);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[3/3] 回复（${reply.length} 字，${secs}s，本turn ${yuan(cost)}）：`);
  console.log(reply || '(空回复)');
  const u = result.usage ?? {};
  const hit = u.cacheReadTokens ?? 0;
  const miss = (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  console.log(`tokens: 缓存命中 ${hit} / 未命中 ${miss} / 输出 ${u.outputTokens ?? 0}`);
  const calls = result.toolCalls ?? [];
  console.log(`工具调用: ${calls.length ? calls.map((c) => `${c.name}${c.ok === false ? '(失败)' : ''}`).join(', ') : '无'}`);
  if (!reply) {
    console.error('[self-test] 模型返回了空回复：检查 persona/patch 是否解析失败（看上面的 [dsh] 日志）');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`[self-test] 失败：${e.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await runtime.stop(); } catch { /* ignore */ }
  });
