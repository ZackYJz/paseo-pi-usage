import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PiUsageService } from "./server/usageService";
import { piUsageCallsRpc, piUsageSnapshotRpc } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  const usage = new PiUsageService();

  server.handle(piUsageSnapshotRpc, ({ agentIds }, { paseo }) => usage.snapshot(agentIds, paseo));
  server.handle(piUsageCallsRpc, ({ agentId, limit }, { paseo }) => usage.calls(agentId, limit, paseo));

  return () => {};
}
