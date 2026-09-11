import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  calls: vi.fn(),
  close: vi.fn(),
  agent: { status: "idle", title: "统计 token" } as { status: string; title: string } | null,
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (rpc: { name: string }) => (rpc.name === "pi-usage.snapshot" ? mocks.snapshot : mocks.calls),
  useAgent: () => mocks.agent,
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Button",
  ScrollView: "ScrollView",
}));

import { PiUsagePopover } from "./panel";
import type { UsageSnapshot } from "../shared/usage";

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    border: "#e4e4e7",
    foreground: "#18181b",
    foregroundMuted: "#71717a",
    accent: "#386f4d",
    accentForeground: "#ffffff",
    statusSuccess: "#386f4d",
    statusWarning: "#916c19",
    statusDanger: "#94433e",
  },
};

const popoverProps = {
  theme,
  layout: { compact: false, platform: "web" },
  host: { id: "test", label: "Test host" },
  context: "agent",
  workspaceId: "wks_1",
  agentId: "agent-1",
  close: mocks.close,
} as unknown as PluginButtonContentProps;

const okSnapshot: UsageSnapshot = {
  agentId: "agent-1",
  status: "ok",
  error: null,
  provider: "pi",
  model: "aliyun/qwen3.8-max",
  thinkingLevel: "xhigh",
  sessionId: "01a08f7c",
  sessionFile: "/Users/liyijun/.pi/agent/sessions/--Users-liyijun-pi-demo--/2026-09-11_01a08f7c.jsonl",
  totals: { input: 180_704, output: 69_842, cacheRead: 7_964_160, cacheWrite: 0, reasoning: 32_862, cost: 0.4213 },
  totalTokens: 8_214_706,
  calls: 79,
  userTurns: 3,
  compactions: 1,
  contextUsedTokens: 167_727,
  contextWindowTokens: 262_144,
  contextPercent: 63.98,
  contextStale: false,
  cacheHitRate: 99.56,
  startedAt: "2026-09-11T08:01:59.655Z",
  lastActivityAt: "2026-09-11T08:35:26.340Z",
  fileBytes: 667_715,
};

const okCalls = {
  agentId: "agent-1",
  status: "ok" as const,
  error: null,
  truncated: true,
  perModel: [
    { key: "aliyun/qwen3.8-max", tokens: 8_000_000, cost: 0.4 },
    { key: "Tools/summaries", tokens: 214_706, cost: 0.02 },
  ],
  calls: [
    {
      index: 79,
      at: "2026-09-11T08:35:26.340Z",
      provider: "aliyun",
      model: "qwen3.8-max",
      input: 730,
      output: 85,
      cacheRead: 166_912,
      cacheWrite: 0,
      reasoning: 6,
      cost: 0.004,
      totalTokens: 167_727,
      contextTokens: 167_727,
      stopReason: "toolUse",
    },
  ],
};

let renderer: ReactTestRenderer;
let queryClient: QueryClient;

function renderPopover(props: PluginButtonContentProps = popoverProps) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return act(async () => {
    renderer = create(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(PiUsagePopover, props)),
    );
  });
}

async function flush() {
  // react-query notifies through batched micro/macrotasks; hop until the tree settles.
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const visible = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.agent = { status: "idle", title: "统计 token" };
  mocks.snapshot.mockResolvedValue({ readAt: "2026-09-11T08:40:00.000Z", agents: [okSnapshot] });
  mocks.calls.mockResolvedValue(okCalls);
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  queryClient?.clear();
});

test("renders cumulative totals, context and per-call detail", async () => {
  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("π Token 用量");
  // The subtitle is the session title, explicitly labelled so it reads as metadata.
  expect(text).toContain("会话：统计 token");
  // Hero numbers.
  expect(text).toContain("8.2M"); // total tokens
  expect(text).toContain("8,214,706");
  expect(text).toContain("$0.421");
  expect(text).toContain("64%"); // context percent
  expect(text).toContain("168k / 262k");
  // Breakdown rows.
  expect(text).toContain("R 缓存读");
  expect(text).toContain("8.0M");
  expect(text).toContain("✳ 思考");
  expect(text).toContain("99.6%");
  expect(text).toContain("缓存命中率 · 全会话");
  expect(text).toContain("97.8%"); // ΣcacheRead / Σprompt tokens
  // Session facts.
  expect(text).toContain("aliyun/qwen3.8-max");
  expect(text).toContain("thinking xhigh");
  expect(text).toContain("用户轮次 3");
  expect(text).toContain("压缩 1 次");
  // Per-model + call table.
  expect(text).toContain("Tools/summaries");
  expect(text).toContain("qwen3.8-max");
  expect(text).toContain("79");
  expect(text).toContain("更早的调用已从内存中丢弃");
  // Session file.
  expect(text).toContain("652.1 KB");
  expect(mocks.snapshot).toHaveBeenCalledWith({ agentIds: ["agent-1"] });
  expect(mocks.calls).toHaveBeenCalledWith({ agentId: "agent-1", limit: 40 });
});

test("close button dismisses the popover through the host close callback", async () => {
  await renderPopover();
  await flush();

  const close = renderer.root.find((node) => node.props?.accessibilityLabel === "关闭 Token 面板");
  expect(close.find((node) => (node.type as unknown as string) === "Text").children.join("")).toBe("关闭");
  act(() => {
    close.props.onPress();
  });

  expect(mocks.close).toHaveBeenCalled();
});

test("hides the wide call columns even on wide layouts", async () => {
  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("8.2M");
  expect(text).not.toContain(" ctx");
});

test("explains a surface outside an agent context", async () => {
  await renderPopover({ ...popoverProps, context: "workspace", agentId: undefined } as unknown as PluginButtonContentProps);
  await flush();

  expect(visible()).toContain("该表面只服务于 agent 上下文");
});

test("explains a session that has not started yet", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, status: "no_session", sessionFile: null, totalTokens: 0 }],
  });

  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("Pi 会话文件还没生成");
  expect(text).not.toContain("按模型拆分");
});

test("explains non-Pi agents instead of showing zeroes", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, status: "not_pi", provider: "codex" }],
  });

  await renderPopover();
  await flush();

  expect(visible()).toContain("本插件只统计 Pi 会话");
});

test("surfaces a failing read", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, status: "error", error: "EACCES", sessionFile: null, totalTokens: 0 }],
  });

  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("读取失败：");
  expect(text).toContain("EACCES");
  expect(text).not.toContain("会话文件");
});

test("marks context unknown after a compaction like Pi does", async () => {
  mocks.snapshot.mockResolvedValue({
    readAt: "2026-09-11T08:40:00.000Z",
    agents: [{ ...okSnapshot, contextStale: true, contextPercent: null }],
  });

  await renderPopover();
  await flush();

  const text = visible();
  expect(text).toContain("压缩后待更新");
});
