/**
 * identity.test.mjs —— 身份走 system prompt，不走对话（2026-10-25 改）
 *
 * 背景（用户 m04984）：他在面板里看见她每轮都带着「规则约束 / 人格设定」，要求
 * 除开发环境外，用户绝对看不到提示词。
 *
 * 根因（内核 0.2.1-rc.3 已核实）：`home/AGENTS.md` 走的是宿主的「工作区指令」，
 * 注入的是**普通 user 消息**、带 `<system-reminder>` 外壳、留在对话历史里。
 * 现在改成 `agent.ctx.systemPrompt.section(...)`：system 角色消息、不进历史。
 *
 * 这个文件守三件事：
 *   1. 落盘副本换了名字（不叫 AGENTS.md，否则又会被注入）；
 *   2. 旧的 AGENTS.md 会被删掉（迁移），不然它继续注入，等于没改；
 *   3. 身份段只在**她那个 agent** 上注册，且拿不到 systemPrompt 时降级不崩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  IDENTITY_ORDER,
  IDENTITY_SECTION,
  WAKE_ORDER,
  WAKE_SECTION,
  attachIdentity,
  clearWakeSection,
  identityText,
  registerIdentity,
  resetIdentityCache,
  setWakeSection,
} from '../lib/identity.js'
import { legacySelfDocPath, selfDocPath } from '../lib/selfdoc.js'
import { DEFAULTS } from '../lib/settings.js'
import { BELIEF_SHOWN, SELF_DOC_BUDGET } from '../lib/persona.js'

const INDEX = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SAY = fs.readFileSync(new URL('../lib/say.js', import.meta.url), 'utf8')

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-identity-'))

test('落盘副本叫「她的身份.md」，不再叫 AGENTS.md', () => {
  const root = tmp()
  assert.ok(selfDocPath(root).endsWith('她的身份.md'))
  assert.ok(!selfDocPath(root).endsWith('AGENTS.md'), 'AGENTS.md 会被宿主当指令注入，不能用这个名')
  assert.ok(legacySelfDocPath(root).endsWith('AGENTS.md'))
})

test('identityText：文件不存在返回空串，不抛', () => {
  resetIdentityCache()
  const root = tmp()
  assert.equal(identityText(root), '')
})

test('identityText：读到文件内容，改文件后（mtime 变）能拿到新内容', async () => {
  resetIdentityCache()
  const root = tmp()
  const file = selfDocPath(root)
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(file, '第一版身份', 'utf8')
  assert.equal(identityText(root), '第一版身份')

  // 改内容并把 mtime 推开（同毫秒写入在部分文件系统上 mtime 不变）
  fs.writeFileSync(file, '第二版身份', 'utf8')
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  assert.equal(identityText(root), '第二版身份')
})

test('attachIdentity：挂两段——身份 + 这一次的处境（后者平时是空）', () => {
  resetIdentityCache()
  clearWakeSection()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  const calls = []
  const agent = { ctx: { systemPrompt: { section: (o) => calls.push(o) } } }
  const r = attachIdentity(agent, root)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2, '身份一段 + 处境一段')
  const sec = calls[0]
  assert.equal(sec.name, IDENTITY_SECTION)
  assert.equal(sec.order, IDENTITY_ORDER)
  assert.equal(typeof sec.text, 'function', 'text 必须是函数：每轮组装时现读，文件变了立即生效')
  assert.equal(sec.text(), '我是她')

  // 第二段：这一次的处境。平时空串（等于不存在），唤醒前才填。
  const wake = calls[1]
  assert.equal(wake.name, WAKE_SECTION)
  assert.equal(wake.order, WAKE_ORDER)
  assert.equal(typeof wake.text, 'function')
  assert.equal(wake.text(), '', '没唤醒时这段必须是空，否则他聊天时她还带着上一次的处境')
  setWakeSection('第 1 天，你醒了。')
  assert.equal(wake.text(), '第 1 天，你醒了。')
  clearWakeSection()
  assert.equal(wake.text(), '')
})

test('attachIdentity：没有 systemPrompt 时返回 ok:false，不抛', () => {
  const r = attachIdentity({ ctx: {} }, tmp())
  assert.equal(r.ok, false)
  assert.match(r.why, /systemPrompt/)
  const r2 = attachIdentity(undefined, tmp())
  assert.equal(r2.ok, false)
})

test('registerIdentity：只给她那个 agent 挂（按 cwd 判），别人不受影响', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  let handler = null
  const ctx = { on: (evt, fn) => { assert.equal(evt, 'agent/created'); handler = fn; return () => {} } }
  const off = registerIdentity(ctx, { root, herDir, log: () => {} })
  assert.equal(typeof off, 'function')
  assert.equal(typeof handler, 'function')

  const mine = []
  handler({ agent: { session: { header: { cwd: herDir } }, ctx: { systemPrompt: { section: (o) => mine.push(o) } } } })
  const others = []
  handler({ agent: { session: { header: { cwd: join(root, 'other') } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })
  handler({ agent: { session: { header: { cwd: '' } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })

  assert.equal(mine.length, 2, '她那条会话必须挂上（身份 + 处境两段）')
  assert.equal(others.length, 0, '用户自己的会话不许挂')
})

test('registerIdentity：ctx.on 不可用时返回空函数，不抛', () => {
  const off = registerIdentity({}, { root: tmp(), herDir: tmp(), log: () => {} })
  assert.equal(typeof off, 'function')
  off()
})

test('index.js：先写身份文本、再注册身份段、最后才建屋子', () => {
  const iPre = INDEX.indexOf('await writeSelfDoc(root')
  const iReg = INDEX.indexOf('registerIdentity(ctx')
  const iHome = INDEX.indexOf('await bootstrapHome(')
  assert.ok(iPre > 0 && iReg > 0 && iHome > 0)
  assert.ok(iPre < iReg, '文本要先生成，否则她第一轮拿到空串')
  assert.ok(iReg < iHome, '必须早于 bootstrapHome：她那条会话就是在里面创建的')
  assert.ok(!/身份文件：宿主每轮会重读它/.test(INDEX), '旧注释里「宿主每轮重读」已经不成立')
})

test('默认预算 1200 → 1800，且三处（配置、常量、界面）一致', () => {
  assert.equal(DEFAULTS.memory.docBudget, 1800)
  assert.equal(SELF_DOC_BUDGET, 1800)
  assert.ok(CLIENT.includes('useState(1800)'), '界面初始值要跟着改')
  assert.ok(CLIENT.includes("cfg.memory?.docBudget ?? 1800"))
  assert.ok(!CLIENT.includes('useState(1200)'), '旧的 1200 不许残留')
  // 判断区仍固定 3 条：这一条是「像工作记忆」，与预算无关
  assert.equal(BELIEF_SHOWN, 3)
})

test('say.js 不再把身份/工具说明塞进 user 消息（否则用户能在对话里看见）', () => {
  const say = SAY
  assert.ok(!/from '\.\/persona\.js'/.test(say), 'say.js 不该再 import persona')
  assert.ok(!say.includes('TOOL_BRIEF'), '工具说明由 system prompt 提供')
  assert.ok(!say.includes('personaLine'), '身份由 system prompt 提供')
  assert.ok(say.includes("const content = ['## 这次', '', ...parts]"))
})
