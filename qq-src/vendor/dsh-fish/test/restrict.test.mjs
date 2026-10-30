/**
 * restrict.test.mjs —— 工具面收窄（2026-10-24）
 *
 * 为什么值得单独立测：这件事的全部价值在于「她真的看不见那 31 个工具」。
 * 一旦哪天宿主的 `restrict()` 改了签名、或者我们的名字写错一个字母，
 * 它会**静默失效**——她照样能看到 shell 和写文件，而我们以为收窄了。
 * 所以这里钉三件事：
 *   ① 清单里每个名字都必须是真实存在的工具（名字错＝当场抛错，不是悄悄地过）；
 *   ② 只对「她的屋子」那一个 agent 下手，别人的会话一个都不碰；
 *   ③ 结论必须分开报「注册了」与「真挂上了」，不许合并成一句“成功”。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HER_TOOLS, isHerAgent, registerToolRestrict, readRestrictState, describeRestrict } from '../lib/restrict.js'

/** 一个够用的假插件 ctx：能 on('agent/created')，也能被我们主动触发。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {
        const arr = listeners.get(ev) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    emit(ev, payload) {
      for (const fn of listeners.get(ev) ?? []) fn(payload)
    },
    count(ev) {
      return (listeners.get(ev) ?? []).length
    },
  }
}

/** 一个够用的假 agent：cwd 决定它是不是她。 */
function fakeAgent(cwd, { withRestrict = true, withGuard = true } = {}) {
  const calls = []
  const tools = {}
  if (withRestrict) {
    tools.restrict = (filter) => {
      calls.push(filter)
      return () => {}
    }
  }
  if (withGuard) {
    // guard 接一个同步函数，返回 undefined = 放行、返回字符串 = 拒绝（这是宿主的契约）
    tools.guard = (fn) => {
      guards.push(fn)
      return () => {}
    }
  }
  const guards = []
  return {
    calls,
    guards,
    agent: {
      session: { header: { cwd } },
      ctx: { tools, effect: () => {} },
    },
  }
}

test('清单里她该有的工具都在，且不含危险口子', () => {
  // 六个是她自己的，外加 read_image（看图片/看视频画面都靠它）
  for (const name of ['growth_commit', 'her_recall', 'her_leave', 'bili_look', 'bili_watch', 'bili_speak', 'read_image']) {
    assert.ok(HER_TOOLS.includes(name), `清单里少了 ${name}`)
  }
  // 这几个一旦放进去，收窄就白做了
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'web_search', 'web_fetch', 'skill', 'subagent', 'workflow']) {
    assert.ok(!HER_TOOLS.includes(name), `清单里不该有 ${name}`)
  }
})

test('isHerAgent 只认她的屋子，不认别的目录', () => {
  const her = 'C:\\Users\\someone\\.dsh-fish\\home'
  assert.equal(isHerAgent({ session: { header: { cwd: her } } }, her), true)
  // 末尾斜杠不该影响判断（任何平台）
  assert.equal(isHerAgent({ session: { header: { cwd: `${her}\\` } } }, her), true)
  // 大小写不敏感是 Windows 文件系统的性质，macOS/Linux 区分大小写，别在那边硬要求
  if (process.platform === 'win32') {
    assert.equal(isHerAgent({ session: { header: { cwd: 'c:/users/someone/.dsh-fish/home/' } } }, her), true)
  }
  assert.equal(isHerAgent({ session: { header: { cwd: 'D:\\work\\my-project' } } }, her), false)
  // 拿不到 cwd 时一律不放行（宁可漏收窄，也不误伤别人的会话）
  assert.equal(isHerAgent({}, her), false)
  assert.equal(isHerAgent({ session: {} }, her), false)
})

test('只有她的 agent 被收窄，别人的会话一个都不碰', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', log: () => {} })

  const hers = fakeAgent('C:\\her-home')
  const mine = fakeAgent('D:\\work\\my-project')

  ctx.emit('agent/created', { agent: mine.agent })
  assert.equal(mine.calls.length, 0, '别人的会话不该被限制')

  ctx.emit('agent/created', { agent: hers.agent })
  assert.equal(hers.calls.length, 1, '她这条应该被限制一次')
  assert.deepEqual(hers.calls[0].allow, [...HER_TOOLS], '只写 allow，不在清单里的一律挡掉')
  assert.equal(hers.calls[0].deny, undefined, '不用 deny：宿主将来新增工具时 allow 会自动挡住它')
})

test('额外放行会并进 allow，且去重', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search', 'web_search', ' read_image '], log: () => {} })
  const hers = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: hers.agent })
  const allow = hers.calls[0].allow
  assert.ok(allow.includes('web_search'), '用户填的额外放行要生效')
  assert.equal(allow.filter((x) => x === 'web_search').length, 1, '同一名字不许重复')
  assert.equal(allow.filter((x) => x === 'read_image').length, 1, '原本就在清单里的不该被重复追加')
})

test('挂上了才算数：结论里 applied 必须 > 0', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })
  // 注册阶段：还没轮到任何 agent，不能说"已收窄"
  assert.equal(seen.applied, 0)
  assert.equal(seen.why, 'registered')

  ctx.emit('agent/created', { agent: fakeAgent('C:\\h').agent })
  assert.equal(seen.applied, 1, '真挂上之后 applied 要变成 1')
  assert.equal(seen.why, 'applied')
  assert.equal(seen.failed, '')
})

test('宿主不认 restrict 时必须报红，不许静默降级成“全部工具”', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  // 没有 restrict 方法的老版本宿主
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h', { withRestrict: false }).agent })
  assert.equal(seen.ok, false)
  assert.match(seen.failed, /restrict/)
})

test('restrict 抛错（名字不存在/作用域不对）不会硬清空工具面：先延后、最终如实报 deferred', async () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {}, retryMs: 5, retryMax: 2 })

  const bad = fakeAgent('C:\\h')
  bad.agent.ctx.tools.restrict = () => { throw new Error('unknown tool: growth_commit') }
  ctx.emit('agent/created', { agent: bad.agent })

  // 0.6.1 起：restrict 抛错不再进「失败」也不按交集硬收，而是先挂着 guard、延后重试。
  assert.equal(seen.why, 'registered', '注册阶段的回执')
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(seen.why, 'deferred', '一直收不上就如实报 deferred，不能假装成功')
  assert.equal(seen.applied, 0)
  assert.equal(bad.guards.length, 1, '兜底守卫必须已经挂上')
})

test('关掉开关就一个都不动', () => {
  const ctx = fakeCtx()
  const off = registerToolRestrict(ctx, { herDir: 'C:\\h', enabled: false, log: () => {} })
  assert.equal(ctx.count('agent/created'), 0, '关掉时不该挂监听')
  assert.equal(typeof off, 'function')
  assert.equal(readRestrictState().why, 'disabled')
})

test('describeRestrict 的三种说法不能混', () => {
  assert.match(describeRestrict({ applied: 1 }), /已收窄/)
  assert.match(describeRestrict({ applied: 0 }), /等她的会话下一次启动/)
  assert.match(describeRestrict({ applied: 0, failed: 'requires a scoped context' }), /没挂上/)
  assert.doesNotMatch(describeRestrict({ applied: 0, failed: 'requires a scoped context' }), /已收窄/)
})

// ---------------------------------------------------------------------------
// 兜底守卫（guard）
//
// 为什么单独测：restrict 挡不住「注册在 agent 自己作用域里」的工具——宿主源码里
// own 层不经过 admits()。实测漏出来的就是 `subagent`，她可以借它派生一个拥有
// 全部工具的子 agent，等于一条现成的逃生通道。所以必须有一道 guard 在**执行时**拦。
// ---------------------------------------------------------------------------

test('guard 会拦住名单外的工具，放行名单内的', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })

  assert.equal(a.guards.length, 1, '应该挂了一道 guard')
  const guard = a.guards[0]

  // 名单内：返回 undefined = 放行
  assert.equal(guard({ name: 'growth_commit' }), undefined)
  assert.equal(guard({ name: 'read_image' }), undefined)

  // 名单外：返回一句拒绝（不能是 undefined，也不能是 true）
  const denied = guard({ name: 'subagent' })
  assert.equal(typeof denied, 'string')
  assert.ok(denied.length > 0)

  // 拒绝话术里不许出现系统词汇——她要以为是自己做不了，不是以为被管理员拦了
  assert.doesNotMatch(denied, /权限|禁止|违规|不允许|没有授权/)
})

test('她自己 scope 里的工具挡不住这件事必须被记下（guard 缺席也不能算失败）', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  // 老宿主：有 restrict、没有 guard
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h', { withGuard: false }).agent })

  assert.equal(seen.why, 'applied', 'restrict 挂上就是挂上了，不能因为缺 guard 就说没生效')
  assert.equal(seen.applied, 1)
  assert.equal(seen.guard, false, '但要如实记下没有兜底守卫')
})

test('guard 自己抛错也不许把 restrict 判成失败', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  const a = fakeAgent('C:\\h')
  a.agent.ctx.tools.guard = () => { throw new Error('guard not supported in this scope') }
  ctx.emit('agent/created', { agent: a.agent })

  assert.equal(seen.why, 'applied')
  assert.equal(seen.applied, 1)
  assert.equal(seen.guard, false)
})

test('restrict 因「名字还没登记」抛错时：先不收窄，等登记齐了再收（0.6.1）', async () => {
  // 2026-10-27 另一台真机（0.6.0）：宿主还没登记她的 6 个工具，旧实现拿报错里的
  // 已知名单取交集、只收窄了 1 个 —— 那条会话从此调 bili_look 报 unknown tool，
  // 她回答「我没法浏览 B 站」。restrict 只能减不能加，所以名字没齐时必须先不收。
  const ctx = fakeCtx()
  const say = []
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: (m) => say.push(m), retryMs: 5, retryMax: 5 })

  const calls = []
  let first = true
  const guards = []
  let names = new Set(['read_image']) // 宿主此刻只认得 1 个
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: names }),
        restrict: (filter) => {
          calls.push(filter)
          if (first) {
            first = false
            if (filter.allow.some((n) => !names.has(n))) {
              throw new Error('tools.restrict() names unknown global tool "growth_commit"; known global tools: read_image')
            }
          }
          return () => {}
        },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(calls.length, 1, '第一次先按完整清单试一把')
  assert.equal(guards.length, 1, '兜底守卫要先挂上（不依赖名字表）')
  assert.ok(say.some((m) => m.includes('延后')), '要如实说这次先不收窄')

  // 宿主随后把她的工具登记齐了
  names = new Set([...HER_TOOLS])
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(calls.length, 2, '登记齐之后应该再收一次')
  assert.deepEqual(calls[1].allow, [...HER_TOOLS], '收窄用的是完整清单，不是交集')
})

test('工具名一直登记不齐：不收窄，但兜底守卫仍然在（挡住 subagent）', async () => {
  const ctx = fakeCtx()
  const seen = []
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {}, onResult: (r) => seen.push(r), retryMs: 5, retryMax: 2 })
  const guards = []
  const agent = {
    session: { header: { cwd: 'C:\\h' } },
    ctx: {
      effect: () => {},
      tools: {
        view: () => ({ restrictableNames: new Set(['read_image']) }),
        restrict: () => { throw new Error('boom') },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(guards.length, 1, 'restrict 挂了，guard 也必须在')
  assert.equal(guards[0]({ name: 'subagent' }), '这件事我做不到。', '挡不住名字就靠执行时拦')
  assert.equal(guards[0]({ name: 'her_recall' }), undefined)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(seen.at(-1).why, 'deferred', '如实报「这次没挂上」，不能假装成功')
  assert.equal(seen.at(-1).applied, 0)
})
