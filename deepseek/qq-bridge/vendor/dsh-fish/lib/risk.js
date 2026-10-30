/**
 * 风控的补救与预防。
 *
 * 背景（2026-10-23 用户提）：B 站会给机器人脸色看——-352 风控、-412 请求被拦、-509 超限，
 * 也可能弹验证码。撞上以后如果还按原节奏打接口，只会越锁越久。
 *
 * 这里做三件事，都不碰她的记忆：
 *   1. **记住被锁了多久**（落盘，重启不丢）。`bili.js` 里的冷却只在内存里，进程一重启就当她没被锁过。
 *   2. **罚则递增**：第一次 30 分钟，重复撞就 60 / 120 / 240 分钟。机器越急，人越不信。
 *   3. **降级而不是停摆**：冷却期不刷站，但照常醒来、说话、写日记；
 *      解冻当天少看几条，把"今天不太顺"表现为内容变少，而不是报错。
 *
 * 预防侧不在这里：请求间隔抖动、接口轮换、每日上限在 `bili.js` 与 `browse.js`。
 */

import { readFileSync, writeFileSync } from 'node:fs'

export const RISK_FILE = 'risk.json'

/** 罚则台阶（分钟）。第 N 次撞墙取第 N 项，超出用最后一项。 */
export const STRIKES_MIN = [30, 60, 120, 240]

export function riskPath(root) {
  return `${root}/${RISK_FILE}`
}

/**
 * 读当前风控状态（坏文件当没撞过，不让它把人卡死）。
 *
 * 用同步 fs 的原因：这一层被 scheduler 的同步判断调用（"现在能不能碰 B 站"），
 * 走异步会让每次 tick 都要多一层 await，也让 noteRisk 变成"写了但还没落地"。
 * 文件只有一个，几十字节，同步读的代价可以忽略。
 */
export function readRisk(root) {
  let r = null
  try {
    r = JSON.parse(readFileSync(riskPath(root), 'utf8'))
  } catch {
    r = null // 不存在或坏了，都当没撞过
  }
  if (!r || typeof r !== 'object') return { until: 0, code: '', at: '', strikes: 0 }
  return {
    until: Number(r.until) || 0,
    code: String(r.code ?? ''),
    at: String(r.at ?? ''),
    strikes: Math.max(0, Number(r.strikes) || 0),
  }
}

/**
 * 记一次撞墙，返回新的状态。
 * @param {string} root
 * @param {number|string} code B 站返回码（-352 等），或 'COOLDOWN'
 * @param {Date} [now]
 */
export function noteRisk(root, code, now = new Date()) {
  const prev = readRisk(root)
  const strikes = Math.min(STRIKES_MIN.length, prev.strikes + 1)
  const min = STRIKES_MIN[strikes - 1] ?? STRIKES_MIN[STRIKES_MIN.length - 1]
  const until = now.getTime() + min * 60_000
  const state = { until, code: String(code ?? ''), at: now.toISOString(), strikes }
  try {
    writeFileSync(riskPath(root), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // 写不进去也不该让她今天不能说话：状态只影响"要不要刷站"，不阻塞唤醒。
  }
  return state
}

/** 手动解冻（自检页用） */
export function clearRisk(root) {
  try {
    writeFileSync(riskPath(root), JSON.stringify({ until: 0, code: '', at: '', strikes: 0 }, null, 2), 'utf8')
  } catch { /* 同上 */ }
  return { until: 0, code: '', at: '', strikes: 0 }
}

/**
 * 现在能不能去碰 B 站。
 * @returns {{cooling:boolean, remainMin:number, code:string, strikes:number}}
 */
export function riskState(root, now = new Date()) {
  const r = readRisk(root)
  const remainMs = r.until - now.getTime()
  return {
    cooling: remainMs > 0,
    remainMin: remainMs > 0 ? Math.ceil(remainMs / 60_000) : 0,
    code: r.code,
    strikes: r.strikes,
  }
}

/**
 * 这一趟看多少条。
 *
 * 冷却中 → 一条都不看（`skip:true`）；
 * 解冻后的头一天（strikes ≥ 1 且已过冷却）→ 减半，先试探；
 * 其余照配置。
 *
 * @param {{browse?:object}} cfg
 * @param {{cooling:boolean, strikes:number}} st
 */
export function browsePlan(cfg, st) {
  const perDay = Number(cfg?.browse?.perDay ?? 0)
  const topN = Number(cfg?.browse?.topN ?? 4)
  const deepRead = Number(cfg?.browse?.deepRead ?? 6)
  if (st?.cooling) return { skip: true, perDay, topN, deepRead, note: '风控冷却中' }
  if (Number(st?.strikes) >= 1) {
    const half = (n) => Math.max(1, Math.floor(n / 2))
    return {
      skip: false,
      perDay: Math.min(1, perDay),
      topN: half(topN),
      deepRead: half(deepRead),
      note: '刚被风控过，减半试探',
    }
  }
  return { skip: false, perDay, topN, deepRead, note: '' }
}
