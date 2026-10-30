/**
 * status.js —— 「现在在干什么」的旁观者视角。
 *
 * 三条设计原则（都是刻意的）：
 *   1. **状态是算出来的，不是她报的。** 全部来自宿主写下的 meta 事件 + 配置 + 时钟。
 *      她那边没有任何"上报我现在醒着"的工具——一旦有，状态就成了她的自我陈述，
 *      既能被对话诱导，也会变成"她读自己参数"的变相入口（B §8 硬禁止）。
 *   2. **不写事件流。** 这里全是纯函数，只读事件、不落盘。状态不是她的记忆。
 *   3. **承认"醒了但什么都没干"。** 这正是用户想看见的那种情况：她醒了，你不知道，
 *      等你发现时只看到"今天醒过，但什么都没有"。所以 idle 必须是**一等状态**，
 *      不能糊成"睡着"。
 *
 * 时间口径全部用本地时区的 dateKey，与 settings.dateKey 一致。
 */

import { dateKey, inWindow } from './settings.js'

/** 最近多久内有动作，算"正在做事" */
export const ACTIVE_MS = 5 * 60_000
/** 醒来后多久没有任何动作，算"醒着发呆" */
export const IDLE_MS = 10 * 60_000

const DK_RE = /^\d{4}-\d{2}-\d{2}$/

function tsOf(e) {
  const t = Date.parse(e?.ts ?? e?.at ?? '')
  return Number.isFinite(t) ? t : NaN
}

function textOf(e) {
  return String(e?.text ?? '')
}

/** 取 `prefix:YYYY-MM-DD ` 形式 meta 的当日部分 */
function dayMarker(text, prefix, dk) {
  const head = `${prefix}:${dk}`
  if (!text.startsWith(head)) return null
  return text.slice(head.length).trim()
}

/**
 * @param {{events:Array, config:object, now?:Date}} input
 * @returns {{phase:string, label:string, detail:string, since:string, minutesAgo:number|null,
 *            plannedWakeAt:string|null, nextWakeAt:string|null, awake:boolean,
 *            today:{wakes:number,idleWakes:number,browsed:number,said:number,comments:number,dairies:number},
 *            timeline:Array<{at:string,kind:string,text:string,idle?:boolean}>}}
 */
export function deriveStatus({ events = [], config = {}, now = new Date() } = {}) {
  const dk = dateKey(now)
  const nowMs = now.getTime()

  // ---- 只取今天、且是 meta 或她的发言 ----
  const today = []
  for (const e of events) {
    const t = tsOf(e)
    if (!Number.isFinite(t)) continue
    if (dateKey(new Date(t)) !== dk) continue
    today.push({ e, t })
  }
  today.sort((a, b) => a.t - b.t)

  // ---- 计划唤醒时间 ----
  let plannedWakeAt = null
  for (const { e } of today) {
    if (e?.type !== 'meta') continue
    const rest = dayMarker(textOf(e), 'sched', dk)
    if (!rest) continue
    const at = Date.parse(rest)
    if (Number.isFinite(at)) plannedWakeAt = at
  }

  // ---- 把今天切成"醒来块"：每个 wake: 是起点，动作挂到它下面 ----
  const blocks = []
  const counts = { wakes: 0, idleWakes: 0, browsed: 0, said: 0, comments: 0, dairies: 0 }
  let cur = null
  const orphan = { at: today[0]?.t ?? nowMs, actions: [], wake: null }

  const push = (at, kind, text, extra = {}) => {
    const target = cur ?? orphan
    target.actions.push({ at, kind, text, ...extra })
  }

  for (const { e, t } of today) {
    const text = textOf(e)
    if (e?.type === 'meta') {
      if (dayMarker(text, 'wake', dk) !== null) {
        if (cur) blocks.push(cur)
        cur = { at: t, wake: dayMarker(text, 'wake', dk) || '?', actions: [] }
        counts.wakes += 1
        continue
      }
      if (dayMarker(text, 'wakefail', dk) !== null) {
        push(t, 'fail', '想醒来，但没成功')
        continue
      }
      if (dayMarker(text, 'browse', dk) !== null) {
        let items = []
        try { items = JSON.parse(dayMarker(text, 'browse', dk)) } catch { items = [] }
        const n = Array.isArray(items) ? items.length : 0
        counts.browsed += n
        const titles = (Array.isArray(items) ? items : []).slice(0, 3).map((x) => x?.title).filter(Boolean)
        push(t, 'browse', n ? `刷了 ${n} 条${titles.length ? '：' + titles.join(' / ') : ''}` : '去刷了，但一条也没看成')
        continue
      }
      if (dayMarker(text, 'comment', dk) !== null) {
        counts.comments += 1
        push(t, 'comment', '在 B 站说了一句')
        continue
      }
      if (dayMarker(text, 'creply', dk) !== null) {
        counts.comments += 1
        push(t, 'comment', '回了一条回复')
        continue
      }
      if (dayMarker(text, 'diary', dk) !== null) {
        counts.dairies += 1
        push(t, 'diary', '写了今天的日记')
        continue
      }
      if (dayMarker(text, 'quiet', dk) !== null) {
        push(t, 'quiet', '醒了，但今天没有该问的事')
        continue
      }
      if (dayMarker(text, 'unrecorded', dk) !== null) continue
      continue
    }
    // 她的发言
    if (e?.type === 'utterance' || e?.type === 'narration' || e?.type === 'revise') {
      counts.said += 1
      const one = text.replace(/\s+/g, ' ').slice(0, 60)
      push(t, 'say', one ? `说了：「${one}${text.length > 60 ? '…' : ''}」` : '说了点什么')
      continue
    }
    if (e?.type === 'diary') {
      counts.dairies += 1
      push(t, 'diary', '写了今天的日记')
    }
  }
  if (cur) blocks.push(cur)
  if (orphan.actions.length) blocks.unshift({ at: orphan.at, wake: null, actions: orphan.actions })

  // ---- 醒着但什么也没做的块，记成 idle ----
  for (const b of blocks) {
    const done = b.actions.filter((a) => a.kind !== 'quiet' && a.kind !== 'fail')
    b.idle = done.length === 0
  }
  counts.idleWakes = blocks.filter((b) => b.idle).length

  // ---- 当前状态 ----
  const lastAct = today.length ? today[today.length - 1] : null
  const lastActMs = lastAct ? lastAct.t : NaN
  const activeBlock = blocks.length ? blocks[blocks.length - 1] : null
  const withinWindow = inWindow({ window: config?.window }, now)
  const wokeToday = counts.wakes > 0

  let phase = 'asleep'
  let label = '沉在水底'
  let detail = ''
  let since = plannedWakeAt && plannedWakeAt > nowMs ? new Date(plannedWakeAt).toISOString() : ''
  let minutesAgo = null

  const recent = Number.isFinite(lastActMs) && nowMs - lastActMs <= ACTIVE_MS
  const lastKind = activeBlock?.actions?.length ? activeBlock.actions[activeBlock.actions.length - 1].kind : null

  if (recent && lastKind === 'browse') {
    phase = 'browsing'; label = '在看别人的视频'
    detail = activeBlock.actions[activeBlock.actions.length - 1].text
  } else if (recent && lastKind === 'say') {
    phase = 'talking'; label = '在想怎么回你'
    detail = activeBlock.actions[activeBlock.actions.length - 1].text
  } else if (recent && lastKind === 'diary') {
    phase = 'writing'; label = '在写日记'
    detail = ''
  } else if (wokeToday && recent) {
    // 刚醒，还没来得及做任何事。不能掉进最后的 else 变成「睡着」——
    // 这恰恰是用户最想看见的那一格（m06219）。
    phase = 'awake-idle'; label = '在吃大白饭'; detail = ''
  } else if (wokeToday && Number.isFinite(lastActMs) && nowMs - lastActMs > IDLE_MS) {
    phase = 'awake-idle'; label = '在吃大白饭'
    minutesAgo = Math.round((nowMs - lastActMs) / 60_000)
    detail = `上次行动是在 ${minutesAgo} 分钟前`
  } else if (wokeToday && !Number.isFinite(lastActMs)) {
    phase = 'awake-idle'; label = '在吃大白饭'; detail = ''
  } else if (withinWindow && !wokeToday) {
    phase = 'waiting'; label = '沉在水底'
    const mins = plannedWakeAt ? Math.round((plannedWakeAt - nowMs) / 60_000) : null
    detail = plannedWakeAt && plannedWakeAt > nowMs
      ? `约 ${new Date(plannedWakeAt).toTimeString().slice(0, 5)} 会睡醒${mins !== null && mins >= 0 ? `（还有 ${mins} 分钟）` : ''}`
      : '今天已经到点，但还没醒'
  } else {
    phase = 'asleep'; label = '沉在水底'
    detail = plannedWakeAt && plannedWakeAt > nowMs
      ? `约 ${new Date(plannedWakeAt).toTimeString().slice(0, 5)} 会睡醒`
      : '虽然什么都没干，但是累了，不会再醒了'
  }

  // since：当前状态是从什么时候开始的
  if (phase === 'browsing' || phase === 'talking' || phase === 'writing') {
    const a = activeBlock.actions[activeBlock.actions.length - 1]
    since = new Date(a.at).toISOString()
  } else if (phase === 'awake-idle' && activeBlock) {
    since = new Date(activeBlock.at).toISOString()
  } else if (phase === 'asleep' || phase === 'waiting') {
    since = ''
  }

  // ---- 时间线（只留今天，最多 40 条）----
  const timeline = []
  for (const b of blocks) {
    const hhmm = new Date(b.at).toTimeString().slice(0, 5)
    if (b.idle) {
      timeline.push({ at: new Date(b.at).toISOString(), kind: 'idle', text: `${hhmm} 醒了，在发呆`, idle: true })
      // 「醒来失败」「没有该问的事」正是这一块为什么什么都没做的原因，必须留下来，
      // 否则旁观者只看到「什么都没做」，会误以为她偷懒（m06219）。
      for (const a of b.actions) {
        const h2 = new Date(a.at).toTimeString().slice(0, 5)
        timeline.push({ at: new Date(a.at).toISOString(), kind: a.kind, text: `${h2} ${a.text}` })
      }
      continue
    }
    timeline.push({ at: new Date(b.at).toISOString(), kind: 'wake', text: `${hhmm} 醒了` })
    for (const a of b.actions) {
      const h2 = new Date(a.at).toTimeString().slice(0, 5)
      timeline.push({ at: new Date(a.at).toISOString(), kind: a.kind, text: `${h2} ${a.text}` })
    }
  }

  const nextWakeAt = plannedWakeAt && plannedWakeAt > nowMs ? new Date(plannedWakeAt).toISOString() : null

  return {
    phase,
    label,
    detail,
    since,
    minutesAgo,
    plannedWakeAt: plannedWakeAt ? new Date(plannedWakeAt).toISOString() : null,
    nextWakeAt,
    awake: phase === 'browsing' || phase === 'talking' || phase === 'writing' || phase === 'awake-idle',
    today: counts,
    timeline: timeline.slice(-40),
  }
}

/**
 * 今天"醒了但没做什么"的次数。
 * 单独一个函数是因为观测台只想要这个数字，不需要整条时间线。
 */
export function idleWakeCount(events, now = new Date()) {
  return deriveStatus({ events, config: {}, now }).today.idleWakes
}
