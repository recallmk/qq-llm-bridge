/**
 * avatar.js —— 状态卡右上角那张头像
 *
 * 铁律：**插件包里不带任何头像图片**（2026-10-24 用户定）。
 * 界面上的圆头像来自 `<数据文件夹>/avatar.<ext>`，谁用谁自己传一张；
 * 没有这张文件时，客户端只画一个空框（一个圆圈 + 「鱼」字），不回落任何内置图片。
 * 原因写在 docs/B-技术契约.md §41：美术资源一旦打进包，开源分发时就变成授权问题，
 * 而这张图到底是谁的、能不能再分发，本机查不清。
 *
 * 只认四种格式，且上限 2MB —— 头像不需要更大，太大只会让 /avatar 每次读盘都变慢。
 */

import fs from 'node:fs'
import path from 'node:path'

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** mime → 扩展名。只收浏览器里常见的四种图片。 */
export const AVATAR_TYPES = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

/** 扩展名 → mime（读盘时用）。 */
const EXT_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
})

/** 按顺序找，先找到的那个就是当前头像。 */
const PROBE = ['png', 'jpg', 'webp', 'gif']

function rootOf(root) {
  return String(root || '')
}

/** 当前头像文件（绝对路径），没有就 null。 */
export function avatarFile(root) {
  const dir = rootOf(root)
  if (!dir) return null
  for (const ext of PROBE) {
    const file = path.join(dir, `avatar.${ext}`)
    try {
      if (fs.statSync(file).isFile()) return file
    } catch { /* 不存在就试下一个 */ }
  }
  return null
}

/** 供 /avatar 路由与界面用的元信息。永远不抛。 */
export function avatarInfo(root) {
  const file = avatarFile(root)
  if (!file) return { present: false, mime: '', bytes: 0, at: '' }
  try {
    const st = fs.statSync(file)
    const ext = path.extname(file).slice(1).toLowerCase()
    return {
      present: true,
      mime: EXT_MIME[ext] || 'application/octet-stream',
      bytes: st.size,
      at: new Date(st.mtimeMs).toISOString(),
    }
  } catch {
    return { present: false, mime: '', bytes: 0, at: '' }
  }
}

/**
 * 存一张头像。
 *
 * 入参是客户端读出来的 `{ data: base64, mime }`（不用 multipart，理由与 /config 一样：
 * 这一层没有表单解析器，少一个解析器就少一处能出错的地方）。
 *
 * 返回 `{ ok: true, mime, bytes }` 或 `{ ok: false, why }`，**永不抛**。
 */
export function saveAvatar(root, input) {
  const dir = rootOf(root)
  if (!dir) return { ok: false, why: '没有数据文件夹' }
  const body = input && typeof input === 'object' ? input : {}
  const mime = String(body.mime || '').toLowerCase()
  const ext = AVATAR_TYPES[mime]
  if (!ext) return { ok: false, why: '只支持 png / jpg / webp / gif' }
  const raw = String(body.data || '')
  if (!raw) return { ok: false, why: '没有收到图片内容' }
  // 允许带 data URL 前缀，直接切掉
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  let buf
  try {
    buf = Buffer.from(base64, 'base64')
  } catch {
    return { ok: false, why: '图片内容不是合法的 base64' }
  }
  if (!buf || !buf.length) return { ok: false, why: '图片内容为空' }
  if (buf.length > AVATAR_MAX_BYTES) {
    return { ok: false, why: `图片太大（${Math.round(buf.length / 1024)}KB），上限 2MB` }
  }
  const file = path.join(dir, `avatar.${ext}`)
  const tmp = `${file}.tmp`
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, file)
    // 换格式时把旧格式清掉，免得 /avatar 读到两张里的旧那张
    for (const other of PROBE) {
      if (other === ext) continue
      try { fs.unlinkSync(path.join(dir, `avatar.${other}`)) } catch { /* 没有就算了 */ }
    }
    return { ok: true, mime, bytes: buf.length }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 清临时文件失败不影响结论 */ }
    return { ok: false, why: `写不进去：${e?.message || e}` }
  }
}

/** 删掉当前头像。没有也不算错。 */
export function removeAvatar(root) {
  const file = avatarFile(root)
  if (!file) return { ok: true, removed: false }
  try {
    fs.unlinkSync(file)
    return { ok: true, removed: true }
  } catch (e) {
    return { ok: false, removed: false, why: `删不掉：${e?.message || e}` }
  }
}
