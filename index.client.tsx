import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startUsagePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  // The token view lives in the composer pill's popover: the only plugin surface
  // the host lets us dismiss programmatically (popover content receives close()).
  return startUsagePills(client);
}
