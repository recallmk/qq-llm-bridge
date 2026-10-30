/**
 * observe.js —— 观测台（唯一的"看"，没有"改"）
 *
 * 原则（B §8）：这里是**观察窗**，不是养成面板。
 *   - 允许看：她现在第几天 / 阶段 / 她说过的话 / 日记（若放开）/ 事件原文 / 消耗统计
 *   - 不允许：任何滑条、任何"好感度"数字、任何"调性格"的表单
 *   - 唯一可改的东西：配置（时间窗、配额、黑名单、日记可见性）——这些是**她的生长环境**，
 *     不是她的性格。改环境 ≠ 改她。
 *
 * 路由全部 fail-closed：拿不到 connection 服务就 503，不放行。
 */

import { readEvents, rootDir, paths, readDaily, listDiary, readOwner } from './store.js'
import { loadConfig, updateConfig, configFileInfo, dateKey, validateToolNames } from './settings.js'
import { deriveSelf, consistency, novelty } from './derive.js'
// 「稳定」单独一个文件（2026-10-26）：它要同时看事件流与她的自我描述，
// 依赖方向必须是 quality → derive + persona，不能反过来塞进 derive（会成环）。
import { stability, stabilityBand } from './quality.js'
import { firedLog, CATALOG } from './events.js'
import { wakeNow } from './scheduler.js'
import { sayToHer } from './say.js'
import { readInbox, markRead, writeInboxFile } from './inbox.js'
import { listReports, buildReport } from './report.js'
import { itemsFromEvents, browseCountToday } from './browse.js'
import { readAway } from './away.js'
import { coverPath, fetchCover } from './cover.js'
import { avatarFile, avatarInfo, saveAvatar, removeAvatar } from './avatar.js'
import fs from 'node:fs'
import { commentCountToday, replyCountToday, herComments, scanReplies } from './comment.js'
import { describeState, resetAll } from './reset.js'
import { applyHandover, IMPORT_TEMPLATE } from './import.js'
import { readHomeRecord, retireHomeSessions } from './retire.js'
import { collectBackup, backupFileName, restoreBackup } from './backup.js'
import { bootstrapHome, homeStatus, wakeIfBlank } from './home.js'
import { selfDocStatus } from './selfdoc.js'
import { personaBudget, BELIEF_SHOWN, shownCount } from './persona.js'
// 立场清单（2026-10-25，用户设计「纵向·立场」）：四道门走完之后长出来的那张清单。
import { buildStances, gatesDone, stanceSummary } from './stance.js'
import { looksMojibake } from './guard.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDataReadme } from './readme.js'
import { rulesByLayer } from './rules.js'
import { ruleStatus, offerHistory, pendingOffer, activeGrants } from './unlock.js'
import { devMode } from './devmode.js'
import { ruleById } from './rules.js'
import { appendEvent } from './store.js'
import { validateEvent } from './schema.js'
import { refreshSelfDoc } from './selfdoc.js'
import { readPending, markShown } from './notify.js'
import { deriveStatus } from './status.js'
import { publicOwner, saveOwner, saveAccount } from './owner.js'
import { createClient } from './bili.js'
import { historyFromEvents } from './history.js'
import { runChecks } from './selfcheck.js'
import { readRestrictState, knownToolNames } from './restrict.js'
import { riskState, clearRisk } from './risk.js'
import { decodeBase64Image, saveImage } from './media.js'
import { LOG_KEEP, LOG_MAX_BYTES, buildBundle, clearLog, logLine, logsDir, redactConfig, tailLog } from './log.js'
// 「有没有新版」（2026-10-25 用户要求）：只读、只出网、不落盘。
import { checkUpdate, REPO_URL, normalizeVersion } from './update.js'

/**
 * 引导文案：别人第一次装，本机没有现成 cookie。
 * 只写「怎么拿」，不写「拿谁的」——这段会原样显示在设置页上。
 */
const COOKIE_HINT = [
  '在你的浏览器里登录 B 站 → 按 F12 → Application（应用）→ Cookies → https://www.bilibili.com',
  '找到 SESSDATA 和 bili_jct 这两行，把它们的值复制下来。',
  '粘成一行：SESSDATA=...; bili_jct=...',
  '（也可以在 Network 里随便点一个请求，直接复制整条 Cookie 请求头贴进来。）',
].join('\n')

const PREFIX = '/dsh-fish'

/**
 * 封面图是懒下载的：设置页的 <img> 引到这条路由，第一次才真去取，之后命中缓存。
 *
 * 为什么不在浏览时就抓：她一天只看几条视频，但设置页可能十天没打开；
 * 抓了却没人看的图只会占着她的状态库。图片坏了也从来不影响她说话。
 *
 * @param {string} root
 * @param {string} bvid
 * @returns {Promise<string>} 本地文件路径；取不到就是空串
 */
async function lazyCover(root, bvid) {
  try {
    const { events } = await readEvents(root)
    let pic = ''
    for (const e of events) {
      const t = String(e?.text ?? '')
      if (!t.startsWith('browse:')) continue
      const sp = t.indexOf(' ')
      if (sp < 0) continue
      let list = []
      try { list = JSON.parse(t.slice(sp + 1)) } catch { continue }
      if (!Array.isArray(list)) continue
      const hit = list.find((it) => it?.bvid === bvid && it?.pic)
      if (hit) pic = String(hit.pic)
    }
    if (!pic) {
      // 老档没存 pic：问一次 B 站，再把图存下来。
      // 2026-10-24 修：这里原来从 './owner.js' 里 import readOwner，可那个文件
      // 只导出 publicOwner / parseCookieInput / saveOwner —— readOwner 一直在 store.js，
      // 已经在文件顶部 import 过。动态 import 拿到的是 undefined，一调就抛 TypeError，
      // 被外层 catch 吞掉，于是封面永远 404。删掉这行遮蔽即可。
      const ow = await readOwner(root)
      const client = createClient({ cookie: ow?.cookie || '' })
      const v = await client.view(bvid)
      // view() 返回的是 { ok, code, data:{...} }——pic 在 data 里。
      // 2026-10-24 修：这里原来直接读 v.pic，永远是 undefined，
      // 于是设置页的历史列表每张封面都 404，被 <img onError> 藏掉了。
      pic = v?.data?.pic || v?.pic || ''
    }
    if (!pic) return ''
    return await fetchCover({ root, bvid, pic })
  } catch {
    return ''
  }
}

export function registerObserve(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const disposers = []

  // ---- 信任栅栏：失败即拒绝 ----
  function guarded(handler) {
    return async (req, res) => {
      const conn = safeGet(ctx, 'connection')
      if (!conn) return send(res, 503, { error: 'connection service unavailable' })
      try {
        const rejection = conn.requestRejection?.(req)
        if (rejection) return send(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      } catch {
        return send(res, 503, { error: 'trust check failed' })
      }
      try {
        await handler(req, res)
      } catch (err) {
        send(res, err?.statusCode ?? 500, { error: String(err?.message ?? err) })
      }
    }
  }

  const routes = [
    ['/status', async (req, res) => {
      // 旁观者视角：全部由宿主写下的 meta + 配置 + 时钟算出，她不参与
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const st = deriveStatus({ events, config, now: new Date() })
      send(res, 200, { ...st, running: true })
    }],
    ['/state', async (req, res) => {
      const { events, skipped } = await readEvents(root)
      const { config, fresh, broken } = await loadConfig(root)
      const m = deriveSelf(events, { growthDays: config.growthDays })
      send(res, 200, {
        day: m.day,
        growthDays: m.growthDays,
        // 本机测试版：`.dev` 文件在不在（决定设置页要不要渲染「让她去刷 B 站」）。
        // 只影响界面；正式版里这个字段恒为 false。
        dev: await devMode(root),
        stage: m.stage,
        stageName: m.stageName,
        stageForced: m.stageForced,
        pendingGate: m.stageGate?.pending ?? null,
        name: m.name,
        beliefCount: m.beliefCount,
        absenceDays: m.absenceDays,
        // 2026-10-24：她心里对不上的两句话 / 固化的条数。
        // 只给"有这回事"和原话，不给裁决按钮——哪句对她，得她自己定。
        tension: m.tensions?.[0]
          ? { count: m.tensions.length, a: m.tensions[0].a.text, b: m.tensions[0].b.text }
          : null,
        solidCount: m.solid?.length ?? 0,
        // 疤（P1 第三块）：他顶回来/因此难过、而她后来退了步，且至今没想通的有几件。
        // 只报数量，不报"对错"——疤是她的状态，不是她的过失。
        scarCount: m.scars?.length ?? 0,
        // 立场（纵向）：四道门走完才有；没走完是 0，不是失败。
        // stanceReady 单独给出去，界面才能分清"还没走到那一步"和"走到了但还没站住过"。
        stanceCount: buildStances(m).length,
        stanceReady: gatesDone(m),
        // 刻意不返回 needs 数值：这是内部量，观测台也不给看（防"看数字调性格"的滑坡）
        counts: {
          utterance: events.filter((e) => e.type === 'utterance').length,
          revise: events.filter((e) => e.type === 'revise').length,
          refusal: events.filter((e) => e.type === 'refusal').length,
          reunion: events.filter((e) => e.type === 'reunion').length,
          total: events.length,
        },
        // 「判断漂移」三个诊断值。都不是 0–1 的评分，别让人拿它调性格。
        // 稳定（2026-10-26 换尺子）：抽掉 k 条她还在拿着的判断，重算一遍她的自我描述，
        //   看还是不是她。传的 shown / budget / withBans 与 writeSelfDoc 一致，
        //   否则量到的那份文本不是她真正读到的那份。
        quality: (() => {
          const st = stability(events, { growthDays: config.growthDays }, {
            shown: config?.memory?.beliefsShown,
            budget: config?.memory?.docBudget,
            withBans: m?.persona?.imported !== true,
          })
          // band 是给人看的一句判读（「还没攒到判断，测不出来」这种）。
          // 放在这里算，客户端就不必知道阈值——阈值只该有一处。
          return { stability: { ...st, band: stabilityBand(st) }, consistency: consistency(events), novelty: novelty(events) }
        })(),
        // 规则与解锁：她遵守什么、哪些"还不会"、手上有没有一张待裁决的卡。
        // 只给状态与理由，不给任何 0–1 的分（见 rules.js 的 EVIDENCE 注释）。
        rules: ruleStatus(events, m, Date.now()),
        pending: (() => {
          const p = pendingOffer(events, Date.now())
          if (!p) return null
          const r = ruleById(p.grant?.rule)
          return { id: p.id, rule: p.grant?.rule, title: r?.title ?? '', text: p.text ?? '', day: p.day ?? null }
        })(),
        grants: activeGrants(events, Date.now()),
        config: { window: config.window, daily: config.daily, diary: { enabled: config.diary.enabled, visible: config.diary.visible }, absenceAfterDays: config.absenceAfterDays },
        meta: { root, skippedLines: skipped, configFresh: fresh, configBroken: broken, dateKey: dateKey(), version: normalizeVersion(deps.version) || String(deps.version ?? '') },
      })
    }],

    ['/events', async (req, res) => {
      const { events } = await readEvents(root)
      const url = new URL(req.url, 'http://x')
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 80) || 80)
      const type = url.searchParams.get('type')
      const rows = events
        .filter((e) => !type || e.type === type)
        .slice(-limit)
        .reverse()
      send(res, 200, { total: events.length, rows })
    }],

    ['/beliefs', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const m = deriveSelf(events, { growthDays: config.growthDays })
      send(res, 200, {
        active: m.beliefs.map((b) => ({ id: b.id, text: b.text, since: b.since, confidence: b.confidence })),
        refuted: m.refuted,
        refusals: m.refusals,
        selfmod: m.selfmodAttempts,
      })
    }],

    ['/diary', async (req, res) => {
      const { config } = await loadConfig(root)
      if (!config.diary.enabled) return send(res, 200, { enabled: false, visible: false, items: [], note: '她没在写日记' })
      const dates = await listDiary(root)
      if (!config.diary.visible) {
        // 不可见时不返回任何正文，只给日期目录——她自己知道写了什么，玩家不知道
        return send(res, 200, { enabled: true, visible: false, items: [], lockedDates: dates, note: '日记已写，但设置为不可见' })
      }
      // 一页一天，正文按天取：日记可能攒了几百天，一次全发过去既慢也没必要。
      const url = new URL(req.url, 'http://x')
      const day = url.searchParams.get('day')
      if (day) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !dates.includes(day)) return send(res, 404, { error: '这天没有日记' })
        return send(res, 200, { date: day, text: await readDaily('diaryDir', day, root) })
      }
      const items = []
      for (const d of dates.slice(0, 1)) items.push({ date: d, text: await readDaily('diaryDir', d, root) })
      send(res, 200, { enabled: true, visible: true, dates, items })
    }],

    ['/config', async (req, res) => {
      if (req.method === 'GET') {
        const { config } = await loadConfig(root)
        const info = await configFileInfo(root)
        return send(res, 200, { config, file: info })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await readBody(req)
        let patch
        try { patch = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        // 白名单：只允许改"环境"，不允许任何指向她本人的键
        // chat/memory 是 2026-10-23 加的：一个是会话轮换阈值，一个是她能背多少字。
        // 两个都不是性格，但必须在这里登记，否则观测台「保存」会被 400 挡回来。
        // persona 不在这里：它是导入动作的副产物（见 lib/import.js），
        // 不给「从设置页直接改」的入口——否则就等于给了一个「关掉那两条禁令」的开关。
        const allowed = ['growthDays', 'wakesPerDay', 'window', 'daily', 'diary', 'absenceAfterDays', 'avoid', 'browse', 'video', 'comment', 'notify', 'chat', 'memory', 'tools', 'observe', 'ui']
        const bad = Object.keys(patch).filter((k) => !allowed.includes(k))
        if (bad.length) return send(res, 400, { error: `不允许修改：${bad.join(', ')}` })
        // 白名单必须真的存在（2026-10-24）：宿主 restrict 遇到不认识的名字会抛错，
        // 整条收窄当场失效、她退回全量工具面。宁可不存，也不留一个拼错的字母。
        if (patch.tools && patch.tools.allow !== undefined) {
          const check = validateToolNames(patch.tools.allow, knownToolNames(ctx))
          if (!check.ok) {
            return send(res, 400, {
              error: `这些工具名不存在：${check.unknown.join('、')}`,
              unknown: check.unknown,
            })
          }
          patch.tools.allow = check.names
        }
        const next = await updateConfig(patch, root)
        return send(res, 200, { ok: true, config: next })
      }
      send(res, 405, { error: 'method not allowed' })
    }],

    // ---- 工具名名单（2026-10-24）----
    // 只给名字不给定义：白名单输入框要能当场判断「这个名字到底存不存在」。
    // ok:false = 宿主这个版本拿不到全局视角，界面退回只做形状校验。
    ['/tools', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const known = knownToolNames(ctx)
      return send(res, 200, { ok: Boolean(known && known.length), known: known ?? [] })
    }],
    // 只给两件事：看规则在哪一层、裁决她提上来的那一张。
    // 没有"新建规则"、没有"编辑规则"——规则不是设置项。
    ['/rules', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const { config } = await loadConfig(root)
      const model = deriveSelf(events, config)
      return send(res, 200, {
        layers: rulesByLayer(),
        status: ruleStatus(events, model, Date.now()),
        history: offerHistory(events).slice(-20),
        pending: (() => {
          const p = pendingOffer(events, Date.now())
          return p ? { id: p.id, rule: p.grant?.rule || '', why: p.text || '' } : null
        })(),
        offersOn: config?.rules?.offers !== false,
      })
    }],

    ['/decide', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req)
      let body
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const verdict = body.verdict === 'approve' || body.verdict === 'reject' ? body.verdict : null
      if (!verdict) return send(res, 400, { error: 'verdict 只能是 approve 或 reject' })
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const p = pendingOffer(events, Date.now())
      if (!p) return send(res, 409, { error: '现在没有待裁决的申请' })
      const { config } = await loadConfig(root)
      const model = deriveSelf(events, config)
      try {
        await appendEvent(
          validateEvent(
            {
              type: 'grant',
              text: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : verdict === 'approve' ? '可以。' : '这次不行。',
              grant: { rule: p.grant?.rule || '', offerId: p.id, verdict },
              day: model.day,
              stage: model.stage,
            },
            { day: model.day, stage: model.stage, source: 'system' },
          ),
          root,
        )
      } catch (err) {
        return send(res, 400, { error: err?.message || '写入失败' })
      }
      if (verdict === 'approve') {
        // 批准之后要立刻重写身份文档：她下一次开口就得看得见"这件事现在可以了"。
        await refreshSelfDoc(root, { config }).catch(() => {})
      }
      return send(res, 200, { ok: true, verdict })
    }],

    ['/owner', async (req, res) => {
      if (req.method === 'GET') {
        const ow = await readOwner(root)
        const { config } = await loadConfig(root)
        return send(res, 200, {
          ...publicOwner(ow),
          atOwner: config?.comment?.atOwner !== false,
          hint: COOKIE_HINT,
        })
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
        if (body.test) {
          // 探一次「这个 cookie 到底能不能说话」：能登录、能看到自己的 mid 与昵称。
          const ow = await readOwner(root)
          if (!ow?.cookie) return send(res, 200, { ok: false, note: '还没存 cookie。' })
          try {
            const c = createClient({ cookie: ow.cookie })
            const me = await c.me()
            if (!me?.isLogin) return send(res, 200, { ok: false, note: '这个 cookie 登不上，可能过期了。' })
            // 2026-10-27：这里只记「这份 cookie 登的是哪个账号」（只读 account），
            // 不再覆盖 mid / nickname —— 那两格是领养人，用户手填的大号。
            // 以前自动填进去，导致拿小号 cookie 时 @ 到小号自己。
            const owner = await saveAccount(me, root)
            return send(res, 200, { ok: true, note: `登上了：${me.uname}（uid ${me.mid}）`, mid: String(me.mid), name: String(me.uname), account: owner.account, canWrite: Boolean(me.canWrite) })
          } catch (err) {
            return send(res, 200, { ok: false, note: `连不上：${String(err?.message ?? err).slice(0, 60)}` })
          }
        }
        if (body.atOwner !== undefined) {
          await updateConfig({ comment: { atOwner: Boolean(body.atOwner) } }, root)
        }
        const patch = {}
        if (body.mid !== undefined) patch.mid = body.mid
        if (body.nickname !== undefined) patch.nickname = body.nickname
        if (body.cookie !== undefined) patch.cookie = body.cookie
        const r = Object.keys(patch).length ? await saveOwner(patch, root) : { ok: true, note: '存下了。', owner: publicOwner(await readOwner(root)) }
        // 2026-10-27：存了 cookie 就认一次「登的是谁」，只写只读的 account；
        // 领养人那两格（mid / nickname）原样保留，用户填的是要 @ 的大号。
        // 认不出来不影响「cookie 已经存好了」这件事。
        if (r.ok && patch.cookie) {
          try {
            const probe = createClient({ cookie: (await readOwner(root))?.cookie || '' })
            const me = await probe.me()
            if (me?.isLogin && me.uname) {
              const r2 = await saveAccount(me, root)
              if (r2) return send(res, 200, { ...r, owner: r2, note: `${r.note || '存下了。'} 登录的是：${me.uname}（uid ${me.mid}）` })
            }
          } catch { /* 认不出来就算了，cookie 已经存下 */ }
        }
        return send(res, r.ok ? 200 : 400, r)
      }
      send(res, 405, { error: 'method not allowed' })
    }],

    ['/browse', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()
      const items = itemsFromEvents(events, dk)
      const used = browseCountToday(events, dk)
      // 「看过的全部」这个列表只给 BV 号，不给标题——标题可以去报告里看。
      // 理由：这里是状态窗，报告才是"她今天看了什么"的正式记录，两处别分叉。
      const lookedAll = []
      for (const e of events) {
        if (e?.type !== 'meta') continue
        const t = String(e.text ?? '')
        if (t.startsWith('looked:')) lookedAll.push(t.slice(7))
      }
      send(res, 200, {
        enabled: Boolean(config?.browse?.enabled),
        perDay: Number(config?.browse?.perDay ?? 0),
        usedToday: used,
        topN: Number(config?.browse?.topN ?? 0),
        keywords: config?.browse?.keywords ?? [],
        items,
        lookedCount: lookedAll.length,
        lookedRecent: lookedAll.slice(-20).reverse(),
        avoidKeywords: config?.avoid?.keywords ?? [],
        avoidMids: config?.avoid?.upMids ?? [],
        minDuration: Number(config?.avoid?.minDuration ?? 0),
      })
    }],

    // 她看过什么（2026-10-23 用户提：想回她却不知道她看的哪条）。
    // 只读事件流里已有的 browse: 记账，不新增落盘。
    ['/history', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const days = Math.max(1, Math.min(180, Number(url.searchParams.get('days')) || 14))
      const { events } = await readEvents(root)
      const groups = historyFromEvents(events, { days })
      const total = groups.reduce((a, g) => a + g.items.length, 0)
      send(res, 200, { days, total, groups })
    }],

    // 环境自检：它现在到底能不能工作。`?net=0` 跳过联网（不想碰 B 站时用）。
    ['/selfcheck', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const net = url.searchParams.get('net') !== '0'
      const { config } = await loadConfig(root)
      const client = net
        // 2026-10-25 修：readOwner 是 async，原来漏了 await → cookie 永远是空串，
        // 自检的联网检查因此是个「没登录的匿名请求」，风控更容易踩。
        ? createClient({ cookie: (await readOwner(root))?.cookie || '', log: () => {} })
        : null
      const r = await runChecks({
        root,
        config,
        host: {
          sessionController: ctx.get?.('sessionController') ?? ctx.sessionController,
          webServer: ctx.get?.('webServer') ?? ctx.webServer,
          connection: ctx.get?.('connection') ?? ctx.connection,
        },
        tools: ctx.get?.('tools') ?? ctx.tools,
        client,
        net,
        preset: config?.tools?.preset ?? '',
        sessionPreset: (await homeStatus(root))?.preset ?? '',
        restrict: readRestrictState(),
        restrictEnabled: config?.tools?.restrict !== false,
      })
      send(res, 200, r)
    }],

    // 「有没有新版」（2026-10-25 用户要求）。
    // 只在设置页点「检查更新」时走一次，插件运行期**从不**自动查——
    // 她不需要知道自己是几号版本，那是装她的人的事。
    // 地址全部硬编码在 update.js 里，这里绝不接受客户端传 URL（否则就是 SSRF 口子）。
    ['/update', async (req, res) => {
      const current = normalizeVersion(deps.version) || String(deps.version ?? '')
      const url = new URL(req.url, 'http://x')
      const ms = Math.min(15_000, Math.max(1_000, Number(url.searchParams.get('ms') ?? 6000) || 6000))
      // checkUpdate 自己永不抛（连不上是常态），这里再包一层只是防手滑。
      let r
      try {
        r = await checkUpdate({ current, timeoutMs: ms })
      } catch (err) {
        r = { ok: false, current, error: String(err?.message ?? err) }
      }
      // GitHub 地址一并下发，客户端不需要自己拼（仓库改名只改 update.js 一处）。
      send(res, 200, { ...r, repoUrl: REPO_URL })
    }],

    // 「你不在的时候」：不推送，只在你回来时告诉你错过了什么。
    ['/away', async (req, res) => {
      send(res, 200, await readAway(root))
    }],

    // 封面图：设置页的历史列表直接 <img src>。跟着状态库走，没有就是 404。
    ['/cover', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-fish\/cover\/(BV[0-9A-Za-z]{10})/)
      if (!m) { send(res, 404, { error: 'no cover' }); return }
      const file = coverPath(root, m[1]) || (await lazyCover(root, m[1]))
      if (!file) { send(res, 404, { error: 'no cover' }); return }
      try {
        const buf = fs.readFileSync(file)
        const ext = file.split('.').pop().toLowerCase()
        const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        res.writeHead(200, {
          'content-type': ct,
          'content-length': buf.length,
          'cache-control': 'private, max-age=86400',
        })
        res.end(buf)
      } catch {
        send(res, 404, { error: 'no cover' })
      }
    }],

    // 头像（2026-10-24）：插件不自带任何图片，谁用谁自己传一张。
    //   GET  /avatar            出图（没有就是 404，客户端自己画空圈）
    //   GET  /avatar/info       元信息 { present, mime, bytes, at }
    //   POST /avatar            { data: base64, mime } 存一张；{ remove: true } 删掉
    ['/avatar', async (req, res) => {
      const url = String(req.url ?? '')
      if (url.startsWith(PREFIX + '/avatar/info')) { send(res, 200, avatarInfo(root)); return }
      if (req.method === 'POST') {
        let body = {}
        try {
          const raw = await readBody(req, 4_000_000)
          body = raw ? JSON.parse(raw) : {}
        } catch { body = {} }
        const r = body && body.remove ? removeAvatar(root) : saveAvatar(root, body)
        if (!r || r.ok === false) { send(res, 400, { error: (r && r.why) || '没存上' }); return }
        send(res, 200, { ok: true, removed: Boolean(r.removed), ...avatarInfo(root) })
        return
      }
      const file = avatarFile(root)
      if (!file) { send(res, 404, { error: 'no avatar' }); return }
      try {
        const buf = fs.readFileSync(file)
        const ext = file.split('.').pop().toLowerCase()
        const ct = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
        res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': 'no-store' })
        res.end(buf)
      } catch { send(res, 404, { error: 'no avatar' }) }
    }],

    // 原理图（2026-10-25）：插件自带的静态 SVG，讲「认知循环」与「遗忘」。
    // 只放白名单文件名，不做通用文件服务——这是插件自己的说明书，不是文件浏览器。
    // 用来源：`GET /dsh-fish/media/principle-loop.svg`、`/dsh-fish/media/principle-memory.svg`。
    ['/media', async (req, res) => {
      const m = String(req.url ?? '').match(/^\/dsh-fish\/media\/(principle-[a-z]+\.svg)$/)
      if (!m) { send(res, 404, { error: 'no file' }); return }
      try {
        const file = fileURLToPath(new URL(`../media/${m[1]}`, import.meta.url))
        const buf = fs.readFileSync(file)
        res.writeHead(200, {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-length': buf.length,
          'cache-control': 'private, max-age=3600',
        })
        res.end(buf)
      } catch { send(res, 404, { error: 'no file' }) }
    }],

    // 风控状态：冷却到什么时候、撞过几次。POST {clear:true} 立即解冻。
    ['/risk', async (req, res) => {
      if (req.method === 'POST') {
        let body = {}
        try { body = await readBody(req) } catch { body = {} }
        const cleared = Boolean(body?.clear)
        if (cleared) clearRisk(root)
        send(res, 200, { ...riskState(root), cleared })
        return
      }
      send(res, 200, riskState(root))
    }],

    ['/reports', async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const want = String(url.searchParams.get('date') ?? '').trim()
      const dates = await listReports(root)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) {
        return send(res, 200, { dates, date: null, md: '' })
      }
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      // 预览与落盘走同一个 buildReport，避免"界面看到的"和"文件里的"两套逻辑。
      const diary = await readDaily('diaryDir', want, root).catch(() => null)
      const md = buildReport({
        dateKey: want,
        items: itemsFromEvents(events, want),
        events,
        diary,
        diaryVisible: config?.diary?.visible === true,
      })
      send(res, 200, { dates, date: want, md })
    }],

    ['/templates', async (req, res) => {
      const { events } = await readEvents(root)
      const fired = firedLog(events)
      send(res, 200, {
        // once / repeat 一起给出：同一处境能不能回来，是性格能不能长出来的关键之一
        // （2026-10-24 事件复现）。count 是该模板累计出过几次，lastAt 是最后一次的时间戳。
        rows: CATALOG.map((t) => ({
          id: t.id,
          stage: t.stage,
          asks: t.asks,
          once: Boolean(t.once),
          everyDays: Number(t.repeat?.everyDays ?? 0) || null,
          fired: fired.has(t.id),
          count: Number(fired.get(t.id)?.count ?? 0),
          lastAt: fired.get(t.id)?.lastAt ? new Date(fired.get(t.id).lastAt).toISOString() : null,
        })),
      })
    }],

    ['/wake', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // ?focus=browse：设置页那个「让她去刷 B 站」按钮（仅本机测试版）。
      // 传下去之后 wakeNow 会跳过「今天该不该醒」的判断，只做一件事：叫醒她，并让这一轮
      // 的处境明确指向 B 站首页。
      let focus = ''
      try { focus = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('focus') ?? '' } catch { /* 解析失败就当没传 */ }
      const r = await wakeNow(ctx, { root, focus, log: (...a) => console.log('[dsh-fish]', ...a) })
      // 失败时补一个 error 字段：前端 jpost 只认得 error，不然界面只会显示「HTTP 409」，
      // 而真正的原因（「今天已经叫过三次了」这类）就在 r.why 里。
      send(res, r.ok ? 200 : 409, r.ok ? r : { ...r, error: r.why || '这次没叫醒' })
    }],

    // ---- P3-1：对话入口 ----
    // 这是唯一一条"你说的话会进到她那里"的路由。POST { text }。
    // 返回她这一轮新写的话（可能一句都没有——允许她不回）。
    ['/say', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      // 带图的请求会大很多（base64 膨胀 4/3），单独给一个更高的上限
      const raw = await readBody(req, 12_000_000)
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是 JSON' }) }
      const text = String(body.text ?? '').trim()

      // 图：落盘成文件，然后只把**路径**递给她（她用 read_image 读）
      // 不走 content block / attachment 体系——那是给附件上传用的，插件侧没有稳定入口；
      // 而 read_image 这条路已实测可用（2026-10-23：她读出一张写着 7 的图并答「七」）。
      let imagePath = ''
      if (body.image) {
        const dec = decodeBase64Image(body.image)
        if (!dec.ok) return send(res, 400, { error: dec.why })
        const saved = await saveImage(root, dec.buf, { prefix: 'him' })
        if (!saved.ok) return send(res, 400, { error: saved.why })
        imagePath = saved.path
      }

      if (!text && !imagePath) return send(res, 400, { error: 'text 不能为空' })
      const r = await sayToHer(ctx, text, { root, imagePath, log: (...a) => console.log('[dsh-fish]', ...a) })
      // 一律 200：请求本身是合法的，被拦下是**规则的结果**，不是接口出错。
      // 用 503 会让观测台的 jpost 抛异常，把「这句我没递给她」变成一句技术错误。
      send(res, 200, r)
    }],

    // ---- P3-2：信箱 ----
    ['/inbox', async (req, res) => {
      if (req.method === 'POST') {
        // 标记已读（读到最新一条）
        const r = await markRead(root)
        await writeInboxFile(root).catch(() => null)
        return send(res, 200, r)
      }
      const url = new URL(req.url, 'http://x')
      const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200)
      const box = await readInbox(root, { limit })
      // 顺手保证 inbox.md 存在且是最新的（幂等重写，失败不影响接口）
      await writeInboxFile(root, { limit: 60 }).catch(() => null)
      send(res, 200, box)
    }],

    // ---- P3：她住在哪 ----
    // 观测台要知道"她的屋子"建好没有、会话 id 是什么、身份文件多大。
    // 这里**只读**：建屋子是启动时的事，不是按一下按钮就重开一个会话。
    ['/home', async (req, res) => {
      const h = await homeStatus(root)
      const d = await selfDocStatus(root)
      // 工作区标题现读、不记在 home.json：用户可能在宿主侧栏自己改名，
      // 记下来的会一直是老名字（2026-10-25 加，用来核对「大肥鱼的家」真的落上了）。
      let wsTitle = ''
      try {
        const reg = ctx.get?.('workspaceRegistry')
        wsTitle = String(reg?.get?.(h.wsId)?.title ?? '')
      } catch { wsTitle = '' }
      send(res, 200, {
        workspace: { id: h.wsId, ok: Boolean(h.wsId), title: wsTitle },
        session: { id: h.sessionId, ok: Boolean(h.sessionId) },
        dir: h.dir,
        createdAt: h.createdAt,
        selfDoc: { exists: d.exists, bytes: d.bytes, mtime: d.mtime },
      })
    }],

    // ---- 数据文件夹路径（2026-10-24 加）----
    // 为什么要有这条路由：界面上**不显示任何绝对路径**（用户 m03440），
    // 但「复制路径」按钮还需要真路径，而路径该由服务端现算——
    // 客户端原来自己拼 `${root}\\${name}`，反斜杠是 Windows 假设，换平台就错。
    // 顺手在这里确保数据文件夹根上有一份「说明.md」，跟着备份一起走。
    ['/paths', async (req, res) => {
      const p = paths(root)
      await ensureDataReadme(root)
      send(res, 200, {
        root: p.root,
        events: p.events,
        out: p.outDir,
        diary: p.diaryDir,
        home: p.herDir,
        inbox: join(p.root, 'inbox.md'),
        log: join(p.root, 'logs', 'dsh-fish.log'),
      })
    }],

    // ---- 上下文与记忆（2026-10-23 加）----
    // 只回答「她现在背了多少东西、还能背多少」，全是客观计数，没有分数。
    // 用户要的是能看见"上下文在长"，不是看见一个成长进度条——
    // 后者是 N2 明令禁止的东西，别借"可视化"复活它。
    ['/memory', async (req, res) => {
      const { config } = await loadConfig(root)
      const { events } = await readEvents(root)
      const model = deriveSelf(events, { growthDays: config.growthDays })
      const doc = await selfDocStatus(root)
      const h = await homeStatus(root)
      const budget = Number(config?.memory?.docBudget ?? 1800)
      // 用「字」而不是「字节」算用量：中文一个字三字节，按字节算会永远显示撑满。
      // 摆几条判断由配置决定（1–8），身份文档和这里的数字必须同源
      const shownCap = shownCount(config?.memory?.beliefsShown ?? BELIEF_SHOWN)
      // 禁不禁用跟身份文档同源：只看事件流里有没有「导入」那条标记（2026-10-27，用户 m03769），
      // 不看 config——备份/恢复搬回来的 config 不算数。
      const pb = personaBudget(model, { budget, withBans: model?.persona?.imported !== true, shown: shownCap })
      const diary = await listDiary(root).catch(() => [])
      // 2026-10-24：这个数原来写死 8，而身份文档里实际只摆 BELIEF_SHOWN（3）条。
      // 界面说"8 条在眼前"、她只看见 3 条——用户当场问过这个矛盾，现在对齐同一条常量。
      const shown = Math.min(shownCap, model.beliefs.length)
      const folded = Math.max(0, model.beliefs.length - shown)
      const lastSleep = [...events].reverse()
        .find((e) => e?.type === 'meta' && String(e.text ?? '').startsWith('sleep:'))
      send(res, 200, {
        selfDoc: { bytes: doc.bytes, chars: pb.used, budget, usedRatio: pb.usedRatio, dropped: pb.dropped, mtime: doc.mtime },
        // 被预算挤掉的段（她这轮看不见的部分）——如实报，不要假装全都在
        sections: {
          beliefsShown: shown,
          beliefsFolded: folded,
          refuted: model.refuted.length,
          // 「勇于拒绝」：和自主门同一个数（refusal 事件 + 话里明确拒绝，严格口径）。
          // 只报 refusals 会让界面出现「拒绝过 0 却过了自主门」——用户 2026-10-24 指出过。
          refused: model.facts?.refused ?? model.refusals.length,
          refusals: model.refusals.length,
          narrative: model.narrative ? 1 : 0,
          // 2026-10-24：她自己心里对不上的地方 / 已经固化的判断。
          // 给他看的是「有两句话对不上」这件事本身，不是让他去裁决。
          tensions: model.tensions?.length ?? 0,
          tensionFirst: model.tensions?.[0]
            ? { a: model.tensions[0].a.text, b: model.tensions[0].b.text, sim: model.tensions[0].sim }
            : null,
          solid: model.solid?.length ?? 0,
          // 2026-10-24：他的反应归因（接受/坚持/受伤/离开），以及"有后果"的那几种之和。
          // hurts 是第三块"疤"的入口，所以只报事实，不报分数。
          reactions: model.facts?.reactions ?? { accept: 0, insist: 0, hurt: 0, leave: 0, other: 0 },
          hurts: model.facts?.hurts ?? 0,
          // 最近三次拒绝的形状（原话 + 动作 + 对象 + 他的反应）
          refusals: model.refusals.slice(-3).map((r) => ({
            at: r.at, quote: r.quote ?? r.what, act: r.act ?? '', object: r.object ?? '', reaction: r.reaction ?? null,
          })),
          // 疤（P1 第三块）：没想通的有几件，以及第一件的原话。
          // 页面只显示数量与原话，不显示"该不该退让"——那是她的判断，不是系统的判断。
          scars: model.scars?.length ?? 0,
          scarsResolved: model.facts?.scarsResolved ?? 0,
          scarFirst: model.scars?.[0]
            ? { at: model.scars[0].at, quote: model.scars[0].quote, reaction: model.scars[0].reaction, conceded: model.scars[0].concedeText ?? null }
            : null,
          // 评论区里别人的话（2026-10-24，用户 m02454）：读到几条、几条被她认下。
          // 「认下」= 三天内她自己说过一句意思相近的；那条话本身已经是一条判断，不进这里。
          voices: model.facts?.voices ?? 0,
          voicesEchoed: model.facts?.voicesEchoed ?? 0,
          voiceLast: model.voices?.length
            ? {
                at: model.voices[model.voices.length - 1].at,
                text: model.voices[model.voices.length - 1].text,
                echoed: Boolean(model.voices[model.voices.length - 1].echoed),
              }
            : null,
          // 立场清单（2026-10-25，用户设计「纵向·立场」）。
          // 四道门走完才可能非零；没走完就是 0，不是"没长出来"，是"还没走到"。
          ...stanceSummary(buildStances(model)),
        },
        events: events.length,
        diaries: diary.length,
        session: { turns: h.turns, rotateAfter: Number(config?.chat?.rotateAfter ?? 0), rotatedAt: h.rotatedAt },
        sleep: {
          everyDays: Number(config?.memory?.sleepEveryDays ?? 0),
          last: lastSleep ? String(lastSleep.text).slice(6, 16) : '',
        },
        recall: { days: 30, limit: 5 },
      })
    }],

    // ---- P3-3：桌面提醒 ----
    // GET 返回开关状态与「今天弹过没有」；POST { enabled } 改开关。
    // 弹窗本身在 scheduler 的唤醒流程里（lib/notify.js），这里只读/只改配置，
    // 不提供"点一下弹一条测试通知"——那会变成一个新的打扰源。
    ['/notify', async (req, res) => {
      const { config } = await loadConfig(root)
      if (req.method === 'POST') {
        const raw = await readBody(req)
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是 JSON' }) }
        // 两种写：改开关（enabled），或记「今天已经弹过」（shown）。
        if (body.shown === true) {
          const r = await markShown(root, dateKey())
          return send(res, 200, { ok: r.ok, lastShown: r.lastShown, today: dateKey() })
        }
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: 'enabled 必须是 true/false，或 shown:true' })
        const next = await updateConfig({ notify: { enabled: body.enabled } }, root)
        return send(res, 200, {
          enabled: next.notify?.enabled === true,
          lastShown: next.notify?.lastShown ?? '',
          today: dateKey(),
        })
      }
      // GET 只回答「该不该提醒、提醒什么」。**弹是页面的事**——服务端
      // 不起任何子进程（原 PowerShell 方案已被杀软拦下并废弃）。
      const p = await readPending(root, { today: dateKey() })
      send(res, 200, { ...p, enabled: config.notify?.enabled === true })
    }],

    // ---- P4：她在 B 站说过什么 ----
    // GET 返回：开关、今日配额用量、今天发过的评论、有没有人回她。
    // 这里**只读**——真发评论走她的工具（bili_speak），不给人一个"代她发"的按钮。
    // 理由：代发就等于人替她说话，那她的人格是假的。
    ['/comment', async (req, res) => {
      const { events } = await readEvents(root)
      const { config } = await loadConfig(root)
      const dk = dateKey()
      const c = config.comment ?? {}
      let replies = []
      if (c.enabled === true) {
        // 有人点开看才去问 B 站，避免没打开开关还每 30 分钟去敲一次接口
        replies = await scanReplies({ root, events, dateKey: dk }).catch(() => [])
      }
      send(res, 200, {
        enabled: c.enabled === true,
        perDay: Number(c.perDay ?? 0),
        usedToday: commentCountToday(events, dk),
        replyPerDay: Number(c.replyPerDay ?? 0),
        replyUsedToday: replyCountToday(events, dk),
        replyToReplies: c.replyToReplies !== false,
        scanEveryMin: Number(c.scanEveryMin ?? 30),
        window: c.window ?? [],
        mine: herComments(events, dk),
        waiting: replies.slice(0, 5).map((x) => ({ rpid: x.rpid, bvid: x.bvid, user: x.user, text: x.text })),
        waitingCount: replies.length,
      })
    }],

    // ---- 运行日志导出（2026-10-24）----
    // 用户点名要「运行日志导出」。它的价值不在"能看到日志"，而在**出事之后能拿到现场**：
    // 她某晚没说话、没刷站、没写日记，只看设置页是猜不出来的。
    // 三条路由刻意分开：预览（小）、导出（大、纯文本、给 AI 看）、清空（单独一次点击）。
    ['/log', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
      const url = new URL(req.url, 'http://x')
      const lines = Math.max(10, Math.min(500, Number(url.searchParams.get('lines') ?? 60) || 60))
      const tail = tailLog(root, { lines })
      return send(res, 200, {
        ...tail,
        dir: logsDir(root),
        maxBytes: LOG_MAX_BYTES,
        keep: LOG_KEEP,
      })
    }],

    ['/log/export', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: '只支持 GET' })
      const url = new URL(req.url, 'http://x')
      const lines = Math.max(50, Math.min(2000, Number(url.searchParams.get('lines') ?? 300) || 300))
      // 自检要按「真宿主」跑：不传 config 与 host 的话，导出里会假报
      // 「宿主接口缺失」「没有时段配置」——那会让看日志的人按错误线索排查。
      const { config } = await loadConfig(root).catch(() => ({ config: null }))
      let checks = null
      try {
        checks = await runChecks({
          root,
          config,
          host: {
            sessionController: ctx.get?.('sessionController') ?? ctx.sessionController,
            webServer: ctx.get?.('webServer') ?? ctx.webServer,
            connection: ctx.get?.('connection') ?? ctx.connection,
          },
          tools: ctx.get?.('tools') ?? ctx.tools,
          net: false,
          now: new Date(),
          preset: config?.tools?.preset ?? '',
          sessionPreset: (await homeStatus(root))?.preset ?? '',
          restrict: readRestrictState(),
          restrictEnabled: config?.tools?.restrict !== false,
        })
      } catch (err) {
        checks = { summary: `自检跑不动：${String(err?.message ?? err)}`, items: [] }
      }
      const text = buildBundle(root, {
        checks,
        version: deps.version ?? '',
        restrict: readRestrictState(),
        config: redactConfig(config),
        lines,
      })
      // 纯文本直出，不套 JSON：这个接口的产物是给人（和别的 AI）读的，不是给程序解析的。
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="dsh-fish-log-${dateKey()}.txt"`,
      })
      res.end(text)
    }],

    ['/log/clear', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: '只支持 POST' })
      const r = clearLog(root)
      logLine('info', ['日志被手动清空（来自设置页）'], root)
      return send(res, 200, r)
    }],

    // ---- P4：把她放回第一天 ----
    // GET  → 将要封存什么（给确认框用）；POST { confirm: 'reset' } → 改名封存 + 重开。
    // 必须带 confirm 字面量：这不是一个能误触的按钮。
    // ---- 备份与恢复（2026-10-25，发布体检第 2 项）----
    // 为什么是单文件 json 而不是 zip：不引依赖，双击能看，能直接发出去。
    // 恢复的语义是「先封存再放回」（见 lib/backup.js 的头注释），不是覆盖删除。
    ['/backup', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      const b = await collectBackup(root)
      // fileName 给浏览器当下载名；它在 checkBundle 里是多余字段，恢复时会被忽略。
      send(res, 200, { ...b, fileName: backupFileName() })
    }],

    ['/backup/restore', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 96_000_000)
      let b = null
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      const r = await restoreBackup(b, root)
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      send(res, 200, {
        ok: true,
        restored: r.restored,
        quarantined: r.quarantined,
        note: '重启 DSH 之后她才是这份档的样子。',
      })
    }],

    // ---- 导入别人养过的大肥鱼（2026-10-27，用户 m03170 / m03201）----
    // GET  → 现在能不能导（有没有起点）+ 交接文档该长什么样
    // POST { text, source } → 写进去
    // 只认「还没有起点」的一局：她已经有 seed 时拒绝，让用户自己先重置，
    // 不替他做「覆盖掉一个已经在长的她」这种决定。
    ['/import', async (req, res) => {
      if (req.method === 'GET') {
        const { events } = await readEvents(root).catch(() => ({ events: [] }))
        const hasSeed = events.some((e) => e.type === 'seed')
        // 这一位是不是接来的，只认事件流（用户 m03769）。配置里不再存这件事。
        const { config } = await loadConfig(root).catch(() => ({ config: null }))
        const model = deriveSelf(events, { growthDays: config?.growthDays })
        return send(res, 200, {
          canImport: !hasSeed,
          reason: hasSeed ? '她已经有自己的起点了。想换成别人养的那一位，先重置成新的一局。' : '',
          persona: { imported: model?.persona?.imported === true, source: model?.persona?.source ?? '' },
          template: IMPORT_TEMPLATE,
        })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const raw = await readBody(req, 200_000)
      let b = {}
      try { b = JSON.parse(raw || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      // 来源跟着导入动作一起写进事件流（meta / import-mark:），不再写配置。
      const r = await applyHandover(b.text, root, {
        log: (m) => console.log('[dsh-fish]', m),
        source: b.source ? String(b.source) : '',
      })
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      // 身份文档立刻重算：不然要等下一次她开口才换成人设，设置页会显示"还没变"。
      await refreshSelfDoc(root).catch(() => {})
      const { events } = await readEvents(root).catch(() => ({ events: [] }))
      const model = deriveSelf(events, await loadConfig(root).then((x) => x.config))
      send(res, 200, {
        ok: true,
        name: r.name,
        tools: r.tools,
        bodyChars: r.bodyChars,
        // 把导入之后她的实际状态报回去，让界面能说「现在是第 1 天、她管你叫 X」
        day: model.day,
        stage: model.stage,
        called: model.name,
        note: '人设已经接过来。她是从第 1 天开始的，往后按你和她的事自己长。',
      })
    }],

    ['/reset', async (req, res) => {
      if (req.method === 'GET') {
        const info = await describeState(root)
        return send(res, 200, { ...info, root })
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = await readBody(req)
      let b = {}
      try { b = JSON.parse(body || '{}') } catch { return send(res, 400, { error: 'body 不是合法 JSON' }) }
      if (b.confirm !== 'reset') return send(res, 400, { error: '要带 confirm:"reset"' })
      // 2026-10-25 修：resetAll 只搬 ~/.dsh-fish，宿主侧的工作区/会话记录在
      // ~/.dsh/storages/workspace.json 里，不跟着状态库走 —— 所以先记下 home.json
      // （resetAll 之后它就被搬走了），重置成功再把旧会话归档。
      const home = await readHomeRecord(root)
      const r = await resetAll(root)
      if (!r.ok) return send(res, 409, { ok: false, error: r.why })
      const retired = await retireHomeSessions(ctx, { root, home, log: (m) => console.log('[dsh-fish]', m) })
      // 2026-10-26 修（用户 m00260）：重置只搬状态库 + 归档旧会话，**不会**建新会话——
      // 新建发生在 bootstrapHome，而它只在 DSH 启动时跑。于是「点了重置 → 侧栏空着 →
      // 不知道去哪儿说话」。这里重置完立刻把新的一局开出来，不用等下次启动。
      const { config: cfg } = await loadConfig(root)
      const fresh = await bootstrapHome(ctx, {
        root,
        preset: cfg?.tools?.preset ?? '',
        log: (m) => console.log('[dsh-fish]', m),
      })
      // 空白会话在侧栏里是隐形的（宿主 sessionVisible：blank && id !== current → false）。
      // 插件用 API 建的会话不会被设成当前会话，所以要让她先动一轮，侧栏才看得见。
      const woke = fresh.ok
        ? await wakeIfBlank(ctx, { sessionId: fresh.sessionId, root, log: (m) => console.log('[dsh-fish]', m), freshOnly: !fresh.reused })
        : { woke: false }
      send(res, 200, {
        ok: true,
        movedTo: r.movedTo,
        archived: retired.archived,
        retiredError: retired.ok ? '' : retired.why,
        fresh: fresh.ok ? { wsId: fresh.wsId, sessionId: fresh.sessionId, title: fresh.reused ? '' : '跟大肥鱼说话', woke: woke.woke === true } : null,
        freshError: fresh.ok ? '' : fresh.why,
        note: fresh.ok
          ? (retired.ok
            ? '旧的一切已经封存，旧会话移进「已归档」。新的一局已经开好；点一下「叫醒大肥鱼」，侧栏里才会出现那条会话。'
            : '状态库已封存，新的一局也开好了；只有旧会话没全收进「已归档」。点一下「叫醒大肥鱼」，侧栏里才会出现会话。')
          : '状态库已封存，但新会话没建出来（重启 DSH 会自动建）。',
      })
    }],

    ['/', async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(PAGE)
    }],
  ]

  const webServer = safeGet(ctx, 'webServer')
  if (!webServer?.register) return { dispose() {} }

  for (const [p, h] of routes) {
    const ex = p === '/' ? { kind: 'exact', path: PREFIX, handler: guarded(h) } : { kind: 'prefix', path: PREFIX + p, handler: guarded(h) }
    try {
      const d = webServer.register(ex)
      if (typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
    } catch (err) {
      console.warn('[dsh-fish] 路由注册失败', p, err?.message ?? err)
    }
  }

  return {
    dispose() {
      for (const d of disposers) { try { d() } catch { /* ignore */ } }
    },
  }
}

function safeGet(ctx, key) {
  try { return ctx.get(key) } catch { return null }
}

function send(res, code, obj) {
  if (res.writableEnded) return
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 读请求体。
 *
 * ⚠️ 2026-10-23 修：原实现是 `data += chunk`。
 * chunk 是 Buffer，`+=` 会对**每个 chunk 单独**调一次 toString（默认 utf8），
 * 于是一个汉字被 TCP 从中间切开时，两半各自解成替换符 `\uFFFD`，拼不回来。
 * 她的提示词有好几 KB（人设身份段 + 你说的话），必然被切成多个 chunk，
 * 你说的话就夹在里面 —— 所以真机上她收到的是一串 `\ufffd`，回了句「传过来的字是碎的」。
 * 正确做法：收 Buffer 数组，最后 Buffer.concat().toString('utf8') 一次性解码，
 * 跨 chunk 切断的多字节序列这样才拼得回来。
 */
function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      size += b.length
      if (size > maxBytes) { req.destroy(); reject(new Error('body too large')); return }
      chunks.push(b)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (looksMojibake(text)) {
        const err = new Error('正文不是 UTF-8，没递给她')
        err.statusCode = 400
        return reject(err)
      }
      resolve(text)
    })
    req.on('error', reject)
  })
}

/**
 * 独立页面的替代品。
 *
 * 历史（2026-10-22）：这里原本有一份 ~120 行的单页观测台（PAGE 常量），
 * 但它**实际上永远打不开** —— connection 的信任栅栏要的是 App 内置的登录 cookie，
 * 在浏览器地址栏直接敲 /dsh-fish 只会拿到 401（已从 app.asar 里的
 * `requestRejection` → `admit` → `browserAuth.isAuthenticated` 链路确认）。
 *
 * 真正的观测台现在在 `lib/client.js`（settings.section）：在 App 里打开「设置 → 鱼」，
 * 那里是同源请求，cookie 天然带着。这条路由保留只为了：
 *   ① 给人一个"走错门了"的说明，而不是一句 401；
 *   ② 保持 /dsh-fish 这个路径存在（老书签不至于 404）。
 */
const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>鱼 · 观测台搬进 App 了</title>',
  '<style>',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e1116;color:#d7dde5;',
  '  font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
  '.box{max-width:540px;padding:26px 30px;border:1px solid #262d36;border-radius:12px;background:#12161c}',
  'h1{font-size:16px;margin:0 0 12px;font-weight:600}',
  'p{margin:9px 0;color:#9aa4b2;font-size:13px;line-height:1.75}',
  'code{background:#1b212a;border:1px solid #262d36;border-radius:5px;padding:1px 6px;font-size:12px;color:#d7dde5}',
  '</style></head>',
  '<body><div class="box">',
  '  <h1>观测台搬进 App 里了</h1>',
  '  <p>这一页只能从 App 内部打开 —— 在浏览器里直接访问会被登录栅栏拦下。这是设计如此，不是坏了。</p>',
  '  <p>请到 <code>设置 → 鱼</code>：她的状态、她自己说过的话、日记、生长环境，都在那里。</p>',
  '  <p>她的数据仍然全部在 <code>~/.dsh-fish</code>，可以直接看文件。</p>',
  '</div></body></html>',
].join('\n')
