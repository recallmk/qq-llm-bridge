/**
 * home.test.mjs —— 她的屋子（工作区 + 专属会话）与身份文件（P3 架构改造）
 *
 * 这一组守的是四件事：
 *   ① 宿主没有 workspaceRegistry 时**明确降级**，不假装建好了；
 *   ② 同一个路径重复 bootstrap 不会每次多一个会话（幂等，否则侧栏会堆一列重复会话）；
 *   ③ 她把会话归档/删了之后会重建，而不是永远指向一个空壳；
 *   ④ 身份文件（她屋子里的「她的身份.md」）内容对得上：有禁令、无路径、无数字、无字段名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureWorkspace,
  ensureTalkSession,
  bootstrapHome,
  homeStatus,
  ensureHomeDir,
  talkSessionId,
} from '../lib/home.js'
import { writeSelfDoc, selfDocPath, selfDocStatus } from '../lib/selfdoc.js'
import { appendEvent } from '../lib/store.js'
import { updateConfig } from '../lib/settings.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-home-'))
}

/** 假宿主：只有 workspaceRegistry + sessionController */
function fakeCtx({ hasRegistry = true, registry = {}, presetReject = false } = {}) {
  const created = []
  const renamed = []
  const sessions = new Map() // wsId -> { id, sessionIds: [], title }

  const reg = {
    list: () => (registry.list ? registry.list() : [...sessions.values()]),
    create: async (path, title) => {
      if (registry.create) return registry.create(path, title)
      const w = { id: `ws-${sessions.size + 1}`, path, title, sessionIds: [] }
      sessions.set(w.id, w)
      return w
    },
    get: (id) => sessions.get(id) ?? null,
  }

  const ctx = {
    sessionController: {
      create: async ({ workspaceId, sessionId, cwd, agentPreset }) => {
        created.push({ workspaceId, sessionId, cwd, agentPreset })
        if (presetReject && agentPreset) throw new Error('unknown preset')
        if (registry.createSession) return registry.createSession({ workspaceId, sessionId, cwd })
        const ws = sessions.get(workspaceId)
        const id = `ses-${created.length}`
        if (ws) ws.sessionIds.push(id)
        return { sessionId: id, ...(agentPreset ? { agentPreset } : {}) }
      },
      rename: async (arg) => { renamed.push(arg) },
    },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    get(key) {
      if (key === 'workspaceRegistry') return hasRegistry ? reg : null
      return ctx[key]
    },
  }
  return { ctx, created, renamed, sessions, reg }
}

test('宿主没有 workspaceRegistry：明确返回 ok:false，不假装成功', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx({ hasRegistry: false })
    const r = await bootstrapHome(ctx, { root })
    assert.equal(r.ok, false)
    assert.match(r.why, /workspaceRegistry/)
    // 屋子目录仍然建出来：身份文件得有地方落
    const dir = await ensureHomeDir(root)
    assert.ok((await stat(dir)).isDirectory())
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('建屋子：工作区指向 ~/.dsh-fish/home，会话挂进工作区并改标题', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created, renamed } = fakeCtx()
    const r = await bootstrapHome(ctx, { root })

    assert.equal(r.ok, true, r.why)
    assert.ok(r.wsId)
    assert.ok(r.sessionId)
    assert.equal(created.length, 1)
    assert.equal(created[0].workspaceId, r.wsId, '会话必须挂进工作区，否则侧栏看不见')
    assert.deepEqual(renamed.map((x) => x.title), ['跟大肥鱼说话'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('幂等：重复 bootstrap 不会再建一个会话', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    const b = await bootstrapHome(ctx, { root })

    assert.equal(a.sessionId, b.sessionId, '第二次必须复用同一个会话')
    assert.equal(b.reused, true)
    assert.equal(created.length, 1, '只应建过一次会话')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('她把会话归档了：下次启动重建一个新的', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions } = fakeCtx()
    const a = await bootstrapHome(ctx, { root })
    assert.equal(a.ok, true, a.why)

    // 模拟用户在侧栏归档它
    const ws = sessions.get(a.wsId)
    const oldId = ws.sessionIds[0]
    ws.sessionIds = []
    ctx.get('workspaceRegistry').archivedSessionIds = [oldId]

    const ses = await ensureTalkSession(ctx, { root, wsId: a.wsId })
    assert.equal(ses.ok, true, ses.why)
    assert.notEqual(ses.sessionId, oldId, '旧会话没了就得建新的')
    assert.equal(ses.reused, false)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('没有工作区 id 时说清楚原因，不抛', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const r = await ensureTalkSession(ctx, { root, wsId: '' })
    assert.equal(r.ok, false)
    assert.match(r.why, /工作区/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('同一路径不会建两个工作区（先查后建）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, sessions } = fakeCtx()
    const a = await ensureWorkspace(ctx, { root })
    const b = await ensureWorkspace(ctx, { root })
    assert.equal(a.wsId, b.wsId)
    assert.equal(sessions.size, 1)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---------- 身份文件 ----------

test('身份文件：有禁令、有工具说明，且不泄露任何路径/数字/字段名', async () => {
  const root = await tmpRoot()
  try {
    const seed = await appendEvent({ type: 'seed', text: '你不是助手。你刚开始存在。' }, { day: 1, stage: 1, source: 'system' }, root)
    assert.ok(seed.id)
    await appendEvent({ type: 'utterance', text: '我觉得他不该替我安排。' }, { day: 1, stage: 1, source: 'tool' }, root)

    const w = await writeSelfDoc(root)
    assert.equal(w.ok, true, w.why)
    assert.equal(w.changed, true)

    const md = await readFile(selfDocPath(root), 'utf8')
    assert.match(md, /## 你是谁/)
    assert.match(md, /## 不能做的/)
    assert.match(md, /撒娇/, '四条黑名单必须在场')
    assert.match(md, /growth_commit/)
    assert.match(md, /我觉得他不该替我安排/, '她说过的话要带进身份文件')

    // 硬约束：不能出现状态库路径、不能出现字段名、不能出现数值型 needs
    assert.equal(md.includes(root), false, '不能把状态库绝对路径写进去')
    assert.equal(md.includes('.dsh-fish'), false)
    assert.equal(md.includes('needs'), false)
    assert.equal(md.includes('events.jsonl'), false)
    assert.equal(md.includes('config.json'), false)
    assert.equal(/好感度\s*[:：]/.test(md), false, '不能出现好感度数字')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('身份文件幂等：内容没变就不重写（不触发宿主重复加载）', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
    const a = await writeSelfDoc(root)
    const b = await writeSelfDoc(root)
    assert.equal(a.changed, true)
    assert.equal(b.changed, false, '内容一样时不该重写')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('她写下新判断后，身份文件跟着变（changed:true）', async () => {
  const root = await tmpRoot()
  try {
    await appendEvent({ type: 'seed', text: '你不是助手。' }, { day: 1, stage: 1, source: 'system' }, root)
    const a = await writeSelfDoc(root)
    assert.equal(a.changed, true)

    await appendEvent({ type: 'utterance', text: '我想他大概是在试探我。' }, { day: 1, stage: 1, source: 'tool' }, root)
    const b = await writeSelfDoc(root)
    assert.equal(b.changed, true, '状态变了就应重写')
    const md = await readFile(selfDocPath(root), 'utf8')
    assert.match(md, /我想他大概是在试探我/)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('selfDocStatus：文件不存在时如实返回 exists:false', async () => {
  const root = await tmpRoot()
  try {
    const s = await selfDocStatus(root)
    assert.equal(s.exists, false)
    assert.equal(s.bytes, 0)
    await writeSelfDoc(root)
    const s2 = await selfDocStatus(root)
    assert.equal(s2.exists, true)
    assert.ok(s2.bytes > 100)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('homeStatus：home.json 不存在时返回空 id，不抛', async () => {
  const root = await tmpRoot()
  try {
    const h = await homeStatus(root)
    assert.equal(h.wsId, '')
    assert.equal(h.sessionId, '')
    assert.ok(h.dir.endsWith('home'))
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ------------------------------------------------- talkSessionId（2026-10-24 加）

test('talkSessionId：有屋子时返回屋子里那个会话', async () => {
  const root = await tmpRoot()
  try {
    const { ctx } = fakeCtx()
    const id = await talkSessionId(ctx, { root })
    assert.ok(id, '应当拿到会话 id')
    const h = await homeStatus(root)
    assert.equal(id, h.sessionId)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('talkSessionId：没有 workspaceRegistry 时交白卷，不建任何会话', async () => {
  const root = await tmpRoot()
  try {
    const notes = []
    const { ctx, created } = fakeCtx({ hasRegistry: false })
    const id = await talkSessionId(ctx, { root, log: (m) => notes.push(m) })
    assert.equal(id, '')
    assert.equal(created.length, 0, '一个会话都不该建')
    assert.ok(notes.some((n) => /屋子没接上/.test(n)), '要留一条人话日志，别静默')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('talkSessionId：记下的会话被归档了，会重建一次而不是原地报错', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, reg } = fakeCtx()
    const first = await talkSessionId(ctx, { root })
    assert.ok(first)

    // 模拟：那条会话在宿主侧被归档（判活口径看的是 registry.archivedSessionIds）
    reg.archivedSessionIds = [first]

    const second = await talkSessionId(ctx, { root })
    assert.ok(second, '应当重建出一条可用的会话')
    assert.notEqual(second, first, '重建的必须是新的那条')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---- 2026-10-24：preset 透传（工具面收窄的入口，宿主侧暂未生效，但线要接对）----

test('preset：建会话时真的提上去了，并记进 home.json', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, created } = fakeCtx()
    const r = await bootstrapHome(ctx, { root, preset: 'fish-home' })
    assert.equal(r.ok, true)
    assert.equal(created.length, 1)
    assert.equal(created[0].agentPreset, 'fish-home', 'create 时必须带上 agentPreset')
    assert.equal(r.preset, 'fish-home')
    const h = await homeStatus(root)
    assert.equal(h.preset, 'fish-home', 'homeStatus 要能读出实际用的是哪套组合')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('preset：宿主不认这套组合时回落建会话，但日志要说清楚（不静默降级）', async () => {
  const root = await tmpRoot()
  try {
    const notes = []
    const { ctx, created } = fakeCtx({ presetReject: true })
    const r = await bootstrapHome(ctx, { root, preset: 'fish-home', log: (m) => notes.push(m) })
    assert.equal(r.ok, true, '屋子还是要建起来')
    assert.equal(created.length, 2, '先试带 preset 的，再回落不带的那次')
    assert.equal(created[0].agentPreset, 'fish-home')
    assert.equal(created[1].agentPreset, undefined)
    assert.equal(r.preset, '', '实际没用上就得如实记空')
    assert.ok(notes.some((n) => /没被接受/.test(n)), '必须留一条日志说明为什么放宽了')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('preset：配置里写的那套会被 talkSessionId 读出来并传下去', async () => {
  const root = await tmpRoot()
  try {
    await updateConfig({ tools: { preset: 'fish-home', allow: [] } }, root)
    const { ctx, created } = fakeCtx()
    const id = await talkSessionId(ctx, { root })
    assert.ok(id)
    assert.equal(created[0].agentPreset, 'fish-home', '配置是唯一来源，建会话要按它来')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

// ---------- 老档改名（2026-10-25）----------

test('早先建的工作区叫「鱼」：用实体的 setTitle 改成「大肥鱼的家」', async () => {
  const root = await tmpRoot()
  try {
    const dir = await ensureHomeDir(root)
    const calls = []
    const entity = { id: 'ws-old', path: dir, title: '鱼', sessionIds: [] }
    entity.setTitle = async (t) => { entity.title = t; calls.push(t) }
    const ctx = { get: (k) => (k === 'workspaceRegistry' ? { list: () => [entity], create: async () => { throw new Error('不该新建') } } : null) }

    const r = await ensureWorkspace(ctx, { root })
    assert.equal(r.ok, true, r.why)
    assert.equal(r.wsId, 'ws-old')
    assert.equal(r.created, false, '已经存在就不算新建')
    assert.equal(r.renamed, true, '改成了要报出来')
    assert.equal(entity.title, '大肥鱼的家')
    assert.deepEqual(calls, ['大肥鱼的家'])
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('宿主没有改名接口时保持原名，不抛', async () => {
  const root = await tmpRoot()
  try {
    const dir = await ensureHomeDir(root)
    const entity = { id: 'ws-old', path: dir, title: '鱼', sessionIds: [] }
    const ctx = { get: (k) => (k === 'workspaceRegistry' ? { list: () => [entity], create: async () => entity } : null) }

    const r = await ensureWorkspace(ctx, { root })
    assert.equal(r.ok, true)
    assert.equal(r.renamed, false)
    assert.equal(entity.title, '鱼', '改不动就保持原名')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
})

test('观测台的 /home 现读工作区标题，不靠 home.json 的旧值', async () => {
  const src = await readFile(new URL('../lib/observe.js', import.meta.url), 'utf8')
  assert.match(src, /title: wsTitle/, '/home 要带标题')
  assert.match(src, /reg\?\.get\?\.\(h\.wsId\)\?\.title/, '标题要现读，不能记在 home.json 里')
})
