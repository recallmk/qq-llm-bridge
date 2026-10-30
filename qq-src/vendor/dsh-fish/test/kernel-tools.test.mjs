import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { adoptKnownFromError, knownToolNames, rememberKnownTools } from '../lib/restrict.js'

// 2026-10-24（DSH 升级到 0.2.1-rc.3 之后）：白名单校验需要一份「宿主认得哪些工具名」的快照。
// 快照取不到时（她还没在这个进程里开过会话）只能查拼写，用户会以为「过了校验 = 名字一定存在」。
// 两条补强：①从 restrict() 的报错里把名单捡回来；②界面明说「这次只核对了拼写」。

const CLIENT = new URL('../lib/client.js', import.meta.url)

test('能从宿主报错里捡回全量工具名', () => {
  rememberKnownTools(null)
  const msg =
    'tools.restrict() names unknown global tool "web_serch"; known global tools: bash, skill, read_image, subagent_fork, working_directory'
  assert.equal(adoptKnownFromError(msg), true)
  assert.deepEqual(knownToolNames(null), [
    'bash',
    'read_image',
    'skill',
    'subagent_fork',
    'working_directory',
  ])
})

test('报错里没有名单、或名单是 (none)，就不动快照', () => {
  rememberKnownTools(null)
  assert.equal(adoptKnownFromError('tools.restrict() requires a scoped context'), false)
  assert.equal(knownToolNames(null), null)
  assert.equal(adoptKnownFromError('known global tools: (none)'), false)
  assert.equal(knownToolNames(null), null)
  assert.equal(adoptKnownFromError(undefined), false)
})

test('名单里混着非法字符时只收合法名字', () => {
  rememberKnownTools(null)
  assert.equal(adoptKnownFromError('known global tools: bash, BadName, skill'), true)
  assert.deepEqual(knownToolNames(null), ['bash', 'skill'])
})

test('设置页在拿不到名单时会明说「只核对拼写」', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('const onlyShape = !known || !known.length'), '要判断名单有没有拿到')
  assert.ok(src.includes('这次只核对了拼写'), '提示要写清只查了拼写')
  assert.ok(src.includes('名字必须一字不差'), '提示要提醒名字必须精确')
})
