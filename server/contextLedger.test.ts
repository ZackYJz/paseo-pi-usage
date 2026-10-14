import { describe, expect, it } from "vitest";
import type { ContextBreakdown, ContextCategory } from "../shared/usage";
import { ContextLedger, estimateTextTokens } from "./contextLedger";

/** `n` tokens of ASCII text under the chars/4 estimate. */
const t = (n: number) => "x".repeat(n * 4);

let seq = 0;
const lastIds = new WeakMap<ContextLedger, string>();
/** Appends entries as Pi does: each one a child of the previous unless `parentId` says otherwise. */
function feed(ledger: ContextLedger, entries: Array<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const id = (entry.id as string | undefined) ?? `e${(seq += 1)}`;
    const parentId = "parentId" in entry ? entry.parentId : (lastIds.get(ledger) ?? null);
    ledger.add({ ...entry, id, parentId });
    lastIds.set(ledger, id);
    ids.push(id);
  }
  return ids;
}

const system = (sections: Record<string, string | null>, toolsAdded: Array<Record<string, unknown>> = [], toolsRemoved: string[] = []) => ({
  type: "message",
  message: { role: "system", content: "", sections, toolsAdded, toolsRemoved: toolsRemoved.map((name) => ({ name })) },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (content: Array<Record<string, unknown>>) => ({ type: "message", message: { role: "assistant", content } });
const toolResult = (toolName: string, text: string) => ({ type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }] } });

function byKey(breakdown: ContextBreakdown | null): Record<ContextCategory, number> {
  expect(breakdown).not.toBeNull();
  return Object.fromEntries(breakdown!.categories.map((category) => [category.key, category.tokens])) as Record<ContextCategory, number>;
}

/** A tool declaration whose JSON is exactly `n` estimated tokens. */
function tool(name: string, n: number) {
  const base = JSON.stringify({ name, description: "" }).length;
  return { name, description: "d".repeat(n * 4 - base) };
}

const prompt = () =>
  system(
    {
      preamble: t(100),
      rules: t(200),
      skills: `<skills>${"<skill>a</skill>".repeat(3)}${t(500)}</skills>`.slice(0, 2000),
      project_context: `<project_instructions path="/a">`.padEnd(200, "x"),
      tools: t(30),
      mcp_servers: t(10),
    },
    [tool("bash", 300), tool("read", 200), tool("mcp__paseo__list", 40)],
  );

describe("estimateTextTokens", () => {
  it("counts CJK characters as one token and the rest at four characters per token", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("上下文")).toBe(3);
    expect(estimateTextTokens("上下文abcd")).toBe(4);
  });
});

describe("ContextLedger", () => {
  it("is null until the session declares its prompt", () => {
    const ledger = new ContextLedger();
    feed(ledger, [user(t(10))]);
    expect(ledger.breakdown(null)).toBeNull();
  });

  it("splits the prompt by section and tools into system and MCP", () => {
    const ledger = new ContextLedger();
    feed(ledger, [prompt(), user(t(10))]);
    const breakdown = ledger.breakdown(null)!;
    const tokens = byKey(breakdown);
    expect(tokens.systemPrompt).toBe(300);
    expect(tokens.systemTools).toBe(30 + 300 + 200);
    expect(tokens.mcp).toBe(10 + 40);
    expect(tokens.skills).toBe(500);
    expect(tokens.messages).toBe(10);
    expect(breakdown.calibrated).toBe(false);
    const counts = Object.fromEntries(breakdown.categories.map((category) => [category.key, category.count]));
    expect(counts).toMatchObject({ systemTools: 2, mcp: 1, skills: 3, projectContext: 1, systemPrompt: null });
  });

  it("attributes tool calls and results per tool and keeps thinking apart", () => {
    const ledger = new ContextLedger();
    feed(ledger, [
      prompt(),
      user(t(10)),
      assistant([{ type: "thinking", thinking: t(40) }, { type: "text", text: t(5) }, { type: "toolCall", name: "bash", arguments: { c: t(20) } }]),
      toolResult("bash", t(200)),
      toolResult("read", t(50)),
    ]);
    const breakdown = ledger.breakdown(null)!;
    const tokens = byKey(breakdown);
    expect(tokens.messages).toBe(15);
    expect(tokens.thinking).toBe(40);
    expect(tokens.toolCalls).toBeGreaterThan(270);
    expect(breakdown.topTools.map((entry) => entry.name)).toEqual(["bash", "read"]);
    expect(breakdown.topTools[1]!.tokens).toBe(50);
  });

  it("replays section patches, removals and tool changes", () => {
    const ledger = new ContextLedger();
    feed(ledger, [prompt(), user(t(10)), system({ skills: null, rules: t(20) }, [tool("write", 100)], ["bash"])]);
    const tokens = byKey(ledger.breakdown(null));
    expect(tokens.skills).toBe(0);
    expect(tokens.systemPrompt).toBe(100 + 20);
    expect(tokens.systemTools).toBe(30 + 200 + 100);
  });

  it("follows the active branch only", () => {
    const ledger = new ContextLedger();
    const [, root] = feed(ledger, [prompt(), user(t(10))]);
    feed(ledger, [{ ...toolResult("bash", t(500)), parentId: root }]);
    // Navigating back to the user message and continuing abandons the tool result.
    feed(ledger, [{ ...user(t(20)), parentId: root }]);
    const tokens = byKey(ledger.breakdown(null));
    expect(tokens.toolCalls).toBe(0);
    expect(tokens.messages).toBe(30);
  });

  it("keeps the newest compaction's summary and kept range, and its prompt checkpoint", () => {
    const ledger = new ContextLedger();
    const ids = feed(ledger, [prompt(), user(t(100)), toolResult("bash", t(400)), user(t(30))]);
    feed(ledger, [
      {
        type: "compaction",
        summary: t(60),
        firstKeptEntryId: ids[3],
        systemMessage: { role: "system", content: "", sections: { preamble: t(80) }, toolsAdded: [tool("read", 200)] },
      },
      user(t(5)),
    ]);
    const tokens = byKey(ledger.breakdown(null));
    expect(tokens.messages).toBe(60 + 30 + 5);
    expect(tokens.toolCalls).toBe(0);
    expect(tokens.systemPrompt).toBe(80);
    expect(tokens.systemTools).toBe(200);
    expect(tokens.skills).toBe(0);
  });

  it("applies context edits: null drops the entry, a replacement swaps its content", () => {
    const ledger = new ContextLedger();
    const ids = feed(ledger, [prompt(), user(t(10)), toolResult("bash", t(400)), toolResult("read", t(300))]);
    feed(ledger, [
      { type: "context_edit", targetId: ids[2], replacement: null },
      { type: "context_edit", targetId: ids[3], replacement: { content: t(7) } },
    ]);
    const breakdown = ledger.breakdown(null)!;
    expect(byKey(breakdown).toolCalls).toBe(7);
    expect(breakdown.topTools).toEqual([{ name: "read", tokens: 7 }]);
  });

  describe("calibration against the measured request", () => {
    function session() {
      const ledger = new ContextLedger();
      const ids = feed(ledger, [
        prompt(),
        user(t(100)),
        assistant([{ type: "thinking", thinking: t(1000) }, { type: "toolCall", name: "bash", arguments: {} }]),
        toolResult("bash", t(900)),
      ]);
      return { ledger, anchor: ids[2]! };
    }
    // prompt() estimates to 300 + 500 + 50 + 530 + 50 = 1430 tokens of fixed overhead.
    const fixed = 1430;

    it("keeps the prompt as estimated and sums exactly to the measurement", () => {
      const { ledger, anchor } = session();
      const breakdown = ledger.breakdown({ id: anchor, tokens: 5000 })!;
      expect(breakdown.calibrated).toBe(true);
      expect(Math.abs(breakdown.total - 5000)).toBeLessThanOrEqual(4);
      expect(byKey(breakdown).systemTools).toBe(530);
    });

    it("gives thinking only what messages and tools leave over", () => {
      const { ledger, anchor } = session();
      // Messages and tools estimate to ~102 before the anchor; leave 400 more for thinking.
      const tokens = byKey(ledger.breakdown({ id: anchor, tokens: fixed + 102 + 400 }));
      expect(Math.abs(tokens.thinking - 400)).toBeLessThanOrEqual(2);
    });

    it("drops thinking when the measurement leaves no room for it (provider did not replay it)", () => {
      const { ledger, anchor } = session();
      const tokens = byKey(ledger.breakdown({ id: anchor, tokens: fixed + 90 }));
      expect(tokens.thinking).toBe(0);
      expect(tokens.messages + tokens.toolCalls).toBe(90);
    });

    it("reports content after the measured request as pending", () => {
      const { ledger, anchor } = session();
      const breakdown = ledger.breakdown({ id: anchor, tokens: 3000 })!;
      expect(breakdown.pendingTokens).toBe(900);
      expect(breakdown.topTools.every((entry) => entry.tokens < 900)).toBe(true);
    });

    it("falls back to raw estimates when the anchor is off the active branch", () => {
      const { ledger } = session();
      const breakdown = ledger.breakdown({ id: "elsewhere", tokens: 3000 })!;
      expect(breakdown.calibrated).toBe(false);
      expect(breakdown.pendingTokens).toBe(0);
      expect(byKey(breakdown).thinking).toBe(1000);
    });
  });
});
