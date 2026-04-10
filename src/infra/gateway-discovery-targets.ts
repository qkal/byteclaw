import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  type GatewayBonjourBeacon,
  type GatewayDiscoveryResolvedEndpoint,
  resolveGatewayDiscoveryEndpoint,
} from "./bonjour-discovery.js";

export interface GatewayDiscoveryTarget {
  title: string;
  domain: string;
  endpoint: GatewayDiscoveryResolvedEndpoint | null;
  wsUrl: string | null;
  sshPort: number | null;
  sshTarget: string | null;
}

function pickSshPort(beacon: GatewayBonjourBeacon): number | null {
  return typeof beacon.sshPort === "number" && Number.isFinite(beacon.sshPort) && beacon.sshPort > 0
    ? beacon.sshPort
    : null;
}

export function buildGatewayDiscoveryTarget(
  beacon: GatewayBonjourBeacon,
  opts?: { sshUser?: string | null },
): GatewayDiscoveryTarget {
  const endpoint = resolveGatewayDiscoveryEndpoint(beacon);
  const sshPort = pickSshPort(beacon);
  const sshUser = normalizeOptionalString(opts?.sshUser) ?? "";
  const baseSshTarget = endpoint ? (sshUser ? `${sshUser}@${endpoint.host}` : endpoint.host) : null;
  const sshTarget =
    baseSshTarget && sshPort && sshPort !== 22 ? `${baseSshTarget}:${sshPort}` : baseSshTarget;
  return {
    domain: normalizeOptionalString(beacon.domain || "local.") ?? "local.",
    endpoint,
    sshPort,
    sshTarget,
    title:
      normalizeOptionalString(beacon.displayName || beacon.instanceName || "Gateway") ?? "Gateway",
    wsUrl: endpoint?.wsUrl ?? null,
  };
}

export function buildGatewayDiscoveryLabel(beacon: GatewayBonjourBeacon): string {
  const target = buildGatewayDiscoveryTarget(beacon);
  const hint = target.endpoint ? `${target.endpoint.host}:${target.endpoint.port}` : "host unknown";
  return `${target.title} (${hint})`;
}

export function serializeGatewayDiscoveryBeacon(beacon: GatewayBonjourBeacon) {
  const target = buildGatewayDiscoveryTarget(beacon);
  return {
    displayName: beacon.displayName ?? null,
    domain: beacon.domain ?? null,
    gatewayPort: beacon.gatewayPort ?? null,
    host: beacon.host ?? null,
    instanceName: beacon.instanceName,
    lanHost: beacon.lanHost ?? null,
    sshPort: beacon.sshPort ?? null,
    tailnetDns: beacon.tailnetDns ?? null,
    wsUrl: target.wsUrl,
  };
}
