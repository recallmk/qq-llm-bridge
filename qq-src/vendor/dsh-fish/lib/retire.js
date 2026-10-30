/**
 * retire.js —— 重置时把宿主侧那间「屋子」也一起收起来（2026-10-25 用户报告）
 *
 * 为什么需要它：
 *   reset.js 只搬 `~/.dsh-fish/`。侧栏那条会话的记录不在状态库里——它在宿主的
 *   `~/.dsh/storages/workspace.json` 和会话目录下。于是用户点了「重开一局」之后，
 *   工作区、旧对话原样留着，重启 DSH 也不变（宿主的注册表压根没被碰过）。
 *
 * 宿主的 API 里**没有删除会话**的入口（已核实：只有 archive / unarchive / pin），
 * 所以这里的语义只能是**归档**：旧会话从工作区主列表移进「已归档」，文件一个字节不删。
 *   工作区本身**不删**——她下次启动还要住这间屋子，删了会变成孤儿会话。
 *
 * 失败不抛：这是启动链路之外的用户动作，归档不完全时把原因带回去给设置页显示，
 * 但不能让她连「重开」都做不成。
 */

import { resolve, join } from 'node:path'
import { rootDir, paths, readJson } from './store.js'

function pathKey(p) {
  return resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase()
}

/** 读她屋子里的 home.json（记录着 wsId / sessionId）。文件不在就返回 null。 */
export async function readHomeRecord(root = rootDir()) {
  try {
    return await readJson(join(paths(root).root, 'home.json'), null)
  } catch {
    return null
  }
}

/**
 * 把「大肥鱼的家」里登记过的会话全部归档。
 *
 * @param {object} ctx  宿主上下文（cordis）
 * @param {object} opts
 * @param {string} opts.root     状态库根目录
 * @param {object} [opts.home]   提前读好的 home.json（resetAll 之后文件已经不在了，调用方要先读）
 * @param {(m:string)=>void} [opts.log]
 * @returns {Promise<{ok:boolean, archived:string[], failed:string[], why:string}>}
 */
export async function retireHomeSessions(ctx, { root = rootDir(), home = null, log } = {}) {
  const out = { ok: false, archived: [], failed: [], why: '' }
  const reg = ctx?.get?.('workspaceRegistry') ?? ctx?.workspaceRegistry

  // 宿主没这个服务（老版本 / 精简内核）时明确说不，而不是假装清空了。
  if (typeof reg?.archiveSession !== 'function') {
    out.why = '宿主没有 workspaceRegistry.archiveSession，宿主侧没动'
    return out
  }

  const record = home ?? (await readHomeRecord(root))
  const dir = join(paths(root).root, 'home')

  // 先按 home.json 记的 wsId 找；找不到再按路径找（用户可能手动改过标题/重建过工作区）。
  let ws = null
  try {
    const list = typeof reg.list === 'function' ? reg.list() : []
    const wantId = String(record?.wsId ?? '')
    ws = (wantId
      ? list.find((w) => w && String(w?.id ?? w?.workspaceId ?? '') === wantId)
      : null)
      ?? list.find((w) => w?.path && pathKey(w.path) === pathKey(dir))
      ?? null
  } catch { /* list 不可用就退到下面只归档 home.json 里那一条 */ }

  const ids = new Set()
  if (Array.isArray(ws?.sessionIds)) {
    for (const id of ws.sessionIds) if (id) ids.add(String(id))
  }
  if (record?.sessionId) ids.add(String(record.sessionId))

  if (!ids.size) {
    out.ok = true
    out.why = '宿主侧没有登记她的会话'
    return out
  }

  for (const sid of ids) {
    try {
      await reg.archiveSession(sid, { stopActivity: true })
      out.archived.push(sid)
      continue
    } catch (err) {
      // 第二种调用形状：老宿主只收 sessionId。第二种也失败才算失败。
      try {
        await reg.archiveSession(sid)
        out.archived.push(sid)
        continue
      } catch (err2) {
        out.failed.push(sid)
        log?.(`归档会话 ${sid} 没成功：${String(err2?.message ?? err2 ?? err).slice(0, 120)}`)
      }
    }
  }

  out.ok = out.failed.length === 0
  if (!out.ok) out.why = `${out.archived.length} 条已归档，${out.failed.length} 条没归档成（下次仍可能看得见）`
  return out
}
