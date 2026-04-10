import type { OpenClawConfig } from "../config/types.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import { runExec } from "../process/exec.js";
import { createEmptyTaskAuditSummary } from "../tasks/task-registry.audit.shared.js";
import { createEmptyTaskRegistrySummary } from "../tasks/task-registry.summary.js";
import { buildTailscaleHttpsUrl, resolveGatewayProbeSnapshot } from "./status.scan.shared.js";

export function buildColdStartUpdateResult(): UpdateCheckResult {
  return {
    installKind: "unknown",
    packageManager: "unknown",
    root: null,
  };
}

export function buildColdStartAgentLocalStatuses() {
  return {
    agents: [],
    bootstrapPendingCount: 0,
    defaultId: "main",
    totalSessions: 0,
  };
}

export function buildColdStartStatusSummary() {
  return {
    channelSummary: [],
    heartbeat: {
      agents: [],
      defaultAgentId: "main",
    },
    queuedSystemEvents: [],
    runtimeVersion: null,
    sessions: {
      byAgent: [],
      count: 0,
      defaults: { contextTokens: null, model: null },
      paths: [],
      recent: [],
    },
    taskAudit: createEmptyTaskAuditSummary(),
    tasks: createEmptyTaskRegistrySummary(),
  };
}

export function shouldSkipStatusScanNetworkChecks(params: {
  coldStart: boolean;
  hasConfiguredChannels: boolean;
  all?: boolean;
}): boolean {
  return params.coldStart && !params.hasConfiguredChannels && params.all !== true;
}

type StatusScanExecRunner = (
  command: string,
  args: string[],
  opts?: number | { timeoutMs?: number; maxBuffer?: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export async function createStatusScanCoreBootstrap<TAgentStatus>(params: {
  coldStart: boolean;
  cfg: OpenClawConfig;
  hasConfiguredChannels: boolean;
  opts: { timeoutMs?: number; all?: boolean };
  getTailnetHostname: (runner: StatusScanExecRunner) => Promise<string | null>;
  getUpdateCheckResult: (params: {
    timeoutMs: number;
    fetchGit: boolean;
    includeRegistry: boolean;
  }) => Promise<UpdateCheckResult>;
  getAgentLocalStatuses: (cfg: OpenClawConfig) => Promise<TAgentStatus>;
}) {
  const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
  const skipColdStartNetworkChecks = shouldSkipStatusScanNetworkChecks({
    all: params.opts.all,
    coldStart: params.coldStart,
    hasConfiguredChannels: params.hasConfiguredChannels,
  });
  const updateTimeoutMs = params.opts.all ? 6500 : 2500;
  const tailscaleDnsPromise =
    tailscaleMode === "off"
      ? Promise.resolve<string | null>(null)
      : params
          .getTailnetHostname((cmd, args) =>
            runExec(cmd, args, { maxBuffer: 200_000, timeoutMs: 1200 }),
          )
          .catch(() => null);
  const updatePromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartUpdateResult())
    : params.getUpdateCheckResult({
        fetchGit: true,
        includeRegistry: true,
        timeoutMs: updateTimeoutMs,
      });
  const agentStatusPromise = skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartAgentLocalStatuses() as TAgentStatus)
    : params.getAgentLocalStatuses(params.cfg);
  const gatewayProbePromise = resolveGatewayProbeSnapshot({
    cfg: params.cfg,
    opts: {
      ...params.opts,
      ...(skipColdStartNetworkChecks ? { skipProbe: true } : {}),
    },
  });

  return {
    agentStatusPromise,
    gatewayProbePromise,
    resolveTailscaleHttpsUrl: async () =>
      buildTailscaleHttpsUrl({
        controlUiBasePath: params.cfg.gateway?.controlUi?.basePath,
        tailscaleDns: await tailscaleDnsPromise,
        tailscaleMode,
      }),
    skipColdStartNetworkChecks,
    tailscaleDnsPromise,
    tailscaleMode,
    updatePromise,
  };
}

export async function createStatusScanBootstrap<TAgentStatus, TSummary>(params: {
  coldStart: boolean;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  hasConfiguredChannels: boolean;
  opts: { timeoutMs?: number; all?: boolean };
  getTailnetHostname: (runner: StatusScanExecRunner) => Promise<string | null>;
  getUpdateCheckResult: (params: {
    timeoutMs: number;
    fetchGit: boolean;
    includeRegistry: boolean;
  }) => Promise<UpdateCheckResult>;
  getAgentLocalStatuses: (cfg: OpenClawConfig) => Promise<TAgentStatus>;
  getStatusSummary: (params: {
    config: OpenClawConfig;
    sourceConfig: OpenClawConfig;
  }) => Promise<TSummary>;
}) {
  const core = await createStatusScanCoreBootstrap<TAgentStatus>({
    cfg: params.cfg,
    coldStart: params.coldStart,
    getAgentLocalStatuses: params.getAgentLocalStatuses,
    getTailnetHostname: params.getTailnetHostname,
    getUpdateCheckResult: params.getUpdateCheckResult,
    hasConfiguredChannels: params.hasConfiguredChannels,
    opts: params.opts,
  });
  const summaryPromise = core.skipColdStartNetworkChecks
    ? Promise.resolve(buildColdStartStatusSummary() as TSummary)
    : params.getStatusSummary({
        config: params.cfg,
        sourceConfig: params.sourceConfig,
      });
  return {
    ...core,
    summaryPromise,
  };
}
