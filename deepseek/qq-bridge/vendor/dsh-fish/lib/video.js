/**
 * video.js —— 让她真的「看过」一条视频，而不是只读了它的简介
 *
 * 之前她判断一条视频好不好，全靠标题/简介/标签/弹幕——那些是别人替她写的字。
 * 这个模块只做一件事：从视频里取 9 帧，拼成一张 3×3 的图，存成文件。
 * 之后 she 用 read_image 读它，等于一次看完整条视频的关键画面。
 *
 * 为什么不用 yt-dlp / 不下载整段：
 *   - B 站给了 dash 播放地址，ffmpeg 能直接从 http 拉流并 seek；
 *   - 抽 9 帧只要几次短 seek，合计几秒、几 MB，而不是把 40MB 全下下来；
 *   - 少一个依赖（yt-dlp）就少一处要用户装的东西。
 *
 * 为什么抽 9 帧均布而不是按镜头切换：
 *   跨整条视频找镜头切换要读完整个流（网络代价 = 全量下载）。
 *   9 帧均布是**覆盖优先**的折中：看得见"这条视频大致是什么样"，
 *   而不是"某一分钟里切了几个镜头"。真要细看，她可以再对某个时间点单独取。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { detectFfmpeg, mediaDir } from './media.js'
import { createClient } from './bili.js'
import { slashed } from './posix.js'
import { rootDir, readOwner } from './store.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 一帧用掉多少秒的网络等待上限
const FRAME_TIMEOUT_MS = 25_000

function runFfmpeg(bin, args, timeoutMs = FRAME_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let err = ''
    let done = false
    const p = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { p.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ code: -1, stderr: `${err}\n(timeout)` })
    }, timeoutMs)
    p.stderr.on('data', (c) => { if (err.length < 4000) err += String(c) })
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -2, stderr: String(e?.message ?? e) }) } })
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -3, stderr: err }) } })
  })
}

/** B 站直链要 Referer + UA + cookie 才给拉；缺一样就是 403 */
function headersFor(bvid, cookie) {
  const lines = [
    `Referer: https://www.bilibili.com/video/${bvid}`,
    `User-Agent: ${UA}`,
    'Accept: */*',
  ]
  if (cookie) lines.push(`Cookie: ${cookie}`)
  return lines.join('\r\n') + '\r\n'
}

/**
 * 抽帧 + 拼图。
 *
 * @param {object} o
 * @param {string} o.bvid
 * @param {object} [o.client] 注入的 bili 客户端（单测用假的）
 * @param {string} [o.root]
 * @param {object} [o.log]
 * @param {number} [o.frames] 取几帧（默认 9 = 3×3）
 * @returns {Promise<{ok:boolean, path:string, why:string, title:string, duration:number, shots:number}>}
 */
export async function grabFrames(o = {}) {
  const root = o.root ?? rootDir()
  const bvid = String(o.bvid ?? '').trim()
  const fail = (why, extra = {}) => ({ ok: false, path: '', why, title: '', duration: 0, shots: 0, ...extra })

  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return fail('不是 BV 号')

  const ff = o.ffmpeg ?? detectFfmpeg()
  if (!ff.ok) return fail(`本机没有可用的 ffmpeg（${ff.why}）。装好后重试，或先只看文字。`)

  const client = o.client ?? createClient({})
  let info
  try {
    info = await client.view(bvid)
  } catch (e) {
    return fail(String(e?.message ?? e))
  }
  if (!info?.ok) return fail(info?.message ?? '取不到这条视频的信息')

  const cid = info.data?.cid
  if (!cid) return fail('取不到分P信息（cid）')

  let pu
  try {
    pu = await client.playurl(bvid, cid)
  } catch (e) {
    return fail(String(e?.message ?? e))
  }
  if (!pu?.ok || !pu.data?.url) return fail(pu?.message ?? '拿不到播放地址（可能要登录或这条视频有地区限制）')

  const url = pu.data.url
  const duration = Number(info.data?.duration ?? pu.data?.duration ?? 0) || 0
  // 2026-10-25 修：readOwner 是 async —— 这里原来在同步 IIFE 里调它，
  // 拿到的是 Promise，cookie 永远为空，看画面就成了匿名请求。
  let cookie = ''
  try { cookie = (await readOwner(root))?.cookie ?? '' } catch { cookie = '' }
  const headers = headersFor(bvid, cookie)

  // 每帧一个临时 PNG，最后 tile 成一张
  const dir = await mediaDir(root)
  const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`
  const tmp = join(dir, `tmp-${stamp}`)
  await fs.mkdir(tmp, { recursive: true })

  const n = Math.max(1, Math.min(16, Number(o.frames ?? 9)))
  // 掐掉头尾各 4%：片头黑场和片尾下滑栏是最没信息量的两段
  const lo = duration > 0 ? duration * 0.04 : 0
  const hi = duration > 0 ? duration * 0.96 : 0
  const times = []
  for (let i = 0; i < n; i++) {
    if (duration > 0) times.push(lo + ((hi - lo) * i) / Math.max(1, n - 1))
    else times.push(i * 5)
  }

  let okShots = 0
  for (let i = 0; i < times.length; i++) {
    const out = join(tmp, `f${String(i + 1).padStart(2, '0')}.png`)
    const grab = async (t) => runFfmpeg(ff.bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-headers', headers,
      '-ss', t.toFixed(2),
      '-i', url,
      '-frames:v', '1',
      '-vf', 'scale=360:-2',
      out,
    ])
    let r = await grab(times[i])
    let st = await fs.stat(out).catch(() => null)
    // 一次失败多半是那一下网络抖了或正好 seek 到关键帧边界；往后挪一点重试一次。
    // 不重试的话视频尾部几帧经常整片空着（实测 9 帧只成 7 帧）。
    if (r.code !== 0 || !st || st.size <= 512) {
      await fs.rm(out, { force: true }).catch(() => {})
      r = await grab(Math.min(times[i] + 1.5, duration > 0 ? duration - 1 : times[i] + 1.5))
      st = await fs.stat(out).catch(() => null)
    }
    if (r.code === 0 && st && st.size > 512) okShots++
  }

  if (okShots === 0) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    return fail('一帧都没取到（可能被风控、或者这条视频不允许外链拉流）')
  }

  // 3×3 拼成一张；不足 9 帧时 tile 会自动留空，可接受
  const cols = n <= 4 ? 2 : 3
  const rows = Math.ceil(n / cols)
  const sheet = join(dir, `sheet-${bvid}-${stamp}.png`)
  const tile = await runFfmpeg(ff.bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '1',
    '-i', join(tmp, 'f%02d.png'),
    '-vf', `scale=360:-2,tile=${cols}x${rows}:padding=4:margin=4:color=white`,
    '-frames:v', '1',
    sheet,
  ], 60_000)
  const st = await fs.stat(sheet).catch(() => null)
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})

  if (!st || st.size < 1024) {
    return fail(`拼图失败：${(tile.stderr || '未知原因').slice(0, 200)}`)
  }

  return {
    ok: true,
    // 交给模型的路径用正斜杠（反斜杠写进 markdown 图片会显示成「无法预览」，2026-10-26 实测）
    path: slashed(sheet),
    why: '',
    title: String(info.data?.title ?? ''),
    duration,
    shots: okShots,
  }
}
