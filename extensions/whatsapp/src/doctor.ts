import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const legacyAckReaction = cfg.messages?.ackReaction?.trim();
  if (!legacyAckReaction || cfg.channels?.whatsapp === undefined) {
    return { changes: [], config: cfg };
  }
  if (cfg.channels.whatsapp?.ackReaction !== undefined) {
    return { changes: [], config: cfg };
  }

  const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  let direct = true;
  let group: "always" | "mentions" | "never" = "mentions";
  if (legacyScope === "all") {
    direct = true;
    group = "always";
  } else if (legacyScope === "direct") {
    direct = true;
    group = "never";
  } else if (legacyScope === "group-all") {
    direct = false;
    group = "always";
  } else if (legacyScope === "group-mentions") {
    direct = false;
    group = "mentions";
  }

  return {
    changes: [
      `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
    ],
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        whatsapp: {
          ...cfg.channels?.whatsapp,
          ackReaction: { direct, emoji: legacyAckReaction, group },
        },
      },
    },
  };
}

export const whatsappDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
};
