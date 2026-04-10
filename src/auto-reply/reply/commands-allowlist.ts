import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { normalizeChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";
type AllowlistTarget = "both" | "config" | "store";
interface ResolvedAllowlistName {
  input: string;
  resolved: boolean;
  name?: string | null;
}

type AllowlistCommand =
  | {
      action: "list";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      resolve?: boolean;
    }
  | {
      action: "add" | "remove";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      entry: string;
      resolve?: boolean;
      target: AllowlistTarget;
    }
  | { action: "error"; message: string };

const ACTIONS = new Set(["list", "add", "remove"]);
const SCOPES = new Set<AllowlistScope>(["dm", "group", "all"]);

function resolveAllowlistAccountId(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  parsedAccount?: string;
  ctxAccountId?: string;
}): string {
  const explicitAccountId = normalizeOptionalAccountId(params.parsedAccount);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  const plugin = getChannelPlugin(params.channelId);
  const configuredDefaultAccountId = normalizeOptionalString(
    plugin?.config.defaultAccountId?.(params.cfg),
  );
  const ctxAccountId = normalizeOptionalAccountId(params.ctxAccountId);
  return configuredDefaultAccountId || ctxAccountId || DEFAULT_ACCOUNT_ID;
}

function parseAllowlistCommand(raw: string): AllowlistCommand | null {
  const trimmed = raw.trim();
  const trimmedLower = normalizeOptionalLowercaseString(trimmed) ?? "";
  if (!trimmedLower.startsWith("/allowlist")) {
    return null;
  }
  const rest = trimmed.slice("/allowlist".length).trim();
  if (!rest) {
    return { action: "list", scope: "dm" };
  }

  const tokens = rest.split(/\s+/);
  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "dm";
  let resolve = false;
  let target: AllowlistTarget = "both";
  let channel: string | undefined;
  let account: string | undefined;
  const entryTokens: string[] = [];

  let i = 0;
  const firstAction = normalizeOptionalLowercaseString(tokens[i]);
  if (firstAction && ACTIONS.has(firstAction)) {
    action = firstAction as AllowlistAction;
    i += 1;
  }
  const firstScope = normalizeOptionalLowercaseString(tokens[i]);
  if (firstScope && SCOPES.has(firstScope as AllowlistScope)) {
    scope = firstScope as AllowlistScope;
    i += 1;
  }

  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lowered = normalizeOptionalLowercaseString(token) ?? "";
    if (lowered === "--resolve" || lowered === "resolve") {
      resolve = true;
      continue;
    }
    if (lowered === "--config" || lowered === "config") {
      target = "config";
      continue;
    }
    if (lowered === "--store" || lowered === "store") {
      target = "store";
      continue;
    }
    if (lowered === "--channel" && tokens[i + 1]) {
      channel = tokens[i + 1];
      i += 1;
      continue;
    }
    if (lowered === "--account" && tokens[i + 1]) {
      account = tokens[i + 1];
      i += 1;
      continue;
    }
    const kv = token.split("=");
    if (kv.length === 2) {
      const key = normalizeOptionalLowercaseString(kv[0]);
      const value = normalizeOptionalString(kv[1]);
      if (key === "channel") {
        if (value) {
          channel = value;
        }
        continue;
      }
      if (key === "account") {
        if (value) {
          account = value;
        }
        continue;
      }
      const normalizedValue = normalizeOptionalLowercaseString(value);
      if (key === "scope" && normalizedValue && SCOPES.has(normalizedValue as AllowlistScope)) {
        scope = normalizedValue as AllowlistScope;
        continue;
      }
    }
    entryTokens.push(token);
  }

  if (action === "add" || action === "remove") {
    const entry = entryTokens.join(" ").trim();
    if (!entry) {
      return { action: "error", message: "Usage: /allowlist add|remove <entry>" };
    }
    return { account, action, channel, entry, resolve, scope, target };
  }

  return { account, action: "list", channel, resolve, scope };
}

function normalizeAllowFrom(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  values: (string | number)[];
}): string[] {
  const plugin = getChannelPlugin(params.channelId);
  if (plugin?.config.formatAllowFrom) {
    return plugin.config.formatAllowFrom({
      accountId: params.accountId,
      allowFrom: params.values,
      cfg: params.cfg,
    });
  }
  return normalizeStringEntries(params.values);
}

function formatEntryList(entries: string[], resolved?: Map<string, string>): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .map((entry) => {
      const name = resolved?.get(entry);
      return name ? `${entry} (${name})` : entry;
    })
    .join(", ");
}

async function updatePairingStoreAllowlist(params: {
  action: "add" | "remove";
  channelId: ChannelId;
  accountId?: string;
  entry: string;
}) {
  const storeEntry = {
    accountId: params.accountId,
    channel: params.channelId,
    entry: params.entry,
  };
  if (params.action === "add") {
    await addChannelAllowFromStoreEntry(storeEntry);
    return;
  }

  await removeChannelAllowFromStoreEntry(storeEntry);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    await removeChannelAllowFromStoreEntry({
      channel: params.channelId,
      entry: params.entry,
    });
  }
}

function mapResolvedAllowlistNames(entries: ResolvedAllowlistName[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.resolved && entry.name) {
      map.set(entry.input, entry.name);
    }
  }
  return map;
}

async function resolveAllowlistNames(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  scope: "dm" | "group";
  entries: string[];
}) {
  const plugin = getChannelPlugin(params.channelId);
  const resolved = await plugin?.allowlist?.resolveNames?.({
    accountId: params.accountId,
    cfg: params.cfg,
    entries: params.entries,
    scope: params.scope,
  });
  return mapResolvedAllowlistNames(resolved ?? []);
}

async function readAllowlistConfig(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
}) {
  const plugin = getChannelPlugin(params.channelId);
  return (
    (await plugin?.allowlist?.readConfig?.({
      accountId: params.accountId,
      cfg: params.cfg,
    })) ?? {}
  );
}

export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.action === "error") {
    return { reply: { text: `⚠️ ${parsed.message}` }, shouldContinue: false };
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
  if (unauthorized) {
    return unauthorized;
  }
  if (parsed.action !== "list") {
    const nonOwner = rejectNonOwnerCommand(params, "/allowlist");
    if (nonOwner) {
      return nonOwner;
    }
  }

  const channelId =
    normalizeChannelId(parsed.channel) ??
    params.command.channelId ??
    normalizeChannelId(params.command.channel);
  if (!channelId) {
    return {
      reply: { text: "⚠️ Unknown channel. Add channel=<id> to the command." },
      shouldContinue: false,
    };
  }
  if (normalizeOptionalString(parsed.account) && !normalizeOptionalAccountId(parsed.account)) {
    return {
      reply: {
        text: "⚠️ Invalid account id. Reserved keys (__proto__, constructor, prototype) are blocked.",
      },
      shouldContinue: false,
    };
  }
  const accountId = resolveAllowlistAccountId({
    cfg: params.cfg,
    channelId,
    ctxAccountId: params.ctx.AccountId,
    parsedAccount: parsed.account,
  });
  const plugin = getChannelPlugin(channelId);

  if (parsed.action === "list") {
    const supportsStore = Boolean(plugin?.pairing);
    if (!plugin?.allowlist?.readConfig && !supportsStore) {
      return {
        reply: { text: `⚠️ ${channelId} does not expose allowlist configuration.` },
        shouldContinue: false,
      };
    }
    const storeAllowFrom = supportsStore
      ? await readChannelAllowFromStore(channelId, process.env, accountId).catch(() => [])
      : [];
    const configState = await readAllowlistConfig({
      accountId,
      cfg: params.cfg,
      channelId,
    });

    const dmAllowFrom = (configState.dmAllowFrom ?? []).map(String);
    const groupAllowFrom = (configState.groupAllowFrom ?? []).map(String);
    const groupOverrides = (configState.groupOverrides ?? []).map((entry) => ({
      entries: entry.entries.map(String).filter(Boolean),
      label: entry.label,
    }));

    const dmDisplay = normalizeAllowFrom({
      accountId,
      cfg: params.cfg,
      channelId,
      values: dmAllowFrom,
    });
    const groupDisplay = normalizeAllowFrom({
      accountId,
      cfg: params.cfg,
      channelId,
      values: groupAllowFrom,
    });
    const groupOverrideEntries = groupOverrides.flatMap((entry) => entry.entries);
    const groupOverrideDisplay = normalizeAllowFrom({
      accountId,
      cfg: params.cfg,
      channelId,
      values: groupOverrideEntries,
    });

    const resolvedDm =
      parsed.resolve && dmDisplay.length > 0
        ? await resolveAllowlistNames({
            accountId,
            cfg: params.cfg,
            channelId,
            entries: dmDisplay,
            scope: "dm",
          })
        : undefined;
    const resolvedGroup =
      parsed.resolve && groupOverrideDisplay.length > 0
        ? await resolveAllowlistNames({
            accountId,
            cfg: params.cfg,
            channelId,
            entries: groupOverrideDisplay,
            scope: "group",
          })
        : undefined;

    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
    if (configState.dmPolicy) {
      lines.push(`DM policy: ${configState.dmPolicy}`);
    }
    if (configState.groupPolicy) {
      lines.push(`Group policy: ${configState.groupPolicy}`);
    }

    const showDm = parsed.scope === "dm" || parsed.scope === "all";
    const showGroup = parsed.scope === "group" || parsed.scope === "all";
    if (showDm) {
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay, resolvedDm)}`);
    }
    if (supportsStore && storeAllowFrom.length > 0) {
      const storeLabel = normalizeAllowFrom({
        accountId,
        cfg: params.cfg,
        channelId,
        values: storeAllowFrom,
      });
      lines.push(`Paired allowFrom (store): ${formatEntryList(storeLabel)}`);
    }
    if (showGroup) {
      if (groupAllowFrom.length > 0) {
        lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay, resolvedGroup)}`);
      }
      if (groupOverrides.length > 0) {
        lines.push("Group overrides:");
        for (const entry of groupOverrides) {
          const normalized = normalizeAllowFrom({
            accountId,
            cfg: params.cfg,
            channelId,
            values: entry.entries,
          });
          lines.push(`- ${entry.label}: ${formatEntryList(normalized, resolvedGroup)}`);
        }
      }
    }

    return { reply: { text: lines.join("\n") }, shouldContinue: false };
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    allowedScopes: ["operator.admin"],
    label: "/allowlist write",
    missingText: "❌ /allowlist add|remove requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    configKey: "config",
    disabledVerb: "are",
    label: "/allowlist edits",
  });
  if (disabled) {
    return disabled;
  }

  const shouldUpdateConfig = parsed.target !== "store";
  const shouldTouchStore = parsed.target !== "config" && Boolean(plugin?.pairing);

  if (shouldUpdateConfig) {
    if (parsed.scope === "all") {
      return {
        reply: { text: "⚠️ /allowlist add|remove requires scope dm or group." },
        shouldContinue: false,
      };
    }
    if (!plugin?.allowlist?.applyConfigEdit) {
      return {
        reply: {
          text: `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
        },
        shouldContinue: false,
      };
    }

    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return {
        reply: { text: "⚠️ Config file is invalid; fix it before using /allowlist." },
        shouldContinue: false,
      };
    }
    const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
    const editResult = await plugin.allowlist.applyConfigEdit({
      accountId,
      action: parsed.action,
      cfg: params.cfg,
      entry: parsed.entry,
      parsedConfig,
      scope: parsed.scope,
    });
    if (!editResult) {
      return {
        reply: {
          text: `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
        },
        shouldContinue: false,
      };
    }
    if (editResult.kind === "invalid-entry") {
      return {
        reply: { text: "⚠️ Invalid allowlist entry." },
        shouldContinue: false,
      };
    }
    const deniedText = resolveConfigWriteDeniedText({
      accountId,
      cfg: params.cfg,
      channel: params.command.channel,
      channelId,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target: editResult.writeTarget,
    });
    if (deniedText) {
      return {
        reply: {
          text: deniedText,
        },
        shouldContinue: false,
      };
    }
    const configChanged = editResult.changed;

    if (configChanged) {
      const validated = validateConfigObjectWithPlugins(parsedConfig);
      if (!validated.ok) {
        const issue = validated.issues[0];
        return {
          reply: { text: `⚠️ Config invalid after update (${issue.path}: ${issue.message}).` },
          shouldContinue: false,
        };
      }
      await writeConfigFile(validated.config);
    }

    if (!configChanged && !shouldTouchStore) {
      const message = parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found.";
      return { reply: { text: message }, shouldContinue: false };
    }

    if (shouldTouchStore) {
      await updatePairingStoreAllowlist({
        accountId,
        action: parsed.action,
        channelId,
        entry: parsed.entry,
      });
    }

    const actionLabel = parsed.action === "add" ? "added" : "removed";
    const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
    const locations: string[] = [];
    if (configChanged) {
      locations.push(editResult.pathLabel);
    }
    if (shouldTouchStore) {
      locations.push("pairing store");
    }
    const targetLabel = locations.length > 0 ? locations.join(" + ") : "no-op";
    return {
      reply: {
        text: `✅ ${scopeLabel} allowlist ${actionLabel}: ${targetLabel}.`,
      },
      shouldContinue: false,
    };
  }

  if (!shouldTouchStore) {
    return {
      reply: { text: "⚠️ This channel does not support allowlist storage." },
      shouldContinue: false,
    };
  }

  await updatePairingStoreAllowlist({
    accountId,
    action: parsed.action,
    channelId,
    entry: parsed.entry,
  });

  const actionLabel = parsed.action === "add" ? "added" : "removed";
  const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
  return {
    reply: { text: `✅ ${scopeLabel} allowlist ${actionLabel} in pairing store.` },
    shouldContinue: false,
  };
};
