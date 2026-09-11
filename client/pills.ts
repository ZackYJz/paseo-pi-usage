import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { buildPillLabel, buildPillTooltip } from "../shared/format";
import { PI_USAGE_PANEL_ID, piUsageSnapshotRpc, type UsageSnapshot } from "../shared/usage";
import { PiUsagePopover } from "./panel";

/**
 * Per-agent composer pill that behaves like Pi's status bar: it shows cumulative
 * ↑input ↓output and the session-wide cache hit rate, and opens the detail panel.
 * The hover tooltip carries the full breakdown (cache, cost, context).
 *
 * Paseo's own agent snapshot only carries `lastUsage` (one turn), so totals come
 * from the daemon handler that reads Pi's session JSONL.
 */

const FAST_INTERVAL_MS = 2500;
const HOT_WINDOW_MS = 2 * 60_000;
const BATCH_SIZE = 40;
const MAX_POLLED_PER_TICK = 120;
const BOOTSTRAP_PAGE_SIZE = 200;
const MAX_BOOTSTRAP_PAGES = 5;
const ERROR_LOG_COOLDOWN_MS = 30_000;

interface TrackedAgent {
  id: string;
  workspaceId: string;
  status: string;
  /** Last time Paseo reported activity for this agent; 0 when unknown. */
  activityAt: number;
  /** Set when Paseo reports a change we have not reflected in a poll yet. */
  dirty: boolean;
  label: string | null;
  tooltip: string | null;
  registration: PluginButtonRegistration;
}

interface AgentLike {
  id: string;
  provider: string;
  workspaceId?: string | null;
  status?: string | null;
  lastUserMessageAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  archivedAt?: string | null;
}

/** Paseo's agent snapshot has no `lastActivityAt`, so derive one. */
function activityOf(agent: AgentLike): number {
  for (const value of [agent.lastUserMessageAt, agent.updatedAt, agent.createdAt]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function startUsagePills(client: PluginClientContext): () => void {
  const tracked = new Map<string, TrackedAgent>();
  let stopped = false;
  let inFlight = false;
  let lastErrorLog = 0;

  function labelFor(snapshot: UsageSnapshot): string {
    return buildPillLabel({
      status: snapshot.status,
      totals: snapshot.totals,
    });
  }

  function tooltipFor(snapshot: UsageSnapshot): string {
    return buildPillTooltip({
      status: snapshot.status,
      totals: snapshot.totals,
      contextPercent: snapshot.contextPercent,
    });
  }

  function track(agent: AgentLike): void {
    if (stopped) return;
    const workspaceId = agent.workspaceId ?? null;
    const eligible = agent.provider === "pi" && workspaceId !== null && !agent.archivedAt;
    const existing = tracked.get(agent.id);

    if (!eligible) {
      if (existing) {
        existing.registration.remove();
        tracked.delete(agent.id);
      }
      return;
    }

    const status = agent.status ?? "idle";
    const activityAt = activityOf(agent);

    if (existing) {
      if (existing.status !== status || existing.activityAt !== activityAt) {
        existing.status = status;
        existing.activityAt = activityAt;
        existing.dirty = true;
      }
      return;
    }

    const registration = client.addComposerPill({
      id: PI_USAGE_PANEL_ID,
      workspaceId: workspaceId as string,
      agentId: agent.id,
      button: {
        title: "Pi token 用量",
        icon: "Gauge",
        label: "π …",
        behavior: {
          kind: "popover",
          Content: PiUsagePopover,
        },
      },
    });

    tracked.set(agent.id, {
      id: agent.id,
      workspaceId: workspaceId as string,
      status,
      activityAt,
      dirty: true,
      label: null,
      tooltip: null,
      registration,
    });
  }

  function forget(agentId: string): void {
    const existing = tracked.get(agentId);
    if (!existing) return;
    existing.registration.remove();
    tracked.delete(agentId);
  }

  /**
   * Running or recently active agents poll every tick; quiet ones only when
   * Paseo reports a change, so an idle directory costs one read per agent.
   */
  function pollTargets(now: number): string[] {
    const ids: string[] = [];
    for (const agent of tracked.values()) {
      const active =
        agent.status === "running" || agent.status === "initializing" || now - agent.activityAt < HOT_WINDOW_MS;
      if (agent.dirty || active) ids.push(agent.id);
    }
    return ids.slice(0, MAX_POLLED_PER_TICK);
  }

  function applySnapshots(agents: readonly UsageSnapshot[]): void {
    for (const snapshot of agents) {
      const agent = tracked.get(snapshot.agentId);
      if (!agent) continue;
      const label = labelFor(snapshot);
      const tooltip = tooltipFor(snapshot);
      if (label === agent.label && tooltip === agent.tooltip) continue;
      agent.label = label;
      agent.tooltip = tooltip;
      agent.registration.update({ label, title: tooltip });
    }
  }

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    const agentIds = pollTargets(Date.now());
    if (agentIds.length === 0) return;

    inFlight = true;
    try {
      for (let i = 0; i < agentIds.length && !stopped; i += BATCH_SIZE) {
        const batch = agentIds.slice(i, i + BATCH_SIZE);
        const result = await client.rpc(piUsageSnapshotRpc, { agentIds: batch });
        applySnapshots(result.agents);
        // Only clear the flag once the numbers for that agent actually arrived.
        for (const snapshot of result.agents) {
          const agent = tracked.get(snapshot.agentId);
          if (agent && snapshot.status !== "error") agent.dirty = false;
        }
      }
    } catch (error) {
      const now = Date.now();
      if (now - lastErrorLog > ERROR_LOG_COOLDOWN_MS) {
        lastErrorLog = now;
        console.error(`[pi-usage] snapshot poll failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      inFlight = false;
    }
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") track(update.agent);
    else if (update.kind === "remove") forget(update.agentId);
  });

  // `agents.subscribe` only mirrors an observation, so own one to seed existing agents.
  let releaseDirectory: (() => void) | null = null;
  void (async () => {
    try {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_BOOTSTRAP_PAGES && !stopped; page += 1) {
        const directory = await client.paseo.agents.list({
          filter: { includeArchived: false },
          page: cursor ? { limit: BOOTSTRAP_PAGE_SIZE, cursor } : { limit: BOOTSTRAP_PAGE_SIZE },
          subscribe: page === 0 ? {} : undefined,
        });
        if (stopped) return;
        for (const entry of directory.entries) track(entry.agent);
        if (page === 0) {
          const subscription = (directory as { subscription?: { release?: () => void } }).subscription;
          if (subscription?.release) releaseDirectory = () => subscription.release?.();
        }
        if (!directory.pageInfo.hasMore || !directory.pageInfo.nextCursor) break;
        cursor = directory.pageInfo.nextCursor;
      }
      await tick();
    } catch (error) {
      if (stopped) return;
      console.error(`[pi-usage] agent directory bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  const timer = setInterval(() => {
    void tick();
  }, FAST_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    releaseDirectory?.();
    for (const agent of tracked.values()) agent.registration.remove();
    tracked.clear();
  };
}
