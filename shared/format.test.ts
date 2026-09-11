import { describe, expect, it } from "vitest";
import { buildPillLabel, buildPillTooltip, emptyUsageTotals, formatCost, formatPercent, formatTokens, sessionCacheHitRate } from "./format";

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
  const totals = { input: 12_300, output: 4500, cacheRead: 1_200_000, cacheWrite: 0, reasoning: 900, cost: 0.421 };

  it("shows input, output, session cache hit rate and cost", () => {
    expect(buildPillLabel({ status: "ok", totals })).toBe("↑12k ↓4.5k 99% $0.421");
  });

  it("drops the hit rate when nothing was cached and the cost when it is zero", () => {
    expect(buildPillLabel({ status: "ok", totals: { ...totals, cacheRead: 0, cacheWrite: 0, cost: 0 } })).toBe(
      "↑12k ↓4.5k",
    );
    expect(buildPillLabel({ status: "ok", totals: { ...totals, cost: 0 } })).toBe("↑12k ↓4.5k 99%");
  });

  it("reports unresolved and failing states without numbers", () => {
    expect(buildPillLabel({ status: "no_session", totals: emptyUsageTotals() })).toBe("—");
    expect(buildPillLabel({ status: "error", totals: emptyUsageTotals() })).toBe("读取失败");
  });
});

describe("buildPillTooltip", () => {
  const totals = { input: 12_300, output: 4500, cacheRead: 1_200_000, cacheWrite: 0, reasoning: 900, cost: 0.421 };

  it("carries the full-precision breakdown the label cannot", () => {
    expect(buildPillTooltip({ status: "ok", totals, contextPercent: 38.1 })).toBe(
      "Pi token 用量 · ↑12k ↓4.5k 缓存命中 99.0% $0.421 上下文 38%",
    );
  });

  it("stays generic when the session is not readable", () => {
    expect(buildPillTooltip({ status: "error", totals: emptyUsageTotals(), contextPercent: null })).toBe(
      "Pi token 用量",
    );
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
