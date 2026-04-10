import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  legacyConfigRules as SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeSlackCompatibilityConfig,
} from "./doctor-contract.js";
import { isSlackMutableAllowEntry } from "./security-doctor.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const collectSlackMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "slack",
    collectLists: (scope) => {
      const lists = [
        {
          list: scope.account.allowFrom,
          pathLabel: `${scope.prefix}.allowFrom`,
        },
      ];
      const dm = asObjectRecord(scope.account.dm);
      if (dm) {
        lists.push({
          list: dm.allowFrom,
          pathLabel: `${scope.prefix}.dm.allowFrom`,
        });
      }
      const channels = asObjectRecord(scope.account.channels);
      if (channels) {
        for (const [channelKey, channelRaw] of Object.entries(channels)) {
          const channel = asObjectRecord(channelRaw);
          if (!channel) {
            continue;
          }
          lists.push({
            list: channel.users,
            pathLabel: `${scope.prefix}.channels.${channelKey}.users`,
          });
        }
      }
      return lists;
    },
    detector: isSlackMutableAllowEntry,
  });

export const slackDoctor: ChannelDoctorAdapter = {
  collectMutableAllowlistWarnings: collectSlackMutableAllowlistWarnings,
  dmAllowFromMode: "topOrNested",
  groupAllowFromFallbackToAllowFrom: false,
  groupModel: "route",
  legacyConfigRules: SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeSlackCompatibilityConfig,
  warnOnEmptyGroupSenderAllowlist: false,
};
