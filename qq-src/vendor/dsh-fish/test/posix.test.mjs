/**
 * posix.test.mjs —— 交给模型的路径一律写成正斜杠。
 *
 * 2026-10-26 用户实测：同一张图
 *   ![x](C:\Users\me\.dsh-fish\media\a.png) → 客户端显示「图片无法预览」
 *   ![x](C:/Users/me/.dsh-fish/media/a.png) → 正常
 * 她照抄工具给的路径，所以路径就得是正斜杠。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slashed } from '../lib/posix.js'

test('slashed：反斜杠全部换成正斜杠', () => {
  assert.equal(
    slashed('C:\\Users\\me\\.dsh-fish\\media\\a.png'),
    'C:/Users/me/.dsh-fish/media/a.png',
  )
  assert.equal(slashed('C:/already/ok.png'), 'C:/already/ok.png', '本来就是正斜杠的不动')
  assert.equal(slashed('C:\\a\\b\\c.png'), 'C:/a/b/c.png')
})

test('slashed：空值与非字符串不炸', () => {
  assert.equal(slashed(''), '')
  assert.equal(slashed(null), '')
  assert.equal(slashed(undefined), '')
  assert.equal(slashed(123), '123')
})
