import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  type OpenClawConfig,
  createChannelPairingController,
  evaluateGroupRouteAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveSenderScopedGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";
import type { GoogleChatAnnotation, GoogleChatMessage, GoogleChatSpace } from "./types.js";

function normalizeUserId(raw?: string | null): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}

function isEmailLike(value: string): boolean {
  // Keep this intentionally loose; allowlists are user-provided config.
  return value.includes("@");
}

export function isSenderAllowed(
  senderId: string,
  senderEmail: string | undefined,
  allowFrom: string[],
  allowNameMatching = false,
) {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeUserId(senderId);
  const normalizedEmail = normalizeLowercaseStringOrEmpty(senderEmail ?? "");
  return allowFrom.some((entry) => {
    const normalized = normalizeLowercaseStringOrEmpty(String(entry));
    if (!normalized) {
      return false;
    }

    // Accept `googlechat:<id>` but treat `users/...` as an *ID* only (deprecated `users/<email>`).
    const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
    if (withoutPrefix.startsWith("users/")) {
      return normalizeUserId(withoutPrefix) === normalizedSenderId;
    }

    // Raw email allowlist entries are a break-glass override.
    if (allowNameMatching && normalizedEmail && isEmailLike(withoutPrefix)) {
      return withoutPrefix === normalizedEmail;
    }

    return withoutPrefix.replace(/^users\//i, "") === normalizedSenderId;
  });
}

interface GoogleChatGroupEntry {
  requireMention?: boolean;
  enabled?: boolean;
  users?: (string | number)[];
  systemPrompt?: string;
}

function resolveGroupConfig(params: {
  groupId: string;
  groupName?: string | null;
  groups?: Record<string, GoogleChatGroupEntry>;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { allowlistConfigured: false, deprecatedNameMatch: false, entry: undefined };
  }
  const entry = entries[groupId];
  const normalizedGroupName = normalizeLowercaseStringOrEmpty(groupName ?? "");
  const deprecatedNameMatch =
    !entry &&
    Boolean(
      groupName &&
      keys.some((key) => {
        const trimmed = key.trim();
        if (!trimmed || trimmed === "*" || /^spaces\//i.test(trimmed)) {
          return false;
        }
        return (
          trimmed === groupName || normalizeLowercaseStringOrEmpty(trimmed) === normalizedGroupName
        );
      }),
    );
  const fallback = entries["*"];
  return {
    allowlistConfigured: true,
    deprecatedNameMatch,
    entry: deprecatedNameMatch ? undefined : (entry ?? fallback),
    fallback,
  };
}

function extractMentionInfo(annotations: GoogleChatAnnotation[], botUser?: string | null) {
  const mentionAnnotations = annotations.filter((entry) => entry.type === "USER_MENTION");
  const hasAnyMention = mentionAnnotations.length > 0;
  const botTargets = new Set(["users/app", botUser?.trim()].filter(Boolean) as string[]);
  const wasMentioned = mentionAnnotations.some((entry) => {
    const userName = entry.userMention?.user?.name;
    if (!userName) {
      return false;
    }
    if (botTargets.has(userName)) {
      return true;
    }
    return normalizeUserId(userName) === "app";
  });
  return { hasAnyMention, wasMentioned };
}

const warnedDeprecatedUsersEmailAllowFrom = new Set<string>();
const warnedMutableGroupKeys = new Set<string>();

function warnDeprecatedUsersEmailEntries(logVerbose: (message: string) => void, entries: string[]) {
  const deprecated = entries
    .map((v) => normalizeOptionalString(v))
    .filter((v): v is string => Boolean(v))
    .filter((v) => /^users\/.+@.+/i.test(v));
  if (deprecated.length === 0) {
    return;
  }
  const key = deprecated
    .map((v) => normalizeLowercaseStringOrEmpty(v))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");
  if (warnedDeprecatedUsersEmailAllowFrom.has(key)) {
    return;
  }
  warnedDeprecatedUsersEmailAllowFrom.add(key);
  logVerbose(
    `Deprecated allowFrom entry detected: "users/<email>" is no longer treated as an email allowlist. Use raw email (alice@example.com) or immutable user id (users/<id>). entries=${deprecated.join(", ")}`,
  );
}

function warnMutableGroupKeysConfigured(
  logVerbose: (message: string) => void,
  groups?: Record<string, GoogleChatGroupEntry>,
) {
  const mutableKeys = Object.keys(groups ?? {})
    .map((key) => key.trim())
    .filter((key) => key && key !== "*" && !/^spaces\//i.test(key));
  if (mutableKeys.length === 0) {
    return;
  }
  const warningKey = mutableKeys
    .map((key) => normalizeLowercaseStringOrEmpty(key))
    .toSorted((a, b) => a.localeCompare(b))
    .join(",");
  if (warnedMutableGroupKeys.has(warningKey)) {
    return;
  }
  warnedMutableGroupKeys.add(warningKey);
  logVerbose(
    `Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: ${mutableKeys.join(", ")}`,
  );
}

export async function applyGoogleChatInboundAccessPolicy(params: {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  core: GoogleChatCoreRuntime;
  space: GoogleChatSpace;
  message: GoogleChatMessage;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  senderEmail?: string;
  rawBody: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  logVerbose: (message: string) => void;
}): Promise<
  | {
      ok: true;
      commandAuthorized: boolean | undefined;
      effectiveWasMentioned: boolean | undefined;
      groupSystemPrompt: string | undefined;
    }
  | { ok: false }
> {
  const {
    account,
    config,
    core,
    space,
    message,
    isGroup,
    senderId,
    senderName,
    senderEmail,
    rawBody,
    statusSink,
    logVerbose,
  } = params;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const spaceId = space.name ?? "";
  const pairing = createChannelPairingController({
    accountId: account.accountId,
    channel: "googlechat",
    core,
  });

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      defaultGroupPolicy,
      groupPolicy: account.config.groupPolicy,
      providerConfigPresent: config.channels?.googlechat !== undefined,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.space,
    log: logVerbose,
    providerKey: "googlechat",
    providerMissingFallbackApplied,
  });
  warnMutableGroupKeysConfigured(logVerbose, account.config.groups ?? undefined);
  const groupConfigResolved = resolveGroupConfig({
    groupId: spaceId,
    groupName: space.displayName ?? null,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
  let effectiveWasMentioned: boolean | undefined;

  if (isGroup) {
    if (groupConfigResolved.deprecatedNameMatch) {
      logVerbose(`drop group message (deprecated mutable group key matched, space=${spaceId})`);
      return { ok: false };
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const routeAccess = evaluateGroupRouteAccessForPolicy({
      groupPolicy,
      routeAllowlistConfigured: groupAllowlistConfigured,
      routeEnabled: groupEntry?.enabled !== false,
      routeMatched: Boolean(groupEntry),
    });
    if (!routeAccess.allowed) {
      if (routeAccess.reason === "disabled") {
        logVerbose(`drop group message (groupPolicy=disabled, space=${spaceId})`);
      } else if (routeAccess.reason === "empty_allowlist") {
        logVerbose(`drop group message (groupPolicy=allowlist, no allowlist, space=${spaceId})`);
      } else if (routeAccess.reason === "route_not_allowlisted") {
        logVerbose(`drop group message (not allowlisted, space=${spaceId})`);
      } else if (routeAccess.reason === "route_disabled") {
        logVerbose(`drop group message (space disabled, space=${spaceId})`);
      }
      return { ok: false };
    }

    if (groupUsers.length > 0) {
      const normalizedGroupUsers = groupUsers.map((v) => String(v));
      warnDeprecatedUsersEmailEntries(logVerbose, normalizedGroupUsers);
      const ok = isSenderAllowed(senderId, senderEmail, normalizedGroupUsers, allowNameMatching);
      if (!ok) {
        logVerbose(`drop group message (sender not allowed, ${senderId})`);
        return { ok: false };
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
  const normalizedGroupUsers = groupUsers.map((v) => String(v));
  const senderGroupPolicy =
    groupConfigResolved.allowlistConfigured && normalizedGroupUsers.length === 0
      ? groupPolicy
      : resolveSenderScopedGroupPolicy({
          groupAllowFrom: normalizedGroupUsers,
          groupPolicy,
        });
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeAuth)
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const access = resolveDmGroupAccessWithLists({
    allowFrom: configAllowFrom,
    dmPolicy,
    groupAllowFrom: normalizedGroupUsers,
    groupAllowFromFallbackToAllowFrom: false,
    groupPolicy: senderGroupPolicy,
    isGroup,
    isSenderAllowed: (allowFrom) =>
      isSenderAllowed(senderId, senderEmail, allowFrom, allowNameMatching),
    storeAllowFrom,
  });
  const { effectiveAllowFrom } = access;
  const { effectiveGroupAllowFrom } = access;
  warnDeprecatedUsersEmailEntries(logVerbose, effectiveAllowFrom);
  const commandAllowFrom = isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(
    senderId,
    senderEmail,
    commandAllowFrom,
    allowNameMatching,
  );
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        authorizers: [
          { allowed: senderAllowedForCommands, configured: commandAllowFrom.length > 0 },
        ],
        useAccessGroups,
      })
    : undefined;

  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const annotations = message.annotations ?? [];
    const mentionInfo = extractMentionInfo(annotations, account.config.botUser);
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "googlechat",
    });
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        hasAnyMention: mentionInfo.hasAnyMention,
        implicitMentionKinds: [],
        wasMentioned: mentionInfo.wasMentioned,
      },
      policy: {
        allowTextCommands,
        commandAuthorized: commandAuthorized === true,
        hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
        isGroup: true,
        requireMention,
      },
    });
    ({ effectiveWasMentioned } = mentionDecision);
    if (mentionDecision.shouldSkip) {
      logVerbose(`drop group message (mention required, space=${spaceId})`);
      return { ok: false };
    }
  }

  if (isGroup && access.decision !== "allow") {
    logVerbose(
      `drop group message (sender policy blocked, reason=${access.reason}, space=${spaceId})`,
    );
    return { ok: false };
  }

  if (!isGroup) {
    if (account.config.dm?.enabled === false) {
      logVerbose(`Blocked Google Chat DM from ${senderId} (dmPolicy=disabled)`);
      return { ok: false };
    }

    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        await pairing.issueChallenge({
          meta: { email: senderEmail, name: senderName || undefined },
          onCreated: () => {
            logVerbose(`googlechat pairing request sender=${senderId}`);
          },
          onReplyError: (err) => {
            logVerbose(`pairing reply failed for ${senderId}: ${String(err)}`);
          },
          sendPairingReply: async (text) => {
            await sendGoogleChatMessage({
              account,
              space: spaceId,
              text,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          senderId,
          senderIdLine: `Your Google Chat user id: ${senderId}`,
        });
      } else {
        logVerbose(`Blocked unauthorized Google Chat sender ${senderId} (dmPolicy=${dmPolicy})`);
      }
      return { ok: false };
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(`googlechat: drop control command from ${senderId}`);
    return { ok: false };
  }

  return {
    commandAuthorized,
    effectiveWasMentioned,
    groupSystemPrompt: normalizeOptionalString(groupEntry?.systemPrompt),
    ok: true,
  };
}
