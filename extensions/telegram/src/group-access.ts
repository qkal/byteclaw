import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import type {
  TelegramAccountConfig,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { evaluateMatchedGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import { type NormalizedAllowFrom, isSenderAllowed } from "./bot-access.js";
import { firstDefined } from "./bot-access.js";

export type TelegramGroupBaseBlockReason =
  | "group-disabled"
  | "topic-disabled"
  | "group-override-unauthorized";

export type TelegramGroupBaseAccessResult =
  | { allowed: true }
  | { allowed: false; reason: TelegramGroupBaseBlockReason };

function isGroupAllowOverrideAuthorized(params: {
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  requireSenderForAllowOverride: boolean;
}): boolean {
  if (!params.effectiveGroupAllow.hasEntries) {
    return false;
  }
  const senderId = params.senderId ?? "";
  if (params.requireSenderForAllowOverride && !senderId) {
    return false;
  }
  return isSenderAllowed({
    allow: params.effectiveGroupAllow,
    senderId,
    senderUsername: params.senderUsername ?? "",
  });
}

export const evaluateTelegramGroupBaseAccess = (params: {
  isGroup: boolean;
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
  hasGroupAllowOverride: boolean;
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  enforceAllowOverride: boolean;
  requireSenderForAllowOverride: boolean;
}): TelegramGroupBaseAccessResult => {
  // Check enabled flags for both groups and DMs
  if (params.groupConfig?.enabled === false) {
    return { allowed: false, reason: "group-disabled" };
  }
  if (params.topicConfig?.enabled === false) {
    return { allowed: false, reason: "topic-disabled" };
  }
  if (!params.isGroup) {
    // For DMs, check allowFrom override if present
    if (params.enforceAllowOverride && params.hasGroupAllowOverride) {
      if (
        !isGroupAllowOverrideAuthorized({
          effectiveGroupAllow: params.effectiveGroupAllow,
          requireSenderForAllowOverride: params.requireSenderForAllowOverride,
          senderId: params.senderId,
          senderUsername: params.senderUsername,
        })
      ) {
        return { allowed: false, reason: "group-override-unauthorized" };
      }
    }
    return { allowed: true };
  }
  if (!params.enforceAllowOverride || !params.hasGroupAllowOverride) {
    return { allowed: true };
  }

  if (
    !isGroupAllowOverrideAuthorized({
      effectiveGroupAllow: params.effectiveGroupAllow,
      requireSenderForAllowOverride: params.requireSenderForAllowOverride,
      senderId: params.senderId,
      senderUsername: params.senderUsername,
    })
  ) {
    return { allowed: false, reason: "group-override-unauthorized" };
  }
  return { allowed: true };
};

export type TelegramGroupPolicyBlockReason =
  | "group-policy-disabled"
  | "group-policy-allowlist-no-sender"
  | "group-policy-allowlist-empty"
  | "group-policy-allowlist-unauthorized"
  | "group-chat-not-allowed";

export type TelegramGroupPolicyAccessResult =
  | { allowed: true; groupPolicy: "open" | "disabled" | "allowlist" }
  | {
      allowed: false;
      reason: TelegramGroupPolicyBlockReason;
      groupPolicy: "open" | "disabled" | "allowlist";
    };

export const resolveTelegramRuntimeGroupPolicy = (params: {
  providerConfigPresent: boolean;
  groupPolicy?: TelegramAccountConfig["groupPolicy"];
  defaultGroupPolicy?: TelegramAccountConfig["groupPolicy"];
}) =>
  resolveOpenProviderRuntimeGroupPolicy({
    defaultGroupPolicy: params.defaultGroupPolicy,
    groupPolicy: params.groupPolicy,
    providerConfigPresent: params.providerConfigPresent,
  });

export const evaluateTelegramGroupPolicyAccess = (params: {
  isGroup: boolean;
  chatId: string | number;
  cfg: OpenClawConfig;
  telegramCfg: TelegramAccountConfig;
  topicConfig?: TelegramTopicConfig;
  groupConfig?: TelegramGroupConfig;
  effectiveGroupAllow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
  resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
  enforcePolicy: boolean;
  useTopicAndGroupOverrides: boolean;
  enforceAllowlistAuthorization: boolean;
  allowEmptyAllowlistEntries: boolean;
  requireSenderForAllowlistAuthorization: boolean;
  checkChatAllowlist: boolean;
}): TelegramGroupPolicyAccessResult => {
  const { groupPolicy: runtimeFallbackPolicy } = resolveTelegramRuntimeGroupPolicy({
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
    groupPolicy: params.telegramCfg.groupPolicy,
    providerConfigPresent: params.cfg.channels?.telegram !== undefined,
  });
  const fallbackPolicy =
    firstDefined(params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ??
    runtimeFallbackPolicy;
  const groupPolicy = params.useTopicAndGroupOverrides
    ? (firstDefined(
        params.topicConfig?.groupPolicy,
        params.groupConfig?.groupPolicy,
        params.telegramCfg.groupPolicy,
        params.cfg.channels?.defaults?.groupPolicy,
      ) ?? runtimeFallbackPolicy)
    : fallbackPolicy;

  if (!params.isGroup || !params.enforcePolicy) {
    return { allowed: true, groupPolicy };
  }
  if (groupPolicy === "disabled") {
    return { allowed: false, groupPolicy, reason: "group-policy-disabled" };
  }
  // Check chat-level allowlist first so that groups explicitly listed in the
  // `groups` config are not blocked by the sender-level "empty allowlist" guard.
  let chatExplicitlyAllowed = false;
  if (params.checkChatAllowlist) {
    const groupAllowlist = params.resolveGroupPolicy(params.chatId);
    if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) {
      return { allowed: false, groupPolicy, reason: "group-chat-not-allowed" };
    }
    // The chat is explicitly allowed when it has a dedicated entry in the groups
    // Config (groupConfig is set).  A wildcard ("*") match alone does not count
    // Because it only enables the group — sender-level filtering still applies.
    if (groupAllowlist.allowlistEnabled && groupAllowlist.allowed && groupAllowlist.groupConfig) {
      chatExplicitlyAllowed = true;
    }
  }
  if (groupPolicy === "allowlist" && params.enforceAllowlistAuthorization) {
    const senderId = params.senderId ?? "";
    const senderAuthorization = evaluateMatchedGroupAccessForPolicy({
      allowlistConfigured:
        chatExplicitlyAllowed ||
        params.allowEmptyAllowlistEntries ||
        params.effectiveGroupAllow.hasEntries,
      allowlistMatched:
        (chatExplicitlyAllowed && !params.effectiveGroupAllow.hasEntries) ||
        isSenderAllowed({
          allow: params.effectiveGroupAllow,
          senderId,
          senderUsername: params.senderUsername ?? "",
        }),
      groupPolicy,
      hasMatchInput: Boolean(senderId),
      requireMatchInput: params.requireSenderForAllowlistAuthorization,
    });
    if (!senderAuthorization.allowed && senderAuthorization.reason === "missing_match_input") {
      return { allowed: false, groupPolicy, reason: "group-policy-allowlist-no-sender" };
    }
    if (!senderAuthorization.allowed && senderAuthorization.reason === "empty_allowlist") {
      return { allowed: false, groupPolicy, reason: "group-policy-allowlist-empty" };
    }
    if (!senderAuthorization.allowed && senderAuthorization.reason === "not_allowlisted") {
      return { allowed: false, groupPolicy, reason: "group-policy-allowlist-unauthorized" };
    }
  }
  return { allowed: true, groupPolicy };
};
