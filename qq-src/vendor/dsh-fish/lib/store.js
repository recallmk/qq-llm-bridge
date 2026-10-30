/**
 * store.js —— 状态库读写（只追加，不改写）
 *
 * 目录结构（~/.dsh-fish）：
 *   events.jsonl   事件流，一行一条，永远只追加
 *   state.json     派生快照（可随时由 events.jsonl 重算删除，不是真相源）
 *   owner.json     主人身份（mid / 昵称 / cookie），0644→0600
 *   diary/YYYY-MM-DD.md   她的日记（可见性由设置决定）
 *   out/YYYY-MM-DD.md     刷站报告
 *
 * 铁律：state.json 是**派生品**。任何「改 state 就当改了她」的写法都不允许。
 *       rebuild() 必须能从 events.jsonl 完全复原，这条由 test 守住。
 *
 * API 全部 async：原子写用「写 tmp → rename」，避免断电留半行。
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { validateEvent, EVENT_SCHEMA_VERSION } from './schema.js'

export function rootDir() {
  return process.env.DSH_FISH_HOME || join(homedir(), '.dsh-fish')
}

export function paths(root = rootDir()) {
  return {
    root,
    events: join(root, 'events.jsonl'),
    state: join(root, 'state.json'),
    owner: join(root, 'owner.json'),
    config: join(root, 'config.json'),
    diaryDir: join(root, 'diary'),
    outDir: join(root, 'out'),
    // 她自己的房间：会话 cwd 指向这里，**不是 root**。
    // 理由（原实现与 B 文档矛盾，已修）：cwd=root 等于让她站在自己的
    // events.jsonl / config.json 旁边，`cat` 一下就读到全部历史与参数，
    // 而 N3「读自己的参数」本该是做不到的。给她一个空目录，状态库是它的**父目录**，
    // 仍需主动 `cd ..` 才能碰到——把「顺手看见」降级成「刻意去找」。
    //
    // 2026-10-23 P3 修订：这个目录**就是** `home/`，不再单独开 `her/`。
    // 原因：她的身份文件原本是 `home/AGENTS.md`（宿主每轮重读 cwd 链上的它），
    // 而 P3 之后她的会话 = home 工作区里那个「跟她说话」的会话，cwd 由宿主定在 `home/`。
    // 曾经 `her/` 与 `home/` 并存：主路径没问题（会话已存在，cwd 参数被忽略），
    // 但**降级路径**（宿主没有 workspaceRegistry，退回每天一个 `fish-talk-*` 会话）
    // 会把 cwd 定在 `her/` —— 那里没有身份文件，她一降级就**没有身份**。
    // 2026-10-25 起身份改走 systemPrompt.section（`home/她的身份.md` 只是落盘副本），
    // 不再依赖 cwd 链，但两个目录仍然合一——她住在自己的房间里这件事没变。
    // 两个目录合一，降级路径也落在有身份文件的房间里。
    herDir: join(root, 'home'),
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * 建好（并返回）她自己的工作目录。会话 cwd 用它，不用 root。
 * 幂等：目录已存在就直接返回。
 */
export async function ensureHer(root = rootDir()) {
  const dir = paths(root).herDir
  await ensureDir(dir)
  return dir
}

/** 原子写：写 tmp 再 rename（同盘 rename 是原子的） */
export async function writeAtomic(file, text, mode) {
  await ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  if (mode) await fs.chmod(tmp, mode).catch(() => {})
  await fs.rename(tmp, file)
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    // 坏文件不静默吞：留证据，返回 fallback 让上层能用
    if (err instanceof SyntaxError) {
      await fs.rename(file, `${file}.corrupt.${Date.now()}`).catch(() => {})
      return fallback
    }
    throw err
  }
}

/** 读全量事件流。坏行跳过但计数（不阻塞启动）。 */
export async function readEvents(root = rootDir()) {
  const p = paths(root).events
  let raw = ''
  try {
    raw = await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], skipped: 0 }
    throw err
  }
  const events = []
  let skipped = 0
  let legacy = 0
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const ev = JSON.parse(s)
      if (ev && typeof ev === 'object' && ev.id) {
        // v 字段是 2026-10-25 才加的：更早写的事件没有它，语义就是 v1。
        // 补上再进内存，下游就不用到处写 `ev.v ?? 1`。
        if (!Number.isInteger(ev.v)) {
          ev.v = EVENT_SCHEMA_VERSION
          legacy++
        }
        events.push(ev)
      } else skipped++
    } catch {
      skipped++
    }
  }
  // legacy：这批事件里有多少条是「加版本号之前」写的。备份与自检会显示它。
  return { events, skipped, legacy }
}

/**
 * 追加一条事件。唯一写入口。
 * @param {object} raw 未校验的事件
 * @param {object} ctx { day, stage, source }
 */
export async function appendEvent(raw, ctx = {}, root = rootDir()) {
  // 2026-10-27（0.5.8）：把「已有事件的 id 集合」交给校验器，让 refs 能真的查到。
  //
  // 只在写 revise / narration 时才去读一遍全量事件流——这两类才带 refs 义务，
  // 别的写（meta、diary、voice…）占绝大多数，不该为它们多读一次盘。
  // 读失败当「不知道有哪些 id」处理（knownIds = null），退化成 0.5.7 的只查非空，
  // 不能因为查不了就拒收她的正常写入。
  let knownIds = null
  const type = String(raw?.type ?? '')
  if (type === 'revise' || type === 'narration') {
    try {
      const { events } = await readEvents(root)
      knownIds = new Set(events.map((e) => e.id).filter(Boolean))
    } catch {
      knownIds = null
    }
  }
  const ev = validateEvent(raw, { ...ctx, knownIds })
  const p = paths(root)
  await ensureDir(p.root)
  await fs.appendFile(p.events, JSON.stringify(ev) + '\n', 'utf8')
  return ev
}

export async function writeState(state, root = rootDir()) {
  await writeAtomic(paths(root).state, JSON.stringify(state, null, 2))
}

/**
 * state.json 的真身：**从 events.jsonl 重算出来的派生快照**。
 *
 * 这个函数以前不存在，只有第 12 行注释声称"rebuild() 这条由 test 守住"，
 * 属于注释撒谎。补上它，并让 test/store.test.mjs 真的去做
 * 「删掉 state.json → rebuild → 内容与之前一致」的往返验证，
 * 才配得上「真相源只有事件流」这句话。
 *
 * @returns {Promise<object>} 写入的 state
 */
export async function rebuild(root = rootDir(), opts = {}) {
  const { events } = await readEvents(root)
  // 惰性 import：避免 store ←→ derive 的静态循环（derive 不依赖 store，但这样更稳）
  const { deriveSelf } = await import('./derive.js')
  const model = deriveSelf(events, opts)
  const state = {
    builtAt: new Date().toISOString(),
    events: events.length,
    day: model.day,
    stage: model.stage,
    stageName: model.stageName,
    stageForced: model.stageForced,
    name: model.name,
    beliefCount: model.beliefCount,
    absenceDays: model.absenceDays,
    // needs 落盘只是为了排查，观测台与提示词都不会返回它（N2）
    needs: model.needs,
  }
  await writeState(state, root)
  return state
}

/** 读派生快照。不存在/坏掉都返回 null（调用方应改用 rebuild）。 */
export async function readState(root = rootDir()) {
  return readJson(paths(root).state, null)
}

/** 主人身份：0600 权限（cookie 在里面） */
export async function readOwner(root = rootDir()) {
  return readJson(paths(root).owner, null)
}

export async function writeOwner(owner, root = rootDir()) {
  await writeAtomic(paths(root).owner, JSON.stringify(owner, null, 2), 0o600)
}

export async function readConfig(root = rootDir()) {
  return readJson(paths(root).config, null)
}

export async function writeConfig(cfg, root = rootDir()) {
  await writeAtomic(paths(root).config, JSON.stringify(cfg, null, 2))
}

/** 日记 / 报告落盘 */
export async function writeDaily(dirName, dateKey, text, root = rootDir()) {
  const file = join(paths(root)[dirName], `${dateKey}.md`)
  await writeAtomic(file, text)
  return file
}

export async function readDaily(dirName, dateKey, root = rootDir()) {
  try {
    return await fs.readFile(join(paths(root)[dirName], `${dateKey}.md`), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/** 列出已有的日记日期（新→旧） */
export async function listDiary(root = rootDir()) {
  try {
    const names = await fs.readdir(paths(root).diaryDir)
    return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)).sort().reverse()
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}
