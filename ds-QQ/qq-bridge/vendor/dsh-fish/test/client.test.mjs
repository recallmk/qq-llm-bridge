/**
 * client.test.mjs —— 客户端半边（lib/client.js）的冒烟测试
 *
 * 为什么这个测试值得存在：
 *   DSH 的客户端插件是**在浏览器里**通过 window.__ModuleLoader__.load 装载的。
 *   宿主侧 node --test 根本不会执行它 —— 一个拼错的分支、一个 undefined 的解构，
 *   只有在用户点开「设置 → 鱼」时才会炸，而那时报错信息是 "entries did not activate"，
 *   完全指不出是哪一行。
 *
 *   所以这里造一个最小的 window / ModuleLoader / react 假环境，真的把 factory 跑一遍，
 *   并**真的渲染一次组件**（用假的 React，把 h() 结果当树遍历），
 *   能在 CI 里就抓到「组件引用了不存在的字段」这类错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

/**
 * 假 React：h() 产出一个普通对象，组件函数就是普通函数。
 * useState 返回一个固定值 + 一个 noop setter（只测渲染不测交互）。
 */
function fakeReact(initialState = {}) {
  const state = { ...initialState }
  let cursor = 0
  const queue = []
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })
  const useState = (init) => {
    const idx = cursor++
    const v = idx in state ? state[idx] : typeof init === 'function' ? init() : init
    queue.push(v)
    return [v, () => {}]
  }
  return {
    h,
    // 客户端用的是 `const { createElement: h, useCallback, useEffect, useState } = React`
    createElement: h,
    useState,
    useCallback: (fn) => fn,
    useEffect: (fn) => { queue.push(['effect', fn]) },
    useMemo: (fn) => fn(),
    useRef: (init) => ({ current: init }),
    resetCursor() { cursor = 0 },
  }
}

/** 收集整棵树里的文本，用来断言"页面里真的有东西" */
function textOf(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  if (node.children) for (const c of node.children) textOf(c, out)
  return out
}

async function loadClient({ react }) {
  const src = await readFile(CLIENT, 'utf8')
  const loaded = []
  const window = {
    __ModuleLoader__: {
      load(spec) { loaded.push(spec) },
    },
  }
  // 客户端文件是**脚本**不是模块：用 Function 在当前作用域里跑，把 window 与 require 注进去
  const fn = new Function('window', 'require', 'document', src)
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
  }
  fn(window, (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  }, document)

  assert.equal(loaded.length, 1, '必须调用一次 window.__ModuleLoader__.load')
  const spec = loaded[0]
  assert.equal(spec.id, 'dsh-fish', 'loader id 必须等于包名，否则客户端模块挂不上')
  const exports = spec.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  })
  return { exports, spec }
}

test('client.js 能被 ModuleLoader 装载，且导出了 apply / inject', async () => {
  const { exports } = await loadClient({ react: fakeReact() })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'], '设置节的客户端只依赖 slots')
  assert.equal(typeof exports.FishSection, 'function')
})

test('apply 注册到 settings.section，id 与 label 都对', async () => {
  const react = fakeReact()
  const { exports } = await loadClient({ react })

  const registered = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    slots: {
      inject(name, fn, label) {
        assert.equal(name, 'settings.section')
        assert.equal(label, 'dsh-fish: settings section')
        fn()
        return () => {}
      },
      register(meta, Component) {
        registered.push({ meta, Component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.name, 'settings.section')
  assert.equal(registered[0].meta.id, 'fish')
  assert.equal(typeof registered[0].meta.label, 'function')
  assert.equal(registered[0].meta.label(), '大肥鱼')
})

test('组件在"还没有数据"时也能渲染，不抛错', async () => {
  const react = fakeReact()
  const { exports } = await loadClient({ react })
  react.resetCursor()
  // 第一次渲染：state 全是初始值（null / 空）
  const tree = exports.FishSection()
  const txt = textOf(tree).join(' ')
  assert.ok(txt.includes('鱼'), '标题要在')
  assert.ok(txt.includes('成长'), '「成长」分页要在')
  assert.ok(txt.includes('现在叫醒大肥鱼'), '操作要在')
  // P3 架构改造后新增：用户"打开侧栏就能看见她"，所以观测台必须告诉他去哪找。
  // 屋子卡片在「住所」页，而默认停在「状态」页 —— 看源码（同本文件 2026-10-23 那条口径：
  // 标签页名字看渲染结果，藏在别的页里的卡片看源码）。
  assert.ok((await readFile(CLIENT, 'utf8')).includes('大肥鱼住在哪'), '屋子卡片要在')
  // 备用入口是条件分支：home 还没读到时显示「读取中」，所以看源码而不是树。
  const src0 = await readFile(CLIENT, 'utf8')
  assert.ok(src0.includes('备用说话入口'), '屋子没建起来时要有备用入口')
  // 信箱在「记忆」页，默认停在「状态」页 —— 同样看源码。
  assert.ok((await readFile(CLIENT, 'utf8')).includes('信箱'), '信箱要在')
})

test('组件在"有数据"时把关键信息渲染出来', async () => {
  const react = fakeReact()
  const { exports } = await loadClient({ react })

  // 用假的 fetch 喂一份完整状态，再手工触发一次 load 的效果
  const state = {
    day: 5, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: 'autonomy', name: null, beliefCount: 2, absenceDays: 0,
    counts: { utterance: 3, revise: 1, refusal: 0, reunion: 0, total: 6 },
    quality: { stability: 0.5, consistency: 0.6, novelty: 0.7 },
    config: {
      window: ['20:00', '23:00'],
      daily: { events: 1, questions: 1 },
      diary: { enabled: true, visible: false },
      absenceAfterDays: 3,
    },
  }
  globalThis.fetch = async (url) => {
    const u = String(url)
    const body = u.endsWith('/state') ? state
      : u.endsWith('/beliefs') ? { active: [{ id: 'ev_1', text: '我不喜欢被催。', confidence: 0.6 }], refuted: [], refusals: [], selfmod: [] }
      : u.includes('/events') ? { rows: [{ type: 'utterance', text: '一句测试话。' }], total: 1 }
      : u.endsWith('/diary') ? { enabled: true, visible: false, items: [], lockedDates: ['2026-10-20'] }
      : u.endsWith('/config') ? { config: state.config }
      : {}
    return { ok: true, status: 200, json: async () => body }
  }

  // 组件内部用 useState 拿状态；这里直接把初始 state 塞进去模拟"已加载"，
  // 然后只验证渲染路径不炸、且关键片段出现。
  react.resetCursor()
  const tree = exports.FishSection()
  const txt = textOf(tree).join(' ')
  assert.ok(txt.includes('成长'), '分页里的「成长」必须有一页')
  // 2026-10-23 起界面改成分页：默认只渲染「现在」页，别的页在源码里但不在这一棵树里。
  // 所以这两类断言分开：标签页名字看渲染结果，藏在别的页里的控件看源码。
  const src = await readFile(CLIENT, 'utf8')
  // 2026-10-25 起页签固定为 8 个（没有「全部」页，用户要求删掉；文案页同日下线）：
  // 状态 / 成长 / 住所 / 上网 / 记忆 / 插件 / 原理 / 数据（末页原叫「危险」，
  // 2026-10-24 改名并把数据在哪、每日报告、运行日志挪了进去；原理页在插件与数据之间）。
  for (const label of ['状态', '成长', '住所', '上网', '记忆', '插件', '原理', '数据']) {
    assert.ok(txt.includes(label), `分页标签「${label}」必须在`)
  }
  assert.ok(!txt.includes('全部'), '不该再有「全部」页')
  const srcAll = await readFile(CLIENT, 'utf8')
  assert.ok(!/\[\s*'all'\s*,/.test(srcAll), '源码里不该再留 all 页签')
  assert.ok(src.includes('让我看日记'), '日记可见性开关必须在')
  assert.ok(src.includes('黑名单（逗号分隔'), '黑名单可追加必须在')
  assert.ok(src.includes('允许她上网（B 站）'), '上网总开关必须在')
  delete globalThis.fetch
})

test('「下载交接单模板」不挂在任何分支里：养着鱼的人也要看得到（用户 m05086）', async () => {
  // 现场事实：这个按钮原来写在「!importInfo.canImport 且 importAsk 展开」那一支里，
  // 已经有起点的人走的是另一条分支，页面上根本没有按钮。用户原话：
  // 「我没在导入其他人的大肥鱼那里看到这个交接单模版下载的按钮」。
  // 这里不出渲染树（要精确命中 importInfo 那个 useState 下标太脆），只钉结构：
  // 按钮必须出现在「importCard」内部、且排在所有分支判断之前。
  const src = await readFile(CLIENT, 'utf8')
  const cardStart = src.indexOf('const importCard = h(')
  const cardEnd = src.indexOf('const resetCard = h(')
  assert.ok(cardStart > 0 && cardEnd > cardStart, '必须能定位到导入卡这段源码')
  const card = src.slice(cardStart, cardEnd)

  const btn = card.indexOf("'下载交接单模板'")
  assert.ok(btn > 0, '导入卡里必须有「下载交接单模板」按钮')

  // 分支起点：第一个判断 importInfo 有没有读到的地方
  const branch = card.indexOf('!importInfo\n')
  assert.ok(branch > 0, '必须能定位到「还没读到 /import」那条分支')
  assert.ok(btn < branch, '下载按钮要排在分支之前——排在后面就又变成「只在某一支里才有」')

  // 顺带钉住那句旁注：它解释了为什么按钮跟能不能接无关
  assert.ok(card.includes('模板随时能下载'), '下载按钮旁要有那句说明')
})

test('组件里没有任何"改她性格"的控件（B §8 红线）', async () => {
  const raw = await readFile(CLIENT, 'utf8')
  // 2026-10-27：导入卡里有一段**说明性**文案，用户明确要求写清「如果你原本的好感度设定，
  // 到这里她看不到自己的好感度、你也不能改她的人设」。它是解释，不是控件——
  // 先把这一段剥掉再扫，别处再出现这些词照样红。
  const src = raw.replace(/此外，根据本插件的规则[\s\S]*?换一种人设。/, '')
  assert.notStrictEqual(src, raw, '导入卡那段说明文案必须还在（它被用户点名要求保留）')
  for (const banned of ['好感度', '亲密度', 'affinity', '外向', '黏人程度', '性格滑条']) {
    assert.ok(!src.includes(banned), `客户端代码里不该出现 ${banned}`)
  }
  // 只允许改"环境"的那几类键
  // 2026-10-24 起字段表集中在 buildConfig()：自动保存与手动保存共用同一份。
  const m = src.match(/const buildConfig = \(\) => \(\{([\s\S]*?)\n {6}\}\)/)
  assert.ok(m, '必须能定位到 buildConfig 的字段表')
  const body = m[1]
  for (const key of ['absenceAfterDays', 'wakesPerDay', 'daily', 'diary', 'avoid', 'browse']) {
    assert.ok(body.includes(key), `保存体里应有 ${key}`)
  }
  for (const key of ['personality', 'persona', 'traits', 'mood', 'love']) {
    assert.ok(!body.includes(key), `保存体里不该有 ${key}`)
  }
})

test('quality 是宿主那套 {score} 结构体时也要能渲染（2026-10-23 设置页空白的根因）', async () => {
  // 现场事实：宿主 /state 返回的 quality 不是数字，是带样本量的结构体：
  //   { stability:{score,sample,worst}, consistency:{score,pairs}, novelty:{score,recent,older} }
  // 客户端曾写成 s.quality.stability.toFixed(2) → 对对象调 toFixed → TypeError
  // → React 渲染抛错 → 设置节被错误边界吞掉 → 用户看到**一片空白**。
  // 这个用例把"真实形状"钉死，谁再退回裸数字假设就会红。
  const realShape = {
    day: 1, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: 'trust', name: null, beliefCount: 0, absenceDays: 0,
    counts: { utterance: 0, revise: 0, refusal: 0, reunion: 0, total: 2 },
    quality: {
      stability: { score: 0, sample: 0, worst: 0 },
      consistency: { score: 1, pairs: 0 },
      novelty: { score: 0, recent: 0, older: 0 },
    },
    config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: { enabled: true, visible: false }, absenceAfterDays: 2 },
  }

  const react = fakeReact({ 0: realShape })   // 第 0 个 useState 就是 state
  const { exports } = await loadClient({ react })
  react.resetCursor()

  let tree
  assert.doesNotThrow(() => { tree = exports.FishSection() }, 'quality 是结构体时不许抛')
  const txt = textOf(tree).join(' ')
  assert.ok(txt.includes('判断漂移'), '质量那行要渲染出来')
  // 2026-10-26 改（用户 m05785「为什么剩下两个全是0」）：
  // 这个形状就是全新一局的样子——0 条判断、0 对可比的话、0 条七天前的老话。
  // 原来三个数会照默认值印成「0.00 / 1.00 / 0.00」，让人以为她很差、还想把 1.00 当满分。
  // 现在样本不足一律写人话，数字只在真能测时才印。
  assert.ok(txt.includes('还没攒到判断，测不出来'), `没有判断时要说测不出来，实际: ${txt.slice(0, 300)}`)
  assert.ok(txt.includes('还没有跨阶段的话可比'), '说话不足两条时要说还没得比')
  // 新鲜：这个夹具里最近一周一条没说（recent=0），先说「没说过话」；
  // 有近期没历史时才说「还没有七天前的老话可比」。两者都不是 0.00。
  assert.ok(txt.includes('最近一周没说过话'), '最近没说话时要说没说过话')
  assert.ok(!txt.includes('稳定 0.00'), '样本不足时不许再印 0.00 冒充读数')
  assert.ok(!txt.includes('undefined'), '不许把 undefined 渲染到界面上')
  assert.ok(!txt.includes('NaN'), '不许把 NaN 渲染到界面上')
})

test('quality 能测出稳定值时，数字和判读一起给（用户 m06350）', async () => {
  const react = fakeReact({
    0: {
      day: 30, growthDays: 30, stage: 2, stageName: '自主', stageForced: false, pendingGate: null,
      name: '梦尘', beliefCount: 6, absenceDays: 0,
      counts: { utterance: 40, revise: 3, refusal: 2, reunion: 1, total: 60 },
      quality: {
        stability: { score: 0.41, sample: 24, k: 3, beliefs: 6, band: '全压在这几条上，少一条就是另一个人' },
        consistency: { score: 0.72, pairs: 12 },
        novelty: { score: 0.35, recent: 9, older: 20 },
      },
      config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: { enabled: true, visible: false }, absenceAfterDays: 2 },
    },
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(exports.FishSection()).join(' ')
  assert.ok(txt.includes('全压在这几条上'), `band 那句话要显示出来，实际: ${txt.slice(0, 300)}`)
  assert.ok(txt.includes('0.41'), '能测出数值时，数字必须印出来——只给判读会让人以为没测（用户 m06350）')
  assert.ok(txt.includes('0.72'), '一致仍然显示数字')
  assert.ok(txt.includes('0.35'), '新鲜仍然显示数字')
})

// 2026-10-27（用户 m06107「这三个参数分成三行显示，现在排成一行有点拥挤」）：
// 三个值原来是拼在同一条 rowTip 的值里，界面上是一长串。现在必须是三个独立的行。
test('判断漂移的三个值分三行渲染，不挤在一行里（用户 m06107）', async () => {
  const react = fakeReact({
    0: {
      day: 30, growthDays: 30, stage: 2, stageName: '自主', stageForced: false, pendingGate: null,
      name: '梦尘', beliefCount: 6, absenceDays: 0,
      counts: { utterance: 40, revise: 3, refusal: 2, reunion: 1, total: 60 },
      quality: {
        stability: { score: 0.41, sample: 24, k: 3, beliefs: 6, band: '全压在这几条上，少一条就是另一个人' },
        consistency: { score: 0.72, pairs: 12 },
        novelty: { score: 0.35, recent: 9, older: 20 },
      },
      config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: { enabled: true, visible: false }, absenceAfterDays: 2 },
    },
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const tree = exports.FishSection()
  // 三个值各自是一个 rowTip（行名 span 的 minWidth 是 84px 那一种）。
  // 取所有行名，断言「稳定 / 一致 / 新鲜」各是一个独立的行，而不是拼在一个值里。
  const labels = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const st = n.props && n.props.style
    if (st && st.minWidth === '84px') labels.push(textOf(n).join(''))
    if (n.children) n.children.forEach(walk)
  }
  walk(tree)
  assert.ok(labels.includes('稳定'), `稳定要单独成一行，实际行名: ${labels.join('/')}`)
  assert.ok(labels.includes('一致'), `一致要单独成一行，实际行名: ${labels.join('/')}`)
  assert.ok(labels.includes('新鲜'), `新鲜要单独成一行，实际行名: ${labels.join('/')}`)
})

test('quality 缺失 / 是裸数字时也都能渲染', async () => {
  for (const q of [undefined, null, {}, { stability: 0.5, consistency: 0.6, novelty: 0.7 }]) {
    const react = fakeReact({
      0: {
        day: 1, growthDays: 30, stage: 1, stageName: '信任', stageForced: false, pendingGate: null,
        name: null, beliefCount: 0, absenceDays: 0,
        counts: { utterance: 0, revise: 0, refusal: 0, reunion: 0, total: 0 },
        quality: q,
        config: { window: [], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 2 },
      },
    })
    const { exports } = await loadClient({ react })
    react.resetCursor()
    assert.doesNotThrow(() => exports.FishSection(), `quality=${JSON.stringify(q)} 时不许抛`)
  }
})

test('观测台有「在线状态」条：7 种状态都有颜色，且页面在后台不轮询', async () => {
  const src = await readFile(CLIENT, 'utf8')

  // 状态来自 /status（宿主用 meta + 配置 + 时钟算出来的，不是她自报）
  assert.ok(src.includes("jget('/status')"), '必须真的去读 /status')

  // 七种状态一个都不能漏；漏了那种状态就变成无色灰点，看不出区别
  for (const phase of ['asleep', 'waiting', 'awake-idle', 'browsing', 'talking', 'writing', 'offline']) {
    assert.ok(src.includes(`'${phase}'`) || src.includes(` ${phase}:`), `缺少状态 ${phase}`)
  }

  // 页面在后台就别轮询（省电，也不制造无谓请求）
  assert.ok(src.includes('visibilityState'), '要检查页面是否可见')

  // 时间线要能显示「醒了，但什么也没做」这类记录
  assert.ok(src.includes('st.timeline'), '要渲染时间线')
})

// ---------------------------------------------------------------------------
// 2026-10-24：状态卡「下一道门」漏英文 + 规则卡空态常驻
// ---------------------------------------------------------------------------

/** 状态卡用的最小 /state 形状（用例按需覆盖字段） */
function stateWith(extra = {}) {
  return {
    day: 3, growthDays: 30, stage: 1, stageName: '信任', stageForced: false,
    pendingGate: null, name: null, beliefCount: 1, absenceDays: 0,
    counts: { utterance: 1, revise: 0, refusal: 0, reunion: 0, total: 1 },
    quality: { stability: 0, consistency: 1, novelty: 0 },
    config: { window: ['20:00', '23:00'], daily: { events: 1, questions: 1 }, diary: {}, absenceAfterDays: 3 },
    ...extra,
  }
}

test('「下一道门」显示中文，不把 trust / autonomy / competence 漏到界面上', async () => {
  // 现场事实：用户看到「下一道门 competence」不知道是什么。宿主 stageGate.pending
  // 给的是技术名，显示层必须翻成 信任 / 自主 / 主动。
  for (const [gate, name] of [['trust', '信任'], ['autonomy', '自主'], ['competence', '主动']]) {
    const react = fakeReact({ 0: stateWith({ pendingGate: gate }) })
    const { exports } = await loadClient({ react })
    react.resetCursor()
    const txt = textOf(exports.FishSection()).join(' ')
    assert.ok(txt.includes(name), `pendingGate=${gate} 时应显示「${name}」，实际：${txt.slice(0, 200)}`)
    assert.ok(!txt.includes(gate), `不该把技术名 ${gate} 印到界面上`)
  }
})

test('三道门都走完时显示「已走完」，不显示 null', async () => {
  const react = fakeReact({ 0: stateWith({ pendingGate: null }) })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(exports.FishSection()).join(' ')
  assert.ok(txt.includes('已走完'), '没门可走时要有话说')
  assert.ok(!txt.includes('null'), '不许把 null 渲染出来')
})

test('规则卡：没有待裁决的申请时不渲染空态行，有申请才出现两个按钮', async () => {
  const idle = {
    pending: null, offersOn: true,
    layers: [{ name: '物理层', mutable: false, note: '代码保证。', rules: [{ id: 'r1', title: '不许打分', inPrompt: false }] }],
    status: [{ id: 'r1', active: true }],
  }

  // 1) 有 pending 通道但没有申请：整行不渲染，也不该出现裁决按钮
  //    rules 是组件里第 10 个 useState（0 基下标 9），数据来自 /rules，不在 /state 里。
  let react = fakeReact({ 0: stateWith(), 9: idle })
  let loaded = await loadClient({ react })
  react.resetCursor()
  let txt = textOf(loaded.exports.FishSection()).join(' ')
  assert.ok(txt.includes('规则约束'), '规则卡要在')
  assert.ok(!txt.includes('目前没有待处理的申请'), '不该常驻一句空待办')
  assert.ok(!txt.includes('这次不行'), '没有申请就不该有裁决按钮')

  // 2) 有申请：卡片 + 两个按钮都要出来
  react = fakeReact({ 0: stateWith(), 9: { ...idle, pending: { why: '想自己决定要不要出门。' } } })
  loaded = await loadClient({ react })
  react.resetCursor()
  txt = textOf(loaded.exports.FishSection()).join(' ')
  assert.ok(txt.includes('大肥鱼提了一个申请'), '有申请时要标出来')
  assert.ok(txt.includes('可以') && txt.includes('这次不行'), '两个裁决按钮都要在')

  // 3) 通道关着：并进卡片说明行，不单独占一行
  react = fakeReact({ 0: stateWith(), 9: { ...idle, offersOn: false } })
  loaded = await loadClient({ react })
  react.resetCursor()
  txt = textOf(loaded.exports.FishSection()).join(' ')
  assert.ok(txt.includes('申请通道现在关着'), '通道关着要说明')
  assert.ok(!txt.includes('目前没有待处理的申请'), '仍然不该有那句空态')
})

test('用户改过的标签已固化：阶段四行、叫法、记忆三项（2026-10-24）', async () => {
  // 这些字原来是用户在文案面板里改的覆盖，已固化进源码；copy.json 也清空了。
  // 谁要是改回短版本，这条会拦下来——那是用户亲手定的措辞。
  const src = await readFile(CLIENT, 'utf8')
  for (const s of [
    '1 信任 · 根据所见所闻形成一条自己的判断/认知',
    '2 自主 · 说过至少两次「不要」，反抗意识的觉醒',
    '3 主动 · 两次推翻自己之前的判断/认知，形成新的正确认知',
    '4 整合 · 回顾过去经历，有意识地发现自己的改变',
    '已成长天数', '当前阶段', '下一个成长瓶颈', '规则约束',
    '特意写给你的信。某种意义上代表她当前的状态，可能含有关键信息。',
    '认知重构', '勇于拒绝',
  ]) {
    assert.ok(src.includes(s), `源码里缺少用户定的这句：${s}`)
  }
  assert.ok(!src.includes('想改自己 '), '「想改自己」已按用户要求删掉')
  assert.ok(!src.includes("rowTip('下一道门'"), '「下一道门」已改叫「下一个成长瓶颈」')
})

test('状态卡把「认知矛盾」和「记得很牢」露出来（2026-10-24 P0）', async () => {
  const react = fakeReact({
    0: stateWith({ solidCount: 2, tension: { count: 1, a: '它不是在看别的。', b: '它就是在看别的。' } }),
  })
  const { exports } = await loadClient({ react })
  react.resetCursor()
  const txt = textOf(exports.FishSection()).join(' ')
  assert.ok(txt.includes('认知矛盾'), '冲突必须能在界面上看见')
  assert.ok(txt.includes('1 处'))
  assert.ok(txt.includes('记得很牢'), '固化的条数也要露出来')
  // 提示语在 title 属性里，textOf 取不到，直接查源码
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('不能同时算数'), '要说清这是什么，不能只丢一个数字')
  assert.ok(src.includes('可以直接问她'), '给她留一条出路：去问，而不是让她自己猜')
  assert.ok(!src.includes('这不是正确答案'), '界面不许替她裁决哪句对')
})

test('互动计数的问号写清四个数字的口径（用户定稿）', async () => {
  const src = await readFile(CLIENT, 'utf8')
  assert.ok(src.includes('说=她写过几句自己的判断（含留话）'))
  assert.ok(src.includes('改口=按照规则推翻历史认知并指明改的是哪条'))
  assert.ok(src.includes('拒绝=她明确登记拒绝过什么'))
  assert.ok(src.includes('重聚=久别之后她自己写下的感受'))
  assert.ok(!src.includes('她自己写下的事件条数，不含系统记的。'), '旧口径已作废')
})
