import {
  type EnvelopeFormatOptions,
  buildMentionRegexes,
  formatInboundEnvelope,
  formatInboundFromLabel,
  logInboundDrop,
  matchesMentionPatterns,
  resolveEnvelopeFormatOptions,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import { resolveDualTextControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveChannelContextVisibilityMode,
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/config-runtime";
import {
  type HistoryEntry,
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  DM_GROUP_ACCESS_REASON,
  evaluateSupplementalContextVisibility,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-runtime";
import { resolveIMessageConversationRoute } from "../conversation-route.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
} from "../targets.js";
import { detectReflectedContent } from "./reflection-guard.js";
import type { SelfChatCache } from "./self-chat-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";

interface IMessageReplyContext {
  id?: string;
  body: string;
  sender?: string;
}

function normalizeReplyField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function describeReplyContext(message: IMessagePayload): IMessageReplyContext | null {
  const body = normalizeReplyField(message.reply_to_text);
  if (!body) {
    return null;
  }
  const id = normalizeReplyField(message.reply_to_id);
  const sender = normalizeReplyField(message.reply_to_sender);
  return { body, id, sender };
}

function resolveInboundEchoMessageIds(message: IMessagePayload): string[] {
  const values = [
    message.id != null ? String(message.id) : undefined,
    normalizeReplyField(message.guid),
  ];
  const ids: string[] = [];
  for (const value of values) {
    if (!value || ids.includes(value)) {
      continue;
    }
    ids.push(value);
  }
  return ids;
}

function hasIMessageEchoMatch(params: {
  echoCache: {
    has: (
      scope: string,
      lookup: { text?: string; messageId?: string },
      skipIdShortCircuit?: boolean,
    ) => boolean;
  };
  scope: string;
  text?: string;
  messageIds: string[];
  skipIdShortCircuit?: boolean;
}): boolean {
  for (const messageId of params.messageIds) {
    if (params.echoCache.has(params.scope, { messageId })) {
      return true;
    }
  }
  const fallbackMessageId = params.messageIds[0];
  if (!params.text && !fallbackMessageId) {
    return false;
  }
  return params.echoCache.has(
    params.scope,
    { messageId: fallbackMessageId, text: params.text },
    params.skipIdShortCircuit,
  );
}

export interface IMessageInboundDispatchDecision {
  kind: "dispatch";
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  groupId?: string;
  historyKey?: string;
  sender: string;
  senderNormalized: string;
  route: ReturnType<typeof resolveAgentRoute>;
  bodyText: string;
  createdAt?: number;
  replyContext: IMessageReplyContext | null;
  effectiveWasMentioned: boolean;
  commandAuthorized: boolean;
  // Used for allowlist checks for control commands.
  effectiveDmAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
}

export type IMessageInboundDecision =
  | { kind: "drop"; reason: string }
  | { kind: "pairing"; senderId: string }
  | IMessageInboundDispatchDecision;

export function resolveIMessageInboundDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  opts?: Pick<MonitorIMessageOpts, "requireMention">;
  messageText: string;
  bodyText: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: string;
  dmPolicy: string;
  storeAllowFrom: string[];
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  echoCache?: {
    has: (
      scope: string,
      lookup: { text?: string; messageId?: string },
      skipIdShortCircuit?: boolean,
    ) => boolean;
  };
  selfChatCache?: SelfChatCache;
  logVerbose?: (msg: string) => void;
}): IMessageInboundDecision {
  const senderRaw = params.message.sender ?? "";
  const sender = senderRaw.trim();
  if (!sender) {
    return { kind: "drop", reason: "missing sender" };
  }
  const senderNormalized = normalizeIMessageHandle(sender);
  const chatId = params.message.chat_id ?? undefined;
  const chatGuid = params.message.chat_guid ?? undefined;
  const chatIdentifier = params.message.chat_identifier ?? undefined;
  const destinationCallerId = params.message.destination_caller_id ?? undefined;
  const createdAt = params.message.created_at ? Date.parse(params.message.created_at) : undefined;
  const messageText = params.messageText.trim();
  const bodyText = params.bodyText.trim();

  const groupIdCandidate = chatId !== undefined ? String(chatId) : undefined;
  const groupListPolicy = groupIdCandidate
    ? resolveChannelGroupPolicy({
        accountId: params.accountId,
        cfg: params.cfg,
        channel: "imessage",
        groupId: groupIdCandidate,
      })
    : {
        allowed: true,
        allowlistEnabled: false,
        defaultConfig: undefined,
        groupConfig: undefined,
      };

  // If the owner explicitly configures a chat_id under imessage.groups, treat that thread as a
  // "group" for permission gating + session isolation, even when is_group=false.
  const treatAsGroupByConfig = Boolean(
    groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig,
  );
  const isGroup = Boolean(params.message.is_group) || treatAsGroupByConfig;
  const selfChatLookup = {
    accountId: params.accountId,
    chatId,
    createdAt,
    isGroup,
    sender,
    text: bodyText,
  };
  const chatIdentifierNormalized = normalizeIMessageHandle(chatIdentifier ?? "") || undefined;
  const destinationCallerIdNormalized =
    normalizeIMessageHandle(destinationCallerId ?? "") || undefined;
  // Require an explicit destination handle that matches the sender. When
  // Destination_caller_id is missing, sender === chat_identifier is ambiguous:
  // It is true for some DM SQLite rows as well as true self-chat (#63980).
  const matchesSelfChatDestination =
    destinationCallerIdNormalized != null && destinationCallerIdNormalized === senderNormalized;
  const isSelfChat =
    !isGroup &&
    chatIdentifierNormalized != null &&
    senderNormalized === chatIdentifierNormalized &&
    matchesSelfChatDestination;
  const isAmbiguousSelfThread =
    !isGroup &&
    chatIdentifierNormalized != null &&
    senderNormalized === chatIdentifierNormalized &&
    destinationCallerIdNormalized == null;
  let skipSelfChatHasCheck = false;
  const inboundMessageIds = resolveInboundEchoMessageIds(params.message);
  const inboundMessageId = inboundMessageIds[0];
  const hasInboundGuid = Boolean(normalizeReplyField(params.message.guid));

  if (params.message.is_from_me) {
    if (isAmbiguousSelfThread) {
      params.selfChatCache?.remember(selfChatLookup);
    }
    if (isSelfChat) {
      params.selfChatCache?.remember(selfChatLookup);
      const echoScope = buildIMessageEchoScope({
        accountId: params.accountId,
        chatId,
        isGroup,
        sender,
      });
      if (
        params.echoCache &&
        (bodyText || inboundMessageId) &&
        hasIMessageEchoMatch({
          echoCache: params.echoCache,
          messageIds: inboundMessageIds,
          scope: echoScope,
          skipIdShortCircuit: !hasInboundGuid,
          text: bodyText || undefined,
        })
      ) {
        return { kind: "drop", reason: "agent echo in self-chat" };
      }
      skipSelfChatHasCheck = true;
    } else {
      return { kind: "drop", reason: "from me" };
    }
  }
  if (isGroup && !chatId) {
    return { kind: "drop", reason: "group without chat_id" };
  }

  const groupId = isGroup ? groupIdCandidate : undefined;
  const accessDecision = resolveDmGroupAccessWithLists({
    allowFrom: params.allowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFrom: params.groupAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    groupPolicy: params.groupPolicy,
    isGroup,
    isSenderAllowed: (allowFrom) =>
      isAllowedIMessageSender({
        allowFrom,
        chatGuid,
        chatId,
        chatIdentifier,
        sender,
      }),
    storeAllowFrom: params.storeAllowFrom,
  });
  const effectiveDmAllowFrom = accessDecision.effectiveAllowFrom;
  const {effectiveGroupAllowFrom} = accessDecision;

  if (accessDecision.decision !== "allow") {
    if (isGroup) {
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
        params.logVerbose?.("Blocked iMessage group message (groupPolicy: disabled)");
        return { kind: "drop", reason: "groupPolicy disabled" };
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
        params.logVerbose?.(
          "Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)",
        );
        return { kind: "drop", reason: "groupPolicy allowlist (empty groupAllowFrom)" };
      }
      if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
        params.logVerbose?.(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
        return { kind: "drop", reason: "not in groupAllowFrom" };
      }
      params.logVerbose?.(`Blocked iMessage group message (${accessDecision.reason})`);
      return { kind: "drop", reason: accessDecision.reason };
    }
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
      return { kind: "drop", reason: "dmPolicy disabled" };
    }
    if (accessDecision.decision === "pairing") {
      return { kind: "pairing", senderId: senderNormalized };
    }
    params.logVerbose?.(`Blocked iMessage sender ${sender} (dmPolicy=${params.dmPolicy})`);
    return { kind: "drop", reason: "dmPolicy blocked" };
  }

  if (isGroup && groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
    params.logVerbose?.(
      `imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`,
    );
    return { kind: "drop", reason: "group id not in allowlist" };
  }

  const route = resolveIMessageConversationRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    chatId,
    isGroup,
    peerId: isGroup ? String(chatId ?? "unknown") : senderNormalized,
    sender,
  });
  const mentionRegexes = buildMentionRegexes(params.cfg, route.agentId);
  if (!bodyText) {
    return { kind: "drop", reason: "empty body" };
  }

  const selfChatHit = skipSelfChatHasCheck
    ? false
    : params.selfChatCache?.has({
        ...selfChatLookup,
        text: bodyText,
      });
  if (selfChatHit) {
    const preview = sanitizeTerminalText(truncateUtf16Safe(bodyText, 50));
    params.logVerbose?.(`imessage: dropping self-chat reflected duplicate: "${preview}"`);
    return { kind: "drop", reason: "self-chat echo" };
  }

  // Echo detection: check if the received message matches a recently sent message.
  // Scope by conversation so same text in different chats is not conflated.
  if (params.echoCache && (messageText || inboundMessageId)) {
    const echoScope = buildIMessageEchoScope({
      accountId: params.accountId,
      chatId,
      isGroup,
      sender,
    });
    if (
      hasIMessageEchoMatch({
        echoCache: params.echoCache,
        messageIds: inboundMessageIds,
        scope: echoScope,
        text: bodyText || undefined,
      })
    ) {
      params.logVerbose?.(
        describeIMessageEchoDropLog({ messageId: inboundMessageId, messageText: bodyText }),
      );
      return { kind: "drop", reason: "echo" };
    }
  }

  // Reflection guard: drop inbound messages that contain assistant-internal
  // Metadata markers. These indicate outbound content was reflected back as
  // Inbound, which causes recursive echo amplification.
  const reflection = detectReflectedContent(messageText);
  if (reflection.isReflection) {
    params.logVerbose?.(
      `imessage: dropping reflected assistant content (markers: ${reflection.matchedLabels.join(", ")})`,
    );
    return { kind: "drop", reason: "reflected assistant content" };
  }

  const replyContext = describeReplyContext(params.message);
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "imessage",
  });
  const replySenderAllowed =
    !isGroup || effectiveGroupAllowFrom.length === 0
      ? true
      : (replyContext?.sender
        ? isAllowedIMessageSender({
            allowFrom: effectiveGroupAllowFrom,
            chatGuid,
            chatId,
            chatIdentifier,
            sender: replyContext.sender,
          })
        : false);
  const filteredReplyContext =
    !replyContext ||
    evaluateSupplementalContextVisibility({
      kind: "quote",
      mode: contextVisibilityMode,
      senderAllowed: replySenderAllowed,
    }).include
      ? replyContext
      : null;
  if (replyContext && !filteredReplyContext && isGroup) {
    params.logVerbose?.(
      `imessage: drop reply context (mode=${contextVisibilityMode}, sender_allowed=${replySenderAllowed ? "yes" : "no"})`,
    );
  }
  const historyKey = isGroup
    ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
    : undefined;

  const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
  const requireMention = resolveChannelGroupRequireMention({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "imessage",
    groupId,
    overrideOrder: "before-config",
    requireMentionOverride: params.opts?.requireMention,
  });
  const canDetectMention = mentionRegexes.length > 0;

  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const commandDmAllowFrom = isGroup ? params.allowFrom : effectiveDmAllowFrom;
  const ownerAllowedForCommands =
    commandDmAllowFrom.length > 0
      ? isAllowedIMessageSender({
          allowFrom: commandDmAllowFrom,
          chatGuid,
          chatId,
          chatIdentifier,
          sender,
        })
      : false;
  const groupAllowedForCommands =
    effectiveGroupAllowFrom.length > 0
      ? isAllowedIMessageSender({
          allowFrom: effectiveGroupAllowFrom,
          chatGuid,
          chatId,
          chatIdentifier,
          sender,
        })
      : false;
  const hasControlCommandInMessage = hasControlCommand(messageText, params.cfg);
  const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
    hasControlCommand: hasControlCommandInMessage,
    primaryAllowed: ownerAllowedForCommands,
    primaryConfigured: commandDmAllowFrom.length > 0,
    secondaryAllowed: groupAllowedForCommands,
    secondaryConfigured: effectiveGroupAllowFrom.length > 0,
    useAccessGroups,
  });
  if (isGroup && shouldBlock) {
    if (params.logVerbose) {
      logInboundDrop({
        channel: "imessage",
        log: params.logVerbose,
        reason: "control command (unauthorized)",
        target: sender,
      });
    }
    return { kind: "drop", reason: "control command (unauthorized)" };
  }

  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      hasAnyMention: false,
      implicitMentionKinds: [],
      wasMentioned: mentioned,
    },
    policy: {
      allowTextCommands: true,
      commandAuthorized,
      hasControlCommand: hasControlCommandInMessage,
      isGroup,
      requireMention,
    },
  });
  const {effectiveWasMentioned} = mentionDecision;
  if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
    params.logVerbose?.(`imessage: skipping group message (no mention)`);
    recordPendingHistoryEntryIfEnabled({
      entry: historyKey
        ? {
            body: bodyText,
            messageId: params.message.id ? String(params.message.id) : undefined,
            sender: senderNormalized,
            timestamp: createdAt,
          }
        : null,
      historyKey: historyKey ?? "",
      historyMap: params.groupHistories,
      limit: params.historyLimit,
    });
    return { kind: "drop", reason: "no mention" };
  }

  return {
    bodyText,
    chatGuid,
    chatId,
    chatIdentifier,
    commandAuthorized,
    createdAt,
    effectiveDmAllowFrom,
    effectiveGroupAllowFrom,
    effectiveWasMentioned,
    groupId,
    historyKey,
    isGroup,
    kind: "dispatch",
    replyContext: filteredReplyContext,
    route,
    sender,
    senderNormalized,
  };
}

export function buildIMessageInboundContext(params: {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  message: IMessagePayload;
  envelopeOptions?: EnvelopeFormatOptions;
  previousTimestamp?: number;
  remoteHost?: string;
  media?: {
    path?: string;
    type?: string;
    paths?: string[];
    types?: (string | undefined)[];
  };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
}): {
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  fromLabel: string;
  chatTarget?: string;
  imessageTo: string;
  inboundHistory?: { sender: string; body: string; timestamp?: number }[];
} {
  const envelopeOptions = params.envelopeOptions ?? resolveEnvelopeFormatOptions(params.cfg);
  const { decision } = params;
  const {chatId} = decision;
  const chatTarget =
    decision.isGroup && chatId != null ? formatIMessageChatTarget(chatId) : undefined;

  const replySuffix = decision.replyContext
    ? `\n\n[Replying to ${decision.replyContext.sender ?? "unknown sender"}${
        decision.replyContext.id ? ` id:${decision.replyContext.id}` : ""
      }]\n${decision.replyContext.body}\n[/Replying]`
    : "";

  const fromLabel = formatInboundFromLabel({
    directId: decision.sender,
    directLabel: decision.senderNormalized,
    groupFallback: "Group",
    groupId: chatId !== undefined ? String(chatId) : "unknown",
    groupLabel: params.message.chat_name ?? undefined,
    isGroup: decision.isGroup,
  });

  const body = formatInboundEnvelope({
    body: `${decision.bodyText}${replySuffix}`,
    channel: "iMessage",
    chatType: decision.isGroup ? "group" : "direct",
    envelope: envelopeOptions,
    from: fromLabel,
    previousTimestamp: params.previousTimestamp,
    sender: { id: decision.sender, name: decision.senderNormalized },
    timestamp: decision.createdAt,
  });

  let combinedBody = body;
  if (decision.isGroup && decision.historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          channel: "iMessage",
          chatType: "group",
          envelope: envelopeOptions,
          from: fromLabel,
          senderLabel: entry.sender,
          timestamp: entry.timestamp,
        }),
      historyKey: decision.historyKey,
      historyMap: params.groupHistories,
      limit: params.historyLimit,
    });
  }

  const imessageTo = (decision.isGroup ? chatTarget : undefined) || `imessage:${decision.sender}`;
  const inboundHistory =
    decision.isGroup && decision.historyKey && params.historyLimit > 0
      ? (params.groupHistories.get(decision.historyKey) ?? []).map((entry) => ({
          body: entry.body,
          sender: entry.sender,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    AccountId: decision.route.accountId,
    Body: combinedBody,
    BodyForAgent: decision.bodyText,
    ChatType: decision.isGroup ? "group" : "direct",
    CommandAuthorized: decision.commandAuthorized,
    CommandBody: decision.bodyText,
    ConversationLabel: fromLabel,
    From: decision.isGroup
      ? `imessage:group:${chatId ?? "unknown"}`
      : `imessage:${decision.sender}`,
    GroupMembers: decision.isGroup
      ? (params.message.participants ?? []).filter(Boolean).join(", ")
      : undefined,
    GroupSubject: decision.isGroup ? (params.message.chat_name ?? undefined) : undefined,
    InboundHistory: inboundHistory,
    MediaPath: params.media?.path,
    MediaPaths:
      params.media?.paths && params.media.paths.length > 0 ? params.media.paths : undefined,
    MediaRemoteHost: params.remoteHost,
    MediaType: params.media?.type,
    MediaTypes:
      params.media?.types && params.media.types.length > 0 ? params.media.types : undefined,
    MediaUrl: params.media?.path,
    MediaUrls:
      params.media?.paths && params.media.paths.length > 0 ? params.media.paths : undefined,
    MessageSid: params.message.id ? String(params.message.id) : undefined,
    OriginatingChannel: "imessage" as const,
    OriginatingTo: imessageTo,
    Provider: "imessage",
    RawBody: decision.bodyText,
    ReplyToBody: decision.replyContext?.body,
    ReplyToId: decision.replyContext?.id,
    ReplyToSender: decision.replyContext?.sender,
    SenderId: decision.sender,
    SenderName: decision.senderNormalized,
    SessionKey: decision.route.sessionKey,
    Surface: "imessage",
    Timestamp: decision.createdAt,
    To: imessageTo,
    WasMentioned: decision.effectiveWasMentioned,
  });

  return { chatTarget, ctxPayload, fromLabel, imessageTo, inboundHistory };
}

export function buildIMessageEchoScope(params: {
  accountId: string;
  isGroup: boolean;
  chatId?: number;
  sender: string;
}): string {
  return `${params.accountId}:${params.isGroup ? formatIMessageChatTarget(params.chatId) : `imessage:${params.sender}`}`;
}

export function describeIMessageEchoDropLog(params: {
  messageText: string;
  messageId?: string;
}): string {
  const preview = truncateUtf16Safe(params.messageText, 50);
  const messageIdPart = params.messageId ? ` id=${params.messageId}` : "";
  return `imessage: skipping echo message${messageIdPart}: "${preview}"`;
}
