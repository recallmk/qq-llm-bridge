/**
 * 她看过什么 —— 把事件流里已有的 `browse:<日期>` 记账还原成给人看的历史。
 *
 * 为什么要单独一个模块（2026-10-23 用户提）：
 * 她在会话里说「有一条是一个人跑不起来了」，用户却不知道是哪条，
 * 于是既没法接话、也没法判断她到底被什么打动了。
 * 数据本来就在（每次刷站都记了 browse:<dk>），缺的只是一个**能点开的出口**。
 * 这里不新增任何落盘，只做读取与格式化。
 */

/** 视频的公开地址。她看的东西必须是用户能点开的。 */
export function videoUrl(bvid) {
  const b = String(bvid ?? '').trim()
  return /^BV[0-9A-Za-z]{10}$/.test(b) ? `https://www.bilibili.com/video/${b}` : ''
}

/**
 * 按日期倒序分组的历史。
 *
 * @param {Array} events 事件流
 * @param {{days?:number, limit?:number}} opts days=取最近几天（默认 14），limit=每天最多几条（默认 200）
 * @returns {Array<{date:string, items:Array<{bvid,title,up,duration,view,url}>}>}
 */
export function historyFromEvents(events, opts = {}) {
  const days = Math.max(1, Math.min(180, Number(opts.days) || 14))
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 200))
  const groups = new Map()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('browse:')) continue
    const sp = t.indexOf(' ')
    if (sp < 0) continue
    const dk = t.slice('browse:'.length, sp).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue
    const json = t.slice(sp + 1).trim()
    if (!json.startsWith('[')) continue
    let arr
    try { arr = JSON.parse(json) } catch { continue } // 坏行跳过，不让页面崩
    if (!groups.has(dk)) groups.set(dk, [])
    const bucket = groups.get(dk)
    const have = new Set(bucket.map((x) => x.bvid))
    for (const it of Array.isArray(arr) ? arr : []) {
      const bvid = String(it?.bvid ?? '')
      if (!bvid || have.has(bvid)) continue
      have.add(bvid)
      bucket.push({
        bvid,
        title: String(it?.title ?? '').slice(0, 120),
        up: String(it?.up ?? '').slice(0, 60),
        duration: Number(it?.duration) || 0,
        view: Number(it?.view) || 0,
        url: videoUrl(bvid),
      })
    }
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, days)
    .map(([date, items]) => ({ date, items: items.slice(0, limit) }))
}

/**
 * 她这一次看到了什么，压成几行带链接的清单，放进唤醒上下文。
 *
 * 只给标题、UP 名、链接，**不给"重点在第几分钟"**——
 * 标好重点她就只会复述，那是摘要，不是她看见的东西。
 */
export function renderWatchList(items, max = 6) {
  const list = (items ?? []).filter((x) => x?.bvid).slice(0, max)
  if (!list.length) return ''
  const lines = list.map((x, i) => {
    const t = String(x.title ?? '').slice(0, 60) || x.bvid
    const u = x.url || videoUrl(x.bvid)
    const up = x.up ? `（${x.up}）` : ''
    return `${i + 1}. ${t}${up}${u ? ` — ${u}` : ''}`
  })
  return ['## 你今天翻到过的，就是这几条', ...lines].join('\n')
}
