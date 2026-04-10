import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  legacyConfigRules as MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeMattermostCompatibilityConfig,
} from "./doctor-contract.js";

function isMattermostMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const normalized = text
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim();
  const lowered = normalizeLowercaseStringOrEmpty(normalized);

  if (/^[a-z0-9]{26}$/.test(lowered)) {
    return false;
  }

  return true;
}

export const collectMattermostMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "mattermost",
    collectLists: (scope) => [
      {
        list: scope.account.allowFrom,
        pathLabel: `${scope.prefix}.allowFrom`,
      },
      {
        list: scope.account.groupAllowFrom,
        pathLabel: `${scope.prefix}.groupAllowFrom`,
      },
    ],
    detector: isMattermostMutableAllowEntry,
  });

export const mattermostDoctor: ChannelDoctorAdapter = {
  collectMutableAllowlistWarnings: collectMattermostMutableAllowlistWarnings,
  legacyConfigRules: MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeMattermostCompatibilityConfig,
};
