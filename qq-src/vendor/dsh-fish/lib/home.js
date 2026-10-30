/**
 * home.js —— 她的屋子：自动建工作区 + 一个专属会话（P3 的核心改造）
 *
 * 为什么改成这样（2026-10-23 用户定案）：
 *   原方案是「观测台里加一个输入框」。用户否掉了，理由是——这是个要发布到 GitHub 的插件，
 *   别人装完不该看到一个黑窗口 + 一个 http://127.0.0.1:xxxx/?token=... 的地址，
 *   也不该被要求「自己建一个 profile」。
 *   正确的形态：插件加载时**自己**在侧栏建一个工作区和一个会话，她住在那里面，
 *   你跟她的所有对话就在那个会话里说。参考 @a9i5k4/dsh-auto-memory 的「记忆中枢」。
 *
 * 三个 API（全部来自宿主，已从 app.asar 核实签名）：
 *   ctx.workspaceRegistry.list() / .create(path, title) / .get(id)
 *     - create 语义：同一个规范路径重复调用返回**已存在**的那条，不新建、不改标题。
 *   ctx.sessionController.create({ workspaceId }) 或 ({ cwd })，二者只能给一个
 *     - 返回 { sessionId }；传 workspaceId 时才会把会话挂进工作区（侧栏才看得见）。
 *   ctx.sessionController.rename({ sessionId, title })
 *     - 需要宿主的 sessionTitle 服务；没有就跳过（不是致命错误）。
 *
 * 幂等（关键，否则每次重启都多一个会话）：
 *   把 {wsId, sessionId} 记在 `~/.dsh-fish/home.json`。
 *   下次加载先验：「这个 sessionId 还在这个工作区的 sessionIds 里吗」——
 *   用户可能把会话归档/删了，那就重建一个，而不是永远指向一个空壳。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { rootDir, paths, readJson, writeAtomic } from './store.js'
import { recentExchanges, renderCarry } from './talkmem.js'
import { freshWakeText } from './wakeconst.js'

const TITLE_WORKSPACE = '大肥鱼的家'
const TITLE_SESSION = '跟大肥鱼说话'

function homeFile(root) {
  return join(paths(root).root, 'home.json')
}

/** 她的屋子目录：工作区指向这里（不是 ~/.dsh-fish 根，那里面有 events.jsonl）。 */
export async function ensureHomeDir(root = rootDir()) {
  const dir = join(paths(root).root, 'home')
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function readRegistry(ctx) {
  try { return ctx.get?.('workspaceRegistry') ?? null } catch { return null }
}

function pathKey(p) {
  // Windows 大小写不敏感；其余平台保持原样。只用于比对，不用于文件访问。
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 找到或创建工作区。**先查后建**：宿主 create 本身是幂等的，但明查一遍能拿到
 * 已存在的 title / id，避免依赖实现细节。
 */
export async function ensureWorkspace(ctx, { root = rootDir(), title = TITLE_WORKSPACE } = {}) {
  const dir = await ensureHomeDir(root)
  const reg = readRegistry(ctx)
  if (!reg?.create) return { ok: false, why: '宿主没有 workspaceRegistry 服务', dir }

  let ws = null
  try {
    const list = typeof reg.list === 'function' ? reg.list() : []
    ws = list.find((w) => w && w.path && pathKey(w.path) === pathKey(dir)) ?? null
  } catch { /* list 不可用就直接 create */ }

  const existed = Boolean(ws)

  // 老档改名：早期版本把工作区叫「鱼」，现在统一叫「大肥鱼的家」。
  // 宿主真正的改名入口在**实体**上：registry.list()/get() 返回的 Workspace 有 setTitle(title)；
  // registry 自己**没有** update/rename（2026-10-25 从 app.asar 核实）。
  // 早先那版调 reg.update/reg.rename，两个都不存在、又被 catch 吞掉，所以标题一直是「鱼」。
  // 改不动的仍然保持原名——她那间屋子还能住，只是侧栏名不对。
  let renamed = false
  if (ws && title && String(ws.title ?? '') !== title) {
    try {
      if (typeof ws.setTitle === 'function') {
        await ws.setTitle(title)
        renamed = true
      } else if (typeof reg.rename === 'function') {
        await reg.rename(ws.id ?? ws.workspaceId, title)
        renamed = true
      }
    } catch { renamed = false }
  }

  if (!ws) {
    try {
      ws = await reg.create(dir, title)
    } catch (err) {
      return { ok: false, why: `建工作区失败：${String(err?.message ?? err).slice(0, 120)}`, dir }
    }
  }

  const wsId = String(ws?.id ?? ws?.workspaceId ?? '')
  if (!wsId) return { ok: false, why: '宿主返回的工作区没有 id', dir }
  return { ok: true, wsId, dir, created: !existed, renamed }
}

/**
 * 找到或创建那个对话会话。
 *
 * 判定「还活着」的口径：home.json 里记的 sessionId 仍在这个工作区的
 * sessionIds 里，且不在 archivedSessionIds 里。任一不满足就重建。
 */
export async function ensureTalkSession(ctx, { root = rootDir(), wsId, title = TITLE_SESSION, preset = '', log } = {}) {
  const sc = ctx.sessionController
  if (!sc?.create) return { ok: false, why: '宿主没有 sessionController 服务' }
  if (!wsId) return { ok: false, why: '没有工作区 id' }

  const reg = readRegistry(ctx)
  const saved = await readJson(homeFile(root), null)

  // ---- 先看上次那个会话还在不在 ----
  if (saved?.sessionId) {
    let alive = false
    try {
      const ws = reg?.get?.(wsId)
      const archived = Array.isArray(reg?.archivedSessionIds) ? reg.archivedSessionIds : []
      alive = Boolean(ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(saved.sessionId))
        && !archived.includes(saved.sessionId)
    } catch { alive = false }
    if (alive) {
      // 老档改名：早期版本叫「跟她说话」，现在统一叫「跟大肥鱼说话」。
      // 改名失败不影响使用（侧栏照旧显示旧标题），所以只试一次、不抛。
      if (title && saved.title !== title) {
        try {
          if (typeof sc.rename === 'function') await sc.rename({ sessionId: saved.sessionId, title })
          await writeAtomic(homeFile(root), JSON.stringify({ ...saved, title }, null, 2))
        } catch { /* 改不了就保持原名 */ }
      }
      return { ok: true, sessionId: saved.sessionId, reused: true }
    }
  }

  // ---- 建一个新的 ----
  // 指定受限 preset：`fish-home` 只挂她的工具 + 看图 + 身份文件，
  // 没有 shell、没有 write/edit、没有联网、没有技能。见 profile 的
  // cordis.patch.yml 里 preset-fish-home 那一行。
  // preset 不被接受（老宿主 / 没装）时回落默认组合，但**必须让调用方知道**，
  // 否则她会在「全套工具」下悄悄长大 —— 这是自检里「她的工具面」要报的。
  let created
  let presetUsed = ''
  const wantPreset = String(preset ?? '').trim()
  if (wantPreset) {
    try {
      created = await sc.create({ workspaceId: wsId, agentPreset: wantPreset })
      presetUsed = wantPreset
    } catch (err) {
      const why = String(err?.message ?? err).slice(0, 160)
      log?.(`受限 preset「${wantPreset}」没被接受（${why}），这次用默认组合建会话`)
      created = null
    }
  }
  try {
    if (!created) created = await sc.create({ workspaceId: wsId })
    const sessionId = String(created?.sessionId ?? created?.id ?? '')
    if (!sessionId) return { ok: false, why: '宿主建了会话但没给 id' }
    if (typeof sc.rename === 'function') {
      // 命名失败不影响功能：侧栏会显示默认标题，但会话本身是好的
      await sc.rename({ sessionId, title }).catch(() => {})
    }
    await writeAtomic(homeFile(root), JSON.stringify({ wsId, sessionId, title, preset: presetUsed, createdAt: new Date().toISOString() }, null, 2))
    return { ok: true, sessionId, reused: false, preset: presetUsed }
  } catch (err) {
    return { ok: false, why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
}

/**
 * 一次做完全部：屋子目录 → 工作区 → 会话。
 * 任何一步失败都返回 ok:false + 人话原因，**不抛**——启动链路上抛异常会带走插件树。
 */
/**
 * 叫醒一间空白屋子。
 *
 * 为什么需要：宿主的侧栏可见性规则是
 *   `if (session.blank && session.id !== current) return false`
 * ——空白会话只在它是「当前主视图会话」时才显示。插件用 API 建出来的会话
 * 不会被设成当前会话，于是它一直藏在列表外面：用户点完重置看到的是「没有新会话」，
 * 重启也一样。让它跑一轮（blank 在开跑/成功后清掉）才是唯一能落地显示的办法。
 *
 * 代价：每一条会话只叫一次。这件事记在 `home.json` 的 `wokeFor` 里，不靠猜
 * （issue #1 报的第二个问题）：插件建的会话永远不是 current，宿主也不把它放进
 * 可见列表，所以「查不到这一行 → 按空白处理」这条分支会在它身上一直命中，
 * 每次重启都再叫一次。靠 `list()` 的 blank 判不准，就自己记账。
 *
 * 只记**成功送达**的那一次：宿主的 prompt 是「这一轮被收下了」就 resolve，
 * 收下就一定会跑出内容；抛错（比如漏传 signal）则不写，下次启动还会再试。
 */
export async function wakeIfBlank(ctx, { sessionId, root = '', log, freshOnly = false } = {}) {
  if (!sessionId) return { woke: false, why: '没有会话 id' }
  const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (!sc) return { woke: false, why: '宿主没有 sessionController 服务' }

  // ---- 已经叫过这一条了？----
  // 有标记就直接收手：同一条会话第二次被叫醒，只会在她的对话里多出一句
  // 没头没尾的「（醒一醒）」，还会白烧一轮。
  // root 为空就不记账（测试与只读调用不为难）：那等于回到「每次都问宿主」的老行为。
  const saved = root ? await readJson(homeFile(root), null).catch(() => null) : null
  if (String(saved?.wokeFor ?? '') === String(sessionId)) {
    return { woke: false, why: '这一局已经叫过了' }
  }

  let blank = false
  try {
    const l = typeof sc.list === 'function' ? await sc.list({}) : null
    const items = l?.items ?? l?.value?.items ?? []
    const row = items.find((x) => String(x?.sessionId ?? x?.id ?? '') === String(sessionId))
    if (row === undefined) {
      // 查不到这一行：新建的会话按空白处理，复用的按有内容处理——
      // 宁可漏唤醒，也不要每次启动都让她说话。
      blank = freshOnly === true
    } else if (typeof row.blank === 'boolean') {
      blank = row.blank
    } else {
      // 宿主没给 blank 字段：只有刚建出来的一定是空的，复用的不碰
      blank = freshOnly === true
    }
  } catch (err) {
    log?.(`查会话状态失败（${String(err?.message ?? err).slice(0, 100)}），这次不唤醒`)
    return { woke: false, why: '查不到会话状态' }
  }
  if (!blank) return { woke: false, why: '' }
  if (typeof sc.prompt !== 'function') return { woke: false, why: '宿主没有 sessionController.prompt' }

  // 不能 await：这一轮要等模型跑完，屋子建好不该被它拖住。
  // 第二个参数 signal 是宿主必填的：`prompt(request, signal)` 第一句就 signal.throwIfAborted()，
  // 漏传会抛 `Cannot read properties of undefined (reading 'throwIfAborted')`，这一声叫不醒（issue #1）。
  // 给一个永不 abort 的 signal——唤醒要等她跑完，不能加超时。
  void sc
    .prompt({
      requestId: `wake-fresh-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: freshWakeText() }],
    }, new AbortController().signal)
    .then(() => markWoke(root, sessionId))
    .catch((err) => log?.(`新屋子唤醒失败：${String(err?.message ?? err).slice(0, 140)}`))
  log?.('新屋子还是空的，叫了她一声（要等她这一轮动起来，侧栏才会显示）')
  return { woke: true, why: '' }
}

/**
 * 记下「这一条会话已经叫过了」。
 *
 * 为什么不写文件就活在内存里：进程一重启就忘了，那正是要防的事。
 * 为什么不用 home.json 里的 sessionId 比对：新建会话和「重置后重建」都会换 id，
 * 拿 id 比是最直接的语义——同一个 sessionId 只叫一次。
 * 失败只影响「下次可能多叫一次」，不影响这一次，所以永不抛。
 */
async function markWoke(root, sessionId) {
  if (!root) return
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    await writeAtomic(homeFile(root), JSON.stringify({ ...saved, wokeFor: String(sessionId) }, null, 2))
  } catch { /* 记不下来就下次多叫一次，没有更坏的后果 */ }
}

export async function bootstrapHome(ctx, { root = rootDir(), log, preset = '' } = {}) {
  const ws = await ensureWorkspace(ctx, { root })
  if (!ws.ok) return { ok: false, why: ws.why, wsId: '', sessionId: '' }

  const ses = await ensureTalkSession(ctx, { root, wsId: ws.wsId, preset, log })
  if (!ses.ok) return { ok: false, why: ses.why, wsId: ws.wsId, sessionId: '' }

  // 唤醒**不放在这里**：talkSessionId 在屋子缺失时也会调 bootstrapHome，
  // 那样每次「第一次说话」都会多叫一次，她一轮被点两次火。只在明确的两个入口叫：
  // index.js 的启动、observe.js 的 POST /reset。
  log?.(`屋子就绪 · 工作区 ${ws.wsId} · 会话 ${ses.sessionId}${ses.reused ? '（复用）' : '（新建）'}${ses.preset ? ` · preset ${ses.preset}` : ''}`)
  return { ok: true, why: '', wsId: ws.wsId, sessionId: ses.sessionId, dir: ws.dir, reused: ses.reused, preset: ses.preset ?? '' }
}

/** 供观测台显示「她住在哪」 */
export async function homeStatus(root = rootDir()) {
  const saved = await readJson(homeFile(root), null)
  return {
    dir: join(paths(root).root, 'home'),
    wsId: saved?.wsId ?? '',
    sessionId: saved?.sessionId ?? '',
    createdAt: saved?.createdAt ?? null,
    turns: Number(saved?.turns ?? 0),
    rotatedAt: saved?.rotatedAt ?? null,
    preset: String(saved?.preset ?? ''),
  }
}

/**
 * 拿一个**挂在屋子里**的会话 id。拿不到就返回空串。
 *
 * 为什么不退而求其次用 `sc.create({ sessionId, cwd })` 现建一个：
 * 那种会话没有工作区归属，宿主侧栏会把它塞进「未分组」。2026-10-24 用户
 * 在 GUI 里看到一串 20 小时前的陌生对话，全是开发期用测试 home 跑出来的残留
 * ——她可以少醒一次，但不能在用户侧栏里堆别人的（她的）垃圾。
 *
 * 顺序：先按记下来的 wsId 复用；失效了就重建一次屋子再复用；还不行就交白卷，
 * 由调用方决定怎么说。**永不抛。**
 */
export async function talkSessionId(ctx, { root = rootDir(), log } = {}) {
  try {
    // 惰性 import，避免 home ↔ settings 的静态循环
    let preset = ''
    try {
      const { loadConfig } = await import('./settings.js')
      preset = String((await loadConfig(root))?.config?.tools?.preset ?? '')
    } catch { preset = '' }
    const { wsId } = await homeStatus(root)
    const first = await ensureTalkSession(ctx, { root, wsId, preset, log })
    if (first.ok) return first.sessionId

    const again = await bootstrapHome(ctx, { root, preset, log })
    if (again.ok) return again.sessionId
    log?.(`屋子没接上：${again.why}`)
    return ''
  } catch (err) {
    log?.(`屋子没接上：${String(err?.message ?? err).slice(0, 120)}`)
    return ''
  }
}

// ---------------------------------------------------------------------------
// 会话轮换（2026-10-23 加）
//
// 为什么必须换：一个侧栏会话聊到几百轮，上下文迟早撑爆——那时候不是"变慢"，
// 是每一轮都在为几十万字的历史付费，最后直接失败。换会话是唯一的解法。
//
// 换会话的两个代价，这个文件负责兜住：
//   1. 上一段的「我们说到哪」没了 → 用 talkmem 的原话搬运续上（不是摘要）。
//   2. 旧会话不能凭空消失 → 改名留档，它还在侧栏里，翻得回去。
// ---------------------------------------------------------------------------

/** 记一轮对话。任何失败都不影响对话本身，所以永不抛。 */
export async function bumpTurns(root = rootDir(), delta = 1) {
  try {
    const saved = (await readJson(homeFile(root), null)) ?? {}
    const turns = Math.max(0, Number(saved.turns ?? 0) + Number(delta || 0))
    await writeAtomic(homeFile(root), JSON.stringify({ ...saved, turns }, null, 2))
    return turns
  } catch {
    return 0
  }
}

/**
 * 换一个新会话：旧的改名留档，新的接管，原话搬过去。
 * @returns {Promise<{ok:boolean, sessionId:string, old?:string, why?:string}>}
 */
export async function rotateTalkSession(ctx, { root = rootDir(), wsId, title = TITLE_SESSION, stamp } = {}) {
  const sc = ctx.sessionController
  if (!sc?.create) return { ok: false, sessionId: '', why: '宿主没有会话服务' }

  const saved = (await readJson(homeFile(root), null)) ?? {}
  const wid = String(wsId ?? saved.wsId ?? '')
  if (!wid) return { ok: false, sessionId: '', why: '没有工作区 id' }

  const old = String(saved.sessionId ?? '')
  const when = stamp ?? new Date().toISOString().slice(0, 10)

  // 1) 旧会话改名留档。失败不影响后面（改不了名也还是那条会话）。
  if (old && typeof sc.rename === 'function') {
    await sc.rename({ sessionId: old, title: `${title}·${when} 之前` }).catch(() => {})
  }

  // 2) 建新的
  let sessionId = ''
  try {
    const created = await sc.create({ workspaceId: wid })
    sessionId = String(created?.sessionId ?? created?.id ?? '')
  } catch (err) {
    return { ok: false, sessionId: '', why: `建会话失败：${String(err?.message ?? err).slice(0, 160)}` }
  }
  if (!sessionId) return { ok: false, sessionId: '', why: '宿主建了会话但没给 id' }
  if (typeof sc.rename === 'function') await sc.rename({ sessionId, title }).catch(() => {})

  // 3) 原话搬运
  const carry = renderCarry(await recentExchanges(root))
  try {
    await writeAtomic(
      homeFile(root),
      JSON.stringify(
        {
          wsId: wid,
          sessionId,
          createdAt: new Date().toISOString(),
          turns: 0,
          rotatedFrom: old,
          rotatedAt: new Date().toISOString(),
          carry,
        },
        null,
        2,
      ),
    )
  } catch {
    /* 记不下来也只影响下次换会话时的续接，不影响这次对话 */
  }
  return { ok: true, sessionId, old }
}

/**
 * 换会话后还要贴多久的「上次说到这」。
 * 太短：她还没来得及接上就没了；太长：那段话变成新的固定人设。
 * 三天或 8 轮，谁先到算谁。
 */
export const CARRY_DAYS = 3
export const CARRY_TURNS = 8

export async function activeCarry(root = rootDir(), now = Date.now()) {
  const saved = (await readJson(homeFile(root), null)) ?? {}
  const text = String(saved.carry ?? '').trim()
  if (!text) return ''
  const at = Date.parse(saved.rotatedAt ?? '')
  if (!Number.isFinite(at)) return ''
  if (Number(saved.turns ?? 0) >= CARRY_TURNS) return ''
  if (now - at > CARRY_DAYS * 86_400_000) return ''
  return text
}
