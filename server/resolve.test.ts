import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionResolver, piSessionDir } from "./resolve";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-usage-resolve-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeAgent {
  id: string;
  provider: string;
  cwd: string;
  model?: string | null;
  persistence?: { provider: string; sessionId: string; nativeHandle?: string } | null;
  runtimeInfo?: { provider: string; sessionId: string | null; model?: string | null } | null;
  lastUsage?: { contextWindowMaxTokens?: number } | null;
}

function fakePaseo(agent: FakeAgent | null, options?: { models?: Array<{ id: string; contextWindowMaxTokens?: number }> }) {
  const refresh = vi.fn(async () => (agent ? { agent, project: null } : null));
  const listModels = vi.fn(async () => ({ provider: agent?.provider ?? "pi", models: options?.models ?? [] }));
  const paseo = {
    agents: { ref: () => ({ refresh }) },
    providers: { listModels },
  } as unknown as PaseoApi;
  return { paseo, refresh, listModels };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("piSessionDir", () => {
  it("encodes cwd the way Pi's session manager does", () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    expect(piSessionDir("/Users/liyijun/pi-demo", "/Users/liyijun/.pi/agent")).toBe(
      "/Users/liyijun/.pi/agent/sessions/--Users-liyijun-pi-demo--",
    );
  });

  it("honours PI_CODING_AGENT_SESSION_DIR", () => {
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "/tmp/pi-sessions");
    expect(piSessionDir("/repo/app", "/ignored")).toBe("/tmp/pi-sessions/--repo-app--");
  });
});

describe("PiSessionResolver", () => {
  it("prefers the nativeHandle Paseo recorded for the Pi session", async () => {
    const dir = await makeTempDir();
    const sessionFile = join(dir, "2026-09-11T08-01-59-655Z_01a08f7c.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const { paseo, refresh } = fakePaseo({
      id: "agent-1",
      provider: "pi",
      cwd: "/Users/liyijun/pi-demo",
      persistence: { provider: "pi", sessionId: "01a08f7c", nativeHandle: sessionFile },
      lastUsage: { contextWindowMaxTokens: 200_000 },
    });

    const resolver = new PiSessionResolver();
    const result = await resolver.resolve("agent-1", paseo);

    expect(result).toEqual({
      kind: "ok",
      provider: "pi",
      path: sessionFile,
      sessionId: "01a08f7c",
      model: null,
      contextWindowTokens: 200_000,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to scanning Pi's cwd-encoded session directory", async () => {
    const agentDir = await makeTempDir();
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    const sessionDir = join(agentDir, "sessions", "--repo-app--");
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, "2026-09-11T08-01-59-655Z_01a09999.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const { paseo } = fakePaseo({
      id: "agent-2",
      provider: "pi",
      cwd: "/repo/app",
      runtimeInfo: { provider: "pi", sessionId: "01a09999", model: "aliyun/qwen3.8-max" },
    });

    const result = await new PiSessionResolver().resolve("agent-2", paseo);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.path).toBe(sessionFile);
    expect(result.sessionId).toBe("01a09999");
    expect(result.model).toBe("aliyun/qwen3.8-max");
  });

  it("reads the context window from Pi's own models.json instead of a provider RPC", async () => {
    const agentDir = await makeTempDir();
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { aliyun: { models: [{ id: "qwen3.8-max", contextWindow: 262_144 }] } } }),
      "utf8",
    );
    const dir = await makeTempDir();
    const sessionFile = join(dir, "s.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const { paseo, listModels } = fakePaseo({
      id: "agent-3",
      provider: "pi",
      cwd: "/repo/app",
      persistence: { provider: "pi", sessionId: "s1", nativeHandle: sessionFile },
      runtimeInfo: { provider: "pi", sessionId: "s1", model: "aliyun/qwen3.8-max" },
    });

    const result = await new PiSessionResolver({ agentDir }).resolve("agent-3", paseo);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.contextWindowTokens).toBe(262_144);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("fills an unknown context window from provider models in the background", async () => {
    const agentDir = await makeTempDir();
    const dir = await makeTempDir();
    const sessionFile = join(dir, "s.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const { paseo, listModels } = fakePaseo(
      {
        id: "agent-3",
        provider: "pi",
        cwd: "/repo/app",
        persistence: { provider: "pi", sessionId: "s1", nativeHandle: sessionFile },
        runtimeInfo: { provider: "pi", sessionId: "s1", model: "aliyun/qwen3.8-max" },
      },
      { models: [{ id: "qwen3.8-max", contextWindowMaxTokens: 262_144 }] },
    );

    const resolver = new PiSessionResolver({ agentDir });
    const first = await resolver.resolve("agent-3", paseo);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    // Never block a usage read on multi-second provider discovery.
    expect(first.contextWindowTokens).toBeNull();
    expect(listModels).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await resolver.resolve("agent-3", paseo);
    if (second.kind !== "ok") throw new Error("expected ok");
    expect(second.contextWindowTokens).toBe(262_144);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("reports non-Pi agents and missing sessions distinctly", async () => {
    const codex = fakePaseo({ id: "agent-4", provider: "codex", cwd: "/repo/app" });
    expect(await new PiSessionResolver().resolve("agent-4", codex.paseo)).toEqual({ kind: "not_pi", provider: "codex" });

    const dir = await makeTempDir();
    const missing = fakePaseo({
      id: "agent-5",
      provider: "pi",
      cwd: dir,
      persistence: { provider: "pi", sessionId: "nope", nativeHandle: join(dir, "gone.jsonl") },
    });
    expect(await new PiSessionResolver().resolve("agent-5", missing.paseo)).toEqual({
      kind: "no_session",
      provider: "pi",
      sessionId: "nope",
    });
  });

  it("caches successful lookups and retries missing sessions quickly", async () => {
    const dir = await makeTempDir();
    const sessionFile = join(dir, "s.jsonl");
    await writeFile(sessionFile, "", "utf8");

    let now = 1_000;
    const { paseo, refresh } = fakePaseo({
      id: "agent-6",
      provider: "pi",
      cwd: dir,
      persistence: { provider: "pi", sessionId: "s1", nativeHandle: sessionFile },
    });
    const resolver = new PiSessionResolver({ now: () => now });

    await resolver.resolve("agent-6", paseo);
    await resolver.resolve("agent-6", paseo);
    expect(refresh).toHaveBeenCalledTimes(1);

    now += 5_000;
    await resolver.resolve("agent-6", paseo);
    expect(refresh).toHaveBeenCalledTimes(1);

    now += 121_000;
    await resolver.resolve("agent-6", paseo);
    expect(refresh).toHaveBeenCalledTimes(2);

    const missing = fakePaseo({ id: "agent-7", provider: "pi", cwd: dir });
    await resolver.resolve("agent-7", missing.paseo);
    await resolver.resolve("agent-7", missing.paseo);
    expect(missing.refresh).toHaveBeenCalledTimes(1);

    // A session that has not appeared yet is retried far sooner than a resolved one.
    now += 5_000;
    await resolver.resolve("agent-7", missing.paseo);
    expect(missing.refresh).toHaveBeenCalledTimes(2);
  });
});
