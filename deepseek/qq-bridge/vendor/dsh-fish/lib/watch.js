/**
 * watch.js —— 工具 `bili_watch`：她要「看画面」的时候用这个
 *
 * 为什么不塞进 bili_look 自动做：抽一次帧要十秒左右、还要占额度。
 * 她翻列表时看四条视频就自动抽四次，既慢又浪费。**让她自己决定哪条值得看画面**，
 * 这也正好是「自主」这个维度唯一的可验证载体——跟当初给她 bili_look 是同一个理由。
 */

import { readEvents, appendEvent, rootDir } from './store.js'
import { loadConfig, dateKey } from './settings.js'
import { grabFrames } from './video.js'

import { defineTool } from './tool.js'
import { slashed } from './posix.js'

/** 今天已经看过几条（只数成功的，失败不占额度） */
export function watchedToday(events, dk) {
  const key = `watched:${dk}`
  return (events ?? []).filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key)).length
}

export function registerWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_watch',
      description:
        '看一条视频的画面。会把整条视频里取几张截图拼成一张图存下来，告诉你文件在哪，' +
        '你用 read_image 打开它就能看见画面了。取画面要花十几秒，所以别每条都看，' +
        '挑你真的想知道"画面里是什么"的那条。不用它也可以。',
      // 用完整 JSON Schema（不是简写 DSL）：工具参数必须是根级 type:object，
      // 否则 provider 直接拒 "schema must be a JSON Schema of 'type: object'"。
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: '哪条视频（形如 BV1xx411c7mD）。' },
        },
        required: ['bvid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '拼好的图在哪（用 read_image 读它）' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名是 (args, value)
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : `这次没看成：${out.note}` }],
      },
      async execute(args) {
        const bvid = String(args?.bvid ?? '').trim()
        const { config } = await loadConfig(root)
        if (!config?.browse?.enabled) return { ok: false, path: '', text: '', note: '现在打不开。' }
        if (config?.video?.enabled === false) return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
          return { ok: false, path: '', text: '', note: '这不是一个视频号。' }
        }

        const ev = await readEvents(root).catch(() => ({ events: [] }))
        const dk = dateKey()
        const cap = Math.max(0, Number(config?.video?.perDay ?? 2))
        // 额度用完只说"不想看了"，不报数字——她不该知道有个计数器在管她（N2）
        if (watchedToday(ev.events, dk) >= cap) {
          return { ok: false, path: '', text: '', note: '今天不想再看画面了。' }
        }

        const r = await grabFrames({ bvid, root, frames: config?.video?.frames })
        if (!r.ok) return { ok: false, path: '', text: '', note: r.why }

        await appendEvent(
          { type: 'meta', text: `watched:${dk} ${bvid}` },
          { source: 'system' },
          root,
        ).catch(() => {})

        // 路径一律给正斜杠：宿主渲染 markdown 图片时会拿路径拼 /api/file，
        // C:\... 这种反斜杠写法在客户端解析后取不到文件，图片就显示成「无法预览」
        // （2026-10-26 实测：同一张图 C:\ 版失败、C:/ 版正常）。
        const posix = slashed(r.path)
        return {
          ok: true,
          path: posix,
          text: [
            `《${r.title || bvid}》的画面，我取了几张拼成一张图放在这儿：`,
            posix,
            '用 read_image 读它就能看见。要在回复里贴这张图，路径就照抄上面这一行——用正斜杠。',
          ].join('\n'),
          note: '',
        }
      },
    }),
  )
}
