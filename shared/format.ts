/**
 * Number formatting shared by the daemon handlers and the app UI.
 *
 * `formatTokens` mirrors `formatTokens()` in Pi's
 * `modes/interactive/components/footer.js` so the Paseo pill and the Pi status
 * bar never disagree about the same number.
 */

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Pi's footer prints `$` + cost.toFixed(3); keep that, plus more room below a cent. */
export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.000";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

/**
 * Share of every prompt token sent this session that was served from cache:
 * ΣcacheRead / Σ(input + cacheRead + cacheWrite). Complements Pi's footer, which
 * only reports the most recent call's hit rate.
 */
export function sessionCacheHitRate(totals: UsageTotals): number | null {
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  if (promptTokens <= 0) return null;
  return (totals.cacheRead / promptTokens) * 100;
}

/**
 * Hover tooltip with the full-precision breakdown the pill label is too narrow
 * to carry (Paseo truncates pill labels at ~17 glyphs).
 */
export function buildPillTooltip(snapshot: PillLabelInput & { contextPercent: number | null }): string {
  if (snapshot.status !== "ok") return "Pi token 用量";
  const bits = [`↑${formatTokens(snapshot.totals.input)}`, `↓${formatTokens(snapshot.totals.output)}`];
  const rate = sessionCacheHitRate(snapshot.totals);
  if (rate !== null) bits.push(`缓存命中 ${rate.toFixed(1)}%`);
  if (snapshot.totals.cost > 0) bits.push(formatCost(snapshot.totals.cost));
  if (snapshot.contextPercent !== null) bits.push(`上下文 ${formatPercent(snapshot.contextPercent)}%`);
  return `Pi token 用量 · ${bits.join(" ")}`;
}

export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "?";
  return percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
}

export interface PillLabelInput {
  status: "ok" | "no_session" | "not_pi" | "error";
  totals: UsageTotals;
}

/**
 * One-line status text for the composer pill: ↑input ↓output, session-wide cache
 * hit rate, cost. Paseo truncates long pill labels, so the remaining breakdown
 * (cache writes, reasoning, context) lives in the panel.
 */
export function buildPillLabel(snapshot: PillLabelInput): string {
  if (snapshot.status === "error") return "读取失败";
  if (snapshot.status === "not_pi") return "非 Pi";
  if (snapshot.status !== "ok") return "—";

  const parts = [`↑${formatTokens(snapshot.totals.input)}`, `↓${formatTokens(snapshot.totals.output)}`];
  const rate = sessionCacheHitRate(snapshot.totals);
  // Bare percent: the pill's host-imposed width budget is ~15 glyphs; the tooltip
  // spells out that this is the session-wide cache hit rate.
  if (rate !== null && rate > 0) parts.push(`${Math.round(rate)}%`);
  if (snapshot.totals.cost > 0) parts.push(formatCost(snapshot.totals.cost));
  return parts.join(" ");
}
