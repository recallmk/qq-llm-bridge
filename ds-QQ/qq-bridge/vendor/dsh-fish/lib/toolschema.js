/**
 * toolschema.js —— 把「简写参数 DSL」翻成**标准 JSON Schema**
 *
 * 为什么需要这个文件（2026-10-23 真机踩到的坑）：
 *   插件里的工具原本写成简写 DSL：
 *     parameters: { what: { type:'string', required:true } }
 *   本地看很舒服，但 `@deepseek-ai/dsh-tools` 在插件进程里**解析不到**
 *   （MODULE_NOT_FOUND，它由宿主运行时内部提供），于是 defineTool 的
 *   try/catch 兜底成 `spec => spec`，简写就这么原封不动发给了 provider。
 *   provider 侧报：
 *     Invalid schema for function 'bili_look':
 *     schema must be a JSON Schema of 'type: "object"', got 'type: null'
 *   结果：她的每一次唤醒都在第一步就失败，报告里显示「她今天什么都没说」——
 *   一个被错误伪装成性格的假象。
 *
 *   官方工具（read / grep / present …）发出去的都是完整 JSON Schema：
 *     { type:'object', properties:{...}, required:[...] }
 *
 * 所以这里做转换：**注册时就把简写变成标准 JSON Schema**，不再赌宿主帮我们转。
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 单个属性：去掉 DSL 专有的 required，递归处理 items / properties / enum */
function prop(spec) {
  if (!isObj(spec)) return { type: 'string' }
  const out = {}
  for (const [k, v] of Object.entries(spec)) {
    if (k === 'required') continue // DSL 专有，交给根级的 required 数组
    if (k === 'items') out.items = prop(v)
    else if (k === 'properties') {
      out.properties = {}
      for (const [pk, pv] of Object.entries(v ?? {})) out.properties[pk] = prop(pv)
    } else out[k] = v
  }
  if (!out.type) out.type = 'string'
  return out
}

/**
 * @param {object} dsl 简写参数表：{ 参数名: { type, required?, ... } }
 * @returns {object} 标准 JSON Schema
 */
export function toJsonSchema(dsl) {
  // 已经是标准形态就原样返回（幂等，重复调用不会坏）
  if (isObj(dsl) && dsl.type === 'object' && isObj(dsl.properties)) return dsl

  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(isObj(dsl) ? dsl : {})) {
    properties[name] = prop(spec)
    if (isObj(spec) && spec.required === true) required.push(name)
  }
  return {
    type: 'object',
    properties,
    // provider 侧对"必填"只认根级 required 数组，属性上的 required:true 会被忽略
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}
