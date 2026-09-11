import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionFileReader, contextTokensOf } from "./sessionFile";

const tempDirs: string[] = [];

async function makeSessionFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-"));
  tempDirs.push(dir);
  const path = join(dir, "2026-09-11T08-01-59-655Z_01a08f7c.jsonl");
  await writeFile(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  return path;
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning = 0, cost = 0) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(model: string, provider: string, u: ReturnType<typeof usage>, stopReason = "toolUse", at = "2026-09-11T08:02:07.120Z") {
  return JSON.stringify({
    type: "message",
    id: `a-${Math.random().toString(36).slice(2)}`,
    timestamp: at,
    message: { role: "assistant", content: [], api: "openai-completions", provider, model, usage: u, stopReason },
  });
}

function toolResult(u: ReturnType<typeof usage>) {
  return JSON.stringify({
    type: "message",
    id: `t-${Math.random().toString(36).slice(2)}`,
    timestamp: "2026-09-11T08:02:09.000Z",
    message: { role: "toolResult", usage: u },
  });
}

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "01a08f7c-db66-7074-883f-fa168c7aea83",
  timestamp: "2026-09-11T08:01:59.655Z",
  cwd: "/home/user/pi-demo",
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("contextTokensOf", () => {
  it("prefers the native total and falls back to the bucket sum", () => {
    expect(contextTokensOf({ totalTokens: 24698, input: 1, output: 1 })).toBe(24698);
    expect(contextTokensOf({ input: 10, output: 5, cacheRead: 20, cacheWrite: 1 })).toBe(36);
  });
});

describe("PiSessionFileReader", () => {
  it("aggregates assistant, toolResult and compaction usage like Pi's footer", async () => {
    const path = await makeSessionFile([
      header,
      JSON.stringify({ type: "model_change", id: "m1", timestamp: "2026-09-11T08:02:00.751Z", provider: "aliyun", modelId: "qwen3.8-max" }),
      JSON.stringify({ type: "thinking_level_change", id: "t1", timestamp: "2026-09-11T08:02:00.751Z", thinkingLevel: "xhigh" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-09-11T08:02:00.983Z", message: { role: "user", content: [] } }),
      assistant("qwen3.8-max", "aliyun", usage(972, 174, 23552, 0, 98, 0.01)),
      toolResult(usage(0, 0, 0, 0, 0, 0.002)),
      assistant("qwen3.8-max", "aliyun", usage(1000, 200, 24000, 5, 50, 0.02), "end_turn", "2026-09-11T08:03:00.000Z"),
      JSON.stringify({ type: "compaction", id: "c1", timestamp: "2026-09-11T08:04:00.000Z", usage: usage(10, 20, 0, 0, 0, 0.003) }),
    ]);

    const reader = new PiSessionFileReader(path);
    await reader.refresh();

    const totals = reader.snapshot.totals;
    expect(totals.input).toBe(972 + 1000 + 10);
    expect(totals.output).toBe(174 + 200 + 20);
    expect(totals.cacheRead).toBe(23552 + 24000);
    expect(totals.cacheWrite).toBe(5);
    expect(totals.reasoning).toBe(98 + 50);
    expect(totals.cost).toBeCloseTo(0.01 + 0.002 + 0.02 + 0.003, 10);

    expect(reader.snapshot.calls).toBe(2);
    expect(reader.snapshot.userTurns).toBe(1);
    expect(reader.snapshot.compactions).toBe(1);
    expect(reader.snapshot.sessionId).toBe("01a08f7c-db66-7074-883f-fa168c7aea83");
    expect(reader.snapshot.cwd).toBe("/home/user/pi-demo");
    expect(reader.snapshot.startedAt).toBe("2026-09-11T08:01:59.655Z");
    expect(reader.snapshot.model).toBe("aliyun/qwen3.8-max");
    expect(reader.snapshot.thinkingLevel).toBe("xhigh");
    expect(reader.snapshot.lastActivityAt).toBe("2026-09-11T08:04:00.000Z");

    // Context is unknown right after a compaction, exactly like Pi's `?`.
    expect(reader.snapshot.contextStale).toBe(true);

    const models = reader.models;
    expect(models.find((entry) => entry.key === "aliyun/qwen3.8-max")?.tokens).toBe(972 + 174 + 23552 + 1000 + 200 + 24000 + 5);
    expect(models.find((entry) => entry.key === "Tools/summaries")?.tokens).toBe(10 + 20);
    expect(models.find((entry) => entry.key === "Tools/summaries")?.cost).toBeCloseTo(0.005, 10);
  });

  it("derives context size and cache hit rate from the newest usable assistant message", async () => {
    const path = await makeSessionFile([
      header,
      assistant("m", "p", usage(100, 50, 900, 0, 0, 0), "toolUse", "2026-09-11T08:02:00.000Z"),
      assistant("m", "p", usage(0, 0, 0, 0, 0, 0), "aborted", "2026-09-11T08:02:10.000Z"),
      assistant("m", "p", usage(200, 80, 1800, 0, 0, 0), "end_turn", "2026-09-11T08:02:20.000Z"),
    ]);

    const reader = new PiSessionFileReader(path);
    await reader.refresh();

    expect(reader.snapshot.contextUsedTokens).toBe(200 + 80 + 1800);
    expect(reader.snapshot.contextStale).toBe(false);
    expect(reader.snapshot.cacheHitRate).toBeCloseTo((1800 / 2000) * 100, 10);
    expect(reader.snapshot.calls).toBe(3);
  });

  it("counts appended lines exactly once across refreshes", async () => {
    const path = await makeSessionFile([header, assistant("m", "p", usage(10, 5, 100, 0, 0, 0.01))]);
    const reader = new PiSessionFileReader(path);
    await reader.refresh();
    expect(reader.snapshot.totalTokens).toBe(115);

    await reader.refresh();
    expect(reader.snapshot.totalTokens).toBe(115);
    expect(reader.snapshot.calls).toBe(1);

    await appendFile(path, assistant("m", "p", usage(20, 7, 200, 0, 0, 0.02)) + "\n", "utf8");
    await reader.refresh();

    expect(reader.snapshot.calls).toBe(2);
    expect(reader.snapshot.totalTokens).toBe(115 + 227);
    expect(reader.snapshot.totals.cost).toBeCloseTo(0.03, 10);
  });

  it("buffers a partially flushed trailing line until it completes", async () => {
    const path = await makeSessionFile([header]);
    const line = assistant("m", "p", usage(10, 5, 100, 0, 0, 0.01));
    await appendFile(path, line.slice(0, 40), "utf8");

    const reader = new PiSessionFileReader(path);
    await reader.refresh();
    expect(reader.snapshot.calls).toBe(0);

    await appendFile(path, line.slice(40) + "\n", "utf8");
    await reader.refresh();

    expect(reader.snapshot.calls).toBe(1);
    expect(reader.snapshot.totalTokens).toBe(115);
  });

  it("keeps multi-byte characters intact when a line is split across refreshes", async () => {
    const path = await makeSessionFile([header]);
    const line = JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: "2026-09-11T08:02:00.983Z",
      message: { role: "user", content: [{ type: "text", text: "统计 token 用量" }] },
    });
    const encoded = Buffer.from(line + "\n", "utf8");
    const splitAt = encoded.indexOf(Buffer.from("统", "utf8")) + 1; // cut inside a 3-byte character

    await appendFile(path, encoded.subarray(0, splitAt));
    const reader = new PiSessionFileReader(path);
    await reader.refresh();
    expect(reader.snapshot.userTurns).toBe(0);

    await appendFile(path, encoded.subarray(splitAt));
    await reader.refresh();
    expect(reader.snapshot.userTurns).toBe(1);
  });

  it("restarts aggregation when the file is replaced by a shorter one", async () => {
    const path = await makeSessionFile([header, assistant("m", "p", usage(10, 5, 100, 0, 0, 0.01))]);
    const reader = new PiSessionFileReader(path);
    await reader.refresh();
    expect(reader.snapshot.calls).toBe(1);

    await writeFile(path, header + "\n", "utf8");
    await reader.refresh();

    expect(reader.snapshot.calls).toBe(0);
    expect(reader.snapshot.totalTokens).toBe(0);
    expect(reader.snapshot.sessionId).toBe("01a08f7c-db66-7074-883f-fa168c7aea83");
  });

  it("caps the retained call list while totals keep counting", async () => {
    const lines = [header];
    for (let i = 0; i < 12; i += 1) {
      lines.push(assistant("m", "p", usage(1, 1, 0, 0, 0, 0.001), "toolUse", `2026-09-11T08:02:${String(i).padStart(2, "0")}.000Z`));
    }
    const path = await makeSessionFile(lines);

    const reader = new PiSessionFileReader(path, { maxCalls: 5 });
    await reader.refresh();

    expect(reader.snapshot.calls).toBe(12);
    expect(reader.calls).toHaveLength(5);
    expect(reader.calls.map((call) => call.index)).toEqual([8, 9, 10, 11, 12]);
    expect(reader.isTruncated).toBe(true);
  });

  it("ignores malformed JSON lines", async () => {
    const path = await makeSessionFile([header, "{not json", assistant("m", "p", usage(10, 5, 0, 0, 0, 0))]);
    const reader = new PiSessionFileReader(path);
    await reader.refresh();
    expect(reader.snapshot.calls).toBe(1);
  });
});
