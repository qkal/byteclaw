import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  createMessageActionDiscoveryContext,
  resolveMessageActionDiscoveryForPlugin,
} from "../../channels/plugins/message-action-discovery.js";
import type {
  ChannelCapabilities,
  ChannelCapabilitiesDiagnostics,
  ChannelCapabilitiesDisplayLine,
  ChannelPlugin,
} from "../../channels/plugins/types.js";
import {
  type OpenClawConfig,
  readConfigFileSnapshot,
  replaceConfigFile,
} from "../../config/config.js";
import { danger } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { type RuntimeEnv, defaultRuntime, writeRuntimeJson } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";
import { resolveInstallableChannelPlugin } from "../channel-setup/channel-plugin-resolution.js";
import { formatChannelAccountLabel, requireValidConfig } from "./shared.js";

export interface ChannelsCapabilitiesOptions {
  channel?: string;
  account?: string;
  target?: string;
  timeout?: string;
  json?: boolean;
}

interface ChannelCapabilitiesReport {
  plugin: ChannelPlugin;
  channel: string;
  accountId: string;
  accountName?: string;
  configured?: boolean;
  enabled?: boolean;
  support?: ChannelCapabilities;
  actions?: string[];
  probe?: unknown;
  diagnostics?: ChannelCapabilitiesDiagnostics;
}

function normalizeTimeout(raw: unknown, fallback = 10_000) {
  const value = typeof raw === "string" ? Number(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function formatSupport(capabilities?: ChannelCapabilities) {
  if (!capabilities) {
    return "unknown";
  }
  const bits: string[] = [];
  if (capabilities.chatTypes?.length) {
    bits.push(`chatTypes=${capabilities.chatTypes.join(",")}`);
  }
  if (capabilities.polls) {
    bits.push("polls");
  }
  if (capabilities.reactions) {
    bits.push("reactions");
  }
  if (capabilities.edit) {
    bits.push("edit");
  }
  if (capabilities.unsend) {
    bits.push("unsend");
  }
  if (capabilities.reply) {
    bits.push("reply");
  }
  if (capabilities.effects) {
    bits.push("effects");
  }
  if (capabilities.groupManagement) {
    bits.push("groupManagement");
  }
  if (capabilities.threads) {
    bits.push("threads");
  }
  if (capabilities.media) {
    bits.push("media");
  }
  if (capabilities.nativeCommands) {
    bits.push("nativeCommands");
  }
  if (capabilities.blockStreaming) {
    bits.push("blockStreaming");
  }
  return bits.length ? bits.join(" ") : "none";
}

function formatGenericProbeLines(probe: unknown): ChannelCapabilitiesDisplayLine[] {
  if (!probe || typeof probe !== "object") {
    return [];
  }
  const probeObj = probe as Record<string, unknown>;
  const ok = typeof probeObj.ok === "boolean" ? probeObj.ok : undefined;
  if (ok === true) {
    return [{ text: "Probe: ok" }];
  }
  if (ok === false) {
    const error =
      typeof probeObj.error === "string" && probeObj.error ? ` (${probeObj.error})` : "";
    return [{ text: `Probe: failed${error}`, tone: "error" }];
  }
  return [];
}

function renderDisplayLine(line: ChannelCapabilitiesDisplayLine) {
  switch (line.tone) {
    case "muted": {
      return theme.muted(line.text);
    }
    case "success": {
      return theme.success(line.text);
    }
    case "warn": {
      return theme.warn(line.text);
    }
    case "error": {
      return theme.error(line.text);
    }
    default: {
      return line.text;
    }
  }
}

async function resolveChannelReports(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  timeoutMs: number;
  accountOverride?: string;
  target?: string;
}): Promise<ChannelCapabilitiesReport[]> {
  const { plugin, cfg, timeoutMs } = params;
  const accountIds = params.accountOverride
    ? [params.accountOverride]
    : (() => {
        const ids = plugin.config.listAccountIds(cfg);
        return ids.length > 0
          ? ids
          : [resolveChannelDefaultAccountId({ accountIds: ids, cfg, plugin })];
      })();
  const reports: ChannelCapabilitiesReport[] = [];

  for (const accountId of accountIds) {
    const resolvedAccount = plugin.config.resolveAccount(cfg, accountId);
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(resolvedAccount, cfg)
      : Boolean(resolvedAccount);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(resolvedAccount, cfg)
      : (resolvedAccount as { enabled?: boolean }).enabled !== false;
    let probe: unknown;
    if (configured && enabled && plugin.status?.probeAccount) {
      try {
        probe = await plugin.status.probeAccount({
          account: resolvedAccount,
          cfg,
          timeoutMs,
        });
      } catch (error) {
        probe = { error: formatErrorMessage(error), ok: false };
      }
    }

    const diagnostics =
      configured && enabled
        ? await plugin.status?.buildCapabilitiesDiagnostics?.({
            account: resolvedAccount,
            cfg,
            probe,
            target: params.target,
            timeoutMs,
          })
        : undefined;
    const discoveredActions = resolveMessageActionDiscoveryForPlugin({
      actions: plugin.actions,
      context: createMessageActionDiscoveryContext({
        accountId,
        cfg,
      }),
      includeActions: true,
      pluginId: plugin.id,
    }).actions;
    const actions = [
      ...new Set<string>([
        "send",
        "broadcast",
        ...discoveredActions.map((action) => String(action)),
      ]),
    ];

    reports.push({
      accountId,
      accountName:
        typeof (resolvedAccount as { name?: string }).name === "string"
          ? normalizeOptionalString((resolvedAccount as { name?: string }).name)
          : undefined,
      actions,
      channel: plugin.id,
      configured,
      diagnostics,
      enabled,
      plugin,
      probe,
      support: plugin.capabilities,
    });
  }
  return reports;
}

export async function channelsCapabilitiesCommand(
  opts: ChannelsCapabilitiesOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
  const loadedCfg = await requireValidConfig(runtime);
  if (!loadedCfg) {
    return;
  }
  let cfg = loadedCfg;
  const timeoutMs = normalizeTimeout(opts.timeout, 10_000);
  const rawChannel = normalizeLowercaseStringOrEmpty(opts.channel);
  const rawTarget = normalizeOptionalString(opts.target) ?? "";

  if (opts.account && (!rawChannel || rawChannel === "all")) {
    runtime.error(danger("--account requires a specific --channel."));
    runtime.exit(1);
    return;
  }
  if (rawTarget && (!rawChannel || rawChannel === "all")) {
    runtime.error(danger("--target requires a specific --channel."));
    runtime.exit(1);
    return;
  }

  const plugins = listChannelPlugins();
  const selected =
    !rawChannel || rawChannel === "all"
      ? plugins
      : await (async () => {
          const resolved = await resolveInstallableChannelPlugin({
            allowInstall: true,
            cfg,
            rawChannel,
            runtime,
          });
          if (resolved.configChanged) {
            ({ cfg } = resolved);
            await replaceConfigFile({
              baseHash: (await sourceSnapshotPromise)?.hash,
              nextConfig: cfg,
            });
          }
          return resolved.plugin ? [resolved.plugin] : null;
        })();

  if (!selected || selected.length === 0) {
    runtime.error(danger(`Unknown channel "${rawChannel}".`));
    runtime.exit(1);
    return;
  }

  const reports: ChannelCapabilitiesReport[] = [];
  for (const plugin of selected) {
    const accountOverride = normalizeOptionalString(opts.account);
    reports.push(
      ...(await resolveChannelReports({
        accountOverride,
        cfg,
        plugin,
        target: rawTarget || undefined,
        timeoutMs,
      })),
    );
  }

  if (opts.json) {
    writeRuntimeJson(runtime, { channels: reports });
    return;
  }

  const lines: string[] = [];
  for (const report of reports) {
    const label = formatChannelAccountLabel({
      accountId: report.accountId,
      accountStyle: theme.heading,
      channel: report.channel,
      channelStyle: theme.accent,
      name: report.accountName,
    });
    lines.push(theme.heading(label));
    lines.push(`Support: ${formatSupport(report.support)}`);
    if (report.actions && report.actions.length > 0) {
      lines.push(`Actions: ${report.actions.join(", ")}`);
    }
    if (report.configured === false || report.enabled === false) {
      const configuredLabel = report.configured === false ? "not configured" : "configured";
      const enabledLabel = report.enabled === false ? "disabled" : "enabled";
      lines.push(`Status: ${configuredLabel}, ${enabledLabel}`);
    }
    const probeLines =
      report.plugin.status?.formatCapabilitiesProbe?.({
        probe: report.probe,
      }) ?? formatGenericProbeLines(report.probe);
    if (probeLines.length > 0) {
      lines.push(...probeLines.map(renderDisplayLine));
    } else if (report.configured && report.enabled) {
      lines.push(theme.muted("Probe: unavailable"));
    }
    if (report.diagnostics?.lines?.length) {
      lines.push(...report.diagnostics.lines.map(renderDisplayLine));
    }
    lines.push("");
  }

  runtime.log(lines.join("\n").trimEnd());
}
