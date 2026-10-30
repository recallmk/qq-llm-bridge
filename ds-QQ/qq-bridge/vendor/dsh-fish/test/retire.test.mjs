/**
 * retire.test.mjs —— 重置时把宿主侧那间屋子一起收起来（2026-10-25）
 *
 * 用户报的问题：重置大肥鱼之后，侧栏工作区里还能看到旧对话，重启 DSH 也一样。
 * 根因是 resetAll 只搬 ~/.dsh-fish，宿主注册表不在里面。
 *
 * 这一组守四件事：
 *   ① 工作区里登记的会话 + home.json 那一票，全部交给宿主的 archiveSession（去重）；
 *   ② 宿主没有这个服务时**明确说不**，不假装清空了；
 *   ③ 老宿主只接受一个参数时能降级调用；
 *   ④ 单条归档失败只记进 failed，绝不抛——重置不能因此做不成。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { retireHomeSessions, readHomeRecord } from '../lib/retire.js'

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'fish-retire-'))
}

function fakeCtx({ ws = null, strict = false, throwIds = [], log = [] } = {}) {
  const calls = []
  const reg = {
    list: () => (ws ? [ws] : []),
    archiveSession: async (sessionId, opts) => {
      calls.push({ sessionId, opts })
      if (strict && opts !== undefined) throw new TypeError('takes 1 argument')
      if (throwIds.includes(sessionId)) throw new Error('session-active')
      return ['whatever']
    },
  }
  return { calls, log, ctx: { get: (k) => (k === 'workspaceRegistry' ? reg : null) } }
}

const HOME = { wsId: 'ws-1', sessionId: 's-1', title: '跟大肥鱼说话' }

test('归档工作区里全部会话 + home.json 那条，且去重', async () => {
  const root = await tmpRoot()
  try {
    await writeFile(join(root, 'home.json'), JSON.stringify(HOME), 'utf8')
    const ws = { id: 'ws-1', path: join(root, 'home'), sessionIds: ['s-1', 's-2', 's-3'] }
    const { ctx, calls } = fakeCtx({ ws })
    const r = await retireHomeSessions(ctx, { root })
    assert.equal(r.ok, true)
    assert.deepEqual([...r.archived].sort(), ['s-1', 's-2', 's-3'])
    assert.equal(calls.length, 3)
    assert.equal(calls[0].opts.stopActivity, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('home.json 已被 resetAll 搬走时，用调用方提前读好的记录', async () => {
  const root = await tmpRoot()
  try {
    const ws = { id: 'ws-9', path: join(root, 'home'), sessionIds: ['s-9'] }
    const { ctx, calls } = fakeCtx({ ws })
    const r = await retireHomeSessions(ctx, { root, home: { wsId: 'ws-9', sessionId: 's-7' } })
    assert.equal(r.ok, true)
    assert.deepEqual([...r.archived].sort(), ['s-7', 's-9'])
    assert.equal(calls.length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('宿主没有 workspaceRegistry：明确降级，不假装成功', async () => {
  const root = await tmpRoot()
  try {
    const r = await retireHomeSessions({ get: () => null }, { root })
    assert.equal(r.ok, false)
    assert.match(r.why, /workspaceRegistry/)
    assert.deepEqual(r.archived, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('宿主侧没登记会话时算成功（无事可做）', async () => {
  const root = await tmpRoot()
  try {
    const { ctx, calls } = fakeCtx({ ws: null })
    const r = await retireHomeSessions(ctx, { root })
    assert.equal(r.ok, true)
    assert.equal(r.archived.length, 0)
    assert.equal(calls.length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('老宿主只收一个参数：降级调用成功', async () => {
  const root = await tmpRoot()
  try {
    await writeFile(join(root, 'home.json'), JSON.stringify(HOME), 'utf8')
    const ws = { id: 'ws-1', path: join(root, 'home'), sessionIds: ['s-1'] }
    const { ctx, calls } = fakeCtx({ ws, strict: true })
    const r = await retireHomeSessions(ctx, { root })
    assert.equal(r.ok, true)
    assert.deepEqual(r.archived, ['s-1'])
    assert.equal(calls.length, 2)
    assert.equal(calls[1].opts, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('单条归档失败只记 failed，不抛', async () => {
  const root = await tmpRoot()
  try {
    await writeFile(join(root, 'home.json'), JSON.stringify(HOME), 'utf8')
    const ws = { id: 'ws-1', path: join(root, 'home'), sessionIds: ['s-1', 's-2'] }
    const { ctx, log } = fakeCtx({ ws, throwIds: ['s-2'] })
    const r = await retireHomeSessions(ctx, { root, log: (m) => log.push(m) })
    assert.equal(r.ok, false)
    assert.deepEqual(r.archived, ['s-1'])
    assert.deepEqual(r.failed, ['s-2'])
    assert.match(r.why, /没归档成/)
    assert.equal(log.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('readHomeRecord：文件不存在返回 null', async () => {
  const root = await tmpRoot()
  try {
    assert.equal(await readHomeRecord(root), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})
