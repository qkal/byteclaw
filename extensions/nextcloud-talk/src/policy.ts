import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupPolicy,
  GroupToolPolicyConfig,
} from "../runtime-api.js";
import {
  buildChannelKeyCandidates,
  evaluateMatchedGroupAccessForPolicy,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "../runtime-api.js";
import type { NextcloudTalkRoomConfig } from "./types.js";

function normalizeAllowEntry(raw: string): string {
  return normalizeLowercaseStringOrEmpty(raw.trim().replace(/^(nextcloud-talk|nc-talk|nc):/i, ""));
}

export function normalizeNextcloudTalkAllowlist(
  values: (string | number)[] | undefined,
): string[] {
  return (values ?? []).map((value) => normalizeAllowEntry(String(value))).filter(Boolean);
}

export function resolveNextcloudTalkAllowlistMatch(params: {
  allowFrom: (string | number)[] | undefined;
  senderId: string;
}): AllowlistMatch<"wildcard" | "id"> {
  const allowFrom = normalizeNextcloudTalkAllowlist(params.allowFrom);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const senderId = normalizeAllowEntry(params.senderId);
  if (allowFrom.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  return { allowed: false };
}

export interface NextcloudTalkRoomMatch {
  roomConfig?: NextcloudTalkRoomConfig;
  wildcardConfig?: NextcloudTalkRoomConfig;
  roomKey?: string;
  matchSource?: "direct" | "parent" | "wildcard";
  allowed: boolean;
  allowlistConfigured: boolean;
}

export function resolveNextcloudTalkRoomMatch(params: {
  rooms?: Record<string, NextcloudTalkRoomConfig>;
  roomToken: string;
}): NextcloudTalkRoomMatch {
  const rooms = params.rooms ?? {};
  const allowlistConfigured = Object.keys(rooms).length > 0;
  const roomCandidates = buildChannelKeyCandidates(params.roomToken);
  const match = resolveChannelEntryMatchWithFallback({
    entries: rooms,
    keys: roomCandidates,
    normalizeKey: normalizeChannelSlug,
    wildcardKey: "*",
  });
  const roomConfig = match.entry;
  const allowed = resolveNestedAllowlistDecision({
    innerConfigured: false,
    innerMatched: false,
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(roomConfig),
  });

  return {
    allowed,
    allowlistConfigured,
    matchSource: match.matchSource,
    roomConfig,
    roomKey: match.matchKey ?? match.key,
    wildcardConfig: match.wildcardEntry,
  };
}

export function resolveNextcloudTalkGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg as {
    channels?: { "nextcloud-talk"?: { rooms?: Record<string, NextcloudTalkRoomConfig> } };
  };
  const roomToken = params.groupId?.trim();
  if (!roomToken) {
    return undefined;
  }
  const match = resolveNextcloudTalkRoomMatch({
    roomToken,
    rooms: cfg.channels?.["nextcloud-talk"]?.rooms,
  });
  return match.roomConfig?.tools ?? match.wildcardConfig?.tools;
}

export function resolveNextcloudTalkRequireMention(params: {
  roomConfig?: NextcloudTalkRoomConfig;
  wildcardConfig?: NextcloudTalkRoomConfig;
}): boolean {
  if (typeof params.roomConfig?.requireMention === "boolean") {
    return params.roomConfig.requireMention;
  }
  if (typeof params.wildcardConfig?.requireMention === "boolean") {
    return params.wildcardConfig.requireMention;
  }
  return true;
}

export function resolveNextcloudTalkGroupAllow(params: {
  groupPolicy: GroupPolicy;
  outerAllowFrom: (string | number)[] | undefined;
  innerAllowFrom: (string | number)[] | undefined;
  senderId: string;
}): { allowed: boolean; outerMatch: AllowlistMatch; innerMatch: AllowlistMatch } {
  const outerAllow = normalizeNextcloudTalkAllowlist(params.outerAllowFrom);
  const innerAllow = normalizeNextcloudTalkAllowlist(params.innerAllowFrom);
  const outerMatch = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.outerAllowFrom,
    senderId: params.senderId,
  });
  const innerMatch = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.innerAllowFrom,
    senderId: params.senderId,
  });
  const access = evaluateMatchedGroupAccessForPolicy({
    allowlistConfigured: outerAllow.length > 0 || innerAllow.length > 0,
    allowlistMatched: resolveNestedAllowlistDecision({
      innerConfigured: innerAllow.length > 0,
      innerMatched: innerMatch.allowed,
      outerConfigured: outerAllow.length > 0 || innerAllow.length > 0,
      outerMatched: outerAllow.length > 0 ? outerMatch.allowed : true,
    }),
    groupPolicy: params.groupPolicy,
  });

  return {
    allowed: access.allowed,
    innerMatch:
      params.groupPolicy === "open"
        ? { allowed: true }
        : (params.groupPolicy === "disabled"
          ? { allowed: false }
          : innerMatch),
    outerMatch:
      params.groupPolicy === "open"
        ? { allowed: true }
        : (params.groupPolicy === "disabled"
          ? { allowed: false }
          : outerMatch),
  };
}

export function resolveNextcloudTalkMentionGate(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}): { shouldSkip: boolean; shouldBypassMention: boolean } {
  const result = resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      implicitMentionKinds: [],
      wasMentioned: params.wasMentioned,
    },
    policy: {
      allowTextCommands: params.allowTextCommands,
      commandAuthorized: params.commandAuthorized,
      hasControlCommand: params.hasControlCommand,
      isGroup: params.isGroup,
      requireMention: params.requireMention,
    },
  });
  return { shouldBypassMention: result.shouldBypassMention, shouldSkip: result.shouldSkip };
}
