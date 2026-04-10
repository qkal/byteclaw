import { resolveAckReaction } from "openclaw/plugin-sdk/agent-runtime";
import {
  type AckReactionScope,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  formatInboundEnvelope,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveEnvelopeFormatOptions,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-auth";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { type ResolvedSlackAccount, resolveSlackReplyToMode } from "../../accounts.js";
import { reactSlackMessage } from "../../actions.js";
import { hasSlackThreadParticipation } from "../../sent-thread-cache.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import {
  normalizeAllowListLower,
  normalizeSlackAllowOwnerEntry,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "../allow-list.js";
import { resolveSlackEffectiveAllowFrom } from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";
import {
  readSessionUpdatedAt,
  resolveChannelContextVisibilityMode,
  resolveStorePath,
} from "../config.runtime.js";
import { type SlackMonitorContext, normalizeSlackChannelType } from "../context.js";
import { recordInboundSession, resolveConversationLabel } from "../conversation.runtime.js";
import { authorizeSlackDirectMessage } from "../dm-auth.js";
import { resolveSlackThreadStarter } from "../media.js";
import { finalizeInboundContext } from "../reply.runtime.js";
import { resolveSlackRoomContextHints } from "../room-context.js";
import { sendMessageSlack } from "../send.runtime.js";
import { resolveSlackMessageContent } from "./prepare-content.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import type { PreparedSlackMessage } from "./types.js";

const mentionRegexCache = new WeakMap<SlackMonitorContext, Map<string, RegExp[]>>();

function resolveCachedMentionRegexes(
  ctx: SlackMonitorContext,
  agentId: string | undefined,
): RegExp[] {
  const key = normalizeOptionalString(agentId) ?? "__default__";
  let byAgent = mentionRegexCache.get(ctx);
  if (!byAgent) {
    byAgent = new Map<string, RegExp[]>();
    mentionRegexCache.set(ctx, byAgent);
  }
  const cached = byAgent.get(key);
  if (cached) {
    return cached;
  }
  const built = buildMentionRegexes(ctx.cfg, agentId);
  byAgent.set(key, built);
  return built;
}

interface SlackConversationContext {
  channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  };
  channelName?: string;
  resolvedChannelType: ReturnType<typeof normalizeSlackChannelType>;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  channelConfig: ReturnType<typeof resolveSlackChannelConfig> | null;
  allowBots: boolean;
  isBotMessage: boolean;
}

interface SlackAuthorizationContext {
  senderId: string;
  allowFromLower: string[];
}

interface SlackRoutingContext {
  route: ReturnType<typeof resolveAgentRoute>;
  chatType: "direct" | "group" | "channel";
  replyToMode: ReturnType<typeof resolveSlackReplyToMode>;
  threadContext: ReturnType<typeof resolveSlackThreadContext>;
  threadTs: string | undefined;
  isThreadReply: boolean;
  threadKeys: ReturnType<typeof resolveThreadSessionKeys>;
  sessionKey: string;
  historyKey: string;
}

async function resolveSlackConversationContext(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
}): Promise<SlackConversationContext> {
  const { ctx, account, message } = params;
  const { cfg } = ctx;

  let channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  } = {};
  let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
  // D-prefixed channels are always direct messages. Skip channel lookups in
  // That common path to avoid an unnecessary API round-trip.
  if (resolvedChannelType !== "im" && (!message.channel_type || message.channel_type !== "im")) {
    channelInfo = await ctx.resolveChannelName(message.channel);
    resolvedChannelType = normalizeSlackChannelType(
      message.channel_type ?? channelInfo.type,
      message.channel,
    );
  }
  const channelName = channelInfo?.name;
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;
  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        allowNameMatching: ctx.allowNameMatching,
        channelId: message.channel,
        channelKeys: ctx.channelsConfigKeys,
        channelName,
        channels: ctx.channelsConfig,
        defaultRequireMention: ctx.defaultRequireMention,
      })
    : null;
  const allowBots =
    channelConfig?.allowBots ??
    account.config?.allowBots ??
    cfg.channels?.slack?.allowBots ??
    false;

  return {
    allowBots,
    channelConfig,
    channelInfo,
    channelName,
    isBotMessage: Boolean(message.bot_id),
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    resolvedChannelType,
  };
}

async function authorizeSlackInboundMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  conversation: SlackConversationContext;
}): Promise<SlackAuthorizationContext | null> {
  const { ctx, account, message, conversation } = params;
  const { isDirectMessage, channelName, resolvedChannelType, isBotMessage, allowBots } =
    conversation;

  if (isBotMessage) {
    if (message.user && ctx.botUserId && message.user === ctx.botUserId) {
      return null;
    }
    if (!allowBots) {
      logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
      return null;
    }
  }

  if (isDirectMessage && !message.user) {
    logVerbose("slack: drop dm message (missing user id)");
    return null;
  }

  const senderId = message.user ?? (isBotMessage ? message.bot_id : undefined);
  if (!senderId) {
    logVerbose("slack: drop message (missing sender id)");
    return null;
  }

  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelName,
      channelType: resolvedChannelType,
    })
  ) {
    logVerbose("slack: drop message (channel not allowed)");
    return null;
  }

  const { allowFromLower } = await resolveSlackEffectiveAllowFrom(ctx, {
    includePairingStore: isDirectMessage,
  });

  if (isDirectMessage) {
    const directUserId = message.user;
    if (!directUserId) {
      logVerbose("slack: drop dm message (missing user id)");
      return null;
    }
    const allowed = await authorizeSlackDirectMessage({
      accountId: account.accountId,
      allowFromLower,
      ctx,
      log: logVerbose,
      onDisabled: () => {
        logVerbose("slack: drop dm (dms disabled)");
      },
      onUnauthorized: ({ allowMatchMeta }) => {
        logVerbose(
          `Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
        );
      },
      resolveSenderName: ctx.resolveUserName,
      sendPairingReply: async (text) => {
        await sendMessageSlack(message.channel, text, {
          accountId: account.accountId,
          client: ctx.app.client,
          token: ctx.botToken,
        });
      },
      senderId: directUserId,
    });
    if (!allowed) {
      return null;
    }
  }

  return {
    allowFromLower,
    senderId,
  };
}

function resolveSlackRoutingContext(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
}): SlackRoutingContext {
  const { ctx, account, message, isDirectMessage, isGroupDm, isRoom, isRoomish } = params;
  const route = resolveAgentRoute({
    accountId: account.accountId,
    cfg: ctx.cfg,
    channel: "slack",
    peer: {
      id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
      kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
    },
    teamId: ctx.teamId || undefined,
  });

  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const { isThreadReply } = threadContext;
  // Keep true thread replies thread-scoped, but preserve channel-level sessions
  // For top-level room turns when replyToMode is off.
  // For DMs, preserve existing auto-thread behavior when replyToMode="all".
  const autoThreadId =
    !isThreadReply && replyToMode === "all" && threadContext.messageTs
      ? threadContext.messageTs
      : undefined;
  // Only fork channel/group messages into thread-specific sessions when they are
  // Actual thread replies (thread_ts present, different from message ts).
  // Top-level channel messages must stay on the per-channel session for continuity.
  // Before this fix, every channel message used its own ts as threadId, creating
  // Isolated sessions per message (regression from #10686).
  const roomThreadId = isThreadReply && threadTs ? threadTs : undefined;
  const canonicalThreadId = isRoomish ? roomThreadId : isThreadReply ? threadTs : autoThreadId;
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    parentSessionKey: canonicalThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
    threadId: canonicalThreadId,
  });
  const { sessionKey } = threadKeys;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  return {
    chatType,
    historyKey,
    isThreadReply,
    replyToMode,
    route,
    sessionKey,
    threadContext,
    threadKeys,
    threadTs,
  };
}

export async function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): Promise<PreparedSlackMessage | null> {
  const { ctx, account, message, opts } = params;
  const { cfg } = ctx;
  const conversation = await resolveSlackConversationContext({ account, ctx, message });
  const {
    channelInfo,
    channelName,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    isBotMessage,
  } = conversation;
  const authorization = await authorizeSlackInboundMessage({
    account,
    conversation,
    ctx,
    message,
  });
  if (!authorization) {
    return null;
  }
  const { senderId, allowFromLower } = authorization;
  const routing = resolveSlackRoutingContext({
    account,
    ctx,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    message,
  });
  const {
    route,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    threadKeys,
    sessionKey,
    historyKey,
  } = routing;

  const mentionRegexes = resolveCachedMentionRegexes(ctx, route.agentId);
  const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
  const explicitlyMentioned = Boolean(
    ctx.botUserId && message.text?.includes(`<@${ctx.botUserId}>`),
  );
  const wasMentioned =
    opts.wasMentioned ??
    (!isDirectMessage &&
      matchesMentionWithExplicit({
        explicit: {
          canResolveExplicit: Boolean(ctx.botUserId),
          hasAnyMention,
          isExplicitlyMentioned: explicitlyMentioned,
        },
        mentionRegexes,
        text: message.text ?? "",
      }));
  const implicitMentionKinds =
    isDirectMessage || !ctx.botUserId || !message.thread_ts
      ? []
      : [
          ...implicitMentionKindWhen("reply_to_bot", message.parent_user_id === ctx.botUserId),
          ...implicitMentionKindWhen(
            "bot_thread_participant",
            hasSlackThreadParticipation(account.accountId, message.channel, message.thread_ts),
          ),
        ];

  let resolvedSenderName = normalizeOptionalString(message.username);
  const resolveSenderName = async (): Promise<string> => {
    if (resolvedSenderName) {
      return resolvedSenderName;
    }
    if (message.user) {
      const sender = await ctx.resolveUserName(message.user);
      const normalized = normalizeOptionalString(sender?.name);
      if (normalized) {
        resolvedSenderName = normalized;
        return resolvedSenderName;
      }
    }
    resolvedSenderName = message.user ?? message.bot_id ?? "unknown";
    return resolvedSenderName;
  };
  const senderNameForAuth = ctx.allowNameMatching ? await resolveSenderName() : undefined;

  const channelUserAuthorized = isRoom
    ? resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        allowNameMatching: ctx.allowNameMatching,
        userId: senderId,
        userName: senderNameForAuth,
      })
    : true;
  if (isRoom && !channelUserAuthorized) {
    logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
    return null;
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: "slack",
  });
  // Strip Slack mentions (<@U123>) before command detection so "@Labrador /new" is recognized
  const textForCommandDetection = stripSlackMentionsForCommandDetection(message.text ?? "");
  const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, cfg);

  const ownerAuthorized = resolveSlackAllowListMatch({
    allowList: allowFromLower,
    allowNameMatching: ctx.allowNameMatching,
    id: senderId,
    name: senderNameForAuth,
  }).allowed;
  const channelUsersAllowlistConfigured =
    isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
  const threadContextAllowFromLower = isRoom
    ? channelUsersAllowlistConfigured
      ? normalizeAllowListLower(channelConfig?.users)
      : []
    : isDirectMessage
      ? ctx.dmPolicy === "open"
        ? []
        : allowFromLower
      : [];
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    accountId: account.accountId,
    cfg: ctx.cfg,
    channel: "slack",
  });
  const channelCommandAuthorized =
    isRoom && channelUsersAllowlistConfigured
      ? resolveSlackUserAllowed({
          allowList: channelConfig?.users,
          allowNameMatching: ctx.allowNameMatching,
          userId: senderId,
          userName: senderNameForAuth,
        })
      : false;
  const commandGate = resolveControlCommandGate({
    allowTextCommands,
    authorizers: [
      { allowed: ownerAuthorized, configured: allowFromLower.length > 0 },
      {
        allowed: channelCommandAuthorized,
        configured: channelUsersAllowlistConfigured,
      },
    ],
    hasControlCommand: hasControlCommandInMessage,
    useAccessGroups: ctx.useAccessGroups,
  });
  const { commandAuthorized } = commandGate;

  if (isRoomish && commandGate.shouldBlock) {
    logInboundDrop({
      channel: "slack",
      log: logVerbose,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return null;
  }

  const shouldRequireMention = isRoom
    ? (channelConfig?.requireMention ?? ctx.defaultRequireMention)
    : false;

  // Allow "control commands" to bypass mention gating if sender is authorized.
  const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      hasAnyMention,
      implicitMentionKinds,
      wasMentioned,
    },
    policy: {
      allowTextCommands,
      allowedImplicitMentionKinds: ctx.threadRequireExplicitMention ? [] : undefined,
      commandAuthorized,
      hasControlCommand: hasControlCommandInMessage,
      isGroup: isRoom,
      requireMention: Boolean(shouldRequireMention),
    },
  });
  const { effectiveWasMentioned } = mentionDecision;
  if (isRoom && shouldRequireMention && mentionDecision.shouldSkip) {
    ctx.logger.info({ channel: message.channel, reason: "no-mention" }, "skipping channel message");
    const pendingText = (message.text ?? "").trim();
    const fallbackFile = message.files?.[0]?.name
      ? `[Slack file: ${message.files[0].name}]`
      : message.files?.length
        ? "[Slack file]"
        : "";
    const pendingBody = pendingText || fallbackFile;
    recordPendingHistoryEntryIfEnabled({
      entry: pendingBody
        ? {
            body: pendingBody,
            messageId: message.ts,
            sender: await resolveSenderName(),
            timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
          }
        : null,
      historyKey,
      historyMap: ctx.channelHistories,
      limit: ctx.historyLimit,
    });
    return null;
  }

  const threadStarter =
    isThreadReply && threadTs
      ? await resolveSlackThreadStarter({
          channelId: message.channel,
          client: ctx.app.client,
          threadTs,
        })
      : null;
  const resolvedMessageContent = await resolveSlackMessageContent({
    botToken: ctx.botToken,
    isBotMessage,
    isThreadReply,
    mediaMaxBytes: ctx.mediaMaxBytes,
    message,
    threadStarter,
  });
  if (!resolvedMessageContent) {
    return null;
  }
  const { rawBody, effectiveDirectMedia } = resolvedMessageContent;

  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    accountId: account.accountId,
    channel: "slack",
  });
  const ackReactionValue = ackReaction ?? "";

  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        canDetectMention,
        effectiveWasMentioned,
        isDirect: isDirectMessage,
        isGroup: isRoomish,
        isMentionableGroup: isRoom,
        requireMention: Boolean(shouldRequireMention),
        scope: ctx.ackReactionScope as AckReactionScope | undefined,
        shouldBypassMention: mentionDecision.shouldBypassMention,
      }),
    );

  const ackReactionMessageTs = message.ts;
  const statusReactionsWillHandle =
    Boolean(ackReactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false &&
    shouldAckReaction();
  const ackReactionPromise =
    !statusReactionsWillHandle && shouldAckReaction() && ackReactionMessageTs && ackReactionValue
      ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
          client: ctx.app.client,
          token: ctx.botToken,
        }).then(
          () => true,
          (error) => {
            logVerbose(`slack react failed for channel ${message.channel}: ${String(error)}`);
            return false;
          },
        )
      : statusReactionsWillHandle
        ? Promise.resolve(true)
        : null;

  const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
  const senderName = await resolveSenderName();
  const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = isDirectMessage
    ? `Slack DM from ${senderName}`
    : `Slack message in ${roomLabel} from ${senderName}`;
  const slackFrom = isDirectMessage
    ? `slack:${message.user}`
    : isRoom
      ? `slack:channel:${message.channel}`
      : `slack:group:${message.channel}`;

  enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
    sessionKey,
  });

  const envelopeFrom =
    resolveConversationLabel({
      ChatType: isDirectMessage ? "direct" : "channel",
      From: slackFrom,
      GroupSubject: isRoomish ? roomLabel : undefined,
      SenderName: senderName,
    }) ?? (isDirectMessage ? senderName : roomLabel);
  const threadInfo =
    isThreadReply && threadTs
      ? ` thread_ts: ${threadTs}${message.parent_user_id ? ` parent_user_id: ${message.parent_user_id}` : ""}`
      : "";
  const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}${threadInfo}]`;
  const storePath = resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    sessionKey,
    storePath,
  });
  const body = formatInboundEnvelope({
    body: textWithId,
    channel: "Slack",
    chatType: isDirectMessage ? "direct" : "channel",
    envelope: envelopeOptions,
    from: envelopeFrom,
    previousTimestamp,
    sender: { id: senderId, name: senderName },
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
  });

  let combinedBody = body;
  if (isRoomish && ctx.historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          body: `${entry.body}${
            entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""
          }`,
          channel: "Slack",
          chatType: "channel",
          envelope: envelopeOptions,
          from: roomLabel,
          senderLabel: entry.sender,
          timestamp: entry.timestamp,
        }),
      historyKey,
      historyMap: ctx.channelHistories,
      limit: ctx.historyLimit,
    });
  }

  const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;

  const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
    channelConfig,
    channelInfo,
    isRoomish,
  });

  const {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  } = await resolveSlackThreadContextData({
    account,
    allowFromLower: threadContextAllowFromLower,
    allowNameMatching: ctx.allowNameMatching,
    contextVisibilityMode,
    ctx,
    effectiveDirectMedia,
    envelopeOptions,
    isThreadReply,
    message,
    roomLabel,
    sessionKey,
    storePath,
    threadStarter,
    threadTs,
  });

  // Use direct media (including forwarded attachment media) if available, else thread starter media
  const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
  const firstMedia = effectiveMedia?.[0];

  const inboundHistory =
    isRoomish && ctx.historyLimit > 0
      ? (ctx.channelHistories.get(historyKey) ?? []).map((entry) => ({
          body: entry.body,
          sender: entry.sender,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const commandBody = textForCommandDetection.trim();

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    From: slackFrom,
    To: slackTo,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: envelopeFrom,
    GroupSubject: isRoomish ? roomLabel : undefined,
    GroupSystemPrompt: groupSystemPrompt,
    UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "slack" as const,
    Surface: "slack" as const,
    MessageSid: message.ts,
    ReplyToId: threadContext.replyToId,
    // Preserve thread context for routed tool notifications.
    MessageThreadId: threadContext.messageThreadId,
    ParentSessionKey: threadKeys.parentSessionKey,
    // Only include thread starter body for NEW sessions (existing sessions already have it in their transcript)
    ThreadStarterBody: !threadSessionPreviousTimestamp ? threadStarterBody : undefined,
    ThreadHistoryBody: threadHistoryBody,
    IsFirstThreadTurn:
      isThreadReply && threadTs && !threadSessionPreviousTimestamp ? true : undefined,
    ThreadLabel: threadLabel,
    Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    WasMentioned: isRoomish ? effectiveWasMentioned : undefined,
    MediaPath: firstMedia?.path,
    MediaType: firstMedia?.contentType,
    MediaUrl: firstMedia?.path,
    MediaPaths:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaUrls:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaTypes:
      effectiveMedia && effectiveMedia.length > 0
        ? effectiveMedia.map((m) => m.contentType ?? "")
        : undefined,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "slack" as const,
    OriginatingTo: slackTo,
    NativeChannelId: message.channel,
  }) satisfies FinalizedMsgContext;
  const pinnedMainDmOwner = isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        allowFrom: ctx.allowFrom,
        dmScope: cfg.session?.dmScope,
        normalizeEntry: normalizeSlackAllowOwnerEntry,
      })
    : null;

  await recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      ctx.logger.warn(
        {
          error: String(err),
          sessionKey,
          storePath,
        },
        "failed updating session meta",
      );
    },
    sessionKey,
    storePath,
    updateLastRoute: isDirectMessage
      ? {
          accountId: route.accountId,
          channel: "slack",
          mainDmOwnerPin:
            pinnedMainDmOwner && message.user
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: normalizeLowercaseStringOrEmpty(message.user),
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `slack: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
          sessionKey: route.mainSessionKey,
          threadId: threadContext.messageThreadId,
          to: `user:${message.user}`,
        }
      : undefined,
  });

  // Live DM replies should target the concrete Slack DM channel id we just
  // Received on. This avoids depending on a follow-up conversations.open
  // Round-trip for the normal reply path while keeping persisted routing
  // Metadata user-scoped for later session deliveries.
  const replyTarget = isDirectMessage ? `channel:${message.channel}` : (ctxPayload.To ?? undefined);
  if (!replyTarget) {
    return null;
  }

  if (shouldLogVerbose()) {
    logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
  }

  return {
    account,
    ackReactionMessageTs,
    ackReactionPromise,
    ackReactionValue,
    channelConfig,
    ctx,
    ctxPayload,
    historyKey,
    isDirectMessage,
    isRoomish,
    message,
    preview,
    replyTarget,
    replyToMode,
    route,
  };
}
