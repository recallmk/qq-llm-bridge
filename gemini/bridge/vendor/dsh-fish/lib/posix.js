/**
 * posix.js —— 交给模型的路径一律写成正斜杠。
 *
 * 2026-10-26 实测（用户报「图片无法预览」）：同一张图
 *   `![x](C:\Users\me\.dsh-fish\media\a.png)` → 显示「图片无法预览」
 *   `![x](C:/Users/me/.dsh-fish/media/a.png)` → 正常显示
 * 宿主渲染 markdown 图片时会把路径拼进 `/api/file?path=`，反斜杠在那一层取不到文件。
 * 她照抄工具给的路径，所以工具就得给正斜杠。
 *
 * 只用于**写进文本/交给模型**的路径；内部读写文件继续用 node:path。
 */

export function slashed(p) {
  return String(p ?? '').replace(/\\/g, '/')
}
