/**
 * speak.js —— 她在 B 站开口：bili_speak 工具
 *
 * 与 look.js 的对偶关系：
 *   look  = 眼睛（只读，不留痕，随时可用）
 *   speak = 嘴（**写**，会留在账号上，默认关闭，有配额）
 *
 * 为什么这条要单独一个工具、而不是并进 look：
 *   「看」和「说」的风险差一个量级。混在一个工具里，她就分不清
 *   哪次调用是安全的、哪次会留痕。工具边界 = 代价边界。
 *
 * 她不知道的东西（和 look 一致）：不知道有配额、不知道配额还剩几次、
 * 不知道有黑名单、不知道这个功能可能被关着。
 * 被拒绝时只听到「现在不方便说」，听不到「你今天的 3 条用完了」——
 * 后者会让她学会攒着、算着，那就成了资源管理，不是说话。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, readOwner } from './store.js'
import { loadConfig } from './settings.js'
import { postComment, postReply } from './comment.js'
import { screenOutgoing } from './guard.js'
import { mentionPrefix } from './owner.js'

import { defineTool } from './tool.js'

/**
 * 说一次。永不抛出。
 * @returns {Promise<{ok:boolean, said:string, note:string}>}
 *   said 是**真正发出去的那句话**（成功时），她可以据此确认自己说了什么。
 */
export async function speakOnce(o = {}) {
  const root = o.root ?? rootDir()
  try {
    const kind = String(o.kind ?? 'comment')
    const text = String(o.text ?? '').trim()
    if (!text) return { ok: false, said: '', note: '没想好说什么，那就先不说。' }

    // 出门前过一道闸：她要说的话里若长得像凭据（cookie / token / sk- / 长随机串），
    // 一律不发。宁可少说一句，也不把家里钥匙贴到评论区。
    const screened = screenOutgoing(text)
    // 拦下的理由不细说：告诉她"你泄露了路径"等于教会她下次换个写法。
    if (!screened.ok) return { ok: false, said: '', note: screened.why === 'leak' ? '这句里有不该说出去的东西。' : '这句先不说了。' }

    // 给她的话加个称呼：只有评论加，回复别人时不加——那会把别人的楼变成你们的客厅。
    let out = text
    if (kind !== 'reply') {
      const ow = await readOwner(o.root ?? rootDir())
      const cfg = await loadConfig(o.root ?? rootDir())
      const prefix = mentionPrefix(ow, cfg.config)
      if (prefix) out = prefix + text
    }

    const r =
      kind === 'reply'
        ? await postReply({ root, bvid: o.bvid, parentRpid: o.parentRpid, text: out, client: o.client, dateKey: o.dateKey })
        : await postComment({ root, bvid: o.bvid, text: out, client: o.client, dateKey: o.dateKey })

    if (!r.ok) return { ok: false, said: '', note: softReason(r.why) }
    return { ok: true, said: out, note: '说出去了。' }
  } catch (err) {
    return { ok: false, said: '', note: '没说出来。' }
  }
}

/**
 * 把内部原因压成一句她能听见的话。
 * 关键：**不泄露配额与开关**。她听到的永远是状态，不是规则。
 */
function softReason(why) {
  const w = String(why ?? '')
  if (w.includes('没开') || w.includes('权限')) return '现在不方便说。'
  if (w.includes('今天说够') || w.includes('今天回够')) return '今天说得够多了。'
  if (w.includes('不是说话的时候')) return '现在不是说话的时候。'
  if (w.includes('没看')) return '这个你还没看过，先看清楚再说。'
  if (w.includes('登录') || w.includes('cookie')) return '说不出去，缺了点什么。'
  if (w.includes('拦')) return '说了但没送到，等一下再说。'
  return w.slice(0, 40) || '没说出来。'
}

export function registerSpeak(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_speak',
      description:
        '在 B 站说一句话。可以给你今天看过的某个视频留一条评论，或者回一句别人留在你评论下面的话。' +
        '这是会留下来的东西——别人看得见，你也删不掉别人已经看到的。' +
        '不想说就不说，没有人等着你回答。',
      parameters: toJsonSchema({
        kind: {
          type: 'string',
          required: true,
          enum: ['comment', 'reply'],
          description: 'comment=给视频留一条评论；reply=回别人留在你评论下面的话。',
        },
        bvid: { type: 'string', required: true, description: '在哪个视频（形如 BV1xx411c7mD）。' },
        text: { type: 'string', required: true, description: '要说的话。说人话，别超过一两百字。' },
        parentRpid: { type: 'string', required: false, description: 'kind=reply 时，你要回的是哪一条（那条回复的编号）。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            said: { type: 'string', description: '真正发出去的话' },
            note: { type: 'string' },
          },
          required: ['ok', 'said', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名 (args, value)。返回裸字符串她会收到
        // "content.some is not a function"，然后以为没发出去、反复重试同一句。
        render: (_args, out) =>
          [{ type: 'text', text: out.ok ? `说出去了：「${out.said}」` : `没说：${out.note}` }],
      },
      async execute(args) {
        const { config } = await loadConfig(root)
        if (config?.comment?.enabled !== true) return { ok: false, said: '', note: '现在不方便说。' }
        return speakOnce({
          kind: args?.kind,
          bvid: args?.bvid,
          text: args?.text,
          parentRpid: args?.parentRpid,
          root,
          client: deps.client,
        })
      },
    }),
  )
}
