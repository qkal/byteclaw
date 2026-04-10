import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyStreamingAliases,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveTelegramPreviewStreamMode } from "./preview-streaming.js";

function hasLegacyTelegramStreamingAliases(value: unknown): boolean {
  return hasLegacyStreamingAliases(value, { includePreviewChunk: true });
}

function resolveCompatibleDefaultGroupEntry(section: Record<string, unknown>): {
  groups: Record<string, unknown>;
  entry: Record<string, unknown>;
} | null {
  const existingGroups = section.groups;
  if (existingGroups !== undefined && !asObjectRecord(existingGroups)) {
    return null;
  }
  const groups = asObjectRecord(existingGroups) ?? {};
  const defaultKey = "*";
  const existingEntry = groups[defaultKey];
  if (existingEntry !== undefined && !asObjectRecord(existingEntry)) {
    return null;
  }
  const entry = asObjectRecord(existingEntry) ?? {};
  return { entry, groups };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    message:
      'channels.telegram.groupMentionsOnly was removed; use channels.telegram.groups."*".requireMention instead. Run "openclaw doctor --fix".',
    path: ["channels", "telegram", "groupMentionsOnly"],
  },
  {
    match: hasLegacyTelegramStreamingAliases,
    message:
      "channels.telegram.streamMode, channels.telegram.streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    path: ["channels", "telegram"],
  },
  {
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyTelegramStreamingAliases),
    message:
      "channels.telegram.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, draftChunk, and blockStreamingCoalesce are legacy; use channels.telegram.accounts.<id>.streaming.{mode,chunkMode,preview.chunk,block.enabled,block.coalesce}.",
    path: ["channels", "telegram", "accounts"],
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.telegram);
  if (!rawEntry) {
    return { changes: [], config: cfg };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  if (updated.groupMentionsOnly !== undefined) {
    const defaultGroupEntry = resolveCompatibleDefaultGroupEntry(updated);
    if (!defaultGroupEntry) {
      changes.push(
        "Skipped channels.telegram.groupMentionsOnly migration because channels.telegram.groups already has an incompatible shape; fix remaining issues manually.",
      );
    } else {
      const { groups, entry } = defaultGroupEntry;
      if (entry.requireMention === undefined) {
        entry.requireMention = updated.groupMentionsOnly;
        groups["*"] = entry;
        updated = { ...updated, groups };
        changes.push(
          'Moved channels.telegram.groupMentionsOnly → channels.telegram.groups."*".requireMention.',
        );
      } else {
        changes.push(
          'Removed channels.telegram.groupMentionsOnly (channels.telegram.groups."*" already set).',
        );
      }
      const { groupMentionsOnly: _ignored, ...rest } = updated;
      updated = rest;
      changed = true;
    }
  }

  const streaming = normalizeLegacyStreamingAliases({
    changes,
    entry: updated,
    includePreviewChunk: true,
    pathPrefix: "channels.telegram",
    resolvedMode: resolveTelegramPreviewStreamMode(updated),
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
      const accountStreaming = normalizeLegacyStreamingAliases({
        changes,
        entry: account,
        includePreviewChunk: true,
        pathPrefix: `channels.telegram.accounts.${accountId}`,
        resolvedMode: resolveTelegramPreviewStreamMode(account),
      });
      if (accountStreaming.changed) {
        accounts[accountId] = accountStreaming.entry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts };
      changed = true;
    }
  }

  if (!changed && changes.length === 0) {
    return { changes: [], config: cfg };
  }
  return {
    changes,
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        telegram: updated as unknown as NonNullable<OpenClawConfig["channels"]>["telegram"],
      } as OpenClawConfig["channels"],
    },
  };
}
