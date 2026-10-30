/**
 * restrict.js —— 只让她看见自己的工具（2026-10-24）
 *
 * ## 为什么要有这个
 *
 * 她的上下文里原本有 **37 个工具**，其中只有 6 个是本插件给的，另外 31 个是宿主
 * 标准工具集（shell、读写文件、联网搜索、定时任务、子代理、工作流……）。
 * 工具定义是每轮都要塞进上下文的东西，31 个用不上的定义意味着：
 *   ① 每轮白烧一大截 token；
 *   ② 她看得见"能跑命令""能写文件"，就真的可能去调 —— 这是"莫名调工具"的来源。
 *
 * ## 为什么走 tools.restrict，而不是 agentPreset
 *
 * `agentPreset` 那条路走过三次都失败（详见 docs/B-技术契约.md §24）：会话首行
 * 能写上 `agentPreset: fish-home`，但首轮 31 秒后宿主自己 append
 * `agent-preset/selected {agentPreset:'standard'}` 把它改回默认；把 preset 的
 * `plugins` 清空也仍然是 37 个工具。那条路是"全局组合"，不是"这个 agent 的视图"。
 *
 * `ctx.tools.restrict()` 才是对的那把刀。宿主自己的开发文档原话：
 *   「Hiding tools from one agent is `ctx.tools.restrict()` on that agent's
 *     context; it keeps schema presentation, lookup, and execution aligned.」
 *
 * 三个关键性质（都来自宿主源码，不是我猜的）：
 *   1. **必须有作用域**：`restrict()` 在无作用域的 ctx 上直接抛
 *      「requires a scoped context (agent.ctx): a context-global restriction
 *        would mask every agent」。→ 天然只影响那一个 agent，不碰用户自己的窗口。
 *   2. **只能减不能加**：`allow`/`deny` 编成 Set 后 append 到该 agent 的层上。
 *      所以"先给 6 个、真要再申请"做不到 —— 被挡掉的工具连名字都看不见。
 *      这正是我们想要的：她不需要"申请"，她本来就用不到那些。
 *   3. **名字必须存在**：`restrict()` 会拿 `restrictableNames` 校验，名字不认识
 *      就抛错（报错里还会列出全部已知工具名）。所以清单写死在这里，改错立刻炸，
 *      不会静默失效。
 *
 * ## 为什么留 read_image
 *
 * `bili_watch` 和 `/say` 的图片都只是**落一个文件路径**，真正"看见"要靠
 * `read_image` 读它。把它挡掉，她就又变回瞎子 —— 这是 P8 刚做出来的能力，
 * 不能因为收窄工具面把它一起收掉。
 *
 * 同理 **不给 `skill`**：一旦有它，`~/.dsh/skills` 里任何未审过的第三方内容
 * 都能进她上下文。将来要她用什么，就包一个形状固定的专用工具（像 bili_watch），
 * 不开通用口。
 */

import { resolve } from 'node:path'

/** 插件自己注册的六个工具。顺序无意义，但**必须全部真实存在**（名字错会抛错）。 */
export const FISH_TOOLS = Object.freeze([
  'growth_commit', // 记下自己的想法（唯一的写入口）
  'her_recall', // 翻自己的旧事
  'her_leave', // 留一句话给他
  'bili_look', // 看 B 站的列表
  'bili_watch', // 看一条视频的画面
  'bili_speak', // 在评论区说话
])

/**
 * 她允许看见的工具。
 * 最后一个是宿主给的 `read_image`——它由宿主某个插件提供，别人的机器上不一定装；
 * 缺了不影响她说话写字，只是看不了图，所以自检里只当提示、不当失败。
 */
export const HER_TOOLS = Object.freeze([...FISH_TOOLS, 'read_image'])

/** 归一化目录，用于判断"这条会话是不是她的屋子"。Windows 大小写不敏感。 */
function normDir(p) {
  if (!p) return ''
  let s = String(p).replace(/[\\/]+$/, '')
  try {
    s = resolve(s)
  } catch {
    /* 保持原样 */
  }
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * 判断这个 agent 是不是"她"。
 *
 * 判据用 **cwd** 而不是 sessionId：会话会轮换（`chat.rotateAfter`），
 * 轮换后 sessionId 变了，但 cwd 永远是她的屋子。用 sessionId 判断的话，
 * 轮换一次限制就悄悄失效了 —— 那是最难发现的那种 bug。
 */
export function isHerAgent(agent, herDir) {
  const want = normDir(herDir)
  if (!want) return false
  const got =
    agent?.session?.header?.cwd ??
    agent?.header?.cwd ??
    agent?.session?.cwd ??
    ''
  return normDir(got) === want
}

/**
 * 注册限制。**必须在任何 agent 被创建之前调用**（`agent/created` 是同步串行监听，
 * 在会话开始跑第一步之前完成），所以 index.js 里放在 ensureHer 之后、
 * bootstrapHome 之前。
 *
 * @param {object} ctx    插件 context
 * @param {object} opts
 * @param {string} opts.herDir    她的屋子（会话 cwd）
 * @param {string[]} [opts.extra] 用户在设置页额外放行的工具名
 * @param {boolean} [opts.enabled=true]
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 * @param {(info: object) => void} [opts.onResult] 记录"这次真的挂上没有"（给自检用）
 */
export function registerToolRestrict(ctx, { herDir, extra = [], enabled = true, log, onResult, retryMs = 200, retryMax = 15 } = {}) {
  // 无论调用方传不传 onResult，模块级单例都要更新——自检读的是它。
  const __raw = onResult
  onResult = (r) => { report(r); try { __raw?.(r) } catch { /* ignore */ } }
  const say = log ?? (() => {})
  if (!enabled) {
    say('[dsh-fish] 工具面收窄：关闭（配置里关掉了）')
    onResult?.({ ok: false, applied: 0, why: 'disabled', allow: [] })
    return () => {}
  }

  const allow = [...new Set([...HER_TOOLS, ...extra.map((s) => String(s).trim()).filter(Boolean)])]
  let applied = 0
  let failed = ''

  const onCreated = ({ agent } = {}) => {
    // 顺手记一份「她这个 agent 认得哪些工具名」（2026-10-24）：
    // 白名单输入框靠它判断名字真假。必须在 restrict 之前取——取的是还没被收窄的视角。
    //
    // 关键：必须把 agent 传进 view(agent)。宿主源码注释写得很清楚：
    //   view(scope) —— "the viewing scope (the agent), or undefined for the global view"
    //   "Once presets moved them onto the agent plane they became an ANCESTOR contribution"
    // 也就是说 read / write / bash / skill 这些是由 preset 挂在**agent 的祖先层**上的，
    // 不在 global 层。不传 agent 拿到的是 global view，只有插件自己注册的那几个
    // （实测 7 个，没有 skill）——用它做校验会把 skill 误判成「不存在」。
    try {
      let set = null
      try { set = agent?.ctx?.tools?.view?.(agent)?.restrictableNames } catch { set = null }
      if (!set || typeof set[Symbol.iterator] !== 'function' || set.size === 0) {
        // 兜底：拿不到就退回 global view（至少还有插件自己那几个）
        try { set = agent?.ctx?.tools?.view?.()?.restrictableNames } catch { set = null }
      }
      if (set && typeof set[Symbol.iterator] === 'function') {
        const names = [...set].map((x) => String(x)).sort()
        // 快照只能变多不能变少：0.6.0 真机上宿主还没登记完时只有 1 个名字，
        // 用它覆盖会把白名单校验搞成「大部分真工具都被判未知」。
        if (names.length && (!lastKnownTools || names.length > lastKnownTools.length)) {
          lastKnownTools = names
        }
      }
    } catch { /* 拿不到就算了，界面会退回只查拼写 */ }
    try {
      if (!isHerAgent(agent, herDir)) return
      const scopedTools = agent?.ctx?.tools
      if (!scopedTools?.restrict) {
        failed = '宿主的 agent.ctx 上没有 tools.restrict（版本不支持）'
        say(`[dsh-fish] 工具面收窄失败：${failed}`)
        onResult?.({ ok: false, applied, failed, why: 'failed', allow })
        return
      }
      // ---- 兜底的一道 guard ----
      //
      // restrict 挡不住「注册在 agent 自己作用域里的工具」。宿主源码原话：
      //   if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
      //     knownNames.add(name); visible.set(name, definition)   // ← 不过 admits
      //   }
      // 也就是说 inherited（全局/祖先）里的工具会被掩码，而 own 层的不受 allow/deny 约束。
      // 实测漏出来的就是 `subagent` —— 她能借它派生一个拥有全部工具的子 agent，
      // 等于一条现成的逃生通道（2026-10-24 真机，37→8 之后只剩它）。
      //
      // guard 是同步的、只 deny 不放行，且注册在 agent.ctx 上就只作用于这个 agent。
      // 两者分工：restrict 管「看不见」，guard 管「看见了也跑不了」。
      //
      // 2026-10-25：顺序改成**先挂 guard、再下 restrict**。真机日志里出现过一次
      // restrict 因「名字还没登记」抛错，整段进 catch，连兜底守卫都没挂上——
      // 那一条会话等于全开。guard 不依赖名字表，先挂它，restrict 再想办法。
      const allowSet = new Set(allow)
      let blocked = 0
      // guard 是**兜底**，不是主刀。宿主老版本可能没有它（这时 restrict 仍然生效，
      // 只是漏在 own 层的那一个挡不住）。所以缺席只记一笔，不能因此判定"没挂上"。
      let guardOk = typeof scopedTools.guard === 'function'
      if (guardOk) {
        try {
          const disposeGuard = scopedTools.guard((exec) => {
            const name = exec?.name
            if (!name || allowSet.has(name)) return undefined
            if (blocked < 20) {
              blocked += 1
              say(`[dsh-fish] 挡住了一次不该有的调用：${name}`)
            }
            // 话术刻意不带「权限/禁止/违规」这类系统词——她要以为是自己做不了，
            // 不是以为背后有个管理员在拦她。
            return '这件事我做不到。'
          })
          try {
            agent.ctx.effect?.(() => disposeGuard)
          } catch {
            /* 同上 */
          }
        } catch (err) {
          guardOk = false
          say(`[dsh-fish] 兜底守卫没挂上（restrict 仍然生效）：${String(err?.message ?? err).slice(0, 160)}`)
        }
      } else {
        say('[dsh-fish] 这个宿主版本没有 tools.guard，只能靠 restrict')
      }

      // ---- 主刀：restrict ----
      // 只写 allow：不在清单里的一切都被挡掉。
      // 不用 deny 白名单是因为"宿主将来新增一个工具"时，allow 自动把它挡在外面，
      // 而 deny 会默认放行 —— 前者是我们想要的方向。
      const applyRestrict = (names) => {
        const dispose = scopedTools.restrict({ allow: names })
        // 文档要求：把这把刀挂到 agent 自己的生命周期上，agent 销毁时自动收回。
        try { agent.ctx.effect?.(() => dispose) } catch { /* 拿不到 effect 就靠父级回滚，不致命 */ }
      }
      try {
        applyRestrict(allow)
        applied += 1
        say(`[dsh-fish] 工具面收窄：她这条会话只留 ${allow.length} 个工具${guardOk ? '，另有兜底守卫' : ''}`)
        // 真的挂上了才算数——"注册了"和"生效了"必须分开报，否则自检会说谎。
        onResult?.({ ok: true, applied, failed, why: 'applied', allow, guard: guardOk })
        return
      } catch (err) {
        // 2026-10-25 真机：宿主先建了她的 agent，插件自己的工具还没在全局层登记完，
        // restrict 抛 `names unknown global tool "growth_commit"; known global tools: …`。
        //
        // 2026-10-27 另一台真机（0.6.0）：旧实现把「从报错里捡回的名单」取交集再收窄，
        // 交集只有 1 个 —— 那条会话从此只看得见 1 个工具。她调 bili_look 直接
        // `Error: unknown tool "bili_look"`，于是回答「我没法浏览 B 站」，用户去装
        // 别的插件了。restrict 只能减不能加，收窄错了没有回头路。
        //
        // 所以这里改成：**名字没登记齐就这一次不收窄**（兜底 guard 照旧在拦），
        // 隔 200ms 再看一眼，齐了就收；等不到就留到下一次会话。宁可多看见几轮，
        // 也不能让她永久少一只手。
        const msg = String(err?.message ?? err)
        adoptKnownFromError(msg) // 顺手捡回全量名单，重试判断也用得上
        say(`[dsh-fish] 工具面收窄延后：宿主还没登记完（${msg.slice(0, 120)}）`)
        let tries = 0
        const attempt = () => {
          let set = null
          try { set = agent?.ctx?.tools?.view?.(agent)?.restrictableNames ?? null } catch { set = null }
          const have = set instanceof Set ? set : new Set([...(set ?? [])])
          if (allow.every((n) => have.has(n))) {
            try {
              applyRestrict(allow)
              applied += 1
              say(`[dsh-fish] 工具面收窄：她这条会话只留 ${allow.length} 个工具${guardOk ? '，另有兜底守卫' : ''}`)
              onResult?.({ ok: true, applied, failed, why: 'applied-late', allow, guard: guardOk })
              return
            } catch (err2) {
              say(`[dsh-fish] 收窄重试没成：${String(err2?.message ?? err2).slice(0, 160)}`)
            }
          }
          tries += 1
          if (tries < retryMax) {
            const t = setTimeout(attempt, retryMs)
            try { agent?.ctx?.effect?.(() => clearTimeout(t)) } catch { /* ignore */ }
          } else {
            say('[dsh-fish] 宿主一直没登记完工具，这次不收窄（只有兜底守卫在拦），下次会话再试')
            onResult?.({ ok: true, applied: 0, failed, why: 'deferred', allow, guard: guardOk })
          }
        }
        const timer = setTimeout(attempt, retryMs)
        try { agent?.ctx?.effect?.(() => clearTimeout(timer)) } catch { /* ignore */ }
        return
      }
    } catch (err) {
      failed = String(err?.message ?? err).slice(0, 300)
      // 宿主的报错里带着「known global tools: a, b, c」全量名单（0.2.1-rc.3 实测）。
      // 白名单输入框正缺这份名单，顺手捡回来——下次校验就不用再猜名字了。
      if (adoptKnownFromError(failed)) say('[dsh-fish] 从报错里捡回了工具名单，白名单校验以后能查真名了')
      say(`[dsh-fish] 工具面收窄失败：${failed}`)
      onResult?.({ ok: false, applied, failed, why: 'failed', allow })
    }
  }

  const off = ctx.on?.('agent/created', onCreated)

  // 立刻把结论报一次（给自检和设置页读）。
  // 注意：onCreated 是之后才跑的，所以这里报的是"已注册"，不是"已生效"。
  onResult?.({ ok: true, applied: 0, why: 'registered', allow })

  return () => {
    try { off?.() } catch { /* ignore */ }
  }
}

/** 给自检/观测台用的一句话结论。 */
export function describeRestrict({ applied = 0, failed = '', allow, why = '' } = {}) {
  if (failed) return `没挂上：${failed}`
  if (why === 'deferred') return '暂未收窄（宿主还没登记完工具，兜底守卫在拦）'
  if (applied > 0) return `已收窄（${allow?.length ?? HER_TOOLS.length} 个工具）`
  return '已注册，等她的会话下一次启动'
}

/**
 * 全局可见的工具名（不含定义），给白名单校验用。
 *
 * 为什么用 `ctx.tools.view()` 不带参数：宿主注释原文「the viewing scope (the agent),
 * or undefined for the global view」——不带 = 全局视角，`restrictableNames` 就是
 * `restrict()` 认的那批名字（inherited 层）。
 *
 * 拿不到就返回 null（调用方只做形状校验，不许把「不知道」当成「不存在」）。
 * 已知边界：preset/own 层的工具可能不在这里，别人机器上会存在「真工具被判未知」，
 * 所以界面不提供强制保存出口，文档写清「名字必须与宿主工具名完全一致」。
 */
export function knownToolNames(ctx) {
  // 有快照就用快照（那是真正会被 restrict() 认可的名字）；
  // 没有就返回 null —— 让调用方只查拼写，别把「还没见过」说成「不存在」。
  if (lastKnownTools && lastKnownTools.length) return lastKnownTools.slice()
  return null
}

/** 测试用：直接塞一份名字快照（真机上由 agent/created 时取到）。 */
export function rememberKnownTools(names) {
  const list = Array.isArray(names) ? names.map((x) => String(x)).sort() : []
  lastKnownTools = list.length ? list : null
}

/**
 * 从宿主 `restrict()` 的报错文本里捡回全量工具名（0.2.1-rc.3 实测可用）。
 *
 * 报错长这样：
 *   tools.restrict() names unknown global tool "web_serch"; known global tools: a, b, c
 * 白名单输入框正缺这份名单——捡回来之后，同一个进程里再校验就不用猜了。
 * 拿不到就什么都不做（永不抛）。
 */
export function adoptKnownFromError(message) {
  try {
    const text = String(message ?? '')
    const i = text.indexOf('known global tools:')
    if (i < 0) return false
    const tail = text.slice(i + 'known global tools:'.length).trim()
    if (!tail || tail === '(none)') return false
    const names = tail.split(',').map((s) => s.trim()).filter((s) => /^[a-z][a-z0-9_-]*$/.test(s))
    if (!names.length) return false
    lastKnownTools = [...new Set(names)].sort()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 进程内共享的「最近一次结论」。
//
// 为什么要模块级变量：`/selfcheck` 是另一条调用链（observe.js），拿不到 index.js
// 里的闭包。硬把状态塞进 ctx 当服务用属于滥用（ctx.get 是给真服务的），
// 而这里要的只是"本进程里那把刀到底挂上没有"——一个模块级单例正好。
// ---------------------------------------------------------------------------
let lastState = { ok: false, applied: 0, why: 'not attempted', allow: HER_TOOLS.slice() }

// 「宿主全局认得哪些工具名」的最近一份快照（进程内）。
// 只有拿到过某个 agent 的全局视角才有值；plugin 自己的 view() 只看得到本插件注册的那几个，
// 拿它校验会把 `skill` 这类宿主工具判成不存在，所以**不用它兜底**。
let lastKnownTools = null

/** 读最近一次收窄结论（自检用）。 */
export function readRestrictState() {
  return { ...lastState }
}

/** 内部：登记一次结论。 */
function report(r) {
  lastState = {
    ok: Boolean(r?.ok),
    applied: Number(r?.applied ?? 0),
    why: String(r?.why ?? ''),
    allow: r?.allow ?? HER_TOOLS.slice(),
    failed: r?.failed ? String(r.failed) : '',
    guard: Boolean(r?.guard),
  }
}
