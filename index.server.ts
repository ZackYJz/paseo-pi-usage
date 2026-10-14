import type { PluginServerContext } from "@getpaseo/plugin/server";
import { PiUsageService } from "./server/usageService";
import { piUsageDetailRpc, piUsageSnapshotRpc } from "./shared/usage";

export default function contribute(server: PluginServerContext) {
  const usage = new PiUsageService();

  server.handle(piUsageSnapshotRpc, ({ agentIds }, { paseo }) => usage.snapshot(agentIds, paseo));
  server.handle(piUsageDetailRpc, ({ agentId, callLimit }, { paseo }) => usage.detail(agentId, callLimit, paseo));

  return () => {};
}
