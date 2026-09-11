import { open, stat } from "node:fs/promises";
import { emptyUsageTotals, type UsageTotals } from "../shared/format";

/**
 * Incremental reader for one Pi session JSONL file.
 *
 * Aggregation mirrors Pi's own status bar (`core/usage-totals.js` +
 * `modes/interactive/components/footer.js`): every assistant message, every
 * toolResult that carries usage, and every `compaction` / `branch_summary`
 * entry counts toward the cumulative totals. Context tokens come from the
 * newest usable assistant message and stay unknown right after a compaction.
 */

export interface CallUsage {
  index: number;
  at: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  totalTokens: number;
  contextTokens: number;
  stopReason: string | null;
}

export interface ModelUsage {
  key: string;
  tokens: number;
  cost: number;
}

export interface SessionAggregate {
  sessionId: string | null;
  cwd: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  model: string | null;
  provider: string | null;
  thinkingLevel: string | null;
  totals: UsageTotals;
  totalTokens: number;
  calls: number;
  userTurns: number;
  compactions: number;
  contextUsedTokens: number;
  contextStale: boolean;
  cacheHitRate: number | null;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { total?: number } | number;
}

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES_PER_REFRESH = 64 * 1024 * 1024;
const DEFAULT_MAX_CALLS = 400;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function costOf(usage: PiUsage): number {
  const cost = usage.cost;
  if (typeof cost === "number") return num(cost);
  return num(cost?.total);
}

/** Pi's `calculateContextTokens`: native total, else the sum of all buckets. */
export function contextTokensOf(usage: PiUsage): number {
  const native = num(usage.totalTokens);
  if (native > 0) return native;
  return num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
}

function totalTokensOf(usage: PiUsage): number {
  return num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
}

function splitLines(buffer: Buffer): { lines: Buffer[]; rest: Buffer } {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      lines.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  return { lines, rest: start === 0 ? buffer : buffer.subarray(start) };
}

export class PiSessionFileReader {
  readonly path: string;

  private readonly maxCalls: number;
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private truncated = false;
  private bytes = 0;
  private callList: CallUsage[] = [];
  private perModel = new Map<string, { tokens: number; cost: number }>();
  private aggregate: SessionAggregate = {
    sessionId: null,
    cwd: null,
    startedAt: null,
    lastActivityAt: null,
    model: null,
    provider: null,
    thinkingLevel: null,
    totals: emptyUsageTotals(),
    totalTokens: 0,
    calls: 0,
    userTurns: 0,
    compactions: 0,
    contextUsedTokens: 0,
    contextStale: false,
    cacheHitRate: null,
  };

  constructor(path: string, options?: { maxCalls?: number }) {
    this.path = path;
    this.maxCalls = options?.maxCalls ?? DEFAULT_MAX_CALLS;
  }

  get snapshot(): SessionAggregate {
    return this.aggregate;
  }

  get calls(): readonly CallUsage[] {
    return this.callList;
  }

  /** True when older calls were dropped to respect `maxCalls`. */
  get isTruncated(): boolean {
    return this.truncated;
  }

  get fileBytes(): number {
    return this.bytes;
  }

  get models(): ModelUsage[] {
    return Array.from(this.perModel, ([key, value]) => ({ key, tokens: value.tokens, cost: value.cost }))
      .filter((entry) => entry.tokens > 0 || entry.cost > 0)
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  }

  /** Reads only the bytes appended since the previous call. */
  async refresh(): Promise<void> {
    const info = await stat(this.path);
    if (info.size < this.offset) {
      this.reset();
    }
    if (info.size === this.offset) {
      this.bytes = info.size;
      return;
    }

    const handle = await open(this.path, "r");
    try {
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      let position = this.offset;
      const ceiling = Math.min(info.size, position + MAX_BYTES_PER_REFRESH);
      while (position < ceiling) {
        const length = Math.min(chunk.length, ceiling - position);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead <= 0) break;
        const combined = this.partial.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([this.partial, chunk.subarray(0, bytesRead)]);
        const { lines, rest } = splitLines(combined);
        this.partial = Buffer.from(rest);
        for (const line of lines) {
          this.applyLine(line.toString("utf8"));
        }
        position += bytesRead;
      }
      this.offset = position;
    } finally {
      await handle.close();
    }
    this.bytes = info.size;
  }

  private reset(): void {
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.callList = [];
    this.perModel = new Map();
    this.truncated = false;
    this.aggregate = {
      sessionId: null,
      cwd: null,
      startedAt: null,
      lastActivityAt: null,
      model: null,
      provider: null,
      thinkingLevel: null,
      totals: emptyUsageTotals(),
      totalTokens: 0,
      calls: 0,
      userTurns: 0,
      compactions: 0,
      contextUsedTokens: 0,
      contextStale: false,
      cacheHitRate: null,
    };
  }

  private applyLine(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) return;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      entry = parsed as Record<string, unknown>;
    } catch {
      return; // A partially flushed line is retried on the next refresh.
    }

    const type = entry.type;
    if (type === "session") {
      this.aggregate.sessionId = str(entry.id) ?? this.aggregate.sessionId;
      this.aggregate.cwd = str(entry.cwd) ?? this.aggregate.cwd;
      this.aggregate.startedAt = str(entry.timestamp) ?? this.aggregate.startedAt;
      return;
    }
    if (type === "model_change") {
      const provider = str(entry.provider);
      const modelId = str(entry.modelId);
      if (provider) this.aggregate.provider = provider;
      if (provider && modelId) this.aggregate.model = `${provider}/${modelId}`;
      else if (modelId) this.aggregate.model = modelId;
      return;
    }
    if (type === "thinking_level_change") {
      this.aggregate.thinkingLevel = str(entry.thinkingLevel) ?? this.aggregate.thinkingLevel;
      return;
    }
    if (type === "compaction" || type === "branch_summary") {
      const at = str(entry.timestamp);
      if (at) this.aggregate.lastActivityAt = at;
      const usage = entry.usage as PiUsage | undefined;
      if (type === "compaction") {
        this.aggregate.compactions += 1;
        // Pi reports `?` until a post-compaction assistant usage arrives.
        this.aggregate.contextStale = true;
      }
      if (usage) this.addUsage(usage, "Tools/summaries");
      return;
    }
    if (type !== "message") return;

    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) return;
    const at = str(entry.timestamp);
    if (at) this.aggregate.lastActivityAt = at;
    const role = message.role;

    if (role === "user") {
      this.aggregate.userTurns += 1;
      return;
    }
    if (role === "toolResult") {
      const usage = message.usage as PiUsage | undefined;
      if (usage) this.addUsage(usage, "Tools/summaries");
      return;
    }
    if (role !== "assistant") return;

    const usage = message.usage as PiUsage | undefined;
    if (!usage) return;

    const provider = str(message.provider) ?? this.aggregate.provider ?? "?";
    const model = str(message.responseModel) ?? str(message.model) ?? "?";
    if (this.aggregate.provider === null) this.aggregate.provider = provider;
    if (this.aggregate.model === null) this.aggregate.model = `${provider}/${model}`;

    const stopReason = str(message.stopReason);
    const contextTokens = contextTokensOf(usage);
    this.aggregate.calls += 1;
    this.addUsage(usage, `${provider}/${model}`, {
      index: this.aggregate.calls,
      at,
      provider,
      model,
      contextTokens,
      stopReason,
    });

    // Pi ignores aborted/errored/zero usage when deriving the live context size.
    if (stopReason !== "aborted" && stopReason !== "error" && contextTokens > 0) {
      this.aggregate.contextUsedTokens = contextTokens;
      this.aggregate.contextStale = false;
      const promptTokens = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
      this.aggregate.cacheHitRate = promptTokens > 0 ? (num(usage.cacheRead) / promptTokens) * 100 : null;
    }
  }

  private addUsage(
    usage: PiUsage,
    modelKey: string,
    call?: { index: number; at: string | null; provider: string; model: string; contextTokens: number; stopReason: string | null },
  ): void {
    const totals = this.aggregate.totals;
    totals.input += num(usage.input);
    totals.output += num(usage.output);
    totals.cacheRead += num(usage.cacheRead);
    totals.cacheWrite += num(usage.cacheWrite);
    totals.reasoning += num(usage.reasoning);
    totals.cost += costOf(usage);

    const tokens = totalTokensOf(usage);
    this.aggregate.totalTokens += tokens;

    const bucket = this.perModel.get(modelKey) ?? { tokens: 0, cost: 0 };
    bucket.tokens += tokens;
    bucket.cost += costOf(usage);
    this.perModel.set(modelKey, bucket);

    if (!call) return;
    this.callList.push({
      index: call.index,
      at: call.at,
      provider: call.provider,
      model: call.model,
      input: num(usage.input),
      output: num(usage.output),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      reasoning: num(usage.reasoning),
      cost: costOf(usage),
      totalTokens: tokens,
      contextTokens: call.contextTokens,
      stopReason: call.stopReason,
    });
    if (this.callList.length > this.maxCalls) {
      this.callList.splice(0, this.callList.length - this.maxCalls);
      this.truncated = true;
    }
  }
}
