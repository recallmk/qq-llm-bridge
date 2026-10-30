/**
 * principle.test.mjs —— 原理页 + 两张自制 SVG（2026-10-25）
 *
 * 守五件事：
 *   1. 两张图真的在包里（`media/principle-*.svg`），且是合法 XML 片段（标签闭合、无裸 &）；
 *   2. 出图走服务端白名单路由，客户端不内联图（bundle 已经十多万字节，别再塞 SVG）；
 *   3. 页签顺序：插件 → 原理 → 数据（2026-10-25 文案页下线，原理仍夹在设置页与数据页之间）；
 *   4. 页面上把理论出处写全了（提出者不是装饰，改设计前要能看见）；
 *   5. 图与页面都不出现男字旁代词（沿用 p5 的口径）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLIENT = join(ROOT, 'lib', 'client.js')
const OBSERVE = join(ROOT, 'lib', 'observe.js')
const LOOP = join(ROOT, 'media', 'principle-loop.svg')
const MEMORY = join(ROOT, 'media', 'principle-memory.svg')
const PKG = join(ROOT, 'package.json')

test('两张原理图在包里，而且是完整的 svg', async () => {
  for (const [file, viewBox, must] of [
    // 图一 2026-10-25 重做：立场从底部一行字改成独立区块，画布 980 → 1160
    [LOOP, 'viewBox="0 0 1400 1160"', ['认知是怎么长出来的', '五步循环', '表态', '撞上', '落差', '改写', '回顾', '1 信任', '4 整合', '立场清单']],
    [MEMORY, 'viewBox="0 0 1400 980"', ['遗忘是怎么发生的', '记得很牢', '折叠 ≠ 删除', 'events.jsonl', 'her_recall']],
  ]) {
    const svg = await readFile(file, 'utf8')
    assert.ok(svg.startsWith('<svg'), `${file} 必须以 <svg 开头`)
    assert.ok(svg.trimEnd().endsWith('</svg>'), `${file} 必须完整闭合`)
    assert.ok(svg.includes(viewBox), `${file} 要有固定 viewBox（大屏小屏都按比例缩）`)
    for (const word of must) assert.ok(svg.includes(word), `${file} 里缺少「${word}」`)
    // 裸 & 会把 SVG 变成解析错误（XML 里 & 必须转义）
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(svg), `${file} 里有未转义的 &`)
    // 组标签必须成对，否则浏览器会静默截断后半张图
    const open = (svg.match(/<g[\s>]/g) || []).length
    const close = (svg.match(/<\/g>/g) || []).length
    assert.equal(open, close, `${file} 的 <g> 开合不配对：${open} vs ${close}`)
    assert.ok(!svg.includes('他'), `${file} 不许出现男字旁代词`)
  }
})

test('出图走服务端白名单路由，客户端不内联图', async () => {
  const ob = await readFile(OBSERVE, 'utf8')
  assert.ok(ob.includes("['/media', async (req, res)"), '必须有 /media 路由')
  assert.ok(ob.includes('/^\\/dsh-fish\\/media\\/(principle-[a-z]+\\.svg)$/'), '文件名必须白名单匹配')
  assert.ok(ob.includes("'content-type': 'image/svg+xml; charset=utf-8'"), '必须声明 svg 类型')
  assert.ok(ob.includes('fileURLToPath(new URL(`../media/'), '必须从包内 media/ 读文件')

  const cl = await readFile(CLIENT, 'utf8')
  assert.ok(cl.includes('`${API}/media/principle-loop.svg`'), '图一必须走 /media 路由')
  assert.ok(cl.includes('`${API}/media/principle-memory.svg`'), '图二必须走 /media 路由')
  assert.ok(!cl.includes('<svg'), '客户端里不许内联 SVG（会让 bundle 无谓变大）')
})

test('页签顺序：插件 → 原理 → 数据', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  const tabs = cl.match(/const TABS = \[([\s\S]*?)\n {6}\]/)
  assert.ok(tabs, '必须能定位到 TABS')
  const ids = [...tabs[1].matchAll(/\['([a-z]+)', '[^']+'\]/g)].map((m) => m[1])
  assert.deepEqual(ids, ['now', 'grow', 'home', 'bili', 'memory', 'env', 'principle', 'data'])
  assert.ok(cl.includes("principle: '原理："), 'TAB_HELP 必须有原理页说明')
  assert.ok(cl.includes("showTab('principle') ? principlePage : null"), '必须真的挂上渲染')
  assert.ok(cl.indexOf("showTab('principle')") > cl.indexOf("showTab('env')"), '原理在插件之后')
  assert.ok(cl.indexOf("showTab('principle')") < cl.indexOf("showTab('data')"), '原理在数据之前')
})

test('原理页把理论出处写全了', async () => {
  const cl = await readFile(CLIENT, 'utf8')
  for (const name of [
    'Kolb 经验学习圈', 'Piaget 失衡', 'Bowlby 依恋理论', 'Erikson 心理社会发展',
    'Festinger 认知失调', 'Bartlett 重构记忆', 'Cowan 工作记忆容量', 'Tulving 线索依赖遗忘',
    'Bjork 遗忘的适应功能', 'Dewey 经验连续性', 'Schön 反思性实践', 'Vygotsky 最近发展区',
    'Bloom 掌握学习', 'Metzinger 自我模型',
  ]) {
    assert.ok(cl.includes(name), `原理页必须提到「${name}」`)
  }
  for (const scene of ['学习', '认知重构', '人格养成']) {
    assert.ok(cl.includes(scene), `用途里必须有「${scene}」`)
  }
  assert.ok(cl.includes('诚实边界'), '必须写明这只是借理论当骨架')
  assert.ok(!/他/.test(cl.slice(cl.indexOf('const principlePage'), cl.indexOf('const envPage'))), '原理页文字不许出现男字旁代词')
})

test('package.json 会一起发布 media/', async () => {
  const pkg = JSON.parse(await readFile(PKG, 'utf8'))
  assert.ok(pkg.files.includes('media'), 'files 里必须带上 media，否则装出去没有图')
})
