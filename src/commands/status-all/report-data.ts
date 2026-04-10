import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../../config/config.js";
import { readLastGatewayErrorLine } from "../../daemon/diagnostics.js";
import { inspectPortUsage } from "../../infra/ports.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildPluginCompatibilityNotices } from "../../plugins/status.js";
import { buildStatusAllOverviewRows } from "../status-overview-rows.ts";
import {
  type StatusOverviewSurface,
  buildStatusOverviewSurfaceFromOverview,
} from "../status-overview-surface.ts";
import {
  resolveStatusGatewayHealthSafe,
  type resolveStatusServiceSummaries,
} from "../status-runtime-shared.ts";
import { resolveStatusAllConnectionDetails } from "../status.gateway-connection.ts";
import type { NodeOnlyGatewayInfo } from "../status.node-mode.js";
import type { StatusScanOverviewResult } from "../status.scan-overview.ts";

type StatusServiceSummaries = Awaited<ReturnType<typeof resolveStatusServiceSummaries>>;
type StatusGatewayServiceSummary = StatusServiceSummaries[0];
type StatusNodeServiceSummary = StatusServiceSummaries[1];
type StatusGatewayHealthSafe = Awaited<ReturnType<typeof resolveStatusGatewayHealthSafe>>;
type ConfigFileSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshot>>;

interface StatusAllProgress {
  setLabel(label: string): void;
  tick(): void;
}

function resolveStatusAllConfigPath(path: string | null | undefined): string {
  const trimmed = path?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "(unknown config path)";
}

async function resolveStatusAllLocalDiagnosis(params: {
  overview: StatusScanOverviewResult;
  progress: StatusAllProgress;
  gatewayReachable: boolean;
  gatewayProbe: StatusScanOverviewResult["gatewaySnapshot"]["gatewayProbe"];
  gatewayCallOverrides: StatusScanOverviewResult["gatewaySnapshot"]["gatewayCallOverrides"];
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  timeoutMs?: number;
}): Promise<{
  configPath: string;
  health: StatusGatewayHealthSafe | undefined;
  diagnosis: {
    snap: ConfigFileSnapshot | null;
    remoteUrlMissing: boolean;
    secretDiagnostics: StatusScanOverviewResult["secretDiagnostics"];
    sentinel: Awaited<ReturnType<typeof readRestartSentinel>> | null;
    lastErr: string | null;
    port: number;
    portUsage: Awaited<ReturnType<typeof inspectPortUsage>> | null;
    tailscaleMode: string;
    tailscale: {
      backendState: null;
      dnsName: string | null;
      ips: string[];
      error: null;
    };
    tailscaleHttpsUrl: string | null;
    skillStatus: ReturnType<typeof buildWorkspaceSkillStatus> | null;
    pluginCompatibility: ReturnType<typeof buildPluginCompatibilityNotices>;
    channelsStatus: StatusScanOverviewResult["channelsStatus"];
    channelIssues: StatusScanOverviewResult["channelIssues"];
    gatewayReachable: boolean;
    health: StatusGatewayHealthSafe | undefined;
    nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  };
}> {
  const { overview } = params;
  const snap = await readConfigFileSnapshot().catch(() => null);
  const configPath = resolveStatusAllConfigPath(snap?.path);

  const health = params.nodeOnlyGateway
    ? undefined
    : await resolveStatusGatewayHealthSafe({
        config: overview.cfg,
        gatewayProbeError: params.gatewayProbe?.error ?? null,
        gatewayReachable: params.gatewayReachable,
        timeoutMs: Math.min(8000, params.timeoutMs ?? 10_000),
        ...(params.gatewayCallOverrides ? { callOverrides: params.gatewayCallOverrides } : {}),
      });

  params.progress.setLabel("Checking local state…");
  const sentinel = await readRestartSentinel().catch(() => null);
  const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
  const port = resolveGatewayPort(overview.cfg);
  const portUsage = await inspectPortUsage(port).catch(() => null);
  params.progress.tick();

  const defaultWorkspace =
    overview.agentStatus.agents.find((a) => a.id === overview.agentStatus.defaultId)
      ?.workspaceDir ??
    overview.agentStatus.agents[0]?.workspaceDir ??
    null;
  const skillStatus =
    defaultWorkspace != null
      ? (() => {
          try {
            return buildWorkspaceSkillStatus(defaultWorkspace, {
              config: overview.cfg,
              eligibility: {
                remote: getRemoteSkillEligibility({
                  advertiseExecNode: canExecRequestNode({
                    agentId: overview.agentStatus.defaultId,
                    cfg: overview.cfg,
                  }),
                }),
              },
            });
          } catch {
            return null;
          }
        })()
      : null;
  const pluginCompatibility = buildPluginCompatibilityNotices({ config: overview.cfg });

  return {
    configPath,
    diagnosis: {
      channelIssues: overview.channelIssues,
      channelsStatus: overview.channelsStatus,
      gatewayReachable: params.gatewayReachable,
      health,
      lastErr,
      nodeOnlyGateway: params.nodeOnlyGateway,
      pluginCompatibility,
      port,
      portUsage,
      remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
      secretDiagnostics: overview.secretDiagnostics,
      sentinel,
      skillStatus,
      snap,
      tailscale: {
        backendState: null,
        dnsName: overview.tailscaleDns,
        error: null,
        ips: [],
      },
      tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
      tailscaleMode: overview.tailscaleMode,
    },
    health,
  };
}

export async function buildStatusAllReportData(params: {
  overview: StatusScanOverviewResult;
  daemon: StatusGatewayServiceSummary;
  nodeService: StatusNodeServiceSummary;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  progress: StatusAllProgress;
  timeoutMs?: number;
}) {
  const { gatewaySnapshot } = params.overview;
  const { configPath, health, diagnosis } = await resolveStatusAllLocalDiagnosis({
    gatewayCallOverrides: gatewaySnapshot.gatewayCallOverrides,
    gatewayProbe: gatewaySnapshot.gatewayProbe,
    gatewayReachable: gatewaySnapshot.gatewayReachable,
    nodeOnlyGateway: params.nodeOnlyGateway,
    overview: params.overview,
    progress: params.progress,
    timeoutMs: params.timeoutMs,
  });

  const overviewSurface: StatusOverviewSurface = buildStatusOverviewSurfaceFromOverview({
    gatewayService: params.daemon,
    nodeOnlyGateway: params.nodeOnlyGateway,
    nodeService: params.nodeService,
    overview: params.overview,
  });
  const overviewRows = buildStatusAllOverviewRows({
    agentStatus: params.overview.agentStatus,
    configPath,
    osLabel: params.overview.osSummary.label,
    secretDiagnosticsCount: params.overview.secretDiagnostics.length,
    surface: overviewSurface,
    tailscaleBackendState: diagnosis.tailscale.backendState,
  });

  return {
    agentStatus: params.overview.agentStatus,
    channelIssues: params.overview.channelIssues.map((issue) => ({
      channel: issue.channel,
      message: issue.message,
    })),
    channels: params.overview.channels,
    connectionDetailsForReport: resolveStatusAllConnectionDetails({
      bindMode: params.overview.cfg.gateway?.bind ?? "loopback",
      configPath,
      gatewayConnection: gatewaySnapshot.gatewayConnection,
      nodeOnlyGateway: params.nodeOnlyGateway,
      remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
    }),
    diagnosis: {
      ...diagnosis,
      health,
    },
    overviewRows,
  };
}
