import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import type { StatusScanOverviewResult } from "./status.scan-overview.ts";
import { resolveStatusSummaryFromOverview } from "./status.scan-overview.ts";
import { type StatusScanResult, buildStatusScanResult } from "./status.scan-result.ts";
import {
  type MemoryPluginStatus,
  type MemoryStatusSnapshot,
  resolveMemoryPluginStatus,
} from "./status.scan.shared.js";

export async function executeStatusScanFromOverview(params: {
  overview: StatusScanOverviewResult;
  runtime?: RuntimeEnv;
  resolveMemory: (args: {
    cfg: StatusScanOverviewResult["cfg"];
    agentStatus: StatusScanOverviewResult["agentStatus"];
    memoryPlugin: MemoryPluginStatus;
    runtime?: RuntimeEnv;
  }) => Promise<MemoryStatusSnapshot | null>;
  channelIssues: StatusScanResult["channelIssues"];
  channels: StatusScanResult["channels"];
  pluginCompatibility: PluginCompatibilityNotice[];
}) {
  const memoryPlugin = resolveMemoryPluginStatus(params.overview.cfg);
  const [memory, summary] = await Promise.all([
    params.resolveMemory({
      agentStatus: params.overview.agentStatus,
      cfg: params.overview.cfg,
      memoryPlugin,
      ...(params.runtime ? { runtime: params.runtime } : {}),
    }),
    resolveStatusSummaryFromOverview({ overview: params.overview }),
  ]);

  return buildStatusScanResult({
    agentStatus: params.overview.agentStatus,
    cfg: params.overview.cfg,
    channelIssues: params.channelIssues,
    channels: params.channels,
    gatewaySnapshot: params.overview.gatewaySnapshot,
    memory,
    memoryPlugin,
    osSummary: params.overview.osSummary,
    pluginCompatibility: params.pluginCompatibility,
    secretDiagnostics: params.overview.secretDiagnostics,
    sourceConfig: params.overview.sourceConfig,
    summary,
    tailscaleDns: params.overview.tailscaleDns,
    tailscaleHttpsUrl: params.overview.tailscaleHttpsUrl,
    tailscaleMode: params.overview.tailscaleMode,
    update: params.overview.update,
  });
}
