/**
 * 封面图：把视频的门面留下来。
 *
 * 为什么是封面而不是视频里的某一帧：
 *   她读的是标题、简介、评论、弹幕、字幕——全是文字。给她一张"某一帧"，
 *   是在暗示她看过画面，而她没看过。封面不一样：封面是这条视频对外的样子，
 *   是任何人点进去之前看到的同一张图，送她不撒谎。
 *
 * 落盘在 `out/covers/<BV>.jpg`，跟着状态库走（重开也不删）。
 * 单张上限 4MB、超时 8 秒；拿不到就返回空串，绝不因为一张图拖垮一次唤醒。
 */
import fs from 'node:fs'
import path from 'node:path'
import { paths } from './store.js'
import { slashed } from './posix.js'

const MAX_BYTES = 4 * 1024 * 1024
const TIMEOUT_MS = 8000
const REFERER = 'https://www.bilibili.com/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** BV 号白名单：只认这个形状，别的一律当不认识（不拼打不开的地址） */
export function isBvid(x) {
  return /^BV[0-9A-Za-z]{10}$/.test(String(x ?? ''))
}

export function coverDir(root) {
  return path.join(paths(root).outDir, 'covers')
}

/** 已经存过的返回绝对路径，没存过返回空串 */
export function coverPath(root, bvid) {
  if (!isBvid(bvid)) return ''
  for (const ext of ['jpg', 'png', 'webp']) {
    const p = path.join(coverDir(root), `${bvid}.${ext}`)
    try {
      if (fs.statSync(p).size > 0) return p
    } catch { /* 没有就试下一个扩展名 */ }
  }
  return ''
}

/** B 站返回的 pic 常常是 `//i0.hdslb.com/...`，补成 https */
export function normPic(url) {
  const s = String(url ?? '').trim()
  if (!s) return ''
  if (s.startsWith('//')) return `https:${s}`
  if (/^https?:\/\//i.test(s)) return s
  return ''
}

function extOf(ct) {
  const t = String(ct ?? '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  return 'jpg'
}

/**
 * 下载封面。已有就复用；失败返回空串（调用方按"没有图"处理）。
 * @returns {Promise<string>} 绝对路径
 */
export async function fetchCover({ root, bvid, pic, fetchImpl = fetch, log } = {}) {
  const url = normPic(pic)
  if (!url || !isBvid(bvid)) return ''
  const hit = coverPath(root, bvid)
  if (hit) return hit
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: { referer: REFERER, 'user-agent': UA },
    })
    clearTimeout(timer)
    if (!res?.ok) {
      log?.('cover http', `${bvid} ${res?.status}`)
      return ''
    }
    const len = Number(res.headers?.get?.('content-length') ?? 0)
    if (len > MAX_BYTES) {
      log?.('cover too big', bvid)
      return ''
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > MAX_BYTES) return ''
    const dir = coverDir(root)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${bvid}.${extOf(res.headers?.get?.('content-type'))}`)
    fs.writeFileSync(file, buf)
    return file
  } catch (err) {
    log?.('cover failed', `${bvid} ${String(err?.message ?? err).slice(0, 60)}`)
    return ''
  }
}

/**
 * 她开口时随消息带出去的图。
 *
 * 用本地绝对路径的 markdown 图片：宿主自己就是这么显示图的，
 * 不依赖图床、不依赖外网能连、不受 B 站防盗链影响（图已经在本机了）。
 * 最多带两张——多了就成了相册，不是她想说什么。
 */
export function coverLines(picks, root, max = 2) {
  const out = []
  for (const p of (picks ?? []).slice(0, max)) {
    const file = coverPath(root, p?.bvid)
    if (!file) continue
    const title = String(p?.title ?? '').replace(/[\[\]]/g, '').slice(0, 40) || p?.bvid
    // 正斜杠：宿主渲染 markdown 图片时按 /api/file 取文件，反斜杠写法在客户端会取不到
    //（2026-10-26 实测：同一张图 C:\ 版显示「图片无法预览」、C:/ 版正常）。
    out.push(`![${title}](${slashed(file)})`)
  }
  return out
}
