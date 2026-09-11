import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { PaseoApi } from "@getpaseo/client";

/**
 * Maps a Paseo agent to the Pi session file that holds its usage.
 *
 * Paseo stores Pi's absolute session path in `persistence.nativeHandle`, which
 * is authoritative. The cwd-encoded directory scan is only a fallback for
 * agents whose snapshot has not been filled in yet.
 */

export type ResolveResult =
  | { kind: "not_pi"; provider: string }
  | { kind: "no_session"; provider: string; sessionId: string | null }
  | {
      kind: "ok";
      provider: string;
      path: string;
      sessionId: string | null;
      model: string | null;
      contextWindowTokens: number | null;
    };

type SessionPart =
  | { kind: "not_pi"; provider: string }
  | { kind: "no_session"; provider: string; sessionId: string | null }
  | {
      kind: "ok";
      provider: string;
      path: string;
      sessionId: string | null;
      model: string | null;
      cwd: string;
      snapshotWindow: number | null;
    };

const OK_TTL_MS = 120_000;
const MISSING_TTL_MS = 4_000;
const NOT_PI_TTL_MS = 600_000;
const CONFIG_TTL_MS = 60_000;
const MODEL_TTL_MS = 600_000;
const MODEL_FAILURE_TTL_MS = 60_000;

export function defaultAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/^~/, homedir());
  return join(homedir(), ".pi", "agent");
}

/** Mirrors `getDefaultSessionDirPath()` in Pi's `core/session-manager.js`. */
export function piSessionDir(cwd: string, agentDir = defaultAgentDir()): string {
  const sessionsRoot = process.env.PI_CODING_AGENT_SESSION_DIR || join(agentDir, "sessions");
  const encoded = `--${resolvePath(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(sessionsRoot, encoded);
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function findSessionFile(cwd: string, sessionId: string, agentDir?: string): Promise<string | null> {
  const dir = piSessionDir(cwd, agentDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  const matches = names.filter((name) => name.endsWith(suffix)).sort();
  return matches.length > 0 ? join(dir, matches[matches.length - 1]) : null;
}

interface ModelConfigEntry {
  models?: Array<{ id?: string; contextWindow?: number }>;
}

export class PiSessionResolver {
  private readonly sessions = new Map<string, { at: number; part: SessionPart }>();
  private readonly configWindows = new Map<string, number>();
  private readonly remoteWindows = new Map<string, { at: number; tokens: number | null }>();
  private readonly inflight = new Set<string>();
  private readonly agentDir: string | undefined;
  private readonly now: () => number;
  private configLoadedAt: number | null = null;

  constructor(options?: { agentDir?: string; now?: () => number }) {
    this.agentDir = options?.agentDir;
    this.now = options?.now ?? (() => Date.now());
  }

  async resolve(agentId: string, paseo: PaseoApi): Promise<ResolveResult> {
    let part: SessionPart;
    try {
      part = await this.sessionPart(agentId, paseo);
    } catch (error) {
      console.error(`[pi-usage] resolve failed for ${agentId}: ${messageOf(error)}`);
      return { kind: "no_session", provider: "pi", sessionId: null };
    }
    if (part.kind !== "ok") return part;

    const key = `${part.provider}|${part.model ?? ""}`;
    let window = part.snapshotWindow ?? (await this.contextWindowFromPiConfig(part.provider, part.model));
    if (window === null) {
      const remote = this.remoteWindows.get(key);
      if (remote && this.now() - remote.at < (remote.tokens === null ? MODEL_FAILURE_TTL_MS : MODEL_TTL_MS)) {
        window = remote.tokens;
      } else {
        // Provider model discovery costs seconds, so never block a usage read on it.
        this.fillWindowFromProvider(key, part.provider, part.model, part.cwd, paseo);
      }
    }

    return {
      kind: "ok",
      provider: part.provider,
      path: part.path,
      sessionId: part.sessionId,
      model: part.model,
      contextWindowTokens: window,
    };
  }

  forget(agentId: string): void {
    this.sessions.delete(agentId);
  }

  private async sessionPart(agentId: string, paseo: PaseoApi): Promise<SessionPart> {
    const cached = this.sessions.get(agentId);
    if (cached && this.now() - cached.at < ttlOf(cached.part)) return cached.part;

    const refetched = await paseo.agents.ref(agentId).refresh();
    const agent = refetched?.agent ?? null;
    const part: SessionPart = await this.buildPart(agent);
    this.sessions.set(agentId, { at: this.now(), part });
    return part;
  }

  private async buildPart(agent: {
    provider: string;
    cwd: string;
    model?: string | null;
    persistence?: { sessionId?: string; nativeHandle?: unknown } | null;
    runtimeInfo?: { sessionId?: string | null; model?: string | null } | null;
    lastUsage?: { contextWindowMaxTokens?: number } | null;
  } | null): Promise<SessionPart> {
    if (!agent) return { kind: "no_session", provider: "unknown", sessionId: null };
    if (agent.provider !== "pi") return { kind: "not_pi", provider: agent.provider };

    const sessionId = agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null;
    const handle = typeof agent.persistence?.nativeHandle === "string" ? agent.persistence.nativeHandle : null;
    const model = agent.runtimeInfo?.model ?? agent.model ?? null;

    let path = handle && (await isFile(handle)) ? handle : null;
    if (!path && sessionId && agent.cwd) {
      path = await findSessionFile(agent.cwd, sessionId, this.agentDir);
    }
    if (!path) return { kind: "no_session", provider: agent.provider, sessionId };

    return {
      kind: "ok",
      provider: agent.provider,
      path,
      sessionId,
      model,
      cwd: agent.cwd,
      snapshotWindow: positive(agent.lastUsage?.contextWindowMaxTokens),
    };
  }

  /** Reads `~/.pi/agent/models.json` + `models-store.json`, where custom providers declare their window. */
  private async contextWindowFromPiConfig(provider: string, model: string | null): Promise<number | null> {
    if (!model) return null;
    const now = this.now();
    if (this.configLoadedAt === null || now - this.configLoadedAt > CONFIG_TTL_MS) {
      await this.loadPiConfig();
      this.configLoadedAt = now;
    }
    const wanted = model.includes("/") ? model : `${provider}/${model}`;
    return this.configWindows.get(wanted) ?? this.configWindows.get(`${provider}/${model.slice(model.indexOf("/") + 1)}`) ?? null;
  }

  private async loadPiConfig(): Promise<void> {
    const agentDir = this.agentDir ?? defaultAgentDir();
    const sources: Array<{ file: string; nested: boolean }> = [
      { file: "models.json", nested: true },
      { file: "models-store.json", nested: false },
    ];
    for (const source of sources) {
      try {
        const parsed: unknown = JSON.parse(await readFile(join(agentDir, source.file), "utf8"));
        const providers = source.nested
          ? (parsed as { providers?: Record<string, ModelConfigEntry> })?.providers
          : (parsed as Record<string, ModelConfigEntry>);
        if (!providers || typeof providers !== "object") continue;
        for (const [provider, entry] of Object.entries(providers)) {
          for (const model of entry?.models ?? []) {
            const window = positive(model?.contextWindow);
            if (model?.id && window) this.configWindows.set(`${provider}/${model.id}`, window);
          }
        }
      } catch {
        // A missing or unreadable model config just means no window from disk.
      }
    }
  }

  private fillWindowFromProvider(key: string, provider: string, model: string | null, cwd: string, paseo: PaseoApi): void {
    if (!model || this.inflight.has(key)) return;
    this.inflight.add(key);
    void (async () => {
      try {
        const result = await paseo.providers.listModels(provider, { cwd });
        const wanted = model.slice(model.indexOf("/") + 1);
        const match = (result.models ?? []).find((entry) => entry.id === model || entry.id === wanted);
        this.remoteWindows.set(key, { at: this.now(), tokens: positive(match?.contextWindowMaxTokens) });
      } catch (error) {
        this.remoteWindows.set(key, { at: this.now(), tokens: null });
        console.error(`[pi-usage] model lookup failed for ${key}: ${messageOf(error)}`);
      } finally {
        this.inflight.delete(key);
      }
    })();
  }
}

function ttlOf(part: SessionPart): number {
  if (part.kind === "ok") return OK_TTL_MS;
  if (part.kind === "not_pi") return NOT_PI_TTL_MS;
  return MISSING_TTL_MS;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
