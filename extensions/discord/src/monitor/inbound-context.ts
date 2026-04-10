import {
  buildUntrustedChannelMetadata,
  wrapExternalContent,
} from "openclaw/plugin-sdk/security-runtime";
import {
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
} from "./allow-list.js";

export interface DiscordSupplementalContextSender {
  id?: string;
  name?: string;
  tag?: string;
  memberRoleIds?: string[];
}

export function createDiscordSupplementalContextAccessChecker(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  isGuild: boolean;
}) {
  return (sender: DiscordSupplementalContextSender): boolean => {
    if (!params.isGuild) {
      return true;
    }
    return resolveDiscordMemberAllowed({
      allowNameMatching: params.allowNameMatching,
      memberRoleIds: sender.memberRoleIds ?? [],
      roleAllowList: params.channelConfig?.roles ?? params.guildInfo?.roles,
      userAllowList: params.channelConfig?.users ?? params.guildInfo?.users,
      userId: sender.id ?? "",
      userName: sender.name,
      userTag: sender.tag,
    });
  };
}

export function buildDiscordGroupSystemPrompt(
  channelConfig?: DiscordChannelConfigResolved | null,
): string | undefined {
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
}

export function buildDiscordUntrustedContext(params: {
  isGuild: boolean;
  channelTopic?: string;
  messageBody?: string;
}): string[] | undefined {
  if (!params.isGuild) {
    return undefined;
  }
  const entries = [
    buildUntrustedChannelMetadata({
      entries: [params.channelTopic],
      label: "Discord channel topic",
      source: "discord",
    }),
    typeof params.messageBody === "string" && params.messageBody.trim().length > 0
      ? wrapExternalContent(`UNTRUSTED Discord message body\n${params.messageBody.trim()}`, {
          includeWarning: false,
          source: "unknown",
        })
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}

export function buildDiscordInboundAccessContext(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  allowNameMatching?: boolean;
  isGuild: boolean;
  channelTopic?: string;
  messageBody?: string;
}) {
  return {
    groupSystemPrompt: params.isGuild
      ? buildDiscordGroupSystemPrompt(params.channelConfig)
      : undefined,
    ownerAllowFrom: resolveDiscordOwnerAllowFrom({
      allowNameMatching: params.allowNameMatching,
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
    }),
    untrustedContext: buildDiscordUntrustedContext({
      channelTopic: params.channelTopic,
      isGuild: params.isGuild,
      messageBody: params.messageBody,
    }),
  };
}
