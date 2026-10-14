import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  close: vi.fn(),
  agent: { status: "idle", title: "统计 token" } as { status: string; title: string } | null,
}));

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: () => mocks.detail,
  useAgent: (_id: string, select: (agent: { status: string; title: string }) => unknown) => (mocks.agent ? select(mocks.agent) : null),
}));

vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));

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
  sessionFile: "/home/user/.pi/agent/sessions/--home-user-pi-demo--/2026-09-11_01a08f7c.jsonl",
  totals: { input: 180_704, output: 69_842, cacheRead: 7_964_160, cacheWrite: 0, reasoning: 32_862, cost: 0.4213 },
  estimatedCost: 2.5,
  totalTokens: 8_214_706,
  callCount: 79,
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

const okDetail = {
  snapshot: okSnapshot,
  lastTurn: { turn: 3, callCount: 12, input: 4200, output: 1300, cacheRead: 900_000, cacheWrite: 0, cost: 0, estimated: 0.31, startedAt: "2026-09-11T08:30:00.000Z" },
  truncated: true,
  perModel: [
    { key: "aliyun/qwen3.8-max", tokens: 8_000_000, cost: 0.4, estimated: 2.4 },
    { key: "Tools/summaries", tokens: 214_706, cost: 0.02, estimated: 0.1 },
  ],
  calls: [
    {
      index: 79,
      turn: 3,
      at: "2026-09-11T08:35:26.340Z",
      provider: "aliyun",
      model: "qwen3.8-max",
      input: 730,
      output: 85,
      cacheRead: 166_912,
      cacheWrite: 0,
      reasoning: 6,
      cost: 0.004,
      estimated: 0.0421,
      totalTokens: 167_727,
      contextTokens: 167_727,
      stopReason: "toolUse",
    },
  ],
  context: {
    total: 167_727,
    calibrated: true,
    pendingTokens: 0,
    categories: [
      { key: "messages", tokens: 20_000, count: null },
      { key: "toolCalls", tokens: 110_000, count: null },
      { key: "thinking", tokens: 0, count: null },
      { key: "mcp", tokens: 40, count: null },
      { key: "systemTools", tokens: 14_088, count: 31 },
      { key: "skills", tokens: 8_862, count: 68 },
      { key: "projectContext", tokens: 340, count: 1 },
      { key: "systemPrompt", tokens: 14_397, count: null },
    ],
    topTools: [{ name: "bash", tokens: 80_000 }, { name: "read", tokens: 30_000 }],
  },
};

let renderer: ReactTestRenderer;
let queryClient: QueryClient;

async function renderPopover(props: PluginButtonContentProps = popoverProps) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    renderer = create(
      React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(PiUsagePopover, props)),
    );
  });
  // React's act() thenable does not chain, so settle is awaited separately.
  await settle();
}

/** Let the detail query resolve and re-render before asserting. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const text = () => JSON.stringify(renderer.toJSON());
const press = async (label: string) => {
  await act(async () => {
    renderer.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress();
  });
  await settle();
};
const withSnapshot = (patch: Partial<UsageSnapshot>) => mocks.detail.mockResolvedValue({ ...okDetail, snapshot: { ...okSnapshot, ...patch } });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.agent = { status: "idle", title: "统计 token" };
  mocks.detail.mockResolvedValue(okDetail);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  queryClient?.clear();
});

test("leads with context, then cost, total tokens and cache hit rate from one detail request", async () => {
  await renderPopover();
  expect(mocks.detail).toHaveBeenCalledTimes(1);
  expect(mocks.detail).toHaveBeenCalledWith({ agentId: "agent-1", callLimit: 40 });
  expect(text()).toContain("统计 token");
  expect(text()).toContain("qwen3.8-max · thinking xhigh");
  expect(text()).toContain("168k / 262k");
  expect(text()).toContain("64%");
  expect(text()).toContain("$2.500");
  expect(text()).toContain("官方价估算");
  expect(text()).toContain("8.2M");
  expect(text()).toContain("79 次调用 · 3 轮");
  expect(text()).toContain("97.8%");
});

test("shows the newest turn and marks it in progress while the agent runs", async () => {
  mocks.agent = { status: "running", title: "统计 token" };
  await renderPopover();
  expect(text()).toContain("本轮 · 第 3 轮（进行中）");
  expect(text()).toContain("↑4.2k · ↓1.3k · 缓存读 900k · 12 次调用 · $0.310");
  expect(text()).toContain("运行中");
});

test("keeps the breakdown, per-model split and calls folded until asked", async () => {
  await renderPopover();
  expect(text()).not.toContain("7,964,160");
  expect(text()).not.toContain("#79");
  await press("展开Token 明细");
  expect(text()).toContain("7,964,160");
  expect(text()).toContain("Pi 记账花费");
  await press("展开按模型");
  expect(text()).toContain("工具与摘要");
  await press("展开最近调用");
  expect(text()).toContain("#79");
  expect(text()).toContain("更早的调用不再保留明细");
});

test("hides the per-model section when the session used a single model", async () => {
  mocks.detail.mockResolvedValue({ ...okDetail, perModel: [okDetail.perModel[0]] });
  await renderPopover();
  expect(text()).not.toContain("按模型");
});

test("draws one sparkline bar per call", async () => {
  mocks.detail.mockResolvedValue({ ...okDetail, calls: [okDetail.calls[0], { ...okDetail.calls[0], index: 78, contextTokens: 80_000, stopReason: "error" }] });
  await renderPopover();
  const spark = renderer.root.find((node) => typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.startsWith("最近 2 次调用"));
  expect(spark.children).toHaveLength(2);
});

test("colors context above 90% as danger", async () => {
  withSnapshot({ contextPercent: 93.2 });
  await renderPopover();
  expect(text()).toContain("93%");
  expect(text()).toContain(theme.colors.statusDanger);
});

test("marks context unknown after a compaction like Pi does", async () => {
  withSnapshot({ contextStale: true, contextPercent: null });
  await renderPopover();
  expect(text()).toContain("压缩后待更新");
});

test("falls back to Pi's recorded cost when the model is not in the price table", async () => {
  withSnapshot({ estimatedCost: 0 });
  await renderPopover();
  expect(text()).toContain("$0.421");
  expect(text()).toContain("Pi 记账");
});

test("explains a session that has not started yet", async () => {
  withSnapshot({ status: "no_session" });
  await renderPopover();
  expect(text()).toContain("Pi 会话文件还没生成");
});

test("explains non-Pi agents instead of showing zeroes", async () => {
  withSnapshot({ status: "not_pi", provider: "codex" });
  await renderPopover();
  expect(text()).toContain("codex provider");
});

test("surfaces a failing read", async () => {
  mocks.detail.mockRejectedValue(new Error("EACCES"));
  await renderPopover();
  expect(text()).toContain("读取失败：EACCES");
});

test("drops the extra background layer on dark themes", async () => {
  await renderPopover({ ...popoverProps, theme: { colors: { ...theme.colors, surface0: "#181818" } } } as PluginButtonContentProps);
  const screen = renderer.root.findAll((node) => (node.type as unknown) === "View")[0]!;
  expect(screen.props.style.backgroundColor).toBe("transparent");
});

test("refresh refetches the detail", async () => {
  await renderPopover();
  await press("立即刷新");
  expect(mocks.detail).toHaveBeenCalledTimes(2);
});

test("breaks the context down by category with shares of the window", async () => {
  await renderPopover();
  expect(text()).toContain("消息");
  expect(text()).toContain("工具调用");
  expect(text()).toContain("系统工具");
  expect(text()).toContain("  31 个");
  expect(text()).toContain("  68 个");
  expect(text()).toContain("  1 个文件");
  // 110k of a 262k window.
  expect(text()).toContain("42.0%");
  // A 40-token MCP listing stays visible instead of rounding to 0.0%.
  expect(text()).toContain("<0.1%");
  expect(text()).toContain("bash 80k · read 30k");
  expect(text()).toContain("已对齐最近一次请求的实际用量");
  // Empty categories get neither a row nor a bar segment.
  expect(text()).not.toContain("思考");
  const bar = renderer.root.find((node) => node.props.style?.[1]?.flexDirection === "row" && node.props.style?.[1]?.height === 6);
  expect(bar.children).toHaveLength(7);
});

test("folds the composition from the context header and remembers it across opens", async () => {
  await renderPopover();
  await press("收起上下文构成");
  expect(text()).not.toContain("系统工具");
  await act(async () => renderer.unmount());
  await renderPopover();
  expect(text()).not.toContain("系统工具");
  await press("展开上下文构成");
  expect(text()).toContain("系统工具");
});

test("notes content waiting for the next request and uncalibrated estimates", async () => {
  mocks.detail.mockResolvedValue({ ...okDetail, context: { ...okDetail.context, calibrated: false, pendingTokens: 12_300 } });
  await renderPopover();
  expect(text()).toContain("压缩后还没有实际用量可对齐");
  expect(text()).toContain("另有约 12k 新内容将计入下一次请求");
});

test("falls back to the plain gauge for sessions without a recorded prompt", async () => {
  mocks.detail.mockResolvedValue({ ...okDetail, context: null });
  await renderPopover();
  expect(text()).not.toContain("系统工具");
  expect(renderer.root.findAll((node) => node.props.accessibilityLabel === "展开上下文构成" || node.props.accessibilityLabel === "收起上下文构成")).toHaveLength(0);
});
