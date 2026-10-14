import { describe, expect, it } from "vitest";
import { buildPillLabel, buildPillTooltip, contextLevel, emptyUsageTotals, formatCost, formatPercent, formatTokens, sessionCacheHitRate } from "./format";

describe("formatTokens", () => {
  it("matches Pi's footer formatting", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(972)).toBe("972");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(45_000)).toBe("45k");
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(12_345_678)).toBe("12M");
  });
});

describe("formatCost", () => {
  it("keeps Pi's three decimals and adds room below a cent", () => {
    expect(formatCost(0)).toBe("$0.000");
    expect(formatCost(0.0042)).toBe("$0.0042");
    expect(formatCost(0.4213)).toBe("$0.421");
    expect(formatCost(12.3456)).toBe("$12.346");
  });
});

describe("formatPercent", () => {
  it("hides decimals once the value is large", () => {
    expect(formatPercent(null)).toBe("?");
    expect(formatPercent(8.24)).toBe("8.2");
    expect(formatPercent(38.11)).toBe("38");
  });
});

describe("buildPillLabel", () => {
  const totals = { input: 12_300, output: 4500, cacheRead: 1_200_000, cacheWrite: 0, reasoning: 900, cost: 0 };
  const ok = { status: "ok" as const, totals, estimatedCost: 0.4214 };

  it("shows session total tokens and the official-price cost estimate", () => {
    expect(buildPillLabel(ok)).toBe("1.2M · $0.421");
  });

  it("falls back to Pi's recorded cost and drops the cost when there is none", () => {
    expect(buildPillLabel({ ...ok, estimatedCost: 0, totals: { ...totals, cost: 0.2 } })).toBe("1.2M · $0.200");
    expect(buildPillLabel({ ...ok, estimatedCost: 0 })).toBe("1.2M");
  });

  it("reports unresolved and failing states without numbers", () => {
    expect(buildPillLabel({ ...ok, status: "no_session" })).toBe("—");
    expect(buildPillLabel({ ...ok, status: "error" })).toBe("读取失败");
    expect(buildPillLabel({ ...ok, status: "not_pi" })).toBe("非 Pi");
  });
});

describe("buildPillTooltip", () => {
  const totals = { input: 12_300, output: 4500, cacheRead: 1_200_000, cacheWrite: 0, reasoning: 900, cost: 0 };
  const ok = { status: "ok" as const, totals, estimatedCost: 0.4214 };

  it("spells out the token split, cost source and cache hit rate", () => {
    expect(buildPillTooltip(ok)).toBe("Pi 用量 · 总 token 1.2M（↑12k ↓4.5k 缓存读 1.2M） · 花费 $0.421（官方价估算） · 缓存命中 99.0%");
  });

  it("surfaces the failure reason instead of a generic line", () => {
    expect(buildPillTooltip({ ...ok, status: "error", error: "EACCES" })).toBe("Pi 用量 · 读取失败：EACCES");
    expect(buildPillTooltip({ ...ok, status: "error" })).toBe("Pi 用量 · 读取失败");
  });

  it("names the provider that has no Pi usage and the missing session", () => {
    expect(buildPillTooltip({ ...ok, status: "not_pi", provider: "codex" })).toBe("Pi 用量 · 当前代理使用 codex provider，不统计 Pi 用量");
    expect(buildPillTooltip({ ...ok, status: "no_session" })).toBe("Pi 用量 · 暂无活动会话");
  });
});

describe("contextLevel", () => {
  it("uses Pi's 70% / 90% thresholds", () => {
    expect([null, 50, 70, 70.1, 90, 90.1].map(contextLevel)).toEqual(["unknown", "ok", "ok", "warn", "warn", "danger"]);
  });
});

describe("sessionCacheHitRate", () => {
  it("weighs every prompt token sent in the session", () => {
    expect(
      sessionCacheHitRate({ input: 180_704, output: 69_842, cacheRead: 7_964_160, cacheWrite: 0, reasoning: 0, cost: 0 }),
    ).toBeCloseTo(97.78, 2);
  });

  it("is null before any prompt tokens exist", () => {
    expect(sessionCacheHitRate(emptyUsageTotals())).toBeNull();
  });
});
