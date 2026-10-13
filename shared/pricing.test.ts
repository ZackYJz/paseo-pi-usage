import { describe, expect, it } from "vitest";
import { estimateCostForModel, priceForModel } from "./pricing";

describe("priceForModel", () => {
  it("maps provider-prefixed ids and relay renames onto official prices", () => {
    expect(priceForModel("aliyun/qwen3.8-max")?.input).toBe(2);
    expect(priceForModel("anthropic/claude-opus-5.5")?.output).toBe(20);
    expect(priceForModel("claude-opus-5-5")?.cacheRead).toBe(0.2);
    expect(priceForModel("apiyi/claude-opus-5-thinking")?.input).toBe(5);
    expect(priceForModel("apimart/apimart-5.6-sol")?.input).toBe(4);
    expect(priceForModel("qingyi/gpt-5.6-luna")?.input).toBe(0.2);
    expect(priceForModel("rh/deepseek/deepseek-v4.1-flash")?.input).toBe(0.3);
    expect(priceForModel("rh-claude/anthropic/claude-opus-5.5")?.cacheWrite).toBe(5);
  });

  it("returns null for models outside the table", () => {
    expect(priceForModel("some-relay/mystery-model")).toBeNull();
    expect(priceForModel(null)).toBeNull();
  });
});

describe("estimateCostForModel", () => {
  it("prices each bucket per million tokens and ignores reasoning", () => {
    const usage = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 100_000, reasoning: 999_999 };
    // claude-opus-5: 5 / 25 / 0.5 / 6.25
    expect(estimateCostForModel("apiyi/claude-opus-5", usage)).toBeCloseTo(5 + 12.5 + 1 + 0.625, 10);
  });

  it("estimates zero for unpriced models", () => {
    expect(estimateCostForModel("some-relay/mystery-model", { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 })).toBe(0);
  });
});
