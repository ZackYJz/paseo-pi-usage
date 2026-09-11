import type { PaseoApi } from "@getpaseo/client";
import type { CallUsage, ModelUsage, UsageSnapshot } from "../shared/usage";
import { emptyUsageTotals } from "../shared/format";
import { PiSessionResolver } from "./resolve";
import { PiSessionFileReader } from "./sessionFile";

/**
 * Daemon-side usage service: resolve an agent's Pi session file, then read only
 * the bytes appended since the previous poll.
 */

const MAX_READERS = 200;
const CONCURRENCY = 8;

function baseSnapshot(agentId: string): UsageSnapshot {
  return {
    agentId,
    status: "error",
    error: null,
    provider: null,
    model: null,
    thinkingLevel: null,
    sessionId: null,
    sessionFile: null,
    totals: emptyUsageTotals(),
    totalTokens: 0,
    calls: 0,
    userTurns: 0,
    compactions: 0,
    contextUsedTokens: 0,
    contextWindowTokens: null,
    contextPercent: null,
    contextStale: false,
    cacheHitRate: null,
    startedAt: null,
    lastActivityAt: null,
    fileBytes: 0,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PiUsageService {
  private readonly resolver = new PiSessionResolver();
  private readonly readers = new Map<string, PiSessionFileReader>();

  async snapshot(agentIds: string[], paseo: PaseoApi): Promise<{ readAt: string; agents: UsageSnapshot[] }> {
    const agents: UsageSnapshot[] = [];
    for (let i = 0; i < agentIds.length; i += CONCURRENCY) {
      const batch = agentIds.slice(i, i + CONCURRENCY);
      const settled = await Promise.all(batch.map((agentId) => this.snapshotOne(agentId, paseo)));
      agents.push(...settled);
    }
    return { readAt: new Date().toISOString(), agents };
  }

  /** Newest call first, so the panel can render the tail without paging. */
  async calls(
    agentId: string,
    limit: number,
    paseo: PaseoApi,
  ): Promise<{
    agentId: string;
    status: UsageSnapshot["status"];
    error: string | null;
    truncated: boolean;
    calls: CallUsage[];
    perModel: ModelUsage[];
  }> {
    try {
      const resolved = await this.resolver.resolve(agentId, paseo);
      if (resolved.kind !== "ok") {
        return {
          agentId,
          status: resolved.kind === "not_pi" ? "not_pi" : "no_session",
          error: null,
          truncated: false,
          calls: [],
          perModel: [],
        };
      }
      const reader = await this.read(agentId, resolved.path);
      return {
        agentId,
        status: "ok",
        error: null,
        truncated: reader.isTruncated,
        calls: reader.calls.slice(-limit).reverse(),
        perModel: reader.models,
      };
    } catch (error) {
      return {
        agentId,
        status: "error",
        error: messageOf(error),
        truncated: false,
        calls: [],
        perModel: [],
      };
    }
  }

  private async snapshotOne(agentId: string, paseo: PaseoApi): Promise<UsageSnapshot> {
    const empty = baseSnapshot(agentId);
    try {
      const resolved = await this.resolver.resolve(agentId, paseo);
      if (resolved.kind === "not_pi") {
        return { ...empty, status: "not_pi", provider: resolved.provider };
      }
      if (resolved.kind === "no_session") {
        return { ...empty, status: "no_session", provider: resolved.provider, sessionId: resolved.sessionId };
      }

      const reader = await this.read(agentId, resolved.path);
      const aggregate = reader.snapshot;
      const window = resolved.contextWindowTokens;
      const contextPercent =
        window && window > 0 && !aggregate.contextStale && aggregate.contextUsedTokens > 0
          ? (aggregate.contextUsedTokens / window) * 100
          : null;

      return {
        ...empty,
        status: "ok",
        error: null,
        provider: resolved.provider,
        model: aggregate.model ?? resolved.model,
        thinkingLevel: aggregate.thinkingLevel,
        sessionId: aggregate.sessionId ?? resolved.sessionId,
        sessionFile: resolved.path,
        totals: { ...aggregate.totals },
        totalTokens: aggregate.totalTokens,
        calls: aggregate.calls,
        userTurns: aggregate.userTurns,
        compactions: aggregate.compactions,
        contextUsedTokens: aggregate.contextUsedTokens,
        contextWindowTokens: window,
        contextPercent,
        contextStale: aggregate.contextStale,
        cacheHitRate: aggregate.cacheHitRate,
        startedAt: aggregate.startedAt,
        lastActivityAt: aggregate.lastActivityAt,
        fileBytes: reader.fileBytes,
      };
    } catch (error) {
      return { ...empty, status: "error", error: messageOf(error) };
    }
  }

  private async read(agentId: string, path: string): Promise<PiSessionFileReader> {
    const existing = this.readers.get(agentId);
    if (existing && existing.path === path) {
      // Refresh recency for the LRU below.
      this.readers.delete(agentId);
      this.readers.set(agentId, existing);
      await existing.refresh();
      return existing;
    }

    const reader = new PiSessionFileReader(path);
    await reader.refresh();
    this.readers.set(agentId, reader);
    while (this.readers.size > MAX_READERS) {
      const oldest = this.readers.keys().next();
      if (oldest.done) break;
      this.readers.delete(oldest.value);
    }
    return reader;
  }
}
