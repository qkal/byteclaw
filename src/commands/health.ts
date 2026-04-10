import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { withProgress } from "../cli/progress.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig, readBestEffortConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { info } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  type HeartbeatSummary,
  resolveHeartbeatSummaryForAgent,
} from "../infra/heartbeat-summary.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { styleHealthChannelLine } from "../terminal/health-style.js";
import { isRich } from "../terminal/theme.js";
import { logGatewayConnectionDetails } from "./status.gateway-connection.js";

export interface ChannelAccountHealthSummary {
  accountId: string;
  configured?: boolean;
  linked?: boolean;
  authAgeMs?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  [key: string]: unknown;
}

export type ChannelHealthSummary = ChannelAccountHealthSummary & {
  accounts?: Record<string, ChannelAccountHealthSummary>;
};

export type AgentHeartbeatSummary = HeartbeatSummary;

export interface AgentHealthSummary {
  agentId: string;
  name?: string;
  isDefault: boolean;
  heartbeat: AgentHeartbeatSummary;
  sessions: HealthSummary["sessions"];
}

export interface HealthSummary {
  /**
   * Convenience top-level flag for UIs (e.g. WebChat) that only need a binary
   * "can talk to the gateway" signal. If this payload exists, the gateway RPC
   * succeeded, so this is always `true`.
   */
  ok: true;
  ts: number;
  durationMs: number;
  channels: Record<string, ChannelHealthSummary>;
  channelOrder: string[];
  channelLabels: Record<string, string>;
  /** Legacy: default agent heartbeat seconds (rounded). */
  heartbeatSeconds: number;
  defaultAgentId: string;
  agents: AgentHealthSummary[];
  sessions: {
    path: string;
    count: number;
    recent: {
      key: string;
      updatedAt: number | null;
      age: number | null;
    }[];
  };
}

const DEFAULT_TIMEOUT_MS = 10_000;

const debugHealth = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH)) {
    console.warn("[health:debug]", ...args);
  }
};

const formatDurationParts = (ms: number): string => {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const units: { label: string; size: number }[] = [
    { label: "w", size: 7 * 24 * 60 * 60 * 1000 },
    { label: "d", size: 24 * 60 * 60 * 1000 },
    { label: "h", size: 60 * 60 * 1000 },
    { label: "m", size: 60 * 1000 },
    { label: "s", size: 1000 },
  ];
  let remaining = Math.max(0, Math.floor(ms));
  const parts: string[] = [];
  for (const unit of units) {
    const value = Math.floor(remaining / unit.size);
    if (value > 0) {
      parts.push(`${value}${unit.label}`);
      remaining -= value * unit.size;
    }
  }
  if (parts.length === 0) {
    return "0s";
  }
  return parts.join(" ");
};

const resolveHeartbeatSummary = (cfg: ReturnType<typeof loadConfig>, agentId: string) =>
  resolveHeartbeatSummaryForAgent(cfg, agentId);

const resolveAgentOrder = (cfg: ReturnType<typeof loadConfig>) => {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const seen = new Set<string>();
  const ordered: { id: string; name?: string }[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push({ id, name: typeof entry.name === "string" ? entry.name : undefined });
  }

  if (!seen.has(defaultAgentId)) {
    ordered.unshift({ id: defaultAgentId });
  }

  if (ordered.length === 0) {
    ordered.push({ id: defaultAgentId });
  }

  return { defaultAgentId, ordered };
};

const buildSessionSummary = (storePath: string) => {
  const store = loadSessionStore(storePath);
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({ key, updatedAt: entry?.updatedAt ?? 0 }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const recent = sessions.slice(0, 5).map((s) => ({
    age: s.updatedAt ? Date.now() - s.updatedAt : null,
    key: s.key,
    updatedAt: s.updatedAt || null,
  }));
  return {
    count: sessions.length,
    path: storePath,
    recent,
  } satisfies HealthSummary["sessions"];
};

async function inspectHealthAccount(plugin: ChannelPlugin, cfg: OpenClawConfig, accountId: string) {
  return (
    plugin.config.inspectAccount?.(cfg, accountId) ??
    (await inspectReadOnlyChannelAccount({
      accountId,
      cfg,
      channelId: plugin.id,
    }))
  );
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  const record = asNullableRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

async function resolveHealthAccountContext(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<{
  account: unknown;
  enabled: boolean;
  configured: boolean;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  let account: unknown;
  try {
    account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to resolve account (${formatErrorMessage(error)}).`,
    );
    account = await inspectHealthAccount(params.plugin, params.cfg, params.accountId);
  }

  if (!account) {
    return {
      account: {},
      configured: false,
      diagnostics,
      enabled: false,
    };
  }

  const enabledFallback = readBooleanField(account, "enabled") ?? true;
  let enabled = enabledFallback;
  if (params.plugin.config.isEnabled) {
    try {
      enabled = params.plugin.config.isEnabled(account, params.cfg);
    } catch (error) {
      enabled = enabledFallback;
      diagnostics.push(
        `${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
      );
    }
  }

  const configuredFallback = readBooleanField(account, "configured") ?? true;
  let configured = configuredFallback;
  if (params.plugin.config.isConfigured) {
    try {
      configured = await params.plugin.config.isConfigured(account, params.cfg);
    } catch (error) {
      configured = configuredFallback;
      diagnostics.push(
        `${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
      );
    }
  }

  return { account, configured, diagnostics, enabled };
}

const formatProbeLine = (probe: unknown, opts: { botUsernames?: string[] } = {}): string | null => {
  const record = asNullableRecord(probe);
  if (!record) {
    return null;
  }
  const ok = typeof record.ok === "boolean" ? record.ok : undefined;
  if (ok === undefined) {
    return null;
  }
  const elapsedMs = typeof record.elapsedMs === "number" ? record.elapsedMs : null;
  const status = typeof record.status === "number" ? record.status : null;
  const error = typeof record.error === "string" ? record.error : null;
  const bot = asNullableRecord(record.bot);
  const botUsername = bot && typeof bot.username === "string" ? bot.username : null;
  const webhook = asNullableRecord(record.webhook);
  const webhookUrl = webhook && typeof webhook.url === "string" ? webhook.url : null;

  const usernames = new Set<string>();
  if (botUsername) {
    usernames.add(botUsername);
  }
  for (const extra of opts.botUsernames ?? []) {
    if (extra) {
      usernames.add(extra);
    }
  }

  if (ok) {
    let label = "ok";
    if (usernames.size > 0) {
      label += ` (@${[...usernames].join(", @")})`;
    }
    if (elapsedMs != null) {
      label += ` (${elapsedMs}ms)`;
    }
    if (webhookUrl) {
      label += ` - webhook ${webhookUrl}`;
    }
    return label;
  }
  let label = `failed (${status ?? "unknown"})`;
  if (error) {
    label += ` - ${error}`;
  }
  return label;
};

const formatAccountProbeTiming = (summary: ChannelAccountHealthSummary): string | null => {
  const probe = asNullableRecord(summary.probe);
  if (!probe) {
    return null;
  }
  const elapsedMs = typeof probe.elapsedMs === "number" ? Math.round(probe.elapsedMs) : null;
  const ok = typeof probe.ok === "boolean" ? probe.ok : null;
  if (elapsedMs == null && ok !== true) {
    return null;
  }

  const accountId = summary.accountId || "default";
  const botRecord = asNullableRecord(probe.bot);
  const botUsername =
    botRecord && typeof botRecord.username === "string" ? botRecord.username : null;
  const handle = botUsername ? `@${botUsername}` : accountId;
  const timing = elapsedMs != null ? `${elapsedMs}ms` : "ok";

  return `${handle}:${accountId}:${timing}`;
};

const isProbeFailure = (summary: ChannelAccountHealthSummary): boolean => {
  const probe = asNullableRecord(summary.probe);
  if (!probe) {
    return false;
  }
  const ok = typeof probe.ok === "boolean" ? probe.ok : null;
  return ok === false;
};

export const formatHealthChannelLines = (
  summary: HealthSummary,
  opts: {
    accountMode?: "default" | "all";
    accountIdsByChannel?: Record<string, string[] | undefined>;
  } = {},
): string[] => {
  const channels = summary.channels ?? {};
  const channelOrder =
    summary.channelOrder?.length > 0 ? summary.channelOrder : Object.keys(channels);
  const accountMode = opts.accountMode ?? "default";

  const lines: string[] = [];
  for (const channelId of channelOrder) {
    const channelSummary = channels[channelId];
    if (!channelSummary) {
      continue;
    }
    const plugin = getChannelPlugin(channelId as never);
    const label = summary.channelLabels?.[channelId] ?? plugin?.meta.label ?? channelId;
    const accountSummaries = channelSummary.accounts ?? {};
    const accountIds = opts.accountIdsByChannel?.[channelId];
    const filteredSummaries =
      accountIds && accountIds.length > 0
        ? accountIds
            .map((accountId) => accountSummaries[accountId])
            .filter((entry): entry is ChannelAccountHealthSummary => Boolean(entry))
        : undefined;
    const listSummaries =
      accountMode === "all"
        ? Object.values(accountSummaries)
        : (filteredSummaries ?? (channelSummary.accounts ? Object.values(accountSummaries) : []));
    const baseSummary =
      filteredSummaries && filteredSummaries.length > 0 ? filteredSummaries[0] : channelSummary;
    const botUsernames = listSummaries
      ? listSummaries
          .map((account) => {
            const probeRecord = asNullableRecord(account.probe);
            const bot = probeRecord ? asNullableRecord(probeRecord.bot) : null;
            return bot && typeof bot.username === "string" ? bot.username : null;
          })
          .filter((value): value is string => Boolean(value))
      : [];
    const linked = typeof baseSummary.linked === "boolean" ? baseSummary.linked : null;
    if (linked !== null) {
      if (linked) {
        const authAgeMs = typeof baseSummary.authAgeMs === "number" ? baseSummary.authAgeMs : null;
        const authLabel = authAgeMs != null ? ` (auth age ${Math.round(authAgeMs / 60_000)}m)` : "";
        lines.push(`${label}: linked${authLabel}`);
      } else {
        lines.push(`${label}: not linked`);
      }
      continue;
    }

    const configured = typeof baseSummary.configured === "boolean" ? baseSummary.configured : null;
    if (configured === false) {
      lines.push(`${label}: not configured`);
      continue;
    }

    const accountTimings =
      accountMode === "all"
        ? listSummaries
            .map((account) => formatAccountProbeTiming(account))
            .filter((value): value is string => Boolean(value))
        : [];
    const failedSummary = listSummaries.find((summary) => isProbeFailure(summary));
    if (failedSummary) {
      const failureLine = formatProbeLine(failedSummary.probe, { botUsernames });
      if (failureLine) {
        lines.push(`${label}: ${failureLine}`);
        continue;
      }
    }

    if (accountTimings.length > 0) {
      lines.push(`${label}: ok (${accountTimings.join(", ")})`);
      continue;
    }

    const probeLine = formatProbeLine(baseSummary.probe, { botUsernames });
    if (probeLine) {
      lines.push(`${label}: ${probeLine}`);
      continue;
    }

    if (configured === true) {
      lines.push(`${label}: configured`);
      continue;
    }
    lines.push(`${label}: unknown`);
  }
  return lines;
};

export async function getHealthSnapshot(params?: {
  timeoutMs?: number;
  probe?: boolean;
}): Promise<HealthSummary> {
  const timeoutMs = params?.timeoutMs;
  const cfg = loadConfig();
  const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);
  const sessionCache = new Map<string, HealthSummary["sessions"]>();
  const agents: AgentHealthSummary[] = ordered.map((entry) => {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
    const sessions = sessionCache.get(storePath) ?? buildSessionSummary(storePath);
    sessionCache.set(storePath, sessions);
    return {
      agentId: entry.id,
      heartbeat: resolveHeartbeatSummary(cfg, entry.id),
      isDefault: entry.id === defaultAgentId,
      name: entry.name,
      sessions,
    } satisfies AgentHealthSummary;
  });
  const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
  const heartbeatSeconds = defaultAgent?.heartbeat.everyMs
    ? Math.round(defaultAgent.heartbeat.everyMs / 1000)
    : 0;
  const sessions =
    defaultAgent?.sessions ??
    buildSessionSummary(resolveStorePath(cfg.session?.store, { agentId: defaultAgentId }));

  const start = Date.now();
  const cappedTimeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(50, timeoutMs);
  const doProbe = params?.probe !== false;
  const channels: Record<string, ChannelHealthSummary> = {};
  const channelOrder = listChannelPlugins().map((plugin) => plugin.id);
  const channelLabels: Record<string, string> = {};

  for (const plugin of listChannelPlugins()) {
    channelLabels[plugin.id] = plugin.meta.label ?? plugin.id;
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      accountIds,
      cfg,
      plugin,
    });
    const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
    const preferredAccountId = resolvePreferredAccountId({
      accountIds,
      boundAccounts,
      defaultAccountId,
    });
    const boundAccountIdsAll = [
      ...new Set([...(channelBindings.get(plugin.id)?.values() ?? [])].flatMap((ids) => ids)),
    ];
    const accountIdsToProbe = [
      ...new Set(
        [preferredAccountId, defaultAccountId, ...accountIds, ...boundAccountIdsAll].filter(
          (value) => value && value.trim(),
        ),
      ),
    ];
    debugHealth("channel", {
      accountIds,
      accountIdsToProbe,
      boundAccounts,
      defaultAccountId,
      id: plugin.id,
      preferredAccountId,
    });
    const accountSummaries: Record<string, ChannelAccountHealthSummary> = {};

    for (const accountId of accountIdsToProbe) {
      const { account, enabled, configured, diagnostics } = await resolveHealthAccountContext({
        accountId,
        cfg,
        plugin,
      });
      if (diagnostics.length > 0) {
        debugHealth("account.diagnostics", { accountId, channel: plugin.id, diagnostics });
      }

      let probe: unknown;
      let lastProbeAt: number | null = null;
      if (enabled && configured && doProbe && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({
            account,
            cfg,
            timeoutMs: cappedTimeout,
          });
          lastProbeAt = Date.now();
        } catch (error) {
          probe = { error: formatErrorMessage(error), ok: false };
          lastProbeAt = Date.now();
        }
      }

      const probeRecord =
        probe && typeof probe === "object" ? (probe as Record<string, unknown>) : null;
      const bot =
        probeRecord && typeof probeRecord.bot === "object"
          ? (probeRecord.bot as { username?: string | null })
          : null;
      if (bot?.username) {
        debugHealth("probe.bot", { accountId, channel: plugin.id, username: bot.username });
      }

      const snapshot: ChannelAccountSnapshot = {
        accountId,
        configured,
        enabled,
      };
      if (probe !== undefined) {
        snapshot.probe = probe;
      }
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }

      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account,
            cfg,
            defaultAccountId: accountId,
            snapshot,
          })
        : undefined;
      const record =
        summary && typeof summary === "object"
          ? (summary as ChannelAccountHealthSummary)
          : ({
              accountId,
              configured,
              lastProbeAt,
              probe,
            } satisfies ChannelAccountHealthSummary);
      if (record.configured === undefined) {
        record.configured = configured;
      }
      if (record.lastProbeAt === undefined && lastProbeAt) {
        record.lastProbeAt = lastProbeAt;
      }
      record.accountId = accountId;
      accountSummaries[accountId] = record;
    }

    const defaultSummary =
      accountSummaries[preferredAccountId] ??
      accountSummaries[defaultAccountId] ??
      accountSummaries[accountIdsToProbe[0] ?? preferredAccountId];
    const fallbackSummary = defaultSummary ?? accountSummaries[Object.keys(accountSummaries)[0]];
    if (fallbackSummary) {
      channels[plugin.id] = {
        ...fallbackSummary,
        accounts: accountSummaries,
      } satisfies ChannelHealthSummary;
    }
  }

  const summary: HealthSummary = {
    agents,
    channelLabels,
    channelOrder,
    channels,
    defaultAgentId,
    durationMs: Date.now() - start,
    heartbeatSeconds,
    ok: true,
    sessions: {
      count: sessions.count,
      path: sessions.path,
      recent: sessions.recent,
    },
    ts: Date.now(),
  };

  return summary;
}

export async function healthCommand(
  opts: { json?: boolean; timeoutMs?: number; verbose?: boolean; config?: OpenClawConfig },
  runtime: RuntimeEnv,
) {
  const cfg = opts.config ?? (await readBestEffortConfig());
  // Always query the running gateway; do not open a direct Baileys socket here.
  const summary = await withProgress(
    {
      enabled: opts.json !== true,
      indeterminate: true,
      label: "Checking gateway health…",
    },
    async () =>
      await callGateway<HealthSummary>({
        config: cfg,
        method: "health",
        params: opts.verbose ? { probe: true } : undefined,
        timeoutMs: opts.timeoutMs,
      }),
  );
  // Gateway reachability defines success; channel issues are reported but not fatal here.
  const fatal = false;

  if (opts.json) {
    writeRuntimeJson(runtime, summary);
  } else {
    const debugEnabled = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH);
    const rich = isRich();
    if (opts.verbose) {
      const details = buildGatewayConnectionDetails({ config: cfg });
      logGatewayConnectionDetails({
        info,
        message: details.message,
        runtime,
      });
    }
    const localAgents = resolveAgentOrder(cfg);
    const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
    const agents = Array.isArray(summary.agents) ? summary.agents : [];
    const fallbackAgents = localAgents.ordered.map((entry) => {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
      return {
        agentId: entry.id,
        heartbeat: resolveHeartbeatSummary(cfg, entry.id),
        isDefault: entry.id === localAgents.defaultAgentId,
        name: entry.name,
        sessions: buildSessionSummary(storePath),
      } satisfies AgentHealthSummary;
    });
    const resolvedAgents = agents.length > 0 ? agents : fallbackAgents;
    const displayAgents = opts.verbose
      ? resolvedAgents
      : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
    const channelBindings = buildChannelAccountBindings(cfg);
    if (debugEnabled) {
      runtime.log(info("[debug] local channel accounts"));
      for (const plugin of listChannelPlugins()) {
        const accountIds = plugin.config.listAccountIds(cfg);
        const defaultAccountId = resolveChannelDefaultAccountId({
          accountIds,
          cfg,
          plugin,
        });
        runtime.log(
          `  ${plugin.id}: accounts=${accountIds.join(", ") || "(none)"} default=${defaultAccountId}`,
        );
        for (const accountId of accountIds) {
          const { account, configured, diagnostics } = await resolveHealthAccountContext({
            accountId,
            cfg,
            plugin,
          });
          const record = asNullableRecord(account);
          const tokenSource =
            record && typeof record.tokenSource === "string" ? record.tokenSource : undefined;
          runtime.log(
            `    - ${accountId}: configured=${configured}${tokenSource ? ` tokenSource=${tokenSource}` : ""}`,
          );
          for (const diagnostic of diagnostics) {
            runtime.log(`      ! ${diagnostic}`);
          }
        }
      }
      runtime.log(info("[debug] bindings map"));
      for (const [channelId, byAgent] of channelBindings.entries()) {
        const entries = [...byAgent.entries()].map(
          ([agentId, ids]) => `${agentId}=[${ids.join(", ")}]`,
        );
        runtime.log(`  ${channelId}: ${entries.join(" ")}`);
      }
      runtime.log(info("[debug] gateway channel probes"));
      for (const [channelId, channelSummary] of Object.entries(summary.channels ?? {})) {
        const accounts = channelSummary.accounts ?? {};
        const probes = Object.entries(accounts).map(([accountId, accountSummary]) => {
          const probe = asNullableRecord(accountSummary.probe);
          const bot = probe ? asNullableRecord(probe.bot) : null;
          const username = bot && typeof bot.username === "string" ? bot.username : null;
          return `${accountId}=${username ?? "(no bot)"}`;
        });
        runtime.log(`  ${channelId}: ${probes.join(", ") || "(none)"}`);
      }
    }
    const channelAccountFallbacks = Object.fromEntries(
      listChannelPlugins().map((plugin) => {
        const accountIds = plugin.config.listAccountIds(cfg);
        const defaultAccountId = resolveChannelDefaultAccountId({
          accountIds,
          cfg,
          plugin,
        });
        const preferred = resolvePreferredAccountId({
          accountIds,
          boundAccounts: channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [],
          defaultAccountId,
        });
        return [plugin.id, [preferred] as string[]] as const;
      }),
    );
    const accountIdsByChannel = (() => {
      const entries = displayAgents.length > 0 ? displayAgents : resolvedAgents;
      const byChannel: Record<string, string[]> = {};
      for (const [channelId, byAgent] of channelBindings.entries()) {
        const accountIds: string[] = [];
        for (const agent of entries) {
          const ids = byAgent.get(agent.agentId) ?? [];
          for (const id of ids) {
            if (!accountIds.includes(id)) {
              accountIds.push(id);
            }
          }
        }
        if (accountIds.length > 0) {
          byChannel[channelId] = accountIds;
        }
      }
      for (const [channelId, fallbackIds] of Object.entries(channelAccountFallbacks)) {
        if (!byChannel[channelId] || byChannel[channelId].length === 0) {
          byChannel[channelId] = fallbackIds;
        }
      }
      return byChannel;
    })();
    const channelLines =
      Object.keys(accountIdsByChannel).length > 0
        ? formatHealthChannelLines(summary, {
            accountIdsByChannel,
            accountMode: opts.verbose ? "all" : "default",
          })
        : formatHealthChannelLines(summary, {
            accountMode: opts.verbose ? "all" : "default",
          });
    for (const line of channelLines) {
      runtime.log(styleHealthChannelLine(line, rich));
    }
    for (const plugin of listChannelPlugins()) {
      const channelSummary = summary.channels?.[plugin.id];
      if (!channelSummary || channelSummary.linked !== true) {
        continue;
      }
      if (!plugin.status?.logSelfId) {
        continue;
      }
      const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        accountIds,
        cfg,
        plugin,
      });
      const accountId = resolvePreferredAccountId({
        accountIds,
        boundAccounts,
        defaultAccountId,
      });
      const accountContext = await resolveHealthAccountContext({
        accountId,
        cfg,
        plugin,
      });
      if (!accountContext.enabled || !accountContext.configured) {
        continue;
      }
      if (accountContext.diagnostics.length > 0) {
        continue;
      }
      try {
        plugin.status.logSelfId({
          account: accountContext.account,
          cfg,
          includeChannelPrefix: true,
          runtime,
        });
      } catch (error) {
        debugHealth("logSelfId.failed", {
          accountId,
          channel: plugin.id,
          error: formatErrorMessage(error),
        });
      }
    }

    if (resolvedAgents.length > 0) {
      const agentLabels = resolvedAgents.map((agent) =>
        agent.isDefault ? `${agent.agentId} (default)` : agent.agentId,
      );
      runtime.log(info(`Agents: ${agentLabels.join(", ")}`));
    }
    const heartbeatParts = displayAgents
      .map((agent) => {
        const everyMs = agent.heartbeat?.everyMs;
        const label = everyMs ? formatDurationParts(everyMs) : "disabled";
        return `${label} (${agent.agentId})`;
      })
      .filter(Boolean);
    if (heartbeatParts.length > 0) {
      runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
    }
    if (displayAgents.length === 0) {
      runtime.log(
        info(`Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`),
      );
      if (summary.sessions.recent.length > 0) {
        for (const r of summary.sessions.recent) {
          runtime.log(
            `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60_000)}m ago` : "no activity"})`,
          );
        }
      }
    } else {
      for (const agent of displayAgents) {
        runtime.log(
          info(
            `Session store (${agent.agentId}): ${agent.sessions.path} (${agent.sessions.count} entries)`,
          ),
        );
        if (agent.sessions.recent.length > 0) {
          for (const r of agent.sessions.recent) {
            runtime.log(
              `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60_000)}m ago` : "no activity"})`,
            );
          }
        }
      }
    }
  }

  if (fatal) {
    runtime.exit(1);
  }
}
