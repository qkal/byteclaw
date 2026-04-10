import { formatCliCommand } from "../cli/command-format.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { Tone } from "../memory-host-sdk/status.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { VERSION } from "../version.js";
import type { HealthSummary } from "./health.js";
import {
  type StatusOverviewSurface,
  buildStatusOverviewRowsFromSurface,
} from "./status-overview-surface.ts";
import {
  buildStatusAllAgentsValue,
  buildStatusEventsValue,
  buildStatusPluginCompatibilityValue,
  buildStatusProbesValue,
  buildStatusSecretsValue,
  buildStatusSessionsOverviewValue,
} from "./status-overview-values.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import {
  buildStatusAgentsValue,
  buildStatusHeartbeatValue,
  buildStatusLastHeartbeatValue,
  buildStatusMemoryValue,
  buildStatusTasksValue,
} from "./status.command-sections.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import type { StatusSummary } from "./status.types.js";

export function buildStatusCommandOverviewRows(params: {
  opts: {
    deep?: boolean;
  };
  surface: StatusOverviewSurface;
  osLabel: string;
  summary: StatusSummary;
  health?: HealthSummary;
  lastHeartbeat: HeartbeatEventPayload | null;
  agentStatus: {
    defaultId?: string | null;
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: AgentLocalStatus[];
  };
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
  formatTimeAgo: (ageMs: number) => string;
  formatKTokens: (value: number) => string;
  resolveMemoryVectorState: (value: NonNullable<MemoryStatusSnapshot["vector"]>) => {
    state: string;
    tone: Tone;
  };
  resolveMemoryFtsState: (value: NonNullable<MemoryStatusSnapshot["fts"]>) => {
    state: string;
    tone: Tone;
  };
  resolveMemoryCacheSummary: (value: NonNullable<MemoryStatusSnapshot["cache"]>) => {
    text: string;
    tone: Tone;
  };
  updateValue?: string;
}) {
  const agentsValue = buildStatusAgentsValue({
    agentStatus: params.agentStatus,
    formatTimeAgo: params.formatTimeAgo,
  });
  const eventsValue = buildStatusEventsValue({
    queuedSystemEvents: params.summary.queuedSystemEvents,
  });
  const tasksValue = buildStatusTasksValue({
    muted: params.muted,
    summary: params.summary,
    warn: params.warn,
  });
  const probesValue = buildStatusProbesValue({
    health: params.health,
    muted: params.muted,
    ok: params.ok,
  });
  const heartbeatValue = buildStatusHeartbeatValue({ summary: params.summary });
  const lastHeartbeatValue = buildStatusLastHeartbeatValue({
    deep: params.opts.deep,
    formatTimeAgo: params.formatTimeAgo,
    gatewayReachable: params.surface.gatewayReachable,
    lastHeartbeat: params.lastHeartbeat,
    muted: params.muted,
    warn: params.warn,
  });
  const memoryValue = buildStatusMemoryValue({
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    muted: params.muted,
    ok: params.ok,
    resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
    resolveMemoryFtsState: params.resolveMemoryFtsState,
    resolveMemoryVectorState: params.resolveMemoryVectorState,
    warn: params.warn,
  });
  const pluginCompatibilityValue = buildStatusPluginCompatibilityValue({
    notices: params.pluginCompatibility,
    ok: params.ok,
    warn: params.warn,
  });

  return buildStatusOverviewRowsFromSurface({
    agentsValue,
    decorateOk: params.ok,
    decorateTailscaleOff: params.muted,
    decorateTailscaleWarn: params.warn,
    decorateWarn: params.warn,
    gatewayAuthWarningValue: params.surface.gatewayProbeAuthWarning
      ? params.warn(params.surface.gatewayProbeAuthWarning)
      : null,
    prefixRows: [{ Item: "OS", Value: `${params.osLabel} · node ${process.versions.node}` }],
    suffixRows: [
      { Item: "Memory", Value: memoryValue },
      { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
      { Item: "Probes", Value: probesValue },
      { Item: "Events", Value: eventsValue },
      { Item: "Tasks", Value: tasksValue },
      { Item: "Heartbeat", Value: heartbeatValue },
      ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
      {
        Item: "Sessions",
        Value: buildStatusSessionsOverviewValue({
          formatKTokens: params.formatKTokens,
          sessions: params.summary.sessions,
        }),
      },
    ],
    surface: params.surface,
    updateValue: params.updateValue,
  });
}

export function buildStatusAllOverviewRows(params: {
  surface: StatusOverviewSurface;
  osLabel: string;
  configPath: string;
  secretDiagnosticsCount: number;
  agentStatus: {
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: {
      id: string;
      lastActiveAgeMs?: number | null;
    }[];
  };
  tailscaleBackendState?: string | null;
}) {
  return buildStatusOverviewRowsFromSurface({
    agentsValue: buildStatusAllAgentsValue({
      agentStatus: params.agentStatus,
    }),
    gatewaySelfFallbackValue: "unknown",
    includeBackendStateWhenOff: true,
    includeBackendStateWhenOn: true,
    includeDnsNameWhenOff: true,
    middleRows: [
      { Item: "Security", Value: `Run: ${formatCliCommand("openclaw security audit --deep")}` },
    ],
    prefixRows: [
      { Item: "Version", Value: VERSION },
      { Item: "OS", Value: params.osLabel },
      { Item: "Node", Value: process.versions.node },
      { Item: "Config", Value: params.configPath },
    ],
    suffixRows: [
      {
        Item: "Secrets",
        Value: buildStatusSecretsValue(params.secretDiagnosticsCount),
      },
    ],
    surface: params.surface,
    tailscaleBackendState: params.tailscaleBackendState,
  });
}
