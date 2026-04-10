import { withProgress } from "../cli/progress.js";
import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import {
  loadStatusProviderUsageModule,
  resolveStatusGatewayHealth,
  resolveStatusRuntimeSnapshot,
  resolveStatusSecurityAudit,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";
import { buildStatusCommandReportLines } from "./status.command-report.ts";
import { logGatewayConnectionDetails } from "./status.gateway-connection.ts";

let statusScanModulePromise: Promise<typeof import("./status.scan.js")> | undefined;
let statusScanFastJsonModulePromise:
  | Promise<typeof import("./status.scan.fast-json.js")>
  | undefined;
let statusAllModulePromise: Promise<typeof import("./status-all.js")> | undefined;
let statusCommandTextRuntimePromise:
  | Promise<typeof import("./status.command.text-runtime.js")>
  | undefined;
let statusGatewayConnectionRuntimePromise:
  | Promise<typeof import("./status.gateway-connection.runtime.js")>
  | undefined;
let statusNodeModeModulePromise: Promise<typeof import("./status.node-mode.js")> | undefined;

function loadStatusScanModule() {
  statusScanModulePromise ??= import("./status.scan.js");
  return statusScanModulePromise;
}

function loadStatusScanFastJsonModule() {
  statusScanFastJsonModulePromise ??= import("./status.scan.fast-json.js");
  return statusScanFastJsonModulePromise;
}

function loadStatusAllModule() {
  statusAllModulePromise ??= import("./status-all.js");
  return statusAllModulePromise;
}

function loadStatusCommandTextRuntime() {
  statusCommandTextRuntimePromise ??= import("./status.command.text-runtime.js");
  return statusCommandTextRuntimePromise;
}

function loadStatusGatewayConnectionRuntime() {
  statusGatewayConnectionRuntimePromise ??= import("./status.gateway-connection.runtime.js");
  return statusGatewayConnectionRuntimePromise;
}

function loadStatusNodeModeModule() {
  statusNodeModeModulePromise ??= import("./status.node-mode.js");
  return statusNodeModeModulePromise;
}

function resolvePairingRecoveryContext(params: {
  error?: string | null;
  closeReason?: string | null;
}): { requestId: string | null } | null {
  const sanitizeRequestId = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    // Keep CLI guidance injection-safe: allow only compact id characters.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) {
      return null;
    }
    return trimmed;
  };
  const source = [params.error, params.closeReason]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  if (!source || !/pairing required/i.test(source)) {
    return null;
  }
  const requestIdMatch = source.match(/requestId:\s*([^\s)]+)/i);
  const requestId =
    requestIdMatch && requestIdMatch[1] ? sanitizeRequestId(requestIdMatch[1]) : null;
  return { requestId: requestId || null };
}

export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  if (opts.all && !opts.json) {
    await loadStatusAllModule().then(({ statusAllCommand }) =>
      statusAllCommand(runtime, { timeoutMs: opts.timeoutMs }),
    );
    return;
  }

  if (opts.json) {
    await runStatusJsonCommand({
      includePluginCompatibility: true,
      includeSecurityAudit: opts.all === true,
      opts,
      runtime,
      scanStatusJsonFast: async (scanOpts, runtimeForScan) =>
        await loadStatusScanFastJsonModule().then(({ scanStatusJsonFast }) =>
          scanStatusJsonFast(scanOpts, runtimeForScan),
        ),
      suppressHealthErrors: true,
    });
    return;
  }

  const scan = await loadStatusScanModule().then(({ scanStatus }) =>
    scanStatus({ all: opts.all, json: false, timeoutMs: opts.timeoutMs }, runtime),
  );

  const {
    cfg,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues,
    agentStatus,
    channels,
    summary,
    secretDiagnostics,
    memory,
    memoryPlugin,
    pluginCompatibility,
  } = scan;

  const {
    securityAudit,
    usage,
    health,
    lastHeartbeat,
    gatewayService: daemon,
    nodeService: nodeDaemon,
  } = await resolveStatusRuntimeSnapshot({
    config: scan.cfg,
    deep: opts.deep,
    gatewayReachable,
    includeSecurityAudit: true,
    resolveHealth: async (input) =>
      await withProgress(
        {
          enabled: opts.json !== true,
          indeterminate: true,
          label: "Checking gateway health…",
        },
        async () => await resolveStatusGatewayHealth(input),
      ),
    resolveSecurityAudit: async (input) =>
      await withProgress(
        {
          enabled: true,
          indeterminate: true,
          label: "Running security audit…",
        },
        async () => await resolveStatusSecurityAudit(input),
      ),
    resolveUsage: async (timeoutMs) =>
      await withProgress(
        {
          enabled: opts.json !== true,
          indeterminate: true,
          label: "Fetching usage snapshot…",
        },
        async () => await resolveStatusUsageSummary(timeoutMs),
      ),
    sourceConfig: scan.sourceConfig,
    timeoutMs: opts.timeoutMs,
    usage: opts.usage,
  });

  const rich = true;
  const {
    buildStatusUpdateSurface,
    formatCliCommand,
    formatHealthChannelLines,
    formatKTokens,
    formatPromptCacheCompact,
    formatPluginCompatibilityNotice,
    formatTimeAgo,
    formatTokensCompact,
    formatUpdateAvailableHint,
    getTerminalTableWidth,
    info,
    renderTable,
    resolveMemoryCacheSummary,
    resolveMemoryFtsState,
    resolveMemoryVectorState,
    shortenText,
    theme,
  } = await loadStatusCommandTextRuntime();
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);
  const updateSurface = buildStatusUpdateSurface({
    update,
    updateConfigChannel: cfg.update?.channel,
  });

  if (opts.verbose) {
    const { buildGatewayConnectionDetails } = await loadStatusGatewayConnectionRuntime();
    const details = buildGatewayConnectionDetails({ config: scan.cfg });
    logGatewayConnectionDetails({
      info,
      message: details.message,
      runtime,
      trailingBlankLine: true,
    });
  }

  const tableWidth = getTerminalTableWidth();

  if (secretDiagnostics.length > 0) {
    runtime.log(theme.warn("Secret diagnostics:"));
    for (const entry of secretDiagnostics) {
      runtime.log(`- ${entry}`);
    }
    runtime.log("");
  }

  const nodeOnlyGateway = await loadStatusNodeModeModule().then(({ resolveNodeOnlyGatewayInfo }) =>
    resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeDaemon,
    }),
  );
  const pairingRecovery = resolvePairingRecoveryContext({
    closeReason: gatewayProbe?.close?.reason ?? null,
    error: gatewayProbe?.error ?? null,
  });

  const usageLines = usage
    ? await loadStatusProviderUsageModule().then(({ formatUsageReportLines }) =>
        formatUsageReportLines(usage),
      )
    : undefined;
  const overviewSurface = buildStatusOverviewSurfaceFromScan({
    gatewayService: daemon,
    nodeOnlyGateway,
    nodeService: nodeDaemon,
    scan: {
      cfg,
      gatewayConnection,
      gatewayMode,
      gatewayProbe,
      gatewayProbeAuth,
      gatewayProbeAuthWarning,
      gatewayReachable,
      gatewaySelf,
      remoteUrlMissing,
      tailscaleDns,
      tailscaleHttpsUrl,
      tailscaleMode,
      update,
    },
  });
  const lines = await buildStatusCommandReportLines(
    await buildStatusCommandReportData({
      accentDim: theme.accentDim,
      agentStatus,
      channelIssues,
      channels,
      formatCliCommand,
      formatHealthChannelLines,
      formatKTokens,
      formatPluginCompatibilityNotice,
      formatPromptCacheCompact,
      formatTimeAgo,
      formatTokensCompact,
      formatUpdateAvailableHint,
      health,
      lastHeartbeat,
      memory,
      memoryPlugin,
      muted,
      ok,
      opts,
      osSummary,
      pairingRecovery,
      pluginCompatibility,
      renderTable,
      resolveMemoryCacheSummary,
      resolveMemoryFtsState,
      resolveMemoryVectorState,
      securityAudit,
      shortenText,
      summary,
      surface: overviewSurface,
      tableWidth,
      theme,
      updateValue: updateSurface.updateAvailable
        ? warn(`available · ${updateSurface.updateLine}`)
        : updateSurface.updateLine,
      usageLines,
      warn,
    }),
  );
  for (const line of lines) {
    runtime.log(line);
  }
}
