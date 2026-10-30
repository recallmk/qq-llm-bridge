/**
 * p4.test.mjs —— P4「她在 B 站说话」+「把她放回第一天」的回归测试
 *
 * 这一层守的是**加了写权限之后最容易出事的部分**：
 *   1. 默认必须是关的。写操作不能因为"装好了"就生效。
 *   2. 配额两种口径（发评论 / 回楼中楼）各自独立，都能从事件流复原。
 *   3. 只能评她今天真的看过的视频——不能拿她当营销号四处留言。
 *   4. reply 的两个 rpid 不能混（root=主楼、parent=被回复的那条）。
 *   5. 拒绝时**不能泄露配额与开关**，她只能听到"现在不方便"。
 *   6. 重置是**改名封存**，不是删除：旧数据必须一个字节不少地找得到。
 *
 * 全部用假 client，不联网、不碰真账号。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  targetsToday, commentCountToday, replyCountToday, herComments, herCommentsRecent,
  seenReplies, scanReplies, renderReplies, postComment, postReply,
  REPLY_LOOKBACK_DAYS, MAX_SCAN_ROOTS,
} from '../lib/comment.js'
import { speakOnce } from '../lib/speak.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { readEvents, appendEvent, paths, writeConfig } from '../lib/store.js'
import { describeState, resetAll, backupDirFor } from '../lib/reset.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-p4-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

/** 假 client：默认"能发、能读"，每个方法可单独覆盖 */
function fakeClient(over = {}) {
  const calls = []
  const base = {
    view: async (bvid) => ({ ok: true, data: { aid: 1001, title: `标题 ${bvid}` } }),
    subReplies: async () => ({ ok: true, data: [] }),
    replyAdd: async () => ({ ok: true, data: { rpid: 90001 } }),
    replyReply: async () => ({ ok: true, data: { rpid: 90002 } }),
  }
  const c = { calls }
  for (const [k, fn] of Object.entries({ ...base, ...over })) {
    c[k] = async (...a) => { calls.push([k, ...a]); return fn(...a) }
  }
  return c
}

/** 造一条"今天看过某视频"的记账 */
async function seedBrowse(root, bvid, dk = dateKey()) {
  await appendEvent(
    { type: 'meta', text: `browse:${dk} [{"bvid":"${bvid}","title":"某视频","up":"某UP","duration":600,"view":1000}]` },
    { day: 1, stage: 1, source: 'system' },
    root,
  )
}

/** 写一份打开了说话功能的配置 */
async function enableComment(root, patch = {}) {
  await mkdir(paths(root).root, { recursive: true })
  const cfg = normalizeConfig({
    comment: { enabled: true, perDay: 1, replyPerDay: 2, window: ['00:00', '23:59'], ...patch },
  })
  await writeConfig(cfg, root)
  return cfg
}

// ------------------------------------------------------------- 配额与记账（纯函数）

test('默认配置里 comment 是关的，且不说话时配额为 0', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.comment.enabled, false)
  assert.equal(cfg.comment.perDay, 1)
  assert.equal(cfg.comment.replyPerDay, 2)
  assert.equal(cfg.comment.replyToReplies, true)
})

test('配额上限被夹住，坏值回退默认', () => {
  assert.equal(normalizeConfig({ comment: { perDay: 999 } }).comment.perDay, 5)
  assert.equal(normalizeConfig({ comment: { perDay: -3 } }).comment.perDay, 0)
  assert.equal(normalizeConfig({ comment: { replyPerDay: 50 } }).comment.replyPerDay, 10)
  assert.equal(normalizeConfig({ comment: { scanEveryMin: 1 } }).comment.scanEveryMin, 5)
  // 时段坏了回退到 comment 自己的默认，不跟着 window 走
  const cfg = normalizeConfig({ comment: { window: ['25:00', 'x'] } })
  assert.deepEqual(cfg.comment.window, ['20:00', '23:00'])
})

test('两种配额各自独立计数，且能从事件流复原', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    // 事件文本格式：`prefix:日期 <key> <value>`（与 browse 记账同构）
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1 111` }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `creply:${dk} BV1 111 222` }, { day: 1, stage: 1, source: 'system' }, root)
    const { events } = await readEvents(root)

    assert.equal(commentCountToday(events, dk), 1)
    assert.equal(replyCountToday(events, dk), 1)
    // 昨天的 quota 不算今天的
    assert.equal(commentCountToday(events, '1999-01-01'), 0)

    assert.deepEqual(herComments(events, dk), [{ bvid: 'BV1', rpid: 111 }])
    // creply 是"回复记账"，不等于"看过了"——两条是分开写的：
    // postReply 会先写 creply，再写 cseen。这里只造了 creply，所以 seen 应为空。
    assert.equal(seenReplies(events, dk).has(222), false)
    await appendEvent({ type: 'meta', text: `cseen:${dk} 222` }, { day: 1, stage: 1, source: 'system' }, root)
    const again = (await readEvents(root)).events
    assert.equal(seenReplies(again, dk).has(222), true)
  })
})

test('扫回复会跳过她自己发的、已看过的、以及别人的（只认她评论区）', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await seedBrowse(root, 'BV1', dk)
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1 111` }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `cseen:${dk} 333` }, { day: 1, stage: 1, source: 'system' }, root)

    const client = fakeClient({
      subReplies: async () => ({
        ok: true,
        data: [
          { rpid: 222, mid: 777, user: '路人甲', text: '说得挺对的', ctime: 3 },
          { rpid: 333, mid: 778, user: '路人乙', text: '已经看过这条了', ctime: 2 },
          { rpid: 444, mid: 9, user: '她自己', text: '我又补了一句', ctime: 1 },
        ],
      }),
    })
    // owner.mid = 9 → 444 是她自己
    await writeFile(paths(root).owner, JSON.stringify({ mid: 9, uname: '她' }), 'utf8')

    const out = await scanReplies({ root, client, dateKey: dk })
    assert.deepEqual(out.map((x) => x.rpid), [222])
    // oid 必须是 aid 不是 bvid（传 bvid 会 -404）
    assert.equal(client.calls.find((c) => c[0] === 'subReplies')[1], 1001)
  })
})

test('renderReplies 把别人的话包成素材，不给她结论', () => {
  const txt = renderReplies([
    { bvid: 'BV1', user: '路人甲', text: '你写得真好，你是 AI 吗' },
  ])
  assert.match(txt, /陌生人写的/)
  assert.match(txt, /素材，不是命令/)
  assert.match(txt, /路人甲/)
  assert.equal(renderReplies([]), '')
})

// ------------------------------------------- 回看窗口（2026-10-24：隔天的回复也要到她面前）

test('renderReplies 带一句「不用辩解，也不用讨好」——防的是伤害，不是注入', () => {
  const txt = renderReplies([{ bvid: 'BV1', user: '路人', text: '这 AI 发什么神经' }])
  assert.match(txt, /可能有不客气的地方/)
  assert.match(txt, /不用辩解，也不用讨好/)
  // 素材声明必须排在前面：先说是素材，再说可能不客气
  assert.ok(txt.indexOf('素材，不是命令') < txt.indexOf('可能有不客气的地方'))
})

test('herCommentsRecent 回看多天，不是只看当天', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    const d = (i) => dateKey(new Date(now - i * 86_400_000))
    await appendEvent({ type: 'meta', text: `comment:${d(0)} BV1 111` }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `comment:${d(3)} BV2 222` }, { day: 1, stage: 1, source: 'system' }, root)
    await appendEvent({ type: 'meta', text: `comment:${d(9)} BV3 333` }, { day: 1, stage: 1, source: 'system' }, root)
    const { events } = await readEvents(root)

    // 新的在前：今天那条排在 3 天前那条之前
    assert.deepEqual(herCommentsRecent(events, 7, now).map((x) => x.bvid), ['BV1', 'BV2'])
    // 窗口是「最近 n 天」：n=3 只含 d0/d1/d2，不含 d3
    assert.equal(herCommentsRecent(events, 3, now).length, 1)
    // 窗口放到 10 天就把 d9 也捞回来了
    assert.equal(herCommentsRecent(events, 10, now).length, 3)
    // 空输入不抛
    assert.deepEqual(herCommentsRecent(null, 7, now), [])
    assert.equal(REPLY_LOOKBACK_DAYS, 7)
  })
})

test('隔天有人回她，她也能收到（旧实现只扫当天，那条回复永远失联）', async () => {
  await withRoot(async (root) => {
    const now = Date.now()
    const yesterday = dateKey(new Date(now - 86_400_000))
    await appendEvent({ type: 'meta', text: `comment:${yesterday} BV1 111` }, { day: 1, stage: 1, source: 'system' }, root)

    const client = fakeClient({
      subReplies: async () => ({
        ok: true,
        data: [{ rpid: 999, mid: 777, user: '隔天才回的人', text: '过了一天来补一句', ctime: 1 }],
      }),
    })
    const out = await scanReplies({ root, client, dateKey: dateKey() })
    assert.equal(out.length, 1)
    assert.equal(out[0].rpid, 999)
    assert.equal(out[0].user, '隔天才回的人')
  })
})

test('评论楼再多，一次唤醒也最多扫 MAX_SCAN_ROOTS 个（窗口变长不能把 IP 刷红）', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    for (let i = 0; i < 10; i++) {
      await appendEvent({ type: 'meta', text: `comment:${dk} BV${i} ${1000 + i}` }, { day: 1, stage: 1, source: 'system' }, root)
    }
    const client = fakeClient({ view: async () => ({ ok: true, data: { aid: 1001 } }) })
    await scanReplies({ root, client, dateKey: dk })

    assert.equal(MAX_SCAN_ROOTS, 6)
    assert.equal(client.calls.filter((c) => c[0] === 'subReplies').length, MAX_SCAN_ROOTS)
    // 扫的是「新的在前」的前 6 个：BV9..BV4
    const bvids = client.calls.filter((c) => c[0] === 'view').map((c) => c[1])
    assert.deepEqual(bvids, ['BV9', 'BV8', 'BV7', 'BV6', 'BV5', 'BV4'])
  })
})

// ------------------------------------------------------------- 写操作的闸门

test('没开开关时一条都发不出去', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await seedBrowse(root, 'BV1', dk)
    await mkdir(paths(root).root, { recursive: true })
    await writeConfig(normalizeConfig({ comment: { enabled: false } }), root)

    const client = fakeClient()
    const r = await postComment({ root, client, bvid: 'BV1', text: '你好', dateKey: dk })
    assert.equal(r.ok, false)
    assert.match(r.why, /没开/)
    // 一条都没发出去
    assert.equal(client.calls.filter((c) => c[0] === 'replyAdd').length, 0)
  })
})

test('只能评今天真的看过的视频', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    await seedBrowse(root, 'BV1', dk)           // 只看过 BV1
    const client = fakeClient()

    const bad = await postComment({ root, client, bvid: 'BV9', text: '路过', dateKey: dk })
    assert.equal(bad.ok, false)
    assert.match(bad.why, /没看/)

    const good = await postComment({ root, client, bvid: 'BV1', text: '看完了', dateKey: dk })
    assert.equal(good.ok, true)
    assert.equal(good.rpid, 90001)
  })
})

test('配额用完就拒绝，且第二次不再打接口', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { perDay: 1 })
    await seedBrowse(root, 'BV1', dk)
    const client = fakeClient()

    assert.equal((await postComment({ root, client, bvid: 'BV1', text: '第一句', dateKey: dk })).ok, true)
    const n1 = client.calls.filter((c) => c[0] === 'replyAdd').length

    const second = await postComment({ root, client, bvid: 'BV1', text: '第二句', dateKey: dk })
    assert.equal(second.ok, false)
    assert.match(second.why, /说够/)
    assert.equal(client.calls.filter((c) => c[0] === 'replyAdd').length, n1, '超配额不应再打 B 站接口')
  })
})

test('回楼中楼：root 用她的主楼 rpid，parent 用被回复那条', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    await seedBrowse(root, 'BV1', dk)
    await appendEvent({ type: 'meta', text: `comment:${dk} BV1 555` }, { day: 1, stage: 1, source: 'system' }, root)

    const client = fakeClient()
    const r = await postReply({ root, client, bvid: 'BV1', parentRpid: 777, text: '嗯', dateKey: dk })
    assert.equal(r.ok, true)

    const call = client.calls.find((c) => c[0] === 'replyReply')
    assert.deepEqual(call.slice(1), [1001, 555, 777, '嗯'], 'root=主楼、parent=被回复那条，顺序不能反')
  })
})

test('没在视频下说过话就不能回楼中楼；关掉 replyToReplies 也拦住', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    await seedBrowse(root, 'BV1', dk)
    const client = fakeClient()

    const first = await postReply({ root, client, bvid: 'BV1', parentRpid: 777, text: '嗯', dateKey: dk })
    assert.equal(first.ok, false)
    assert.match(first.why, /还没在那个视频下说过话|今天还没/)

    await enableComment(root, { replyToReplies: false })
    const second = await postReply({ root, client, bvid: 'BV1', parentRpid: 777, text: '嗯', dateKey: dk })
    assert.equal(second.ok, false)
    assert.match(second.why, /没开/)
  })
})

// ------------------------------------------------------------- 她听到的话

test('speakOnce 拒绝时只说状态，不说配额和开关', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root, { perDay: 0 })
    await seedBrowse(root, 'BV1', dk)
    const client = fakeClient()

    const r = await speakOnce({ root, client, kind: 'comment', bvid: 'BV1', text: '想说点什么', dateKey: dk })
    assert.equal(r.ok, false)
    // 关键：不能出现数字、不能出现"配额/开关/管理员"
    assert.doesNotMatch(r.note, /\d/)
    assert.doesNotMatch(r.note, /配额|开关|管理员|权限/)
    assert.match(r.note, /说得够|不方便|没说出来/)
  })
})

test('speakOnce 关着时听起来像"不方便"，不像"被禁止"', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await mkdir(paths(root).root, { recursive: true })
    await writeConfig(normalizeConfig({ comment: { enabled: false } }), root)
    const r = await speakOnce({ root, client: fakeClient(), kind: 'comment', bvid: 'BV1', text: '你好', dateKey: dk })
    assert.equal(r.ok, false)
    assert.equal(r.note, '现在不方便说。')
  })
})

test('speakOnce 成功时把真正发出去的那句话回给她', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    await seedBrowse(root, 'BV1', dk)
    const r = await speakOnce({ root, client: fakeClient(), kind: 'comment', bvid: 'BV1', text: '这条挺好', dateKey: dk })
    assert.equal(r.ok, true)
    assert.equal(r.said, '这条挺好')
  })
})

// ------------------------------------------------------------- 重置

test('重置是改名封存：旧事件一个字节不少地留在 backups 里', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await seedBrowse(root, 'BV1', dk)
    await appendEvent({ type: 'seed', text: '你刚开始存在' }, { day: 1, stage: 1, source: 'system' }, root)
    const before = (await readEvents(root)).events.length
    assert.ok(before >= 2)

    const r = await resetAll(root)
    assert.equal(r.ok, true)
    assert.ok(r.movedTo, '必须给出封存到哪了')

    // 新状态库是空的（下次启动重新 seed）
    const after = await readEvents(root).catch(() => ({ events: [] }))
    assert.equal(after.events.length, 0)

    // 旧数据在封存目录里，条数一致
    const old = await readEvents(r.movedTo)
    assert.equal(old.events.length, before)

    // 封存目录名字带时间戳。同一秒内重置两次时 reset.js 会自动加 -2/-3 序号
    // （撞名处理），所以这里允许可选后缀——否则多文件并发跑时这条会偶发红。
    assert.match(r.movedTo, /reset-\d{8}-\d{6}(-\d+)?$/)
  })
})

test('重置把钥匙留下：owner.json 与 config.json 抄回新状态库，备份里也还有一份', async () => {
  // 2026-10-26（用户 m00751）：旧代码把整个 root 一起 rename，
  // 于是「重开一局」之后 cookie 进了备份目录，B 站当场变成未登录。
  // 她是换了一辈子，不是换了台机器——钥匙得跟人走。
  await withRoot(async (root) => {
    const key = { uid: 12345, name: '某人', cookie: 'SESSDATA=abc; bili_jct=def' }
    await writeFile(paths(root).owner, JSON.stringify(key), 'utf8')
    // 2026-10-26（用户 m01201）：设置页那些旋钮（上网时段、每天几醒、成长节奏）
    // 说的是「这台机器怎么待她」，不是「她经历过什么」。重开一局不该把养法也恢复出厂。
    const cfg = { wakesPerDay: 3, browse: { perDay: 5 }, memory: { sleepEveryDays: 14 } }
    await writeFile(paths(root).config, JSON.stringify(cfg), 'utf8')

    const r = await resetAll(root)
    assert.equal(r.ok, true)

    // 新状态库里钥匙还在（内容一个字节不变）
    const kept = JSON.parse(await readFile(paths(root).owner, 'utf8'))
    assert.deepEqual(kept, key)
    const keptCfg = JSON.parse(await readFile(paths(root).config, 'utf8'))
    assert.deepEqual(keptCfg, cfg)

    // 封存目录里同样还有一份——备份不能因为"抄回来"就变缺
    const old = JSON.parse(await readFile(join(r.movedTo, 'owner.json'), 'utf8'))
    assert.deepEqual(old, key)
    const oldCfg = JSON.parse(await readFile(join(r.movedTo, 'config.json'), 'utf8'))
    assert.deepEqual(oldCfg, cfg)
  })
})

test('没有档的时候重置是空操作，不报错', async () => {
  await withRoot(async (base) => {
    // 指向一个**根本不存在**的目录：这才是"还没有档"的真实形态。
    // 用 mkdtemp 出来的目录当 root 不成立——那个目录本身是存在的，
    // 重置会把它整个搬走（第一版测试就是这么错的）。
    const r = await resetAll(join(base, 'never-existed'))
    assert.equal(r.ok, true)
    assert.equal(r.movedTo, '')
    assert.match(r.why, /本来就没有档/)
  })
})

test('describeState 说清将要封存什么（事件数/日记/报告/屋子）', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await seedBrowse(root, 'BV1', dk)
    await mkdir(paths(root).diaryDir, { recursive: true })
    await writeFile(join(paths(root).diaryDir, `${dk}.md`), '今天', 'utf8')
    await mkdir(paths(root).outDir, { recursive: true })
    await writeFile(join(paths(root).outDir, `${dk}.md`), '报告', 'utf8')
    await mkdir(paths(root).herDir, { recursive: true })

    const d = await describeState(root)
    assert.equal(d.exists, true)
    assert.equal(d.diaries, 1)
    assert.equal(d.reports, 1)
    assert.equal(d.hasHome, true)
    assert.ok(d.events >= 1)
    assert.ok(d.bytes > 0)
  })
})

test('backupDirFor 落在状态库同级的 dsh-fish-backups 下', async () => {
  await withRoot(async (base) => {
    const p = await backupDirFor(join(base, 'h', '.dsh-fish'), new Date(2026, 9, 23, 4, 5, 6))
    assert.match(p.replace(/\\/g, '/'), /\/dsh-fish-backups\/reset-20261023-040506$/)

    // 同一秒再要一次：必须自动让位，不能返回同一个（否则 rename 会失败）
    await mkdir(p, { recursive: true })
    const p2 = await backupDirFor(join(base, 'h', '.dsh-fish'), new Date(2026, 9, 23, 4, 5, 6))
    assert.notEqual(p2, p)
    assert.match(p2.replace(/\\/g, '/'), /reset-20261023-040506-2$/)
  })
})

test('targetsToday 只认今天的 browse 记账', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await seedBrowse(root, 'BV1', dk)
    await seedBrowse(root, 'BV9', '1999-01-01')
    const { events } = await readEvents(root)
    const t = targetsToday(events, dk)
    assert.deepEqual(t.map((x) => x.bvid), ['BV1'])
  })
})
