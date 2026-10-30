/**
 * avatar.test.mjs —— 状态卡上的头像：谁用谁自己传，包里不带图
 *
 * 背景（用户 m03751，2026-10-24）：
 *   想把「大肥鱼」原图放上去，但那张图是画师原创角色的二创，二创开放 ≠ 可以再分发。
 *   所以插件**不带任何图片**：头像来自 `<数据文件夹>/avatar.<ext>`，
 *   用户在设置页自己传一张；没有就只画一个空圈。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  AVATAR_MAX_BYTES,
  AVATAR_TYPES,
  avatarFile,
  avatarInfo,
  removeAvatar,
  saveAvatar,
} from '../lib/avatar.js'

const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const OBSERVE = fs.readFileSync(new URL('../lib/observe.js', import.meta.url), 'utf8')
const AVATAR = fs.readFileSync(new URL('../lib/avatar.js', import.meta.url), 'utf8')

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-avatar-'))

// 1×1 透明 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gGkY8H1AAAAAElFTkSuQmCC'

test('没有头像时：present=false，avatarFile 返回 null', () => {
  const root = tmp()
  assert.equal(avatarFile(root), null)
  const info = avatarInfo(root)
  assert.equal(info.present, false)
  assert.equal(info.bytes, 0)
})

test('存一张 png：落盘成 avatar.png，info 能读出大小', () => {
  const root = tmp()
  const r = saveAvatar(root, { data: PNG, mime: 'image/png' })
  assert.equal(r.ok, true)
  assert.equal(r.mime, 'image/png')
  const file = avatarFile(root)
  assert.equal(file, join(root, 'avatar.png'))
  assert.ok(fs.existsSync(file))
  const info = avatarInfo(root)
  assert.equal(info.present, true)
  assert.equal(info.mime, 'image/png')
  assert.ok(info.bytes > 0)
})

test('带 data URL 前缀也认', () => {
  const root = tmp()
  const r = saveAvatar(root, { data: `data:image/png;base64,${PNG}`, mime: 'image/png' })
  assert.equal(r.ok, true)
  assert.ok(fs.existsSync(join(root, 'avatar.png')))
})

test('只认四种图片格式：别的类型直接拒，不落盘', () => {
  const root = tmp()
  for (const mime of ['text/plain', 'image/bmp', 'application/pdf', 'image/svg+xml']) {
    const r = saveAvatar(root, { data: PNG, mime })
    assert.equal(r.ok, false, `${mime} 应该被拒`)
    assert.ok(String(r.why).includes('png'), r.why)
  }
  assert.deepEqual(Object.keys(AVATAR_TYPES).sort(), ['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
  assert.equal(avatarFile(root), null)
})

test('超过 2MB 拒收，并说清多大', () => {
  const root = tmp()
  const big = Buffer.alloc(AVATAR_MAX_BYTES + 1024, 1).toString('base64')
  const r = saveAvatar(root, { data: big, mime: 'image/png' })
  assert.equal(r.ok, false)
  assert.ok(r.why.includes('2MB'), r.why)
  assert.equal(avatarFile(root), null)
})

test('换格式时旧文件被清掉（/avatar 不会读到两张里的旧那张）', () => {
  const root = tmp()
  saveAvatar(root, { data: PNG, mime: 'image/png' })
  assert.ok(fs.existsSync(join(root, 'avatar.png')))
  saveAvatar(root, { data: PNG, mime: 'image/jpeg' })
  assert.equal(avatarFile(root), join(root, 'avatar.jpg'))
  assert.ok(!fs.existsSync(join(root, 'avatar.png')), '旧 png 必须清掉')
})

test('移除：第一次真删，第二次就算没有也不报错', () => {
  const root = tmp()
  saveAvatar(root, { data: PNG, mime: 'image/png' })
  const a = removeAvatar(root)
  assert.deepEqual([a.ok, a.removed], [true, true])
  assert.equal(avatarFile(root), null)
  const b = removeAvatar(root)
  assert.deepEqual([b.ok, b.removed], [true, false])
})

test('空输入不抛，只回 why', () => {
  const root = tmp()
  for (const bad of [null, undefined, {}, { data: '', mime: 'image/png' }, { data: PNG }]) {
    const r = saveAvatar(root, bad)
    assert.equal(r.ok, false)
    assert.ok(typeof r.why === 'string' && r.why.length > 0)
  }
})

test('路由：/avatar 同时管出图、元信息、上传与移除', () => {
  assert.ok(OBSERVE.includes("import { avatarFile, avatarInfo, saveAvatar, removeAvatar } from './avatar.js'"), 'observe 要 import avatar')
  assert.ok(OBSERVE.includes("['/avatar', async (req, res) => {"), '要有 /avatar 路由')
  assert.ok(OBSERVE.includes("url.startsWith(PREFIX + '/avatar/info')"), '要有 /avatar/info 分支')
  assert.ok(OBSERVE.includes("req.method === 'POST'"), '要处理 POST')
  assert.ok(OBSERVE.includes("body && body.remove ? removeAvatar(root) : saveAvatar(root, body)"), 'remove 与保存分派')
})

test('客户端：状态卡上有头像与换头像入口，且不再出现「没在跑」', () => {
  assert.ok(CLIENT.includes('avatarBox'), '要有头像块')
  assert.ok(CLIENT.includes("API + '/avatar'"), '图片地址走 API + /avatar')
  assert.ok(CLIENT.includes("h('span', null, '鱼')"), '没有头像时画空圈占位')
  assert.ok(CLIENT.includes('换头像'), '要有换头像入口')
  assert.ok(CLIENT.includes('移除头像'), '传过之后要能移除')
  assert.ok(CLIENT.includes("jget('/avatar/info')"), '加载时读头像元信息')
  assert.ok(CLIENT.includes("accept: 'image/png,image/jpeg,image/webp,image/gif'"), '只让选这四种')
  assert.ok(!CLIENT.includes("label: '没在跑'"), '离线文案已改成「离线」')
  assert.ok(CLIENT.includes("label: '离线'"), '离线文案')
})

test('包里不带图：avatar.js 里没有任何 base64 图片', () => {
  assert.ok(!/data:image\//.test(AVATAR), '不许在源码里内嵌图片')
  assert.ok(!/\.(png|jpe?g|webp|gif|svg)'/.test(AVATAR), '不许引用内置图片文件')
})
