import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'
import { readEvents, paths, writeConfig, appendEvent } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'
import { deriveSelf } from '../lib/derive.js'
import { startScheduler, wakeNow, wakeTimeLine } from '../lib/scheduler.js'
import { rememberKnownTools } from '../lib/restrict.js'
import { dateKey } from '../lib/settings.js'
import { writeSelfDoc } from '../lib/selfdoc.js'
import { clearWakeSection, getWakeSection } from '../lib/identity.js'
import { WAKE_TRIGGER } from '../lib/wakeconst.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-boot-'))
  try {
    return await fn(root)
  } finally {
    // Windows 上插件里的定时器/写盘可能在用例结束的瞬间还没收尾，直接 rm 会
    // 撞 ENOTEMPTY（CI 的 windows-latest 就是这么红的）。maxRetries 让 Node 在
    // EBUSY / ENOTEMPTY / EPERM 上线性退避重试，断言本身一条没放松。
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假宿主：tools / webServer / connection / sessionController / logger 全套 */
function fakeCtx({ allow = true, promptImpl } = {}) {
  const tools = new Map()
  const routes = []
  const prompts = []
  const sessions = new Set()
  const creates = []
  const ctx = {
    tools: { register: (spec) => { tools.set(spec.name, spec); return () => tools.delete(spec.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    connection: { requestRejection: () => (allow ? null : { status: 403, message: 'blocked' }) },
    sessionController: {
      async create({ sessionId, cwd }) { creates.push({ sessionId, cwd }); if (sessions.has(sessionId)) throw new Error('exists'); sessions.add(sessionId) },
      async prompt(payload) { prompts.push(payload); if (promptImpl) await promptImpl(payload) },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) { return ctx[key] },
  }
  return { ctx, tools, routes, prompts, sessions, creates }
}

/** 等注册生效：apply() 的工具/路由登记不是同步可见的，固定 sleep 在慢机上会偶发不够
 *  （CI 的 ubuntu Node 20 就是这样红的：`Cannot read properties of undefined (reading 'handler')`）。 */
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('插件元信息：名字与 inject', () => {
  assert.equal(name, 'dsh-fish')
  assert.ok(Array.isArray(inject), 'inject 必须是数组（写成对象会让 sessionController 静默丢失）')
  for (const k of ['sessionController', 'tools', 'webServer', 'connection']) assert.ok(inject.includes(k), `缺 ${k}`)
})

test('首次启动会播种，且只播一次', async () => {
  await withRoot(async (root) => {
    const { ctx } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    let { events } = await readEvents(root)
    const seeds = events.filter((e) => e.type === 'seed')
    assert.equal(seeds.length, 1)
    assert.ok(seeds[0].text.length > 20, '种子文本不能是空壳')
    assert.equal(seeds[0].source, 'system')

    // 再来一次（模拟重启）
    const h2 = apply(fakeCtx().ctx, { root })
    await new Promise((r) => setTimeout(r, 120))
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'seed').length, 1, '重启不能重复播种')

    h.dispose?.(); h2.dispose?.()
  })
})

test('注册了 growth_commit 与观测台路由', async () => {
  await withRoot(async (root) => {
    const { ctx, tools, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    assert.ok(await waitFor(() => tools.has('growth_commit')))
    const paths_ = routes.map((r) => r.path)
    assert.ok(paths_.includes('/dsh-fish'), '首页要注册')
    assert.ok(paths_.includes('/dsh-fish/state'))
    assert.ok(paths_.includes('/dsh-fish/config'))
    h.dispose?.()
  })
})

test('信任栅栏 fail-closed：connection 拒绝时 403', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx({ allow: false })
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/state'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/state', method: 'GET' }, res)
    assert.equal(res.code, 403)

    h.dispose?.()
  })
})

test('观测台 /state 不泄露 needs 数值', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/state'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/state', method: 'GET' }, res)
    assert.equal(res.code, 200)
    const dumped = res.body.toLowerCase()
    for (const leak of ['autonomy', 'competence', 'relatedness', 'needs', 'affinity']) {
      assert.ok(!dumped.includes(leak), `观测台不应返回 ${leak}`)
    }
    assert.ok(res.json.stageName)

    h.dispose?.()
  })
})

test('/state 与 /memory 把「对不上」和「记得很牢」报出来（2026-10-24 P0）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    // 两句极性相反、剥掉否定后是同一件事 → 她心里对不上
    // 注意：正面那句不能带「别 / 没 / 无」——那些字本身就算否定词，两句会同极性而被跳过。
    await appendEvent({ type: 'utterance', source: 'tool', text: '它是在看我。' }, {}, root)
    await appendEvent({ type: 'utterance', source: 'tool', text: '它不是在看我。' }, {}, root)

    const stateRoute = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/state'))
    const sres = fakeRes()
    await stateRoute.handler({ url: '/dsh-fish/state', method: 'GET' }, sres)
    assert.equal(sres.code, 200)
    assert.ok(sres.json.tension, '对不上要在 /state 里露出来')
    assert.equal(sres.json.tension.count, 1)
    assert.ok(sres.json.tension.a && sres.json.tension.b, '两句原话都要给，界面才能显示')
    assert.equal(typeof sres.json.solidCount, 'number')

    const memRoute = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/memory'))
    const mres = fakeRes()
    await memRoute.handler({ url: '/dsh-fish/memory', method: 'GET' }, mres)
    assert.equal(mres.code, 200)
    assert.equal(mres.json.sections.tensions, 1)
    assert.ok(mres.json.sections.tensionFirst)
    assert.equal(typeof mres.json.sections.solid, 'number')
    // 界面说的「在眼前」必须和真正注入的条数一致（曾出现 8 vs 3 的虚报）
    assert.ok(mres.json.sections.beliefsShown <= 3)

    h.dispose?.()
  })
})

test('config POST 白名单挡住指向她本人的键', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config'))
    const bad = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ personality: { clingy: 0.9 } })), bad)
    assert.equal(bad.code, 400, '改人格的键必须被拒')

    const good = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ daily: { questions: 3 } })), good)
    assert.equal(good.code, 200)
    assert.equal(good.json.config.daily.questions, 3)

    // 客户端（settings.section）会提交的两项环境配置，必须都能过
    const env = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({
      absenceAfterDays: 4,
      wakesPerDay: 2,
      diary: { visible: true, enabled: true },
      avoid: { keywords: ['恐怖', '血腥', '新的一个'] },
    })), env)
    assert.equal(env.code, 200, `环境配置必须能保存：${env.body}`)
    assert.equal(env.json.config.absenceAfterDays, 4)
    assert.equal(env.json.config.wakesPerDay, 2)
    assert.equal(env.json.config.diary.visible, true)
    assert.deepEqual(env.json.config.avoid.keywords, ['恐怖', '血腥', '新的一个'])

    h.dispose?.()
  })
})

test('请求体里的中文即使被 TCP 切断也要完整还原（跨 chunk 的多字节）', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config'))

    // 真机病史（2026-10-23）：她回「传过来的字是碎的，我认不出」。
    // 根因是 readBody 用 `data += chunk`，Buffer 隐式 toString 按 latin1 逐字节拆中文
    // → 送进去的是 \ufffd 一串替换符。这条测试就是钉死它：切点故意落在汉字中间。
    const payload = JSON.stringify({ avoid: { keywords: ['恐怖片', '血腥'] } })
    const bytes = Buffer.from(payload, 'utf8')
    const parts = []
    for (let i = 0; i < bytes.length; i += 4) parts.push(bytes.subarray(i, i + 4))

    const res = fakeRes()
    await route.handler({
      method: 'POST',
      url: '/dsh-fish/config',
      on(ev, cb) {
        if (ev === 'data') for (const p of parts) cb(p)
        if (ev === 'end') cb()
        return this
      },
      destroy() {},
    }, res)

    assert.equal(res.code, 200, `中文配置必须能存：${res.body}`)
    assert.deepEqual(res.json.config.avoid.keywords, ['恐怖片', '血腥'])
    assert.ok(!res.body.includes('\uFFFD'), '响应里不该出现替换符（说明解码坏了）')

    h.dispose?.()
  })
})

test('/dsh-fish 不再吐单页观测台，而是给一句"搬走了"', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish', method: 'GET' }, res)
    assert.equal(res.code, 200)
    assert.ok(res.body.includes('设置'), '要告诉人去设置里看')
    assert.ok(!res.body.includes('现在叫醒她'), '旧页面不该还在（它打不开，留着就是死代码）')

    h.dispose?.()
  })
})

test('日记默认不可见：只给日期，不给正文', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    // 手工放一篇日记
    const { writeDaily } = await import('../lib/store.js')
    await writeDaily('diaryDir', '2026-10-20', '今天没人来。', root)

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/diary'))
    const res = fakeRes()
    await route.handler({ url: '/dsh-fish/diary', method: 'GET' }, res)
    assert.equal(res.json.visible, false)
    assert.deepEqual(res.json.lockedDates, ['2026-10-20'])
    assert.ok(!JSON.stringify(res.json).includes('今天没人来'), '不可见时正文绝不能出现在响应里')

    h.dispose?.()
  })
})

test('日记可见时一天一页：默认只给最新一天，?day= 取指定那天', async () => {
  // 2026-10-26（用户 m01201）：日记攒到几十天之后，一次全发给前端既慢又没法看。
  // 现在 /diary 只给「日期目录 + 最新一天」，翻页按 day 单独取。
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ diary: { enabled: true, visible: true } }), root)
    const { ctx, routes } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const { writeDaily } = await import('../lib/store.js')
    await writeDaily('diaryDir', '2026-10-19', '前一天写的。', root)
    await writeDaily('diaryDir', '2026-10-20', '今天没人来。', root)

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/diary'))

    // 默认：日期全给（新在前），正文只给最新一天
    const r1 = fakeRes()
    await route.handler({ url: '/dsh-fish/diary', method: 'GET' }, r1)
    assert.deepEqual(r1.json.dates, ['2026-10-20', '2026-10-19'])
    assert.equal(r1.json.items.length, 1, '默认只带一天正文')
    assert.equal(r1.json.items[0].date, '2026-10-20')
    assert.ok(String(r1.json.items[0].text).includes('今天没人来'))

    // 指定更早一天：只回那一天，页里不能混进别的日子
    const r2 = fakeRes()
    await route.handler({ url: '/dsh-fish/diary?day=2026-10-19', method: 'GET' }, r2)
    assert.equal(r2.code, 200)
    assert.equal(r2.json.date, '2026-10-19')
    assert.ok(String(r2.json.text).includes('前一天写的'))
    assert.ok(!String(r2.json.text).includes('今天没人来'), '一页只放一天')

    // 那天没有（或日期不是 YYYY-MM-DD）：404 带说明
    const r3 = fakeRes()
    await route.handler({ url: '/dsh-fish/diary?day=2026-01-01', method: 'GET' }, r3)
    assert.equal(r3.code, 404)

    h.dispose?.()
  })
})

test('dispose 之后不再有后台活动（定时器真的停了）', async () => {
  await withRoot(async (root) => {
    const { ctx } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))
    h.dispose?.()

    const before = (await readEvents(root)).events.length
    await new Promise((r) => setTimeout(r, 200))
    const after = (await readEvents(root)).events.length
    assert.equal(after, before)
  })
})

test('scheduler.tick 在时间窗外不唤醒', async () => {
  await withRoot(async (root) => {
    // 窗口设成一个必然不含"现在"的区间（当前分钟往后推 3 小时开，1 分钟后关）
    const now = new Date()
    const h1 = (now.getHours() + 3) % 24
    await writeConfig(normalizeConfig({ window: [`${String(h1).padStart(2, '0')}:00`, `${String((h1 + 1) % 24).padStart(2, '0')}:00`] }), root)

    const { ctx, prompts } = fakeCtx()
    const s = startScheduler(ctx, { root, log: () => {} })
    await s.tick()
    assert.equal(prompts.length, 0, '时间窗外不该唤醒')
    s.dispose()
  })
})

// 回归（2026-10-23 用户报「她会话里有一大块隐藏提示词」→ 2026-10-25 晚再次报
// 「自动刷 B 站把她推醒了，对话框里又出现提示词」）：
// 唤醒会作为一条 user message 留在她的会话里，用户点开就看得见。
// 宿主没有「模型看得见、用户看不见」的通道（asar 已核实），所以正文不再进对话——
// 它走 system prompt 的 `fish:wake` 动态段；对话里只留一句极短的触发语。
test('唤醒消息只剩一句触发语，处境走 system prompt 段不进对话', async () => {
  await withRoot(async (root) => {
    // 关掉刷站，这两条测试才不会去打真接口（慢且不确定）。
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(prompts.length, 1)
    const text = prompts[0].content[0].text

    // 对话里只剩一句：不许再出现处境、身份、禁令、工具手册
    assert.equal(text, WAKE_TRIGGER, `对话里只该剩触发语，现在是：${text.slice(0, 80)}`)
    // 2026-10-26（用户 m00507）：原来是「……」，她当成用户发来的一句话去猜，
    // 侧栏标题还被生成成「Error」。现在触发语是括号旁白，且必须**不是**省略号。
    assert.ok(!text.includes('……'), '不能再拿省略号当触发语')
    assert.ok(!text.includes('## 你是谁'), '身份段不该出现在会话消息里')
    assert.ok(!text.includes('## 不能做的'), '禁令段不该出现在会话消息里')
    assert.ok(!text.includes('撒娇'), '禁令正文不该出现在会话消息里')
    assert.ok(!text.includes('autonomy'), '不能泄露字段名')
    assert.ok(!text.includes('第 1 天'), '处境正文不该再进对话')

    // 处境必须还在——只是换了通道（system prompt 段，见 attachIdentity）
    const wake = getWakeSection()
    assert.ok(wake.length > 0, '这次唤醒的处境不能为空')
    assert.ok(wake.includes('第 1 天') || wake.includes('醒'), '处境正文要在 wake 段里')
    assert.ok(wake.length < 1200, `处境段过长：${wake.length} 字`)
    // 2026-10-27 用户反馈：她第一次醒来时自己猜「大概不是我的时段」，还以为是权限问题。
    // 手动叫醒必须把「现在几点、是谁让醒的」说清楚，不让她猜。
    assert.match(wake, /现在是 \d{2}:\d{2}/, '唤醒段要给出当前时间')
    assert.match(wake, /有人刚按了叫醒/, '手动唤醒要说清是谁让醒的')

    // 身份必须还在落盘副本里（真通道是 systemPrompt 段，见 test/identity.test.mjs）
    await writeSelfDoc(root)
    const doc = await readFile(join(paths(root).root, 'home', '她的身份.md'), 'utf8')
    assert.ok(doc.includes('## 你是谁'))
    assert.ok(doc.includes('撒娇'), 'N1 禁令要在身份文档里')
    assert.ok(doc.includes('好感度'), 'N2 禁令要在身份文档里')
    assert.ok(doc.includes('growth_commit'), '工具说明要在身份文档里')
  })
})

// 回归：手动唤醒的 dateKey 必须是纯日期。
// 以前写成 `${dk}-manual`，这个后缀会一路跟着进 browse 记账、日记文件名、
// 报告文件名和会话 id；报告按 `2026-10-23` 去查，记账却写在
// `2026-10-23-manual` 里 → 报告"看了什么"永远显示"今天没看"。
// 区分手动只允许体现在 sessionId 上。
test('回归：手动唤醒的 dateKey 是纯日期，不污染 browse/日记/报告', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, sessions } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    const dk = dateKey()

    // 会话 id 允许带 -manual（那正是"这是一次手动唤醒"的标记，也是避开
    // 「同一天复用 id → create 抛已存在 → cwd 不更新」的办法），但它必须以
    // 纯日期开头，不能把后缀混进日期本身。
    for (const id of sessions) {
      assert.ok(id.startsWith(`fish-wake-${dk}`), `会话 id 应以纯日期开头：${id}`)
    }

    // 真正的防线在落盘产物上：记账的日期键必须是纯日期。
    const { events } = await readEvents(root)
    const browse = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('browse:'))
    for (const e of browse) {
      const key = String(e.text).slice('browse:'.length).split(' ')[0]
      assert.equal(key, dk, `browse 记账键必须等于纯日期，实际是 ${key}`)
    }
    const wakeMeta = events.filter((e) => e.type === 'meta' && String(e.text).startsWith('wake:'))
    for (const e of wakeMeta) {
      const key = String(e.text).slice('wake:'.length).split(' ')[0]
      assert.equal(key, dk, `wake 记账键必须等于纯日期，实际是 ${key}`)
    }
  })
})

test('她的会话 cwd 是她自己的空房间，不是状态库根目录', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({}), root)
    const { ctx, creates } = fakeCtx()
    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(creates.length, 1)
    const { cwd } = creates[0]
    assert.equal(cwd, paths(root).herDir, 'cwd 必须指向 herDir')
    assert.notEqual(cwd, root, 'cwd 不能就是状态库根——否则她 cat 一下就读到全部历史')
    // 真建出来了，不是个虚假路径
    const st = await stat(cwd)
    assert.ok(st.isDirectory())
    // 房间里没有事件流与配置
    const inRoom = await readdir(cwd)
    assert.ok(!inRoom.includes('events.jsonl'))
    assert.ok(!inRoom.includes('config.json'))
  })
})

// 回归（2026-10-26 用户 m00507「叫醒之后，对话到了未分组」）：
// 手动唤醒原来每次都伪造一个 `fish-wake-<日期>-manual-<ts>` 当会话 id，
// 宿主不认识它 → 按 cwd 新建一条 → 那条会话不在任何工作区的 sessionIds 里，
// 侧栏只能把它丢进「未分组」，用户在「大肥鱼的家」里根本看不见。
// 现在只要有屋子，就落在屋子那条会话里，会话自然还在工作区名下。
test('手动唤醒落在屋子会话里，不再另造一条（否则会掉进「未分组」）', async () => {
  await withRoot(async (root) => {
    // 关掉刷站：这条测的是会话归属，不该去打真接口
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts, creates } = fakeCtx()
    const WS = 'ws-home'
    const SID = 'session-home-1'
    const ws = { sessionIds: [SID] }
    ctx.workspaceRegistry = {
      get: (id) => (id === WS ? ws : undefined),
      list: () => [ws],
      archivedSessionIds: [],
    }
    await writeFile(
      join(paths(root).root, 'home.json'),
      JSON.stringify({ wsId: WS, sessionId: SID, title: '跟大肥鱼说话', preset: '' }),
      'utf8',
    )

    const r = await wakeNow(ctx, { root })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.sessionId, SID, '手动唤醒没有走屋子会话')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].sessionId, SID, '唤醒消息发进了别的会话')
    // 不许再顺手造一条新会话（那条就是会掉进未分组的东西）
    for (const c of creates) {
      assert.notEqual(c.sessionId, undefined)
      assert.ok(!String(c.sessionId).startsWith('fish-wake-'), `不该再伪造 wake 会话：${c.sessionId}`)
    }
  })
})

// 反向：屋里那条会话被删/被归档了，就当没屋子，退回独立会话 —— 但要想办法
// 让人知道（log 里有话），不能默默再制造一条未分组垃圾。
test('屋子会话没了：退回独立会话，并且把原因说出来', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ browse: { enabled: false } }), root)
    const { ctx, prompts } = fakeCtx()
    const WS = 'ws-home'
    const logs = []
    ctx.workspaceRegistry = {
      get: (id) => (id === WS ? { sessionIds: ['session-gone'] } : undefined),
      list: () => [{ sessionIds: ['session-gone'] }],
      archivedSessionIds: [],
    }
    // home.json 指向一条早已不在工作区里的会话
    await writeFile(
      join(paths(root).root, 'home.json'),
      JSON.stringify({ wsId: WS, sessionId: 'session-old', title: '跟大肥鱼说话', preset: '' }),
      'utf8',
    )

    const r = await wakeNow(ctx, { root, log: (m) => logs.push(String(m)) })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(String(r.sessionId).startsWith('fish-wake-'), '没有屋子时才该用独立会话 id')
    assert.equal(prompts.length, 1)
    assert.ok(logs.some((m) => m.includes('未分组')), `退回独立会话必须写明后果，实际日志：${JSON.stringify(logs)}`)
  })
})

test('整条链路：她说一句 → 判断数 +1 → 阶段门仍卡着（不跳级）', async () => {
  await withRoot(async (root) => {
    await writeConfig(normalizeConfig({ growthDays: 30 }), root)
    const { ctx, tools } = fakeCtx()
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const tool = await waitFor(() => tools.get('growth_commit'))
    await tool.execute({ type: 'utterance', text: '我不太确定自己喜不喜欢安静。', confidence: 0.3 })

    const { events } = await readEvents(root)
    const m = deriveSelf(events, { growthDays: 30 })
    assert.equal(m.beliefCount, 1)
    assert.equal(m.stage, 1, '只过 trust 门、没过 autonomy 门，不该到 stage 2')
    assert.equal(m.stageGate.pending, 'autonomy')

    h.dispose?.()
  })
})

function fakeRes() {
  const res = {
    code: 200,
    body: '',
    headers: {},
    writableEnded: false,
    writeHead(code, headers) { res.code = code; Object.assign(res.headers, headers || {}); return res },
    end(chunk) { if (chunk) res.body += String(chunk); res.writableEnded = true; return res },
    get json() { try { return JSON.parse(res.body) } catch { return null } },
  }
  return res
}

function reqWithBody(method, body) {
  const chunks = [Buffer.from(body, 'utf8')]
  return {
    method,
    url: '/dsh-fish/config',
    on(ev, cb) {
      if (ev === 'data') for (const c of chunks) cb(c)
      if (ev === 'end') cb()
      return this
    },
    destroy() {},
  }
}

test('工具面白名单：拼错的名字不许保存，合法名字按全角逗号/空格存成数组', async () => {
  await withRoot(async (root) => {
    const { ctx, routes } = fakeCtx()
    // 真机上这份快照在 agent/created 时从她的全局视角取到；测试里直接塞
    rememberKnownTools(['web_search', 'read_image', 'skill'])
    const h = apply(ctx, { root })
    await new Promise((r) => setTimeout(r, 120))

    const route = await waitFor(() => routes.find((r) => r.path === '/dsh-fish/config'))

    // 拼错一个字母：形状合法、名单里没有 —— 存进去就会让整条收窄失效，必须 400
    const typo = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ tools: { restrict: true, allow: ['web_serch'] } })), typo)
    assert.equal(typo.code, 400, '拼错的名字必须被拒')
    assert.ok(typo.body.includes('web_serch'), '要说出是哪个名字不对')

    // 合法名字：全角逗号也认，落盘是干净的数组
    const okRes = fakeRes()
    await route.handler(reqWithBody('POST', JSON.stringify({ tools: { restrict: true, allow: ['skill，read_image'] } })), okRes)
    assert.equal(okRes.code, 200, okRes.body)
    assert.deepEqual(okRes.json.config.tools.allow, ['skill', 'read_image'])

    // /tools 把名字给界面（只给名字，不给定义）
    const toolsRoute = routes.find((r) => r.path === '/dsh-fish/tools')
    const listRes = fakeRes()
    await toolsRoute.handler({ url: '/dsh-fish/tools', method: 'GET' }, listRes)
    assert.equal(listRes.code, 200)
    assert.equal(listRes.json.ok, true)
    assert.deepEqual(listRes.json.known, ['read_image', 'skill', 'web_search'])

    h.dispose?.()
  })
})

// 2026-10-27 用户反馈（m00974）：她第一次醒来时自己猜「大概不是我的时段」，
// 用户还以为是自己没给权限。叫醒先把「几点、谁让醒」说清楚，别留给她猜。
test('叫醒的时间行：手动的说清谁按的，定时的说清是她自己醒的', () => {
  const at = (h, m) => new Date(2026, 9, 27, h, m)
  assert.equal(
    wakeTimeLine(at(16, 6), { manual: true, insideWindow: false }),
    '现在是 16:06。有人刚按了叫醒——这个点不在你平时的时段，是有人要你现在醒。',
  )
  assert.equal(
    wakeTimeLine(at(20, 43), { manual: true, insideWindow: true }),
    '现在是 20:43。有人刚按了叫醒，要你现在醒。',
  )
  assert.equal(
    wakeTimeLine(at(20, 43), { manual: false }),
    '现在是 20:43，这一次是你自己醒的。',
  )
})
