/**
 * paths.test.mjs —— 数据文件夹：路径由服务端算、界面上不出现绝对路径
 *
 * 背景（用户 m03440，2026-10-24）：
 *   原来「住所」页把每个子目录的绝对路径都印在页面上，而这些路径是客户端
 *   拿 workspace 目录名反推根目录、再用反斜杠拼出来的——目录改名就推错，
 *   换平台也错。现在一律由服务端 /paths 现算，界面上只留一个「复制」按钮。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { README_MARK, README_NAME, README_TEXT, ensureDataReadme } from '../lib/readme.js'

const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const OBSERVE = fs.readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-paths-'))

test('readme：缺了就写一份，带着版本标记', () => {
  const root = tmp()
  const r = ensureDataReadme(root)
  assert.equal(r.wrote, true)
  const text = fs.readFileSync(join(root, README_NAME), 'utf8')
  assert.ok(text.startsWith(README_MARK), '第一行必须是版本标记')
  assert.ok(text.includes('events.jsonl'))
  assert.ok(text.includes('logs/dsh-fish.log'))
  assert.equal(text, README_TEXT)
})

test('readme：已经是当前版本就不覆盖（用户改过的内容不许被冲掉）', () => {
  const root = tmp()
  ensureDataReadme(root)
  const file = join(root, README_NAME)
  fs.writeFileSync(file, `${README_MARK}\n我自己的笔记\n`, 'utf8')
  const r = ensureDataReadme(root)
  assert.equal(r.wrote, false)
  assert.equal(r.reason, 'current')
  assert.ok(fs.readFileSync(file, 'utf8').includes('我自己的笔记'))
})

test('readme：版本标记落后就重写', () => {
  const root = tmp()
  const file = join(root, README_NAME)
  fs.writeFileSync(file, '<!-- fish-docs:v0 -->\n旧的说明\n', 'utf8')
  const r = ensureDataReadme(root)
  assert.equal(r.wrote, true)
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(README_MARK))
})

test('readme：写不进去也不抛（观测台顺手调它，不该拖垮整页）', () => {
  // 拿一个「父级是文件」的路径：mkdir 会 ENOTDIR，ensureDataReadme 必须吞掉它。
  const base = tmp()
  const file = join(base, 'not-a-dir')
  fs.writeFileSync(file, 'x', 'utf8')
  const r = ensureDataReadme(join(file, 'sub'))
  assert.equal(r.wrote, false)
  assert.equal(typeof r.reason, 'string')
})

test('服务端有 /paths，客户端不再自己拼路径', () => {
  assert.ok(OBSERVE.includes("['/paths', async (req, res) => {"))
  assert.ok(OBSERVE.includes('ensureDataReadme(root)'))
  assert.ok(OBSERVE.includes('inbox: join(p.root'))
  // 旧的客户端拼法必须全部消失
  assert.equal(CLIENT.includes('stateRoot'), false)
  assert.equal(CLIENT.includes('statePath('), false)
  assert.equal(CLIENT.includes('joinPath('), false)
  // 也不许再把日志目录印在页面上
  assert.equal(CLIENT.includes('logTail.dir'), false)
  assert.ok(CLIENT.includes("jget('/paths')"))
  assert.ok(CLIENT.includes('复制数据文件夹路径'))
})

test('「危险」页改名「数据」，仍是 8 个页签，排最后', () => {
  assert.ok(CLIENT.includes("['data', '数据']"))
  assert.equal(CLIENT.includes("['danger'"), false)
  assert.ok(CLIENT.includes("showTab('data') ? dataPage : null"))
  assert.ok(CLIENT.includes("group('数据在哪'"))
  // 每日报告与运行日志都在数据页里（不只在住所页）
  const dataIdx = CLIENT.indexOf("const dataPage = h(")
  assert.ok(dataIdx > 0)
  assert.ok(CLIENT.indexOf("groupFull('每日报告'", dataIdx) > dataIdx)
  assert.ok(CLIENT.indexOf("group('运行日志导出'", dataIdx) > dataIdx)
})

test('复制之后不再把路径回显在提示里', () => {
  assert.ok(CLIENT.includes('已复制到剪贴板。粘到资源管理器地址栏回车就能打开。'))
  assert.equal(CLIENT.includes('setNote(`已复制路径'), false)
})
