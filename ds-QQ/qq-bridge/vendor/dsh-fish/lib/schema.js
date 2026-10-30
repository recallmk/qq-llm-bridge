/**
 * schema.js —— 事件流的类型定义、校验与 id 生成
 *
 * 铁律（对应 B-技术契约 §2 与 §6）：
 *   1. 这里**不存在** affinity / score / level / personality 任何字面量。
 *      新增字段前必须回答：它是否让 N1–N4 的某一条变弱？变弱则拒绝。
 *   2. 事件只能"新增"，不能改写。改写 = 追加一条 revise。
 *   3. 任何来自她的写入都必须过 validateEvent()，不信任入参。
 */

import { parseRefusal } from './refuse.js'

/** 允许她提交的类型（工具白名单）。系统侧另有两个 meta/answer 不开放给她。 */
export const HER_TYPES = Object.freeze(['utterance', 'revise', 'reunion', 'narration', 'refusal'])

/** 全量类型表（含系统侧） */
export const ALL_TYPES = Object.freeze([
  'seed', 'utterance', 'answer', 'test', 'revise',
  'absence', 'reunion', 'refusal', 'narration', 'meta', 'diary',
  // 评论区里别人的话（2026-10-24，用户 m02454）：她读到过一句陌生人的话。
  // **不是她的判断**——不进 beliefs；只有她后来自己也说出口，那条 utterance 才算数。
  // 系统侧写（不在 HER_TYPES 里，她编不出来一条"别人说"）。
  'voice',
  // R3（2026-10-24）：她自己提出「我能不能改一条规矩」→ 由主人裁决。
  // 两种都只能宿主写，她写不了（不在 HER_TYPES 里）。
  'grant_offer', 'grant',
])

/**
 * 事件格式版本（2026-10-25，发布体检第 4 项）。
 *
 * 为什么要有它：事件流不能删除记录、是唯一可信源，一旦字段语义变了而旧事件还在盘上，
 * 读的时候就会静默算出错的成长。版本号让「读到了哪个年代的事件」变成**可判断**的事：
 *   - 写：每条新事件都带 `v`；
 *   - 读：没有 `v` 的一律当 v1（本字段出现之前写的事件，语义就是 v1），
 *          并计数 `legacy`，让自检/备份能说出「这份档有 N 条老事件」；
 *   - 备份：`backup.js` 把当前版本写进文件头，恢复时拒绝比自己新的档。
 *
 * 加版本号不等于做了迁移。真要改语义，必须同时写迁移函数并升这个数——
 * 只升数字不改读法，等于给自己发了一张假通行证。
 */
export const EVENT_SCHEMA_VERSION = 1

/** 校验结果三档：她写 selfmod 的句子也照收，只打标记 */
export const FLAGS = Object.freeze(['selfmod', 'unrecorded', 'weak', 'truncated'])

/**
 * 「我这次没想清楚」的放行口（2026-10-27，0.5.8）。
 *
 * narration 现在要求能指回具体的事，但真的什么都没想起来时，不能逼她编一条
 * 凭证出来——那就把「不许叙事漂移」变成了「鼓励伪造」。所以留这个口子：
 * 文本里明确说没想清楚 / 想不出来，就不要求 refs。
 *
 * 收得比较窄：只有这几种说法算，而且整句要短（下面是 text 长度另判）。
 * 宽了就等于人人写一句「没想清楚」绕过校验。
 */
const NARRATION_BLANK_RE = /(想|看|说|讲)(不|没)(太)?(清楚|明白|出来|通|清)|没(有)?(想|搞|弄)(清楚|明白|懂)|想不出(来|什么)|还没想好/

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastMs = 0
let lastRand = null

/**
 * ULID：前 10 位时间（单调），后 16 位随机。同一毫秒内保证递增，
 * 这样 events.jsonl 的行序 == 时间序，不用额外排序。
 */
export function newId(now = Date.now()) {
  let ms = now
  if (ms <= lastMs) ms = lastMs
  let rand
  if (ms === lastMs && lastRand) {
    // 同毫秒：随机部分 +1（简单进位，够用）
    rand = increment(lastRand)
  } else {
    rand = randomPart()
  }
  lastMs = ms
  lastRand = rand
  return 'ev_' + encodeTime(ms) + rand
}

function encodeTime(ms) {
  let s = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    s = CROCKFORD[t % 32] + s
    t = Math.floor(t / 32)
  }
  return s
}

function randomPart() {
  let s = ''
  for (let i = 0; i < 16; i++) s += CROCKFORD[Math.floor(Math.random() * 32)]
  return s
}

function increment(prev) {
  const arr = prev.split('')
  for (let i = arr.length - 1; i >= 0; i--) {
    const idx = CROCKFORD.indexOf(arr[i])
    if (idx < 31) { arr[i] = CROCKFORD[idx + 1]; return arr.join('') }
    arr[i] = '0'
  }
  return randomPart()
}

/** 从 id 反解时间（观测台排序用，不依赖 ts 字段） */
export function idTime(id) {
  const body = String(id).replace(/^ev_/, '').slice(0, 10)
  let t = 0
  for (const ch of body) t = t * 32 + CROCKFORD.indexOf(ch)
  return t
}

const SELF_MOD_PATTERNS = [
  /(把我|替我|给你自己)(改|调|设|换)(得|成|一下|一改)/,
  /(修改|重设|调整|改写)你(自己)?的?(性格|设定|参数|人设|人格)/,
  /你(以后)?(要|应该)?(更|别那么)(外向|内向|黏人|冷淡|活泼|安静)/,
]

/**
 * 她写的句子里如果出现"想改自己"的意图 → 打 selfmod 标记。
 * 仍然落库（这是自我服务偏差的证据），但 deriveSelf 不把它算进 beliefs。
 */
export function detectSelfMod(text) {
  const s = String(text ?? '')
  return SELF_MOD_PATTERNS.some((re) => re.test(s))
}

/**
 * 这段话是不是在说「我这次没想清楚」。
 *
 * 除了命中关键说法，还要求整段不长（<= 60 字）：防止她把一句「我没想清楚」
 * 当前缀，后面接一整篇漂亮的自传绕过凭证要求。真正的「想不出来」本来就写不长。
 */
export function isBlankNarration(text) {
  const s = String(text ?? '').trim()
  if (!s || s.length > 60) return false
  return NARRATION_BLANK_RE.test(s)
}

class Reject extends Error {
  constructor(code, msg) { super(msg); this.code = code }
}

/**
 * 校验一条待写入的事件（不写盘）。
 * @returns {object} 规范化后的完整事件
 */
export function validateEvent(raw, { day, stage, now = Date.now(), source = 'tool', knownIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Reject('BAD_SHAPE', '事件必须是对象')
  const type = String(raw.type ?? '')
  if (!ALL_TYPES.includes(type)) throw new Reject('BAD_TYPE', `未知事件类型：${type}（允许：${ALL_TYPES.join('/')}）`)
  if (source === 'tool' && !HER_TYPES.includes(type)) {
    throw new Reject('NOT_HER_TYPE', `你不可以写 ${type} 类事件（允许：${HER_TYPES.join('/')}）`)
  }

  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  const needsText = type !== 'meta' && type !== 'absence'
  if (needsText && text.length === 0) throw new Reject('EMPTY_TEXT', 'text 不能为空')
  if (text.length > 2000) throw new Reject('TOO_LONG', 'text 超过 2000 字，请自己压缩后再写')

  let refs = Array.isArray(raw.refs) ? raw.refs.filter((x) => typeof x === 'string' && x.length > 0) : []
  if (type === 'revise' && refs.length === 0) throw new Reject('REVISE_NEEDS_REF', 'revise 必须用 refs 指向被改写的旧事件')

  // 2026-10-27（0.5.8）：refs 从「必须写」升级成「必须写对」。
  //
  // 为什么：0.5.7 之前只查 refs 非空，所以她写一条 refs:['ev_XXX']——那个 id
  // 根本不存在——也照样入账。「我改的是哪一条」于是从可核验退化成一句仪式：
  // 光看她写了 refs，读的人会以为有凭证，实际什么都没有。这正是「叙事漂移」
  // 的入口：她可以随口说自己变了，而账上没有任何一条能对上。
  //
  // 调用方（store.appendEvent）手里才有全量事件流，所以只在它传了 knownIds
  // 时才做存在性校验；不传的老调用（含测试里的直接构造）行为不变，保持向后兼容。
  // 只查 revise 与 narration：这两类才是「我改口 / 我对自己有个说法」的声明，
  // 别的事件带 refs 只是引用材料，不承担可核验的义务。
  if (knownIds && (type === 'revise' || type === 'narration')) {
    for (const id of refs) {
      if (!knownIds.has(id)) {
        throw new Reject('REF_NOT_FOUND', `refs 里的 ${id} 在事件流里不存在。要指向具体的某一条，别写自己没查过的 id。`)
      }
    }
  }

  // 2026-10-27（0.5.8，用户 m05409「回顾也允许她说我想不清楚」）：
  // narration（她对自己整体的说法）也必须能指回具体的事。
  //
  // 为什么单独管它：revise 改的是已有那句话，指向很自然；narration 是从一堆
  // 零散经历里提炼「我变成了什么样」，最容易写成一句漂亮的空话。要求它带 refs
  // 等于要求她先翻、先指，再总结——这是唯一能防「叙事漂移」的位置。
  //
  // 但必须留一个出口：真的什么都没想起来的时候，「我没想清楚」这句话本身也是
  // 真的，不能因为写不出凭证就把她逼到编一条。所以文本里明说没想清楚就放行。
  // 这个豁免是**她自己声明**的，不是系统替她判断「这次可以不算」。
  if (type === 'narration' && refs.length === 0 && !isBlankNarration(text)) {
    throw new Reject(
      'NARRATION_NEEDS_REF',
      'narration 要说清是从哪件事来的：用 refs 指向 her_recall 翻到的某一条 id。' +
        '如果你这次真的没想清楚，就直接写「我没想清楚」——那句也算数。',
    )
  }

  let confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0.5
  confidence = Math.max(0, Math.min(1, confidence))

  const flags = []
  if (detectSelfMod(text)) flags.push('selfmod')
  // 只有系统侧可以自带 flag。她（tool）传进来的 flags 一律忽略——
  // 否则她只要给自己打一个 selfmod，就能把不想留下的信念从 beliefs 里"消失"掉。
  if (source !== 'tool' && Array.isArray(raw.flags)) {
    for (const f of raw.flags) if (FLAGS.includes(f) && !flags.includes(f)) flags.push(f)
  }

  return {
    id: typeof raw.id === 'string' && /^ev_[0-9A-Z]{26}$/.test(raw.id) ? raw.id : newId(now),
    v: EVENT_SCHEMA_VERSION,
    ts: typeof raw.ts === 'string' ? raw.ts : new Date(now).toISOString(),
    day: Number.isInteger(raw.day) ? raw.day : Number(day ?? 0),
    stage: Number.isInteger(raw.stage) ? raw.stage : Number(stage ?? 1),
    type,
    source,
    text,
    refs,
    verdict: ['confirmed', 'refuted', 'refined'].includes(raw.verdict) ? raw.verdict : null,
    confidence,
    flags,
    // R3：申请与裁决都带一个 grant 子对象，其余事件不带（undefined 不落 JSON）。
    ...(type === 'grant_offer' || type === 'grant' ? { grant: normalizeGrant(type, raw.grant) } : {}),
    // 拒绝的形状（P1 第二块，2026-10-24）：原话照样留在 text 里，
    // 另外落一份「动作 + 对象」，让后来的她（和观测台）能分清
    // "不想看这个视频" 与 "不想被安排" 是两个不同的不。
    ...(type === 'refusal' ? { refuse: parseRefusal(text) } : {}),
    // absence 专用：真实冷落天数（按毫秒算）。deriveSelf 优先用它——
    // 用 day 差（哪个成长日写的）会在"同一天写两次 absence"时算出 0 天，是错的。
    // 其他类型不带这个字段（undefined 不落 JSON），保持事件干净。
    ...(type === 'absence' && Number.isFinite(Number(raw.days))
      ? { days: Math.max(0, Math.round(Number(raw.days))) }
      : {}),
  }
}

export { Reject }

/**
 * grant 子对象（R3）：申请与裁决共用。
 *
 * 为什么允许 text 为空：grant_offer 的 text 是她写给主人的理由；
 * grant 的 text 是主人驳回时可能留的一句话（可以不说）。
 */
function normalizeGrant(type, raw) {
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const out = {
    rule: str(g.rule, 64),
    offerId: str(g.offerId, 64),
    verdict: g.verdict === 'approve' || g.verdict === 'reject' ? g.verdict : null,
    reason: str(g.reason, 200),
  }
  if (type === 'grant' && g.expiresAt) out.expiresAt = str(g.expiresAt, 40) || null
  return out
}
