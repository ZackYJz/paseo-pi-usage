import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PI_USAGE_PANEL_ID = "pi-usage";

/** One LLM call, i.e. one assistant message carrying usage in Pi's session JSONL. */
export const callUsageSchema = z.object({
  index: z.number(),
  at: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  totalTokens: z.number(),
  contextTokens: z.number(),
  stopReason: z.string().nullable(),
});

export const modelUsageSchema = z.object({
  key: z.string(),
  tokens: z.number(),
  cost: z.number(),
});

export const usageStatusSchema = z.enum(["ok", "no_session", "not_pi", "error"]);

export const usageSnapshotSchema = z.object({
  agentId: z.string(),
  status: usageStatusSchema,
  error: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionFile: z.string().nullable(),
  totals: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    reasoning: z.number(),
    cost: z.number(),
  }),
  totalTokens: z.number(),
  calls: z.number(),
  userTurns: z.number(),
  compactions: z.number(),
  contextUsedTokens: z.number(),
  contextWindowTokens: z.number().nullable(),
  contextPercent: z.number().nullable(),
  /** True while the newest compaction has no post-compaction usage yet, like Pi's `?`. */
  contextStale: z.boolean(),
  cacheHitRate: z.number().nullable(),
  startedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  fileBytes: z.number(),
});

export type UsageSnapshot = z.infer<typeof usageSnapshotSchema>;
export type CallUsage = z.infer<typeof callUsageSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;

/** Batched so one client poll is a single RPC round trip for every visible agent. */
export const piUsageSnapshotRpc = defineRpc({
  name: "pi-usage.snapshot",
  input: z.object({
    agentIds: z.array(z.string()).min(1).max(40),
  }),
  output: z.object({
    readAt: z.string(),
    agents: z.array(usageSnapshotSchema),
  }),
});

export const piUsageCallsRpc = defineRpc({
  name: "pi-usage.calls",
  input: z.object({
    agentId: z.string(),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  output: z.object({
    agentId: z.string(),
    status: usageStatusSchema,
    error: z.string().nullable(),
    truncated: z.boolean(),
    calls: z.array(callUsageSchema),
    perModel: z.array(modelUsageSchema),
  }),
});
