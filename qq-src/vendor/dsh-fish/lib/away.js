/**
 * 「你不在的时候」：把空档期她做了什么，摊在你回来第一眼能看到的地方。
 *
 * 为什么不是通知：她没有时效性——一条视频你今天不看，明天看也一样。
 * 所以不往外推，只在你回到 DSH 时告诉你错过了什么。
 *
 * 口径（全部只读，不改事件流、不写任何东西）：
 *   - 起点 = 你最后一次开口的时间（`meta seen:<ISO>`）；从没开过口就从第一条事件算。
 *   - 醒了 N 次（`meta wake:`）、看了 M 条（`browse:` 记账里的 BV 去重）、
 *     说了 K 句话（`utterance`）、写了 J 篇日记（`meta diary:`）。
 *   - 日记只报**篇数**，永不报内容——看不看得到是 `diary.visible` 那件事。
 */
import { readEvents } from './store.js'

function tsOf(e) {
  const raw = e?.ts
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const t = Date.parse(String(raw ?? ''))
  return Number.isFinite(t) ? t : 0
}

/** 你最后一次露面的时间（毫秒）。从没露面返回 0。 */
export function lastSeenMs(events) {
  let best = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('seen:')) continue
    const v = Date.parse(t.slice(5).trim())
    if (Number.isFinite(v) && v > best) best = v
  }
  return best
}

/** 起点：最后一次露面；没有就用最早一条事件的时间。都没有返回 0。 */
export function awaySince(events) {
  const seen = lastSeenMs(events)
  if (seen) return seen
  let first = 0
  for (const e of events ?? []) {
    const t = tsOf(e)
    if (t && (!first || t < first)) first = t
  }
  return first
}

/**
 * @returns {{since:number,days:number,wakes:number,videos:number,said:number,diaries:number,quiet:boolean}}
 */
export function summarizeAway(events, { now = Date.now(), maxDays = 60 } = {}) {
  const since = awaySince(events)
  const zero = { since, days: 0, wakes: 0, videos: 0, said: 0, diaries: 0, quiet: true }
  if (!since) return zero

  const floor = Math.max(since, now - maxDays * 86400_000)
  const days = Math.max(0, Math.floor((now - since) / 86400_000))
  let wakes = 0
  let said = 0
  let diaries = 0
  const bvids = new Set()

  for (const e of events ?? []) {
    const t = tsOf(e)
    if (t && t < floor) continue
    const type = String(e?.type ?? '')
    if (type === 'utterance') { said++; continue }
    if (type === 'diary') { diaries++; continue }
    if (type === 'meta') {
      const txt = String(e.text ?? '')
      if (txt.startsWith('wake:')) { wakes++; continue }
      if (txt.startsWith('diary:')) { diaries++; continue }
      if (txt.startsWith('browse:')) {
        const json = txt.slice(txt.indexOf(' ')).trim()
        if (!json.startsWith('[')) continue
        try {
          for (const it of JSON.parse(json)) {
            const b = String(it?.bvid ?? '')
            if (b) bvids.add(b)
          }
        } catch { /* 坏行跳过，不让整张卡片空掉 */ }
      }
    }
  }

  return {
    since,
    days,
    wakes,
    videos: bvids.size,
    said,
    diaries,
    quiet: wakes === 0 && said === 0 && bvids.size === 0 && diaries === 0,
  }
}

/** 直接给观测台用：读事件流再汇总，永不抛。 */
export async function readAway(root, opts = {}) {
  try {
    const { events } = await readEvents(root)
    return summarizeAway(events, opts)
  } catch {
    return { since: 0, days: 0, wakes: 0, videos: 0, said: 0, diaries: 0, quiet: true }
  }
}
