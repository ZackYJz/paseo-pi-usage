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

export function formatPercent(percent: number | null): string {
  if (percent === null || !Number.isFinite(percent)) return "?";
  return percent >= 10 ? percent.toFixed(0) : percent.toFixed(1);
}

/**
 * The one cost figure the UI shows: official-price estimate when the model is in
 * the price table, else whatever Pi recorded (relay channels often record 0).
 */
export function displayCost(snapshot: { estimatedCost: number; totals: { cost: number } }): number {
  return snapshot.estimatedCost > 0 ? snapshot.estimatedCost : snapshot.totals.cost;
}

/** Same thresholds as Pi's footer: above 70% warn, above 90% danger. */
export type ContextLevel = "unknown" | "ok" | "warn" | "danger";
export function contextLevel(percent: number | null): ContextLevel {
  if (percent === null || !Number.isFinite(percent)) return "unknown";
  return percent > 90 ? "danger" : percent > 70 ? "warn" : "ok";
}

export interface PillInput {
  status: "ok" | "no_session" | "not_pi" | "error";
  totals: UsageTotals;
  estimatedCost: number;
  provider?: string | null;
  error?: string | null;
}

/**
 * Pill label, about 15 glyphs wide: session-wide total tokens and cost. Context
 * use is left to Paseo's own composer meter; the popover still charts it.
 */
export function buildPillLabel(snapshot: PillInput): string {
  if (snapshot.status === "error") return "读取失败";
  if (snapshot.status === "not_pi") return "非 Pi";
  if (snapshot.status !== "ok") return "—";
  const tokens = formatTokens(snapshot.totals.input + snapshot.totals.output + snapshot.totals.cacheRead + snapshot.totals.cacheWrite);
  const cost = displayCost(snapshot);
  return cost > 0 ? `${tokens} · ${formatCost(cost)}` : tokens;
}

/** Hover tooltip: the full one-line summary the pill has no room for. */
export function buildPillTooltip(snapshot: PillInput): string {
  if (snapshot.status === "error") {
    return `Pi 用量 · ${snapshot.error ? `读取失败：${snapshot.error}` : "读取失败"}`;
  }
  if (snapshot.status === "not_pi") {
    return `Pi 用量 · 当前代理使用 ${snapshot.provider ?? "其他"} provider，不统计 Pi 用量`;
  }
  if (snapshot.status === "no_session") return "Pi 用量 · 暂无活动会话";
  const t = snapshot.totals;
  const bits = [`总 token ${formatTokens(t.input + t.output + t.cacheRead + t.cacheWrite)}（↑${formatTokens(t.input)} ↓${formatTokens(t.output)} 缓存读 ${formatTokens(t.cacheRead)}）`];
  const cost = displayCost(snapshot);
  if (cost > 0) bits.push(`花费 ${formatCost(cost)}${snapshot.estimatedCost > 0 ? "（官方价估算）" : ""}`);
  const rate = sessionCacheHitRate(t);
  if (rate !== null) bits.push(`缓存命中 ${rate.toFixed(1)}%`);
  return `Pi 用量 · ${bits.join(" · ")}`;
}
