/**
 * 额度相关的纯函数，便于单独测试。
 */

/** ISO 周标识，例如 2026-W42 */
export function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil((((t - Date.UTC(y, 0, 1)) / 86_400_000) + 1) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

/**
 * 一轮对话的人民币成本。
 * @param {{inputTokens?:number, outputTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number}} u
 * @param {{cacheHit:number, cacheMiss:number, output:number}} price USD / 1M tokens
 * @param {number} usdCny 汇率
 */
export function costCny(u, price, usdCny) {
  if (!u) return 0;
  const usd = (
    (u.cacheReadTokens ?? 0) * price.cacheHit +
    (u.inputTokens ?? 0) * price.cacheMiss +
    (u.cacheWriteTokens ?? 0) * price.cacheMiss +
    (u.outputTokens ?? 0) * price.output
  ) / 1e6;
  return usd * usdCny;
}
