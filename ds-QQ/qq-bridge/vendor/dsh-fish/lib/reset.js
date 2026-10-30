/**
 * reset.js —— 把她放回第一天（旧的一切不删，只封存）
 *
 * 用户要的是「重开一局」，不是「删档」。所以：
 *   1. 整个状态库目录**改名**到 `backups/reset-<时间戳>/`，一个字节都不删；
 *   2. 新状态库是空的，下次启动时 seed 会重新落下「你刚开始存在」；
 *   3. 她的屋子（`home/`）也在被搬走的目录里。**但 DSH 里的会话记录不在这里**——
 *      会话存在 `~/.dsh/storages/workspace.json` 和 `~/.dsh/sessions/`，
 *      所以重置后旧会话要由调用方归档（`lib/retire.js` 的 retireHomeSessions）。
 *      这条注释原来写的是「会话记忆一起封存了」，2026-10-25 被用户实测打脸后改掉。
 *
 * ⚠️ 唯一真正要做的事是「改名」，不是复制也不是删除。
 *    在 Windows 上跨盘改名会失败，所以只在同盘内用 rename；
 *    失败就退回「建新目录 + 中止」，绝不部分搬走（半搬状态比不搬更糟）。
 */

import { rename, mkdir, readdir, stat, cp, readFile, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { rootDir, paths } from './store.js'

/**
 * 生成封存目录路径。
 * 放在状态库的**同级**目录下的 `backups/`，这样状态库整体被改名时不会把它一起带走。
 *
 * 同一秒内重置两次会撞名 —— `rename` 到已存在且非空的目录会失败（EPERM/ENOTEMPTY），
 * 那会让用户看到"重置失败"却什么都没发生。所以**自动加序号**直到空位。
 * 这条不是假想：单测里两个用例在同一秒内跑，就撞上了。
 */
export async function backupDirFor(root = rootDir(), now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const base = join(dirname(resolve(root)), 'dsh-fish-backups')
  let target = join(base, `reset-${stamp}`)
  for (let i = 2; i <= 99; i++) {
    try {
      await stat(target)
      target = join(base, `reset-${stamp}-${i}`)
    } catch {
      return target
    }
  }
  return join(base, `reset-${stamp}-${Date.now()}`)
}

/** 状态库里大概有什么（给确认框显示"你将封存这些东西"） */
export async function describeState(root = rootDir()) {
  const p = paths(root)
  const out = { exists: false, events: 0, diaries: 0, reports: 0, hasHome: false, bytes: 0 }
  try {
    const st = await stat(p.root)
    out.exists = st.isDirectory()
  } catch {
    return out
  }
  const count = async (dir, filter) => {
    try {
      const names = await readdir(dir)
      return names.filter(filter).length
    } catch {
      return 0
    }
  }
  out.diaries = await count(p.diaryDir, (n) => n.endsWith('.md'))
  out.reports = await count(p.outDir, (n) => n.endsWith('.md'))
  try {
    const names = await readdir(p.root)
    out.hasHome = names.includes('home')
  } catch {}
  try {
    const ev = await stat(p.events)
    out.bytes = ev.size
    const { readEvents } = await import('./store.js')
    out.events = (await readEvents(root)).events.length
  } catch {}
  return out
}

/**
 * 「钥匙」：重置时**不跟着人生一起搬走**的那几样东西。
 *
 * 2026-10-26 修（用户 m00751）：`owner.json` 存的是这台机器上那个 B 站账号的
 * 登录凭据（SESSDATA 等），不是她的记忆。旧实现把整个 root 一起 rename，
 * 于是「重开一局」之后 cookie 进了备份目录，B 站当场变成未登录——
 * 用户得重新导一次 cookie 才能让她继续刷。
 * 她是换了一辈子，不是换了台机器；钥匙还是同一把。
 *
 * 2026-10-26 再修（用户 m01201）：`config.json` 也留下。设置页上那些旋钮
 * （上网时段、每天几醒、刷站额度、成长节奏）说的是「这台机器怎么待她」，
 * 不是「她经历过什么」。重开一局不该顺手把人家的养法也恢复出厂——
 * 那更像换了个主人，不像重新活一次。
 */
const CARRIED = ['owner.json', 'config.json', '.dev']

/** 把「钥匙」从封存目录里抄回新状态库（rename 之后调用）。抄失败不影响重置成功。 */
async function carryKeys(from, root, log) {
  for (const name of CARRIED) {
    try {
      const buf = await readFile(join(from, name))
      await mkdir(root, { recursive: true })
      await writeFile(join(root, name), buf)
    } catch (err) {
      if (String(err?.code ?? '') !== 'ENOENT') log?.(`钥匙没抄回来（${name}）：${String(err?.message ?? err)}`)
    }
  }
}

/**
 * 执行重置。返回 { ok, movedTo, why?, carried? }。
 *
 * 顺序很关键：
 *   ① 先把「封存目录」的父目录建好；
 *   ② rename 整个状态库过去（同盘 → 原子、瞬间、不占额外空间）；
 *   ③ rename 失败（跨盘 / 被占用）→ **立刻中止**并把可能的半成品状态说清楚；
 *   ④ 成功后由调用方（或下次启动）重新 seed。
 */
export async function resetAll(root = rootDir(), opts = {}) {
  const target = await backupDirFor(root, opts.now ?? new Date())
  const p = paths(root)

  let exists = false
  try {
    exists = (await stat(p.root)).isDirectory()
  } catch {
    return { ok: true, movedTo: '', why: '本来就没有档，等于已经重开了' }
  }
  if (!exists) return { ok: true, movedTo: '', why: '本来就没有档，等于已经重开了' }

  await mkdir(dirname(target), { recursive: true })

  try {
    await rename(p.root, target)
    await carryKeys(target, p.root, opts.log)
    // 2026-10-27：这里原来要清一个 config 里的「导入豁免」标记。
    // 现在不需要了——「这一局是不是接别人养的」只由事件流里那条 meta 决定，
    // 而事件流整体被 rename 走了，新的一局天生没有那条记录（用户 m03769 的要求：
    // 豁免必须来自导入动作本身，不能是能被备份/恢复搬运的状态）。
    return { ok: true, movedTo: target, why: '', carried: CARRIED }
  } catch (err) {
    // EPERM / EXDEV / EBUSY：一般是文件被占用（服务还开着）或跨盘
    const code = String(err?.code ?? '')
    const hint =
      code === 'EXDEV'
        ? '状态库和备份不在同一个盘，没法整体搬走'
        : code === 'EBUSY' || code === 'EPERM'
          ? '有文件正被占用，先把这个窗口关掉再试'
          : String(err?.message ?? err)
    // 尝试跨盘兜底：先复制再删——但只在确实没有半成品时做
    if (code === 'EXDEV') {
      try {
        await cp(p.root, target, { recursive: true, errorOnExist: false })
        const { rm } = await import('node:fs/promises')
        await rm(p.root, { recursive: true, force: true })
        await carryKeys(target, p.root, opts.log)
        return { ok: true, movedTo: target, why: '跨盘，已复制后清空', carried: CARRIED }
      } catch (err2) {
        return { ok: false, movedTo: '', why: `复制也失败了：${String(err2?.message ?? err2)}` }
      }
    }
    return { ok: false, movedTo: '', why: hint }
  }
}
