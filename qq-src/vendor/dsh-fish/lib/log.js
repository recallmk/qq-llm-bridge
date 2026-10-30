/**
 * log.js —— 插件自己的运行日志（2026-10-24 加）
 *
 * 为什么要有这个：插件的所有日志以前走 `ctx.logger`，而宿主不把它落盘。
 * 真机上 `launch.log` 只有两行（token + 一条 llm 提示），`launch.err.log` 是 0 字节。
 * 结果就是：她某晚没说话、没刷站、没写日记，事后只能靠自检页猜。
 * 以「天」为单位的行为出问题，几乎都是「昨天还好今天不动了」，而那时的现场
 * 全在内存里，重启就没了。
 *
 * 三条硬规矩：
 * 1. **永不抛**。日志写不进去（盘满、权限被改、目录被删）绝不能连带让插件挂掉。
 * 2. **不做成配置项**。没有 `log.enabled` 这种开关——理由有两个：
 *    ① 关掉日志只会在出事那一刻让人后悔；② `/config` 的白名单曾经因为漏登记
 *    一个组把保存挡成 400（静默 bug ⑪），少一个可配键就少一个坑。
 * 3. **脱敏**。cookie 一类的值在写盘前替换掉，日志是给人看的，不是给泄露用的。
 *
 * 文件：`~/.dsh-fish/logs/dsh-fish.log`，超过 LOG_MAX_BYTES 轮转，
 * 依次 `dsh-fish.log.1`、`.2`，更老的丢掉。总量上界约 3 × 2MB。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { platform, arch } from 'node:os'

export const LOG_MAX_BYTES = 2 * 1024 * 1024
export const LOG_KEEP = 2
export const LINE_MAX = 2000

/** 日志目录（状态库下的 logs/，与 events.jsonl 同级，方便一起打包） */
export function logsDir(root) {
  const base = root || process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')
  return join(base, 'logs')
}

export function logFile(root) {
  return join(logsDir(root), 'dsh-fish.log')
}

/** 抹掉可疑的凭据。宁可把一条日志毁掉，也不要让 cookie 进日志文件。 */
export function scrub(text) {
  let s = String(text ?? '')
  // SESSDATA=xxx&bili_jct=yyy 这种整段 cookie
  s = s.replace(/(SESSDATA|bili_jct|buvid3|DedeUserID__ckMd5|DedeUserID|sid)=[^&\s"',;}]{4,}/gi, '$1=***')
  // 裸的 32+ 位十六进制/base64 长串（cookie 值常见形状）
  s = s.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '***' : m))
  return s
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  // 本地时间，不写时区偏移：看日志的人只关心"几点发生的"
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtArg(a) {
  if (a instanceof Error) return a.stack ? `${a.message} :: ${a.stack.split('\n').slice(1, 3).join(' ').trim()}` : a.message
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

/** 轮转：把 .log 顶成 .log.1，.1 顶成 .2，.2 丢掉 */
export function rotateIfNeeded(root) {
  try {
    const file = logFile(root)
    if (!existsSync(file)) return false
    if (statSync(file).size < LOG_MAX_BYTES) return false
    for (let i = LOG_KEEP; i >= 1; i -= 1) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      if (!existsSync(from)) continue
      try {
        if (i === LOG_KEEP && existsSync(to)) unlinkSync(to)
        renameSync(from, to)
      } catch { /* 单个文件挪不动不影响别的 */ }
    }
    return true
  } catch {
    return false
  }
}

/**
 * 写一行。level ∈ debug|info|warn|error。
 * 返回 true/false（写没写成功），但调用方**不需要看**返回值——永不抛。
 */
export function logLine(level, parts, root) {
  try {
    const line = `${stamp()} [${level}] ${scrub(parts.map(fmtArg).join(' ')).slice(0, LINE_MAX)}\n`
    const dir = logsDir(root)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateIfNeeded(root)
    appendFileSync(logFile(root), line, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 造一个 logger：既能进日志文件，也继续转发宿主 logger（有人在控制台看时仍然有）。
 * `ctx.logger` 可能不存在（测试环境），所以每一层都 optional。
 */
export function makeLogger(ctx, root) {
  const push = (level) => (...args) => {
    logLine(level, args, root)
    try {
      ctx?.logger?.[level]?.(...args)
    } catch { /* 宿主 logger 自己坏了也不能影响我们 */ }
  }
  return { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/** 启动时打一行分隔，方便在导出里定位"这一次启动" */
export function logBoot(root, extra = '') {
  logLine('info', [`===== 启动 ${extra}`.trim()], root)
}

/** 读末尾若干行（给设置页预览与导出用） */
export function tailLog(root, { lines = 50, maxBytes = 256 * 1024 } = {}) {
  try {
    const file = logFile(root)
    if (!existsSync(file)) return { file, exists: false, bytes: 0, lines: [] }
    const st = statSync(file)
    const size = st.size
    const readBytes = Math.min(size, maxBytes)
    const buf = readFileSync(file)
    const slice = buf.subarray(buf.length - readBytes)
    const text = slice.toString('utf8')
    // 从尾部读的时候第一行可能是半截，丢掉
    const all = text.split('\n')
    if (readBytes < size) all.shift()
    const kept = all.filter((l) => l.length > 0)
    return { file, exists: true, bytes: size, lines: kept.slice(-lines), total: kept.length }
  } catch (err) {
    return { file: logFile(root), exists: false, bytes: 0, lines: [], why: String(err?.message ?? err) }
  }
}

export function clearLog(root) {
  try {
    const file = logFile(root)
    if (!existsSync(file)) return { ok: true, cleared: false }
    writeFileSync(file, '', 'utf8')
    return { ok: true, cleared: true }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err) }
  }
}

/** 把配置里不该外带的东西去掉。config 结构里没有 cookie，但别指望将来也没有。 */
export function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg
  const clone = JSON.parse(JSON.stringify(cfg))
  for (const k of ['cookie', 'cookies', 'token', 'password', 'secret']) {
    if (k in clone) clone[k] = '***'
  }
  if (clone.owner && typeof clone.owner === 'object') {
    for (const k of Object.keys(clone.owner)) if (/cookie|sessdata|jct/i.test(k)) clone.owner[k] = '***'
  }
  return clone
}

/**
 * 导出包：一次给 AI 看够。
 * 顺序按"排查时最先想看什么"排：环境 → 自检 → 配置 → 日志 → 宿主报错。
 */
export function buildBundle(root, { checks = null, version = '', restrict = null, config = null, lines = 200 } = {}) {
  const out = []
  const now = new Date()
  out.push('=== 大肥鱼 dsh-fish 运行日志导出 ===')
  out.push(`导出时间: ${stamp(now)}`)
  if (version) out.push(`插件版本: ${version}`)
  out.push(`Node: ${process.version} / 平台: ${platform()} ${arch()}`)
  out.push(`状态库: ${root}`)

  if (restrict) {
    out.push(
      `工具面: ${restrict.applied ? '已收窄' : '未收窄'} · 允许 ${(restrict.allow || []).length} 个` +
        `${restrict.guard ? ' · 有兜底守卫' : ' · 没有兜底守卫'}` +
        `${restrict.why ? ` · 原因: ${restrict.why}` : ''}`,
    )
  }

  if (checks && Array.isArray(checks.items)) {
    out.push('', '--- 自检 ---')
    out.push(`结论: ${checks.summary || '(无)'}`)
    for (const it of checks.items) {
      const mark = it.ok ? 'OK ' : 'BAD'
      out.push(`${mark} ${it.label || it.id}: ${it.detail || ''}${it.fix ? ` | 修法: ${it.fix}` : ''}`)
    }
  }

  const log = tailLog(root, { lines })
  out.push('', `--- 日志（最近 ${log.lines.length} 行，文件共 ${log.bytes} 字节）---`)
  out.push(log.exists ? log.lines.map((l) => scrub(l)).join('\n') : '(还没有日志文件)')

  try {
    const errFile = join(root, 'launch.err.log')
    if (existsSync(errFile)) {
      const t = readFileSync(errFile, 'utf8').split('\n').filter(Boolean).slice(-40)
      out.push('', '--- 启动 stderr（launch.err.log 末 40 行）---')
      out.push(t.length ? scrub(t.join('\n')) : '(空)')
    }
  } catch { /* ignore */ }

  out.push('', '=== 结束 ===')
  return out.join('\n')
}
