/**
 * look.js —— 她自己的眼睛：bili_look 工具
 *
 * 为什么给她一个"主动看"的工具，而不是只让她被动接受推送：
 *   **能不能自己决定看什么，是「自主」这个需要的唯一可验证载体。**
 *   如果她只能看定时器塞给她的东西，"可以说不"就永远只是一句话。
 *   这个工具让她能在醒着的时候自己说"我想看看别的"。
 *
 * 三条约束（与 growth_commit 同构）：
 *   1. **只读**。不带 cookie、不点赞、不评论。她看什么不会留下任何账号痕迹。
 *   2. **不回显状态**。返回值只有素材本身，没有"你今天还剩几次""你处于第几阶段"。
 *   3. **不给她配置**。她不知道有黑名单、不知道有配额；被过滤掉的东西她也不会知道。
 *      知道就变成了"哦原来他们不让我看这个"，那不是她要处理的事。
 */

import { createClient } from './bili.js'
import { absorb, renderMaterial, rankVideos, seenBvids, LOOK_BRIEF, WATCH_RULE } from './browse.js'
import { readEvents, rootDir, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
// 评论区里别人的话（2026-10-24，用户 m02454）
import { recordVoice } from './voices.js'
import { toJsonSchema } from './toolschema.js'

import { defineTool } from './tool.js'

/**
 * 调一次"看"：返回素材文本。永不抛出。
 * 单独抽出来是为了能在观测台/单测里直接调（不经模型）。
 *
 * @param {object} o
 * @param {'home'|'search'|'related'} o.what
 * @param {string} [o.keyword]
 * @param {string} [o.bvid]
 * @param {object} o.cfg 规范化配置
 * @param {object} [o.model] deriveSelf 结果（只用来选来源）
 * @param {string} [o.root]
 * @param {object} [o.client] 注入客户端（单测用假 client）
 * @returns {Promise<{ok:boolean, text:string, note:string, picks:object[]}>}
 */
export async function lookOnce(o = {}) {
  const root = o.root ?? rootDir()
  try {
    const client = o.client ?? createClient({})
    const cfg = o.cfg ?? (await loadConfig(root)).config
    const what = String(o.what ?? 'home')
    const limit = Math.max(1, Math.min(20, Number(cfg?.browse?.topN ?? 4)))
    // 2026-10-26 修（用户 m00751 现场证据）：原来是
    //   (await readEvents(root).then((r) => r.events)).catch(() => [])
    // 括号把 await 一起圈进去了，于是 `.catch` 作用在**已经 await 出来的数组**上，
    // 数组没有 catch → TypeError: (intermediate value).catch is not a function。
    // 她两次刷首页/搜索都只拿到这个报错，日记里还把它当成了"世界没让我看"。
    const events = o.events ?? (await readEvents(root).then((r) => r.events).catch(() => []))
    const seen = seenBvids(events)

    let list = []
    if (what === 'search') {
      const kw = String(o.keyword ?? '').trim().slice(0, 40)
      if (!kw) return { ok: false, text: '', note: '要搜什么？给个词。', picks: [] }
      const r = await client.search(kw, { pageSize: limit * 2 })
      if (!r.ok) return { ok: false, text: '', note: describeErr(r), picks: [] }
      list = r.data ?? []
    } else if (what === 'related') {
      const bvid = String(o.bvid ?? '').trim()
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) {
        return { ok: false, text: '', note: '要看哪条的相关推荐？给个 BV 号。', picks: [] }
      }
      const r = await client.related(bvid, limit * 2)
      if (!r.ok) return { ok: false, text: '', note: describeErr(r), picks: [] }
      list = r.data ?? []
    } else {
      const r1 = await client.popular(limit * 3)
      list = r1.ok ? (r1.data ?? []) : []
      if (list.length < 2) {
        const r2 = await client.ranking(0, 'all')
        if (r2.ok) list = [...list, ...(r2.data ?? [])]
      }
      if (!list.length) {
        const r3 = await client.precious(limit * 3)
        if (r3.ok) list = r3.data ?? []
      }
    }

    // 她自己搜的词不套黑名单吗？——套。黑名单是"她不想看的东西"，
    // 是环境的一部分，不是审查；她搜"恐怖"也可能是因为想验证它到底是什么。
    // 取舍：P2 仍然过滤（用户明确要求四条黑名单是硬的），但**把过滤记账**，
    // 将来要改成"允许她搜但拦住推送"只需改这一处。
    const picked = rankVideos(list, cfg, { seen, limit })
    if (!picked.length) {
      return { ok: false, text: '', note: '这次什么都没找到。也许是被过滤了，也许是平台没给。', picks: [] }
    }

    const packs = []
    for (const v of picked) {
      try {
        const p = await absorb(client, v, cfg)
        if (!p.blocked) packs.push(p)
      } catch { /* 单条失败忽略 */ }
    }
    if (!packs.length) return { ok: false, text: '', note: '打开了几条，但都打不开。', picks: [] }

    for (const p of packs) {
      await appendEvent(
        { type: 'meta', text: `looked:${p.video.bvid}` },
        { day: Number(o.model?.day ?? 0), stage: Number(o.model?.stage ?? 1), source: 'system' },
        root,
      ).catch(() => {})
    }

    // 评论区里别人的话（2026-10-24，用户 m02454）：她自己去看的时候也可能读到一句。
    const voice = await recordVoice({ packs, events, model: o.model, root, cfg })

    return {
      ok: true,
      text: renderMaterial(packs),
      note: '',
      voice: voice ? { text: voice.text, why: voice.why, across: voice.across ?? 1 } : null,
      picks: packs.map((p) => ({
        bvid: p.video.bvid,
        title: p.video.title,
        up: p.video.up,
        duration: p.video.duration,
        view: p.video.view,
      })),
    }
  } catch (err) {
    return { ok: false, text: '', note: String(err?.message ?? err).slice(0, 120), picks: [] }
  }
}

function describeErr(r) {
  const code = r?.code ?? '?'
  if (code === 'COOLDOWN') return 'B 站这会儿不让我看了，过一会儿再说。'
  if (code === 'NO_WBI') return '连不上。等等再试。'
  if (code === 'NETWORK') return '网断了。'
  return `打不开（${code}）。`
}

/**
 * 注册工具。
 * @param {object} ctx
 * @param {{root?:string, client?:object}} deps
 */
export function registerLook(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_look',
      description:
        '去看一眼 B 站：首页在推什么、搜一个词、或者看某条视频之后平台又接着推什么。' +
        '只读，不会留下痕迹。给的是标题、简介、标签、热评、弹幕——没有视频画面。' +
        '不用它也可以。',
      // 注意：必须 toJsonSchema 包一层。简写 DSL 直接发出去会被 provider 拒：
      // "schema must be a JSON Schema of 'type: object', got 'type: null'"
      parameters: toJsonSchema({
        what: {
          type: 'string',
          required: true,
          enum: ['home', 'search', 'related'],
          description: 'home=首页推给你的；search=你自己搜（要带 keyword）；related=接着某条往下看（要带 bvid）。',
        },
        keyword: { type: 'string', required: false, description: 'what=search 时搜什么。' },
        bvid: { type: 'string', required: false, description: 'what=related 时从哪条接着看（形如 BV1xx411c7mD）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string', description: '看到的素材' },
            note: { type: 'string' },
          },
          required: ['ok', 'text', 'note'],
        },
        // ⚠️ render 必须返回 ContentBlock 数组，签名是 (args, value)。
        // 返回裸字符串会让她收到 "Error: content.some is not a function"。
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看到什么：${out.note}` }],
      },
      async execute(args) {
        const { config } = await loadConfig(root)
        if (!config?.browse?.enabled) {
          // 关掉时不能装作看了。但也不能说"管理员不让你看"——就说不通。
          return { ok: false, text: '', note: '现在打不开。' }
        }
        const r = await lookOnce({
          what: args?.what,
          keyword: args?.keyword,
          bvid: args?.bvid,
          cfg: config,
          root,
          client: deps.client,
        })
        return { ok: r.ok, text: r.text, note: r.note }
      },
    }),
  )
}

export { LOOK_BRIEF, WATCH_RULE }
