import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// 2026-10-24（用户 m03888）：设置项改成「改完就生效」。
// 原来的问题是：每个页签底部挂一颗「保存改动」，住所页没有设置项也挂着一颗，
// 让人以为必须点；上网页设置项很多，只改一半、没滚到底，改动就不生效且没有任何提示。
const CLIENT = new URL('../lib/client.js', import.meta.url)
const STATUS = new URL('../lib/status.js', import.meta.url)

test('设置页不再有底部保存条，改成改完即存', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(!src.includes(": '保存改动'"), '「保存改动」按钮必须删掉（已改为自动保存）')
  assert.ok(!src.includes('saveBar'), 'saveBar 必须整个删掉，不要留空壳')
  assert.ok(src.includes('这里的改动改完就生效，不需要点保存。'), '页面顶部要写明不需要点保存')
  assert.ok(src.includes('const buildConfig = () => ({'), '字段表要集中在一处（自动保存与手动保存共用）')
  assert.ok(src.includes('const badNumber = () =>'), '数字框半截值要先判，不写盘')
  assert.ok(src.includes('}, 700)'), '自动保存要防抖（连点加减号只写一次）')
  assert.ok(src.includes('setAutoNote(`已保存 '), '保存成功后要有回执，而不是静默')
})

test('自动保存不会在首屏载入时把配置回写一遍', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('baselinePending.current = true'), '每次 load 都要重置基线')
  assert.ok(src.includes('if (baselinePending.current) { baselinePending.current = false; lastSaved.current = cfgSig; return }'),
    '首屏那次只记基线，不发请求')
  assert.ok(src.includes('if (cfgSig === lastSaved.current) return'), '签名没变就不发请求')
})

test('状态卡的四个句子按用户定稿改了', async () => {
  const src = await readFile(STATUS, 'utf8')
  for (const s of ['上次行动是在 ${minutesAgo} 分钟前', '会睡醒', '虽然什么都没干，但是累了，不会再醒了', '醒了，在发呆']) {
    assert.ok(src.includes(s), `status.js 里应有「${s}」`)
  }
  for (const s of ['上次动是', '会醒${mins', '今天不会再醒了', '醒了，但什么也没做']) {
    assert.ok(!src.includes(s), `status.js 里不该再有「${s}」`)
  }
})

test('「改完就生效」那句话只出现在真有设置项的页签', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes("const AUTO_SAVE_TABS = new Set(['grow', 'bili', 'memory'])"),
    '只有成长 / 上网 / 记忆三页是自动保存')
  assert.ok(src.includes("AUTO_SAVE_TABS.has(tab) ? h('p'"),
    '提示行要按当前页签判断')
  assert.ok(src.includes("AUTO_SAVE_TABS.has(tab) && autoNote ?"),
    '「已保存」回执也只在有设置项的页签显示')
  for (const t of ['now', 'home', 'env', 'data']) {
    assert.ok(!src.includes(`AUTO_SAVE_TABS = new Set(['grow', 'bili', 'memory', '${t}'`),
      `${t} 不该加进自动保存页签`)
  }
})
