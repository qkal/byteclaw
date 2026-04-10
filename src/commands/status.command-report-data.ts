import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import type { Tone } from "../memory-host-sdk/status.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import type { SecurityAuditReport } from "../security/audit.js";
import type { RenderTableOptions, TableColumn } from "../terminal/table.js";
import type { HealthSummary } from "./health.js";
import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import {
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
} from "./status.command-sections.js";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import type { SessionStatus, StatusSummary } from "./status.types.js";

export async function buildStatusCommandReportData(params: {
  opts: {
    deep?: boolean;
    verbose?: boolean;
  };
  surface: StatusOverviewSurface;
  osSummary: ReturnType<typeof resolveOsSummary>;
  summary: StatusSummary;
  securityAudit?: SecurityAuditReport;
  health?: HealthSummary;
  usageLines?: string[];
  lastHeartbeat: HeartbeatEventPayload | null;
  agentStatus: {
    defaultId?: string | null;
    bootstrapPendingCount: number;
    totalSessions: number;
    agents: AgentLocalStatus[];
  };
  channels: {
    rows: {
      id: string;
      label: string;
      enabled: boolean;
      state: "ok" | "warn" | "off" | "setup";
      detail: string;
    }[];
  };
  channelIssues: {
    channel: string;
    message: string;
  }[];
  memory: MemoryStatusSnapshot | null;
  memoryPlugin: MemoryPluginStatus;
  pluginCompatibility: PluginCompatibilityNotice[];
  pairingRecovery: { requestId: string | null } | null;
  tableWidth: number;
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
  shortenText: (value: string, maxLen: number) => string;
  formatCliCommand: (value: string) => string;
  formatTimeAgo: (ageMs: number) => string;
  formatKTokens: (value: number) => string;
  formatTokensCompact: (value: SessionStatus) => string;
  formatPromptCacheCompact: (value: SessionStatus) => string | null;
  formatHealthChannelLines: (summary: HealthSummary, opts: { accountMode: "all" }) => string[];
  formatPluginCompatibilityNotice: (notice: PluginCompatibilityNotice) => string;
  formatUpdateAvailableHint: (update: StatusOverviewSurface["update"]) => string | null;
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
  accentDim: (value: string) => string;
  updateValue?: string;
  theme: {
    heading: (value: string) => string;
    muted: (value: string) => string;
    warn: (value: string) => string;
    error: (value: string) => string;
  };
  renderTable: (input: RenderTableOptions) => string;
}) {
  const overviewRows = buildStatusCommandOverviewRows({
    agentStatus: params.agentStatus,
    formatKTokens: params.formatKTokens,
    formatTimeAgo: params.formatTimeAgo,
    health: params.health,
    lastHeartbeat: params.lastHeartbeat,
    memory: params.memory,
    memoryPlugin: params.memoryPlugin,
    muted: params.muted,
    ok: params.ok,
    opts: params.opts,
    osLabel: params.osSummary.label,
    pluginCompatibility: params.pluginCompatibility,
    resolveMemoryCacheSummary: params.resolveMemoryCacheSummary,
    resolveMemoryFtsState: params.resolveMemoryFtsState,
    resolveMemoryVectorState: params.resolveMemoryVectorState,
    summary: params.summary,
    surface: params.surface,
    updateValue: params.updateValue,
    warn: params.warn,
  });

  const sessionsColumns = [
    { flex: true, header: "Key", key: "Key", minWidth: 20 },
    { header: "Kind", key: "Kind", minWidth: 6 },
    { header: "Age", key: "Age", minWidth: 9 },
    { header: "Model", key: "Model", minWidth: 14 },
    { header: "Tokens", key: "Tokens", minWidth: 16 },
    ...(params.opts.verbose ? [{ flex: true, header: "Cache", key: "Cache", minWidth: 16 }] : []),
  ] satisfies TableColumn[];
  const securityAudit = params.securityAudit ?? {
    findings: [],
    summary: { critical: 0, info: 0, warn: 0 },
  };

  return {
    channelsColumns: statusChannelsTableColumns,
    channelsRows: buildStatusChannelsTableRows({
      accentDim: params.accentDim,
      channelIssues: params.channelIssues,
      formatIssueMessage: (message) => params.shortenText(message, 84),
      muted: params.muted,
      ok: params.ok,
      rows: params.channels.rows,
      warn: params.warn,
    }),
    footerLines: buildStatusFooterLines({
      formatCliCommand: params.formatCliCommand,
      gatewayReachable: params.surface.gatewayReachable,
      nodeOnlyGateway: params.surface.nodeOnlyGateway,
      updateHint: params.formatUpdateAvailableHint(params.surface.update),
      warn: params.theme.warn,
    }),
    heading: params.theme.heading,
    healthColumns: params.health ? statusHealthColumns : undefined,
    healthRows: params.health
      ? buildStatusHealthRows({
          formatHealthChannelLines: params.formatHealthChannelLines,
          health: params.health,
          muted: params.muted,
          ok: params.ok,
          warn: params.warn,
        })
      : undefined,
    muted: params.theme.muted,
    overviewRows,
    pairingRecoveryLines: buildStatusPairingRecoveryLines({
      formatCliCommand: params.formatCliCommand,
      muted: params.theme.muted,
      pairingRecovery: params.pairingRecovery,
      warn: params.theme.warn,
    }),
    pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
      formatNotice: params.formatPluginCompatibilityNotice,
      muted: params.theme.muted,
      notices: params.pluginCompatibility,
      warn: params.theme.warn,
    }),
    renderTable: params.renderTable,
    securityAuditLines: buildStatusSecurityAuditLines({
      formatCliCommand: params.formatCliCommand,
      securityAudit,
      shortenText: params.shortenText,
      theme: params.theme,
    }),
    sessionsColumns,
    sessionsRows: buildStatusSessionsRows({
      formatPromptCacheCompact: params.formatPromptCacheCompact,
      formatTimeAgo: params.formatTimeAgo,
      formatTokensCompact: params.formatTokensCompact,
      muted: params.muted,
      recent: params.summary.sessions.recent,
      shortenText: params.shortenText,
      verbose: params.opts.verbose,
    }),
    showTaskMaintenanceHint: params.summary.taskAudit.errors > 0,
    systemEventsRows: buildStatusSystemEventsRows({
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    systemEventsTrailer: buildStatusSystemEventsTrailer({
      muted: params.muted,
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    taskMaintenanceHint: `Task maintenance: ${params.formatCliCommand("openclaw tasks maintenance --apply")}`,
    usageLines: params.usageLines,
    width: params.tableWidth,
  };
}
