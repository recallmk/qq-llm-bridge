/**
 * tools.test.mjs —— 工具注册的形状守门
 *
 * 为什么单独一个文件（2026-10-25）：
 *   用全新 profile 从 tarball 装一遍才发现，npm 装进来的插件真实路径在
 *   `<profile>/node_modules/dsh-fish/`，往上能找到宿主的 `@deepseek-ai/dsh-tools`，
 *   于是 `defineTool` 真的被调用——它期待「简写 DSL 属性表」，我们传的是完整
 *   JSON Schema，编译时把根上的 `type:'object'` 当成一个叫 type 的参数，报
 *     unsupported JSON schema: parameters.type must be a value schema object
 *   → 6 个工具全部注册失败。本机是 link: 装的，往上找不到那个包，走兜底，所以
 *   这条 bug 只会在别人装了之后出现。
 *
 * 这里守三件事：
 *   1. lib/ 里不许再 import 宿主的 dsh-tools；
 *   2. `defineTool(spec)` 就是恒等（注册时直接交 JSON Schema）；
 *   3. 七个工具定义都长成宿主认的形状（parameters 是 object-rooted JSON Schema、
 *      output.schema 也是、render / execute 是函数）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { defineTool } from '../lib/tool.js'
import { registerCapture } from '../lib/capture.js'
import { registerLetter } from '../lib/letter.js'
import { registerLook } from '../lib/look.js'
import { registerRecall } from '../lib/recall.js'
import { registerSpeak } from '../lib/speak.js'
import { registerWatch } from '../lib/watch.js'
import { FISH_TOOLS, HER_TOOLS } from '../lib/restrict.js'
import { runChecks } from '../lib/selfcheck.js'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const ROOT = join(tmpdir(), 'dsh-fish-tools-test')

function fakeCtx() {
  const defs = []
  return {
    defs,
    tools: {
      register(d) {
        defs.push(d)
        return () => {}
      },
    },
  }
}

test('lib/ 里不再 import 宿主的 dsh-tools', () => {
  const hits = []
  for (const f of readdirSync(LIB)) {
    if (!f.endsWith('.js')) continue
    const s = readFileSync(join(LIB, f), 'utf8')
    // 注释里可以提这个名字（tool.js 就在解释为什么不用它），但代码里不许出现
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/@deepseek-ai\/dsh-tools/.test(code)) hits.push(f)
  }
  assert.deepEqual(hits, [], '这些文件又把宿主的 dsh-tools import 回来了')
})

test('defineTool 是恒等：不编译、不改写', () => {
  const spec = { name: 'x', parameters: { type: 'object', properties: {} } }
  assert.equal(defineTool(spec), spec)
})

test('七个工具定义都长成宿主认的形状', () => {
  const ctx = fakeCtx()
  const deps = { root: ROOT, log: () => {} }
  registerCapture(ctx, deps)
  registerLetter(ctx, deps)
  registerLook(ctx, deps)
  registerRecall(ctx, deps)
  registerSpeak(ctx, deps)
  registerWatch(ctx, deps)

  assert.equal(ctx.defs.length, 6, '我们自己的工具是 6 个（第 7 个 read_image 是宿主的）')
  const names = ctx.defs.map((d) => d.name)
  for (const n of names) assert.ok(FISH_TOOLS.includes(n), `${n} 不在 FISH_TOOLS 里`)

  for (const d of ctx.defs) {
    assert.equal(typeof d.name, 'string')
    assert.ok(d.description.length > 10, `${d.name} 的说明太短`)
    // parameters：根级 object JSON Schema（不是简写 DSL）
    assert.equal(d.parameters?.type, 'object', `${d.name}.parameters 根级必须是 object`)
    assert.equal(typeof d.parameters.properties, 'object', `${d.name}.parameters.properties 缺失`)
    assert.ok(!('required' in d.parameters) || Array.isArray(d.parameters.required))
    // output：宿主 registry 会校验它
    assert.equal(d.output?.schema?.type, 'object', `${d.name}.output.schema 根级必须是 object`)
    assert.equal(typeof d.output.render, 'function', `${d.name}.output.render 必须是函数`)
    assert.equal(typeof d.execute, 'function', `${d.name}.execute 必须是函数`)
  }
})

test('自检按 registry 里真的在不在判断，而不是配置名单', async () => {
  const cfg = { growthDays: 30, window: { start: '20:00', end: '23:00' }, tools: {} }
  const allThere = { get: (n) => (HER_TOOLS.includes(n) ? { name: n } : undefined) }
  const R = { allow: [...HER_TOOLS], applied: 1, failed: '' }
  const ok = await runChecks({ root: ROOT, config: cfg, host: {}, tools: allThere, restrict: R, net: false })
  const okItem = ok.items.find((i) => i.id === 'tools')
  assert.equal(okItem.ok, true, okItem.detail)

  // read_image 缺失只提示、不算失败
  const noImage = { get: (n) => (n === 'read_image' ? undefined : { name: n }) }
  const img = await runChecks({ root: ROOT, config: cfg, host: {}, tools: noImage, restrict: R, net: false })
  const imgItem = img.items.find((i) => i.id === 'tools')
  assert.equal(imgItem.ok, true, imgItem.detail)
  assert.match(imgItem.detail, /read_image/)

  const missingOne = { get: (n) => (n === 'growth_commit' ? undefined : { name: n }) }
  const bad = await runChecks({ root: ROOT, config: cfg, host: {}, tools: missingOne, net: false })
  const badItem = bad.items.find((i) => i.id === 'tools')
  assert.equal(badItem.ok, false)
  assert.match(badItem.detail, /growth_commit/)
  assert.match(badItem.fix, /日志/)
})
