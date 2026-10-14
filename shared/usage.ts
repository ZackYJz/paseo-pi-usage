import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PI_USAGE_PANEL_ID = "pi-usage";

/** One LLM call, i.e. one assistant message carrying usage in Pi's session JSONL. */
export const callUsageSchema = z.object({
  index: z.number(),
  /** User turn the call belongs to (1-based); 0 for calls before the first user message. */
  turn: z.number(),
  at: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
  estimated: z.number(),
  totalTokens: z.number(),
  contextTokens: z.number(),
  stopReason: z.string().nullable(),
});

export const modelUsageSchema = z.object({
  key: z.string(),
  tokens: z.number(),
  cost: z.number(),
  estimated: z.number(),
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
  /** Session cost at official API list prices; see shared/pricing.ts. */
  estimatedCost: z.number(),
  totalTokens: z.number(),
  /** Number of LLM calls, not the call list; see `piUsageCallsRpc`. */
  callCount: z.number(),
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

/** Usage of one user turn: every LLM call and tool/summary usage after that user message. */
export const turnUsageSchema = z.object({
  turn: z.number(),
  callCount: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.number(),
  estimated: z.number(),
  startedAt: z.string().nullable(),
});

export type TurnUsage = z.infer<typeof turnUsageSchema>;

/** Display order: conversation first, then the fixed prompt-and-tool overhead. */
export const CONTEXT_CATEGORIES = ["messages", "toolCalls", "thinking", "mcp", "systemTools", "skills", "projectContext", "systemPrompt"] as const;
export const contextCategorySchema = z.enum(CONTEXT_CATEGORIES);
export type ContextCategory = z.infer<typeof contextCategorySchema>;

/**
 * What the current model context is made of, estimated from the session file
 * (Pi persists the system prompt by section and every tool declaration). When
 * `calibrated`, the categories are scaled to sum to the newest measured request.
 */
export const contextBreakdownSchema = z.object({
  total: z.number(),
  calibrated: z.boolean(),
  /** Estimated tokens appended after the measured request (e.g. a fresh tool result); not in `total`. */
  pendingTokens: z.number(),
  categories: z.array(z.object({
    key: contextCategorySchema,
    tokens: z.number(),
    /** Tools, skills or instruction files behind the category, where that means something. */
    count: z.number().nullable(),
  })),
  /** Tool calls plus their results, per tool, largest first. */
  topTools: z.array(z.object({ name: z.string(), tokens: z.number() })),
});

export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>;

/**
 * Everything the popover shows, in one round trip: the snapshot, the newest
 * turn, the per-model split and the newest calls (newest first). The calls also
 * feed the context sparkline, so they are fetched even while the list is folded.
 */
export const piUsageDetailRpc = defineRpc({
  name: "pi-usage.detail",
  input: z.object({
    agentId: z.string(),
    callLimit: z.number().int().min(1).max(200).default(40),
  }),
  output: z.object({
    snapshot: usageSnapshotSchema,
    lastTurn: turnUsageSchema.nullable(),
    truncated: z.boolean(),
    calls: z.array(callUsageSchema),
    perModel: z.array(modelUsageSchema),
    /** Null for sessions written before Pi persisted its system prompt. */
    context: contextBreakdownSchema.nullable(),
  }),
});
