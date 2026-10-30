/**
 * log.test.mjs —— 运行日志（2026-10-24 加）
 *
 * 这里测的不是"能写"。能写是显然的。要钉住的是三条容易悄悄坏掉的性质：
 *   1. **永不抛**：盘满、目录没了、root 是怪值，都不能连带让插件挂掉。
 *   2. **脱敏**：cookie 一类的值进不了日志文件。这条一旦失效，用户把日志导出发给
 *      别的 AI 排查的同时就把账号送出去了。
 *   3. **导出包不含不该外带的东西**：配置里的 cookie 字段、owner 里的凭据。
 *
 * 另外一个反直觉的规矩也要钉：**日志没有开关**。没有 `log.enabled` 这种配置键——
 * 出事那一刻才发现日志关着，是最常见的一种后悔。测试直接断言 DEFAULTS 里没这组。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  LOG_MAX_BYTES,
  LINE_MAX,
  buildBundle,
  clearLog,
  logBoot,
  logLine,
  logFile,
  makeLogger,
  redactConfig,
  scrub,
  tailLog,
} from '../lib/log.js'
import { DEFAULTS } from '../lib/settings.js'

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'fish-log-'))
}

test('写一行就能读回来，带级别与时间戳', async () => {
  const root = await tempRoot()
  assert.equal(logLine('info', ['你好'], root), true)
  const tail = tailLog(root)
  assert.equal(tail.exists, true)
  assert.equal(tail.lines.length, 1)
  assert.match(tail.lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[info\] 你好$/)
})

test('tailLog 只给最后 N 行，并且丢掉被截断的半截首行', async () => {
  const root = await tempRoot()
  for (let i = 0; i < 12; i += 1) logLine('info', [`第 ${i} 行`], root)
  const tail = tailLog(root, { lines: 3 })
  assert.equal(tail.lines.length, 3)
  assert.match(tail.lines[2], /第 11 行/)
  // maxBytes 小到切在行中间时，第一行必须是完整的行（不能以半句开头）
  const cut = tailLog(root, { lines: 5, maxBytes: 40 })
  for (const line of cut.lines) assert.match(line, /^\d{4}-\d{2}-\d{2} /)
})

test('没有日志文件时不抛，如实说没有', async () => {
  const root = await tempRoot()
  const tail = tailLog(root)
  assert.equal(tail.exists, false)
  assert.deepEqual(tail.lines, [])
  assert.equal(tail.bytes, 0)
})

test('root 是怪值也永不抛（日志坏了不能连带插件挂掉）', () => {
  // 用一段既不像路径、Windows 上又确实建不出来的串
  const bad = 'D:\\u0000nul\\\u0000bad'
  assert.doesNotThrow(() => logLine('error', ['写不进去也没关系'], bad))
  assert.equal(logLine('info', ['x'], bad), false)
  assert.doesNotThrow(() => tailLog(bad))
  assert.doesNotThrow(() => clearLog(bad))
})

test('Error 对象只留 message 与栈的前两帧，不整段倒进来', async () => {
  const root = await tempRoot()
  const err = new Error('屋子没接上')
  logLine('warn', [err], root)
  const line = tailLog(root).lines[0]
  assert.match(line, /屋子没接上/)
  assert.ok(line.length < LINE_MAX, '一行不能超长')
})

test('超长参数被截断到 LINE_MAX 以内', async () => {
  const root = await tempRoot()
  logLine('info', ['x'.repeat(50_000)], root)
  const line = tailLog(root).lines[0]
  assert.ok(line.length <= LINE_MAX + 40, `实际 ${line.length}`)
})

test('cookie 值在写盘前被抹掉', async () => {
  const root = await tempRoot()
  logLine('info', ['Cookie: SESSDATA=abcdef123456; bili_jct=deadbeef99'], root)
  const line = tailLog(root).lines[0]
  assert.doesNotMatch(line, /abcdef123456/)
  assert.doesNotMatch(line, /deadbeef99/)
  assert.match(line, /SESSDATA=\*\*\*/)
})

test('裸长串也抹：40 位以上且字母数字混杂的当凭据处理', () => {
  assert.equal(scrub('t=AbCdEf0123456789AbCdEf0123456789AbCdEf01'), 't=***')
  // 纯字母的长串更可能是路径或标识符，不清洗（清洗过头会毁掉排查信息）
  assert.match(scrub('a'.repeat(45)), /^a+$/)
})

test('export 里不留配置与 owner 的凭据', () => {
  const cfg = { comment: { enabled: true }, cookie: 'SESSDATA=xxx', owner: { mid: '1', cookie: 'SESSDATA=yyy' } }
  const out = redactConfig(cfg)
  assert.equal(out.cookie, '***')
  assert.equal(out.owner.cookie, '***')
  assert.equal(out.owner.mid, '1', 'mid 不是凭据，要留着')
  assert.equal(cfg.cookie, 'SESSDATA=xxx', '不能改原对象')
})

test('buildBundle 的段落顺序按"排查时最先想看什么"排', async () => {
  const root = await tempRoot()
  logBoot(root, '0.1.0 · test')
  const text = buildBundle(root, {
    version: '0.1.0',
    checks: { summary: '10 项里 9 项正常', items: [{ id: 'cookie', ok: false, label: '登录', detail: '还没存', fix: '贴上 cookie' }] },
    restrict: { applied: 1, allow: ['growth_commit'], guard: true, why: '' },
    lines: 20,
  })
  const iSelf = text.indexOf('--- 自检 ---')
  const iLog = text.indexOf('--- 日志')
  assert.ok(iSelf > 0 && iLog > iSelf, '自检要在日志前面')
  assert.match(text, /BAD 登录: 还没存 \| 修法: 贴上 cookie/)
  assert.match(text, /工具面: 已收窄/)
  assert.match(text, /插件版本: 0\.1\.0/)
})

test('清空是真的清空，之后再写还能写', async () => {
  const root = await tempRoot()
  logLine('info', ['一'], root)
  assert.deepEqual(clearLog(root), { ok: true, cleared: true })
  assert.equal(tailLog(root).lines.length, 0)
  logLine('info', ['二'], root)
  assert.equal(tailLog(root).lines.length, 1)
  // 文件不存在时清空也算成功（幂等）
  assert.deepEqual(clearLog(root).ok, true)
})

test('超过上限会轮转，旧内容进 .1 而不是被丢掉', async () => {
  const root = await tempRoot()
  const file = logFile(root)
  // 目录由第一条日志创建，所以这里要自己先建（顺手钉住"目录不存在时 logLine 自己会建"）
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'x'.repeat(LOG_MAX_BYTES + 10), 'utf8')
  logLine('info', ['轮转之后'], root)
  const rotated = await readFile(`${file}.1`, 'utf8')
  assert.ok(rotated.length >= LOG_MAX_BYTES, '.1 里应是那份超限的旧日志')
  assert.match(tailLog(root).lines.join('\n'), /轮转之后/)
})

test('makeLogger 同时写文件与转发宿主；宿主 logger 抛错也不影响写盘', async () => {
  const root = await tempRoot()
  const seen = []
  const ctx = { logger: { info: (...a) => seen.push(a.join(' ')), warn: () => { throw new Error('宿主坏了') } } }
  const log = makeLogger(ctx, root)
  log.info('第一次')
  assert.doesNotThrow(() => log.warn('第二次'))
  const lines = tailLog(root).lines
  assert.equal(lines.length, 2, '两次都要落盘')
  assert.deepEqual(seen, ['第一次'])
})

test('ctx 里没有 logger 也能用（测试环境与极老宿主）', async () => {
  const root = await tempRoot()
  const log = makeLogger(undefined, root)
  assert.doesNotThrow(() => log.info('照写'))
  assert.equal(tailLog(root).lines.length, 1)
})

test('日志没有开关：DEFAULTS 里不存在 log 这组配置', () => {
  assert.equal('log' in DEFAULTS, false, '有开关就等于允许"出事那一刻才发现日志关着"')
})
