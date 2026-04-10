import { listSystemPresence } from "../../infra/system-presence.js";
import type { GatewayBroadcastFn } from "../server-broadcast.js";

export function broadcastPresenceSnapshot(params: {
  broadcast: GatewayBroadcastFn;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
}): number {
  const presenceVersion = params.incrementPresenceVersion();
  params.broadcast(
    "presence",
    { presence: listSystemPresence() },
    {
      dropIfSlow: true,
      stateVersion: {
        health: params.getHealthVersion(),
        presence: presenceVersion,
      },
    },
  );
  return presenceVersion;
}
