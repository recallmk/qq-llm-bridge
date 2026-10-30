/**
 * media.test.mjs —— 图片落盘与抽帧工具的纯逻辑部分。
 *
 * 不联网、不调真 ffmpeg（只调 detectFfmpeg 的探测分支）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  sniffMime,
  decodeBase64Image,
  parseDuration,
  detectFfmpeg,
  saveImage,
  sweepMedia,
  mediaDir,
  MAX_IMAGE_BYTES,
} from '../lib/media.js'

// 1×1 透明 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-fish-media-'))
}

test('sniffMime 认得 png/jpeg/webp/gif，其余一律 null', () => {
  assert.equal(sniffMime(Buffer.from(PNG_B64, 'base64')), 'image/png')
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  const webp = Buffer.alloc(16)
  webp.write('RIFF', 0, 'latin1')
  webp.write('WEBP', 8, 'latin1')
  assert.equal(sniffMime(webp), 'image/webp')
  assert.equal(sniffMime(Buffer.from('GIF89a______', 'latin1')), 'image/gif')
  assert.equal(sniffMime(Buffer.from('not an image at all')), null)
  assert.equal(sniffMime(null), null)
  assert.equal(sniffMime(Buffer.alloc(3)), null)
})

test('decodeBase64Image 接受裸 base64 与 data URL 两种写法', () => {
  const a = decodeBase64Image(PNG_B64)
  assert.equal(a.ok, true)
  assert.equal(a.buf.length > 0, true)

  const b = decodeBase64Image(`data:image/png;base64,${PNG_B64}`)
  assert.equal(b.ok, true)
  assert.equal(b.declared, 'image/png')
  assert.deepEqual(b.buf, a.buf)

  assert.equal(decodeBase64Image('').ok, false)
  assert.equal(decodeBase64Image(null).ok, false)
})

test('parseDuration 解析 ffmpeg 的 Duration 行，认不出返回 0', () => {
  const stderr = '  Duration: 00:03:07.52, start: 0.000000, bitrate: 812 kb/s'
  assert.equal(parseDuration(stderr), 3 * 60 + 7.52)
  assert.equal(parseDuration('  Duration: 01:00:00.00'), 3600)
  assert.equal(parseDuration('no duration here'), 0)
  assert.equal(parseDuration(undefined), 0)
})

test('detectFfmpeg：指到不存在的路径时如实报红，并说明那个环境变量', () => {
  const r = detectFfmpeg({ DSH_FISH_FFMPEG: 'C:/definitely/not/here/ffmpeg.exe' })
  assert.equal(r.ok, false)
  assert.match(r.why, /DSH_FISH_FFMPEG/)
})

test('saveImage：真的写进 media/，名字带前缀，坏数据与空数据被拒', async () => {
  const root = await tmpRoot()
  try {
    const r = await saveImage(root, Buffer.from(PNG_B64, 'base64'), { prefix: 'pic' })
    assert.equal(r.ok, true)
    assert.equal(r.mime, 'image/png')
    assert.match(r.name, /^pic-/)
    assert.equal(r.path, join(await mediaDir(root), r.name))

    assert.equal((await saveImage(root, Buffer.alloc(0))).ok, false)
    assert.equal((await saveImage(root, Buffer.from('hello world'))).ok, false)

    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1)
    big[0] = 0x89
    big[1] = 0x50
    big[2] = 0x4e
    big[3] = 0x47
    const tooBig = await saveImage(root, big)
    assert.equal(tooBig.ok, false)
    assert.match(tooBig.why, /太大了/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('sweepMedia：只删过期的，留着新的；空目录不炸', async () => {
  const root = await tmpRoot()
  try {
    const dir = await mediaDir(root)
    await writeFile(join(dir, 'old.png'), Buffer.from(PNG_B64, 'base64'))
    await writeFile(join(dir, 'new.png'), Buffer.from(PNG_B64, 'base64'))

    const now = Date.now()
    const fourDaysAgo = (now - 4 * 24 * 3600 * 1000) / 1000
    await utimes(join(dir, 'old.png'), fourDaysAgo, fourDaysAgo)

    const r = await sweepMedia(root, { now })
    assert.equal(r.removed, 1)
    assert.equal(r.kept, 1)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('sweepMedia：目录还不存在时返回全零，不抛错', async () => {
  const root = join(tmpdir(), `dsh-fish-missing-${Date.now()}`)
  const r = await sweepMedia(root)
  assert.deepEqual(r, { removed: 0, kept: 0 })
})
