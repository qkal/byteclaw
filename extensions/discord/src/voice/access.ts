import type { Guild } from "@buape/carbon";
import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import {
  isDiscordGroupAllowedByPolicy,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAccess,
} from "../monitor/allow-list.js";

export async function authorizeDiscordVoiceIngress(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  groupPolicy?: "open" | "disabled" | "allowlist";
  useAccessGroups?: boolean;
  guild?: Guild<true> | Guild | null;
  guildName?: string;
  guildId: string;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  parentId?: string;
  parentName?: string;
  parentSlug?: string;
  scope?: "channel" | "thread";
  channelLabel?: string;
  memberRoleIds: string[];
  sender: { id: string; name?: string; tag?: string };
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const groupPolicy =
    params.groupPolicy ??
    resolveOpenProviderRuntimeGroupPolicy({
      defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
      groupPolicy: params.discordConfig.groupPolicy,
      providerConfigPresent: params.cfg.channels?.discord !== undefined,
    }).groupPolicy;
  const guild =
    params.guild ??
    ({ id: params.guildId, ...(params.guildName ? { name: params.guildName } : {}) } as Guild);
  const guildInfo = resolveDiscordGuildEntry({
    guild,
    guildEntries: params.discordConfig.guilds,
    guildId: params.guildId,
  });
  const channelConfig = params.channelId
    ? resolveDiscordChannelConfigWithFallback({
        channelId: params.channelId,
        channelName: params.channelName,
        channelSlug: params.channelSlug,
        guildInfo,
        parentId: params.parentId,
        parentName: params.parentName,
        parentSlug: params.parentSlug,
        scope: params.scope,
      })
    : null;

  if (channelConfig?.enabled === false) {
    return { message: "This channel is disabled.", ok: false };
  }

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  if (!params.channelId && groupPolicy === "allowlist" && channelAllowlistConfigured) {
    return {
      message: `${params.channelLabel ?? "This channel"} is not allowlisted for voice commands.`,
      ok: false,
    };
  }

  const channelAllowed = channelConfig ? channelConfig.allowed : !channelAllowlistConfigured;
  if (
    !isDiscordGroupAllowedByPolicy({
      channelAllowed,
      channelAllowlistConfigured,
      groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
    }) ||
    channelConfig?.allowed === false
  ) {
    return {
      message: `${params.channelLabel ?? "This channel"} is not allowlisted for voice commands.`,
      ok: false,
    };
  }

  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    allowNameMatching: false,
    channelConfig,
    guildInfo,
    memberRoleIds: params.memberRoleIds,
    sender: params.sender,
  });

  const { ownerAllowList, ownerAllowed } = resolveDiscordOwnerAccess({
    allowFrom: params.discordConfig.allowFrom ?? params.discordConfig.dm?.allowFrom ?? [],
    allowNameMatching: false,
    sender: params.sender,
  });

  const useAccessGroups = params.useAccessGroups ?? params.cfg.commands?.useAccessGroups !== false;
  const authorizers = useAccessGroups
    ? [
        { allowed: ownerAllowed, configured: ownerAllowList != null },
        { allowed: memberAllowed, configured: hasAccessRestrictions },
      ]
    : [{ allowed: memberAllowed, configured: hasAccessRestrictions }];

  return resolveCommandAuthorizedFromAuthorizers({
    authorizers,
    modeWhenAccessGroupsOff: "configured",
    useAccessGroups,
  })
    ? { ok: true }
    : { message: "You are not authorized to use this command.", ok: false };
}
