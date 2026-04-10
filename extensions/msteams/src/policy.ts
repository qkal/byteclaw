import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupPolicy,
  GroupToolPolicyConfig,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "../runtime-api.js";
import {
  buildChannelKeyCandidates,
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  normalizeChannelSlug,
  resolveAllowlistMatchSimple,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
  resolveToolsBySender,
} from "../runtime-api.js";

export interface MSTeamsResolvedRouteConfig {
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
  allowlistConfigured: boolean;
  allowed: boolean;
  teamKey?: string;
  channelKey?: string;
  channelMatchKey?: string;
  channelMatchSource?: "direct" | "wildcard";
}

export function resolveMSTeamsRouteConfig(params: {
  cfg?: MSTeamsConfig;
  teamId?: string | null | undefined;
  teamName?: string | null | undefined;
  conversationId?: string | null | undefined;
  channelName?: string | null | undefined;
  allowNameMatching?: boolean;
}): MSTeamsResolvedRouteConfig {
  const teamId = params.teamId?.trim();
  const teamName = params.teamName?.trim();
  const conversationId = params.conversationId?.trim();
  const channelName = params.channelName?.trim();
  const teams = params.cfg?.teams ?? {};
  const allowlistConfigured = Object.keys(teams).length > 0;
  const teamCandidates = buildChannelKeyCandidates(
    teamId,
    params.allowNameMatching ? teamName : undefined,
    params.allowNameMatching && teamName ? normalizeChannelSlug(teamName) : undefined,
  );
  const teamMatch = resolveChannelEntryMatchWithFallback({
    entries: teams,
    keys: teamCandidates,
    normalizeKey: normalizeChannelSlug,
    wildcardKey: "*",
  });
  const teamConfig = teamMatch.entry;
  const channels = teamConfig?.channels ?? {};
  const channelAllowlistConfigured = Object.keys(channels).length > 0;
  const channelCandidates = buildChannelKeyCandidates(
    conversationId,
    params.allowNameMatching ? channelName : undefined,
    params.allowNameMatching && channelName ? normalizeChannelSlug(channelName) : undefined,
  );
  const channelMatch = resolveChannelEntryMatchWithFallback({
    entries: channels,
    keys: channelCandidates,
    normalizeKey: normalizeChannelSlug,
    wildcardKey: "*",
  });
  const channelConfig = channelMatch.entry;

  const allowed = resolveNestedAllowlistDecision({
    innerConfigured: channelAllowlistConfigured,
    innerMatched: Boolean(channelConfig),
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(teamConfig),
  });

  return {
    allowed,
    allowlistConfigured,
    channelConfig,
    channelKey: channelMatch.matchKey ?? channelMatch.key,
    channelMatchKey: channelMatch.matchKey,
    channelMatchSource:
      channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard"
        ? channelMatch.matchSource
        : undefined,
    teamConfig,
    teamKey: teamMatch.matchKey ?? teamMatch.key,
  };
}

export function resolveMSTeamsGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.msteams;
  if (!cfg) {
    return undefined;
  }
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();
  const groupSpace = params.groupSpace?.trim();
  const allowNameMatching = isDangerousNameMatchingEnabled(cfg);

  const resolved = resolveMSTeamsRouteConfig({
    allowNameMatching,
    cfg,
    channelName: groupChannel,
    conversationId: groupId,
    teamId: groupSpace,
    teamName: groupSpace,
  });

  if (resolved.channelConfig) {
    const senderPolicy = resolveToolsBySender({
      senderE164: params.senderE164,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      toolsBySender: resolved.channelConfig.toolsBySender,
    });
    if (senderPolicy) {
      return senderPolicy;
    }
    if (resolved.channelConfig.tools) {
      return resolved.channelConfig.tools;
    }
    const teamSenderPolicy = resolveToolsBySender({
      senderE164: params.senderE164,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      toolsBySender: resolved.teamConfig?.toolsBySender,
    });
    if (teamSenderPolicy) {
      return teamSenderPolicy;
    }
    return resolved.teamConfig?.tools;
  }
  if (resolved.teamConfig) {
    const teamSenderPolicy = resolveToolsBySender({
      senderE164: params.senderE164,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      toolsBySender: resolved.teamConfig.toolsBySender,
    });
    if (teamSenderPolicy) {
      return teamSenderPolicy;
    }
    if (resolved.teamConfig.tools) {
      return resolved.teamConfig.tools;
    }
  }

  if (!groupId) {
    return undefined;
  }

  const channelCandidates = buildChannelKeyCandidates(
    groupId,
    allowNameMatching ? groupChannel : undefined,
    allowNameMatching && groupChannel ? normalizeChannelSlug(groupChannel) : undefined,
  );
  for (const teamConfig of Object.values(cfg.teams ?? {})) {
    const match = resolveChannelEntryMatchWithFallback({
      entries: teamConfig?.channels ?? {},
      keys: channelCandidates,
      normalizeKey: normalizeChannelSlug,
      wildcardKey: "*",
    });
    if (match.entry) {
      const senderPolicy = resolveToolsBySender({
        senderE164: params.senderE164,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        toolsBySender: match.entry.toolsBySender,
      });
      if (senderPolicy) {
        return senderPolicy;
      }
      if (match.entry.tools) {
        return match.entry.tools;
      }
      const teamSenderPolicy = resolveToolsBySender({
        senderE164: params.senderE164,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        toolsBySender: teamConfig?.toolsBySender,
      });
      if (teamSenderPolicy) {
        return teamSenderPolicy;
      }
      return teamConfig?.tools;
    }
  }

  return undefined;
}

export interface MSTeamsReplyPolicy {
  requireMention: boolean;
  replyStyle: MSTeamsReplyStyle;
}

export type MSTeamsAllowlistMatch = AllowlistMatch<"wildcard" | "id" | "name">;

export function resolveMSTeamsAllowlistMatch(params: {
  allowFrom: (string | number)[];
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): MSTeamsAllowlistMatch {
  return resolveAllowlistMatchSimple(params);
}

export function resolveMSTeamsReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: MSTeamsConfig;
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
}): MSTeamsReplyPolicy {
  if (params.isDirectMessage) {
    return { replyStyle: "thread", requireMention: false };
  }

  const requireMention =
    params.channelConfig?.requireMention ??
    params.teamConfig?.requireMention ??
    params.globalConfig?.requireMention ??
    true;

  const explicitReplyStyle =
    params.channelConfig?.replyStyle ??
    params.teamConfig?.replyStyle ??
    params.globalConfig?.replyStyle;

  const replyStyle: MSTeamsReplyStyle =
    explicitReplyStyle ?? (requireMention ? "thread" : "top-level");

  return { replyStyle, requireMention };
}

export function isMSTeamsGroupAllowed(params: {
  groupPolicy: GroupPolicy;
  allowFrom: (string | number)[];
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): boolean {
  return evaluateSenderGroupAccessForPolicy({
    groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
    groupPolicy: params.groupPolicy,
    isSenderAllowed: () => resolveMSTeamsAllowlistMatch(params).allowed,
    senderId: params.senderId,
  }).allowed;
}
