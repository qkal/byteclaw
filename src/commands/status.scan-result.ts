import type { OpenClawConfig } from "../config/config.js";
import type { collectChannelStatusIssues as collectChannelStatusIssuesFn } from "../infra/channels-status-issues.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { buildChannelsTable as buildChannelsTableFn } from "./status-all/channels.js";
import type { getAgentLocalStatuses as getAgentLocalStatusesFn } from "./status.agent-local.js";
import type {
  GatewayProbeSnapshot,
  MemoryPluginStatus,
  MemoryStatusSnapshot,
  pickGatewaySelfPresence,
} from "./status.scan.shared.js";
import type { getStatusSummary as getStatusSummaryFn } from "./status.summary.js";

export interface StatusScanResult {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: UpdateCheckResult;
  gatewayConnection: GatewayProbeSnapshot["gatewayConnection"];
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: GatewayProbeSnapshot["gatewayProbe"];
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  summary: Awaited<ReturnType<typeof getStatusSummaryFn>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
}

export function buildStatusScanResult(params: {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  secretDiagnostics: string[];
  osSummary: ReturnType<typeof resolveOsSummary>;
  tailscaleMode: string;
  tailscaleDns: string | null;
  tailscaleHttpsUrl: string | null;
  update: UpdateCheckResult;
  gatewaySnapshot: Pick<
    GatewayProbeSnapshot,
    | "gatewayConnection"
    | "remoteUrlMissing"
    | "gatewayMode"
    | "gatewayProbeAuth"
    | "gatewayProbeAuthWarning"
    | "gatewayProbe"
    | "gatewayReachable"
    | "gatewaySelf"
  >;
  channelIssues: ReturnType<typeof collectChannelStatusIssuesFn>;
  agentStatus: Awaited<ReturnType<typeof getAgentLocalStatusesFn>>;
  channels: Awaited<ReturnType<typeof buildChannelsTableFn>>;
  summary: Awaited<ReturnType<typeof getStatusSummaryFn>>;
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
}): StatusScanResult {
  return {
    agentStatus: params.agentStatus,
    cfg: params.cfg,
    channelIssues: params.channelIssues,
    channels: params.channels,
    gatewayConnection: params.gatewaySnapshot.gatewayConnection,
    gatewayMode: params.gatewaySnapshot.gatewayMode,
    gatewayProbe: params.gatewaySnapshot.gatewayProbe,
    gatewayProbeAuth: params.gatewaySnapshot.gatewayProbeAuth,
    gatewayProbeAuthWarning: params.gatewaySnapshot.gatewayProbeAuthWarning,
    gatewayReachable: params.gatewaySnapshot.gatewayReachable,
    gatewaySelf: params.gatewaySnapshot.gatewaySelf,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    osSummary: params.osSummary,
    pluginCompatibility: params.pluginCompatibility,
    remoteUrlMissing: params.gatewaySnapshot.remoteUrlMissing,
    secretDiagnostics: params.secretDiagnostics,
    sourceConfig: params.sourceConfig,
    summary: params.summary,
    tailscaleDns: params.tailscaleDns,
    tailscaleHttpsUrl: params.tailscaleHttpsUrl,
    tailscaleMode: params.tailscaleMode,
    update: params.update,
  };
}
