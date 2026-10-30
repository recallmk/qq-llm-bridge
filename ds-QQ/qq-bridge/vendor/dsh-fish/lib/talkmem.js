/**
 * talkmem.js —— 换会话时带走的那几句话（2026-10-23）
 *
 * 为什么需要：
 *   她的侧栏会话不可能无限长——上下文会撑爆。但换新会话有个残酷的副作用：
 *   上一段对话里「我们说到哪了」全部消失。她会像一个刚失忆的人面对你。
 *
 * 为什么不是「让 AI 总结上一段」：
 *   总结出来的东西是**别人替她讲的**。这份东西要做的只是把**原话**搬过去，
 *   一句都不改。搬运是诚实的，总结是不诚实的。
 *
 * 为什么存这么少：
 *   存最近 4 轮，每句截断。存多了等于换了个地方做上下文膨胀；
 *   更老的事她该用 her_recall 自己翻——翻到的才是记得的。
 */

import { join } from 'node:path'
import { rootDir, paths, readJson, writeAtomic } from './store.js'

export const TALK_KEEP = 4
export const TALK_SNIPPET = 160

function file(root) {
  return join(paths(root).root, 'talk-recent.json')
}

function cut(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > TALK_SNIPPET ? t.slice(0, TALK_SNIPPET - 1) + '…' : t
}

/** 记一轮。her 为空也记（"他没说话"本身也是那天的样子），但只留 he 那句。 */
export async function addExchange(root = rootDir(), { me, her } = {}) {
  const a = cut(me)
  if (!a) return { ok: false, kept: 0 }
  try {
    const saved = await readJson(file(root), null)
    const list = Array.isArray(saved?.list) ? saved.list : []
    list.push({ at: new Date().toISOString(), me: a, her: cut(her) })
    const trimmed = list.slice(-TALK_KEEP)
    await writeAtomic(file(root), JSON.stringify({ list: trimmed }, null, 2))
    return { ok: true, kept: trimmed.length }
  } catch {
    return { ok: false, kept: 0 }
  }
}

/** 读最近 N 轮（默认全部） */
export async function recentExchanges(root = rootDir(), n = TALK_KEEP) {
  try {
    const saved = await readJson(file(root), null)
    const list = Array.isArray(saved?.list) ? saved.list : []
    return list.slice(-Math.max(1, n))
  } catch {
    return []
  }
}

/**
 * 渲染成给下一段会话看的那几句。
 * 只放原话与时间，不加任何"她当时的心情是…"这类解释。
 */
export function renderCarry(list) {
  const rows = (list ?? []).filter((r) => r && (r.me || r.her))
  if (!rows.length) return ''
  const lines = ['## 上次我们说到这', '（会话刚换过，这些是原话。更早的事你自己去翻。）']
  for (const r of rows) {
    const day = String(r.at ?? '').slice(0, 10)
    if (r.me) lines.push(`- ${day} 他说：${r.me}`)
    if (r.her) lines.push(`  ${day} 你说：${r.her}`)
  }
  return lines.join('\n')
}
