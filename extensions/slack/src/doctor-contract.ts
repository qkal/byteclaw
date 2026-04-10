import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacySlackStreamingAliases(value: unknown): boolean {
  return hasLegacyStreamingAliases(value, { includeNativeTransport: true });
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    match: hasLegacySlackStreamingAliases,
    message:
      "channels.slack.streamMode, channels.slack.streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}.",
    path: ["channels", "slack"],
  },
  {
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacySlackStreamingAliases),
    message:
      "channels.slack.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.accounts.<id>.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}.",
    path: ["channels", "slack", "accounts"],
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.slack);
  if (!rawEntry) {
    return { changes: [], config: cfg };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const dm = normalizeLegacyDmAliases({
    changes,
    entry: updated,
    pathPrefix: "channels.slack",
  });
  updated = dm.entry;
  changed = changed || dm.changed;

  const streaming = normalizeLegacyStreamingAliases({
    changes,
    entry: updated,
    pathPrefix: "channels.slack",
    resolvedMode: resolveSlackStreamingMode(updated),
    resolvedNativeTransport: resolveSlackNativeStreaming(updated),
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      let accountEntry = account;
      let accountChanged = false;
      const accountDm = normalizeLegacyDmAliases({
        changes,
        entry: accountEntry,
        pathPrefix: `channels.slack.accounts.${accountId}`,
      });
      accountEntry = accountDm.entry;
      accountChanged = accountDm.changed;
      const accountStreaming = normalizeLegacyStreamingAliases({
        changes,
        entry: accountEntry,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        resolvedMode: resolveSlackStreamingMode(accountEntry),
        resolvedNativeTransport: resolveSlackNativeStreaming(accountEntry),
      });
      accountEntry = accountStreaming.entry;
      accountChanged = accountChanged || accountStreaming.changed;
      if (accountChanged) {
        accounts[accountId] = accountEntry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts };
      changed = true;
    }
  }

  if (!changed) {
    return { changes: [], config: cfg };
  }
  return {
    changes,
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        slack: updated as unknown as NonNullable<OpenClawConfig["channels"]>["slack"],
      } as OpenClawConfig["channels"],
    },
  };
}
