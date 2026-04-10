import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostChannel } from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";
import {
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveAllowlistMatchSimple,
  resolveControlCommandGate,
  resolveEffectiveAllowFromLists,
} from "./runtime-api.js";

export function normalizeMattermostAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim()
    ? normalizeLowercaseStringOrEmpty(trimmed.replace(/^(mattermost|user):/i, "").replace(/^@/, ""))
    : "";
}

export function normalizeMattermostAllowList(entries: (string | number)[]): string[] {
  const normalized = entries
    .map((entry) => normalizeMattermostAllowEntry(String(entry)))
    .filter(Boolean);
  return [...new Set(normalized)];
}

export function resolveMattermostEffectiveAllowFromLists(params: {
  allowFrom?: (string | number)[] | null;
  groupAllowFrom?: (string | number)[] | null;
  storeAllowFrom?: (string | number)[] | null;
  dmPolicy?: string | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  return resolveEffectiveAllowFromLists({
    allowFrom: normalizeMattermostAllowList(params.allowFrom ?? []),
    dmPolicy: params.dmPolicy,
    groupAllowFrom: normalizeMattermostAllowList(params.groupAllowFrom ?? []),
    storeAllowFrom: normalizeMattermostAllowList(params.storeAllowFrom ?? []),
  });
}

export function isMattermostSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}): boolean {
  const allowFrom = normalizeMattermostAllowList(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  const match = resolveAllowlistMatchSimple({
    allowFrom,
    allowNameMatching: params.allowNameMatching,
    senderId: normalizeMattermostAllowEntry(params.senderId),
    senderName: params.senderName ? normalizeMattermostAllowEntry(params.senderName) : undefined,
  });
  return match.allowed;
}

function mapMattermostChannelKind(channelType?: string | null): "direct" | "group" | "channel" {
  const normalized = channelType?.trim().toUpperCase();
  if (normalized === "D") {
    return "direct";
  }
  if (normalized === "G" || normalized === "P") {
    return "group";
  }
  return "channel";
}

export type MattermostCommandAuthDecision =
  | {
      ok: true;
      commandAuthorized: boolean;
      channelInfo: MattermostChannel;
      kind: "direct" | "group" | "channel";
      chatType: "direct" | "group" | "channel";
      channelName: string;
      channelDisplay: string;
      roomLabel: string;
    }
  | {
      ok: false;
      denyReason:
        | "unknown-channel"
        | "dm-disabled"
        | "dm-pairing"
        | "unauthorized"
        | "channels-disabled"
        | "channel-no-allowlist";
      commandAuthorized: false;
      channelInfo: MattermostChannel | null;
      kind: "direct" | "group" | "channel";
      chatType: "direct" | "group" | "channel";
      channelName: string;
      channelDisplay: string;
      roomLabel: string;
    };

export function authorizeMattermostCommandInvocation(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  senderId: string;
  senderName: string;
  channelId: string;
  channelInfo: MattermostChannel | null;
  storeAllowFrom?: (string | number)[] | null;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
}): MattermostCommandAuthDecision {
  const {
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    channelInfo,
    storeAllowFrom,
    allowTextCommands,
    hasControlCommand,
  } = params;

  if (!channelInfo) {
    return {
      channelDisplay: "",
      channelInfo: null,
      channelName: "",
      chatType: "channel",
      commandAuthorized: false,
      denyReason: "unknown-channel",
      kind: "channel",
      ok: false,
      roomLabel: `#${channelId}`,
    };
  }

  const kind = mapMattermostChannelKind(channelInfo.type);
  const chatType = kind;
  const channelName = channelInfo.name ?? "";
  const channelDisplay = channelInfo.display_name ?? channelName;
  const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const configAllowFrom = normalizeMattermostAllowList(account.config.allowFrom ?? []);
  const configGroupAllowFrom = normalizeMattermostAllowList(account.config.groupAllowFrom ?? []);
  const normalizedStoreAllowFrom = normalizeMattermostAllowList(storeAllowFrom ?? []);
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveMattermostEffectiveAllowFromLists({
    allowFrom: configAllowFrom,
    dmPolicy,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom: normalizedStoreAllowFrom,
  });

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const commandDmAllowFrom = kind === "direct" ? effectiveAllowFrom : configAllowFrom;
  const commandGroupAllowFrom =
    kind === "direct"
      ? effectiveGroupAllowFrom
      : (configGroupAllowFrom.length > 0
        ? configGroupAllowFrom
        : configAllowFrom);

  const senderAllowedForCommands = isMattermostSenderAllowed({
    allowFrom: commandDmAllowFrom,
    allowNameMatching,
    senderId,
    senderName,
  });
  const groupAllowedForCommands = isMattermostSenderAllowed({
    allowFrom: commandGroupAllowFrom,
    allowNameMatching,
    senderId,
    senderName,
  });

  const commandGate = resolveControlCommandGate({
    allowTextCommands,
    authorizers: [
      { allowed: senderAllowedForCommands, configured: commandDmAllowFrom.length > 0 },
      {
        allowed: groupAllowedForCommands,
        configured: commandGroupAllowFrom.length > 0,
      },
    ],
    hasControlCommand: allowTextCommands && hasControlCommand,
    useAccessGroups,
  });

  const commandAuthorized =
    kind === "direct"
      ? dmPolicy === "open" || senderAllowedForCommands
      : commandGate.commandAuthorized;

  if (kind === "direct") {
    if (dmPolicy === "disabled") {
      return {
        channelDisplay,
        channelInfo,
        channelName,
        chatType,
        commandAuthorized: false,
        denyReason: "dm-disabled",
        kind,
        ok: false,
        roomLabel,
      };
    }

    if (dmPolicy !== "open" && !senderAllowedForCommands) {
      return {
        channelDisplay,
        channelInfo,
        channelName,
        chatType,
        commandAuthorized: false,
        denyReason: dmPolicy === "pairing" ? "dm-pairing" : "unauthorized",
        kind,
        ok: false,
        roomLabel,
      };
    }
  } else {
    const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
      groupAllowFrom: effectiveGroupAllowFrom,
      groupPolicy,
      isSenderAllowed: (_senderId, allowFrom) =>
        isMattermostSenderAllowed({
          allowFrom,
          allowNameMatching,
          senderId,
          senderName,
        }),
      senderId,
    });

    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
      return {
        channelDisplay,
        channelInfo,
        channelName,
        chatType,
        commandAuthorized: false,
        denyReason: "channels-disabled",
        kind,
        ok: false,
        roomLabel,
      };
    }

    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
      return {
        channelDisplay,
        channelInfo,
        channelName,
        chatType,
        commandAuthorized: false,
        denyReason: "channel-no-allowlist",
        kind,
        ok: false,
        roomLabel,
      };
    }

    if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {
      return {
        channelDisplay,
        channelInfo,
        channelName,
        chatType,
        commandAuthorized: false,
        denyReason: "unauthorized",
        kind,
        ok: false,
        roomLabel,
      };
    }

    if (commandGate.shouldBlock) {
      return {
        channelDisplay,
        channelInfo,
        channelName,
        chatType,
        commandAuthorized: false,
        denyReason: "unauthorized",
        kind,
        ok: false,
        roomLabel,
      };
    }
  }

  return {
    channelDisplay,
    channelInfo,
    channelName,
    chatType,
    commandAuthorized,
    kind,
    ok: true,
    roomLabel,
  };
}
