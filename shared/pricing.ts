/**
 * Official API list prices (USD per 1M tokens) for the models this Pi install
 * connects to, researched 2026-09-28 from each vendor's official pricing page
 * and cross-checked against Pi's bundled first-party model catalog
 * (pi-ai `providers/*.json`, which mirrors those same pages):
 *
 * - claude-opus-5 / claude-opus-5.5: platform.claude.com pricing table
 *   (Opus 5.5 cache read is 5% of input; 5m cache write $5/MTok).
 * - gpt-5.6-sol / gpt-5.6-luna: OpenAI list price, base tier. Sol has a
 *   >272k-input tier (8/30/0.8/10) that this table deliberately ignores.
 * - grok-4.5 / grok-4.6: xAI list price.
 * - deepseek-v4-pro / deepseek-v4-flash: api-docs.deepseek.com peak prices
 *   (off-peak window is exactly half). V4.1-Flash serves `deepseek-v4-flash`
 *   and bills at the Flash price, so both ids share one entry.
 * - glm-5.2 / glm-5.3: Z.ai list price.
 * - qwen3.8-max: Alibaba Model Studio list price; cacheRead = implicit cache
 *   hit, cacheWrite = explicit cache creation.
 * - gemini-3.8-flash: Google list price (implicit caching, no write charge).
 * - kimi-k3: Moonshot list price.
 *
 * Relay providers (yunwu, qingyi, apimart, apiyi, rh, …) bill their own rates;
 * this table intentionally answers "what would these tokens cost at the
 * vendor's official API price", which is what the panel displays.
 *
 * Reasoning tokens are not priced separately: every vendor bills thinking as
 * output tokens, and Pi's `usage.reasoning` is a subset of `usage.output`
 * (see pi-ai's anthropic-messages / openai-completions usage mapping).
 *
 * To maintain: edit `MODEL_PRICES` and, for relay renames, `PRICE_RULES`.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
  "deepseek-v4-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
  "qwen3.8-max": { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
  "kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
};

/**
 * Relay rename → canonical price key.
 *
 * Order matters and is significant: the first match wins, so every entry whose
 * pattern is a prefix of a longer variant must come first (`opus-5[.-]5` before
 * `opus-5`, `grok-4[.-]6` before `grok-4[.-]5`, `deepseek-v4[.-]1-flash` and
 * `deepseek-v4-pro` before `deepseek-v4-flash`). Append new versions above the
 * family they extend, never below it.
 */
const PRICE_RULES: Array<[RegExp, string]> = [
  [/opus-5[.-]5/, "claude-opus-5.5"],
  [/opus-5/, "claude-opus-5"],
  [/5[.-]6-sol/, "gpt-5.6-sol"],
  [/5[.-]6-luna/, "gpt-5.6-luna"],
  [/grok-4[.-]6/, "grok-4.6"],
  [/grok-4[.-]5/, "grok-4.5"],
  [/deepseek-v4[.-]1-flash/, "deepseek-v4-flash"],
  [/deepseek-v4-pro/, "deepseek-v4-pro"],
  [/deepseek-v4-flash/, "deepseek-v4-flash"],
  [/glm-5[.-]3/, "glm-5.3"],
  [/glm-5[.-]2/, "glm-5.2"],
  [/qwen3[.-]8-max/, "qwen3.8-max"],
  [/gemini-3[.-]8-flash/, "gemini-3.8-flash"],
  [/kimi-k3/, "kimi-k3"],
];

/** Null when the model is not in the table; callers then estimate $0. */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const id = model.toLowerCase().split("/").pop() ?? "";
  for (const [pattern, key] of PRICE_RULES) {
    if (pattern.test(id)) return MODEL_PRICES[key];
  }
  return null;
}

export interface PricedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function estimateCost(price: ModelPrice | null, usage: PricedUsage): number {
  if (!price) return 0;
  return (
    (usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * price.cacheRead +
      usage.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

export function estimateCostForModel(model: string | null | undefined, usage: PricedUsage): number {
  return estimateCost(priceForModel(model), usage);
}
