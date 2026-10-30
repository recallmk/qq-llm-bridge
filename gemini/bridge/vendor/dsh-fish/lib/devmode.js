/**
 * devmode.js —— 「本机测试版」开关（2026-10-26，用户 m00928）
 *
 * 为什么要有这个东西：用户要求「让她去刷 B 站」这个按钮**只在本机的测试版出现**，
 * 公开正式版不带它——那是他用来验证「她到底能不能刷」的探针，不是给她用的功能。
 *
 * 判据刻意做成**文件**而不是设置项：
 *   1. 设置项会进设置页，用户在正式版里也能看见、能打开——那就等于带出去了；
 *   2. 文件不需要改代码、不需要环境变量、不需要重启，删掉即消失；
 *   3. `.dev` 跟着状态库走，重开一局（resetAll）会被 `CARRIED` 一起带过去，
 *      否则测一半重置一次按钮就没了。
 *
 * 注意：**只有界面用它**。服务端的 /wake?focus=browse 不设防——它本来就是个
 * 手动唤醒，谁点都是「多叫醒一次」，没有比定时器更大的权力。
 */
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { rootDir } from './store.js'

/** @returns {Promise<boolean>} 本机是否开启了测试版按钮 */
export async function devMode(root = rootDir()) {
  if (process.env.DSH_FISH_DEV === '1') return true
  try {
    await fs.access(join(root, '.dev'))
    return true
  } catch {
    return false
  }
}
