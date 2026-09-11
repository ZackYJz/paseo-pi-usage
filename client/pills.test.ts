import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piUsageSnapshotRpc } from "../shared/usage";
import { startUsagePills } from "./pills";

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: vi.fn(),
  useAgent: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Button",
  ScrollView: "ScrollView",
}));

interface FakePill extends PluginButtonRegistration {
  agentId: string;
  label: string;
  title: string;
  removed: boolean;
  presses: number;
}

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-11T09:00:00.000Z");

function agent(overrides: Partial<Record<string, unknown>> & { id: string }) {
  return {
    provider: "pi",
    workspaceId: "wks_1",
    status: "idle",
    cwd: "/repo/app",
    archivedAt: null,
    lastUserMessageAt: new Date(NOW - 10 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 10 * HOUR).toISOString(),
    createdAt: new Date(NOW - 10 * HOUR).toISOString(),
    ...overrides,
  };
}

function snapshotFor(agentId: string, totalTokens: number) {
  return {
    agentId,
    status: "ok" as const,
    error: null,
    provider: "pi",
    model: "aliyun/qwen3.8-max",
    thinkingLevel: null,
    sessionId: "s1",
    sessionFile: "/tmp/s1.jsonl",
    totals: { input: 12_300, output: 4500, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 },
    totalTokens,
    calls: 3,
    userTurns: 1,
    compactions: 0,
    contextUsedTokens: 0,
    contextWindowTokens: null,
    contextPercent: null,
    contextStale: false,
    cacheHitRate: null,
    startedAt: null,
    lastActivityAt: null,
    fileBytes: 10,
  };
}

function harness(agents: Array<Record<string, unknown>>) {
  const pills = new Map<string, FakePill>();
  const polled: string[][] = [];
  const listeners: Array<(update: unknown) => void> = [];

  const addComposerPill = vi.fn((contribution: { agentId: string; button: { title: string; label?: string } }) => {
    const pill: FakePill = {
      agentId: contribution.agentId,
      title: contribution.button.title,
      label: contribution.button.label ?? "",
      removed: false,
      presses: 0,
      update(patch: { label?: string; title?: string }) {
        if (patch.label !== undefined) this.label = patch.label;
        if (patch.title !== undefined) this.title = patch.title;
      },
      remove() {
        this.removed = true;
        pills.delete(this.agentId);
      },
    };
    pills.set(contribution.agentId, pill);
    return pill;
  });

  const rpc = vi.fn(async (_contract: unknown, input: { agentIds: string[] }) => {
    polled.push([...input.agentIds]);
    return { readAt: new Date(NOW).toISOString(), agents: input.agentIds.map((id, index) => snapshotFor(id, 1000 + index)) };
  });

  const list = vi.fn(async () => ({
    requestId: "r1",
    entries: agents.map((entry) => ({ agent: entry, project: null })),
    pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
  }));

  const subscribe = vi.fn((handler: (update: unknown) => void) => {
    listeners.push(handler);
    return () => {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    };
  });

  const client = {
    addComposerPill,
    rpc,
    paseo: { agents: { list, subscribe } },
  } as unknown as PluginClientContext;

  return {
    client,
    pills,
    polled,
    list,
    rpc,
    addComposerPill,
    emit(update: unknown) {
      for (const listener of [...listeners]) listener(update);
    },
  };
}

describe("startUsagePills", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pills only Pi agents that belong to a workspace", async () => {
    const context = harness([
      agent({ id: "pi-1" }),
      agent({ id: "codex-1", provider: "codex" }),
      agent({ id: "pi-detached", workspaceId: null }),
      agent({ id: "pi-archived", archivedAt: new Date(NOW).toISOString() }),
    ]);

    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);

    expect([...context.pills.keys()]).toEqual(["pi-1"]);
    expect(context.pills.get("pi-1")?.title).toBe("Pi token 用量 · ↑12k ↓4.5k 缓存命中 0.0%");

    stop();
  });

  it("labels the pill from the snapshot and keeps polling only active agents", async () => {
    const context = harness([
      agent({ id: "hot", status: "running", updatedAt: new Date(NOW).toISOString() }),
      agent({ id: "cold" }),
    ]);

    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);

    // Bootstrap polls every tracked agent once, newest first from the batch result.
    expect(context.polled[0].sort()).toEqual(["cold", "hot"]);
    expect(context.pills.get("hot")?.label).toBe("↑12k ↓4.5k");
    expect(context.pills.get("cold")?.label).toBe("↑12k ↓4.5k");

    context.polled.length = 0;
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.polled).toEqual([["hot"]]);

    // A status change makes a quiet agent worth one more read.
    context.polled.length = 0;
    context.emit({ kind: "upsert", agent: agent({ id: "cold", status: "running", updatedAt: new Date(NOW).toISOString() }) });
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.polled[0].sort()).toEqual(["cold", "hot"]);

    stop();
  });

  it("drops the pill when the agent goes away", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    expect(context.pills.has("pi-1")).toBe(true);

    context.emit({ kind: "remove", agentId: "pi-1" });
    expect(context.pills.has("pi-1")).toBe(false);

    context.emit({ kind: "upsert", agent: agent({ id: "pi-2" }) });
    expect(context.pills.has("pi-2")).toBe(true);
    context.emit({ kind: "upsert", agent: agent({ id: "pi-2", archivedAt: new Date(NOW).toISOString() }) });
    expect(context.pills.has("pi-2")).toBe(false);

    stop();
  });

  it("opens the token view as a pill popover", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);

    const contribution = context.addComposerPill.mock.calls[0][0] as unknown as {
      button: { behavior: { kind: string; Content: unknown } };
    };
    expect(contribution.button.behavior.kind).toBe("popover");
    expect(typeof contribution.button.behavior.Content).toBe("function");

    stop();
  });

  it("keeps the previous label and stops polling after cleanup", async () => {
    const context = harness([agent({ id: "hot", status: "running", updatedAt: new Date(NOW).toISOString() })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);
    const label = context.pills.get("hot")?.label;
    expect(label).toBe("↑12k ↓4.5k");

    context.rpc.mockRejectedValueOnce(new Error("daemon gone"));
    context.polled.length = 0;
    await vi.advanceTimersByTimeAsync(2500);
    expect(context.pills.get("hot")?.label).toBe(label);

    stop();
    expect(context.pills.size).toBe(0);
    context.polled.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(context.polled).toEqual([]);
  });

  it("asks for the snapshot through the plugin RPC contract", async () => {
    const context = harness([agent({ id: "pi-1" })]);
    const stop = startUsagePills(context.client);
    await vi.advanceTimersByTimeAsync(0);

    expect(context.rpc.mock.calls[0][0]).toBe(piUsageSnapshotRpc);
    stop();
  });
});
