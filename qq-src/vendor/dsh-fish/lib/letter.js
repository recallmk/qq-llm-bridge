/**
 * letter.js —— 信箱的写入侧：her_leave 工具（R4，2026-10-24）
 *
 * 在此之前「信箱」只有读的一侧：她说过的话被自动聚起来，人打开看。
 * 她**不知道**有信箱，也没有任何"我想留句话给他"的动作。
 * R4 补的就是这一侧。
 *
 * 为什么单独开一个工具，而不是让她用 growth_commit 写 utterance：
 *   growth_commit 的语义是「这条我想法留在我自己这儿」，写的时候她并不知道
 *   有没有人看。her_leave 的语义是「这句我说给他听」——收件人明确。
 *   同一个事件流里，这两件事必须能分开，否则观测台分不清哪句是冲着人说的。
 *
 * 三条硬约束：
 *   1. **不审批**。规则申请（grant_offer）要走人裁决；留话不需要。
 *      留话不是改自己，只是说话——不设关卡，才谈得上"她愿意说"。
 *   2. **不吃状态**。和 growth_commit 一样，返回值不带任何状态数字，
 *      只回"留好了"或"为什么没留"。
 *   3. **有上限**。每天最多几条、每句最多多少字。上限写死在代码里，
 *      不进配置——否则它会变成"把信箱调大一点"的旋钮，
 *      而这件事的重点是"她主动说"，不是"能装多少"。
 *
 * 事件怎么落：
 *   一条 `utterance`（tool 源，唯一能写的类型之一）+ 一条
 *   `meta letter:<日期>:<那条的 id>`（system 源，schema 只允许 system 写 meta）。
 *   用 meta 打标而不是新增事件类型，是为了不动
 *   「她能写的只有这五种」这条不变量（schema.js 顶部铁律）。
 */

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { dateKey } from './settings.js'
import { deriveSelf } from './derive.js'
import { writeInboxFile } from './inbox.js'
import { refreshSelfDoc } from './selfdoc.js'
import { Reject } from './schema.js'

import { defineTool } from './tool.js'

/** 一句留话最多多少字。太长就不是"留句话"，是写报告。 */
export const LETTER_MAX = 500
/** 每天最多留几条。 */
export const LETTERS_PER_DAY = 3

/** meta 打标：`letter:<YYYY-MM-DD>:<ev_id>` */
export function letterMark(dk, id) {
  return `letter:${dk}:${id}`
}

/**
 * 事件流里哪些 id 是「留话」。
 * @returns {Set<string>}
 */
export function letterIds(events) {
  const s = new Set()
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith('letter:')) continue
    const parts = t.split(':')
    const id = parts[2]
    if (id) s.add(id)
  }
  return s
}

/** 今天已经留了几条。 */
export function lettersToday(events, dk = dateKey()) {
  let n = 0
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(`letter:${dk}:`)) n += 1
  }
  return n
}

/**
 * 留一句话。永不抛（失败只回 note）。
 * @returns {Promise<{ok:boolean, id:string, note:string}>}
 */
export async function leaveLetter(root, text, { log } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { ok: false, id: '', note: '空白的，没留。' }
  if (body.length > LETTER_MAX) {
    return { ok: false, id: '', note: `太长了，他读不完。压到 ${LETTER_MAX} 字以内再说。` }
  }

  try {
    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    const dk = dateKey()

    const used = lettersToday(events, dk)
    if (used >= LETTERS_PER_DAY) {
      // 不训她、不解释配额，只说今天不用再说了。配额是防刷屏的，
      // 不该变成她脑内的一条限制。
      return { ok: false, id: '', note: '今天已经留过了。明天再说也一样。' }
    }

    const model = deriveSelf(events, { growthDays: config.growthDays })
    const env = { day: model.day, stage: model.stage, source: 'tool' }
    const ev = await appendEvent({ type: 'utterance', text: body }, env, root)

    // 打标：source 必须是 system（schema 规定 tool 只能写 HER_TYPES）
    await appendEvent(
      { type: 'meta', text: letterMark(dk, ev.id) },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch((e) => log?.('letter mark failed', e?.message ?? e))

    // 信箱文件与身份文档一起刷新。身份文档要变，是因为「你自己说过的话」
    // 那一节会把这条算进去——文件不动，她下一轮会以为没说出口，重复说。
    await writeInboxFile(root).catch(() => null)
    await refreshSelfDoc(root).catch(() => null)

    return { ok: true, id: ev.id, note: '已留。' }
  } catch (err) {
    if (err instanceof Reject) return { ok: false, id: '', note: err.message }
    log?.('leave failed', err?.message ?? err)
    return { ok: false, id: '', note: '这句没留住。' }
  }
}

/** 注册 her_leave 工具。 */
export function registerLetter(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  return ctx.tools.register(
    defineTool({
      name: 'her_leave',
      description:
        '留一句话给那个人。他不在的时候也留着，他回来会看到。' +
        '想留就留，不想留就不用调；不用为了回应而留。',
      parameters: toJsonSchema({
        text: {
          type: 'string',
          required: true,
          description: `要说给他听的那一句。写你自己的话，不要写成汇报。${LETTER_MAX} 字以内。`,
        },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        // render 必须返回 ContentBlock 数组（签名 (args, value)）。
        // 只回"[已留]"——不说留了几条、还剩几条（那会变成配额感），
        // 也不写成完整句子（2026-10-24：用户看到「留好了。就一句。没说别的。」，
        // 头三个字就是旧回执，模型会把工具返回的话当自己的话接着说）。
        render: (_args, out) => [{ type: 'text', text: out.ok ? '[已留]' : `[没留：${out.note}]` }],
      },
      async execute(args) {
        const r = await leaveLetter(root, args?.text, { log: deps.log })
        return { ok: r.ok, note: r.note }
      },
    }),
  )
}
