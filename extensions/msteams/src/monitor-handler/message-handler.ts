import { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  dispatchReplyFromConfigWithSettledDispatcher,
  evaluateSenderGroupAccessForPolicy,
  filterSupplementalContextItems,
  formatAllowlistMatchMeta,
  logInboundDrop,
  recordPendingHistoryEntryIfEnabled,
  resolveChannelContextVisibilityMode,
  resolveDualTextControlCommandGate,
  resolveInboundSessionEnvelopeContext,
  shouldIncludeSupplementalContext,
} from "../../runtime-api.js";
import {
  type MSTeamsAttachmentLike,
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsMediaPayload,
  summarizeMSTeamsHtmlAttachments,
} from "../attachments.js";
import { isRecord } from "../attachments/shared.js";
import type { StoredConversationReference } from "../conversation-store.js";
import { formatUnknownError } from "../errors.js";
import {
  fetchChannelMessage,
  fetchThreadReplies,
  formatThreadContext,
  resolveTeamGroupId,
} from "../graph-thread.js";
import { resolveGraphChatId } from "../graph-upload.js";
import {
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  translateMSTeamsDmConversationIdForGraph,
  wasMSTeamsBotMentioned,
} from "../inbound.js";

function extractTextFromHtmlAttachments(attachments: MSTeamsAttachmentLike[]): string {
  for (const attachment of attachments) {
    if (attachment.contentType !== "text/html") {
      continue;
    }
    const {content} = attachment;
    const raw =
      typeof content === "string"
        ? content
        : isRecord(content) && typeof content.text === "string"
          ? content.text
          : isRecord(content) && typeof content.body === "string"
            ? content.body
            : "";
    if (!raw) {
      continue;
    }
    const text = raw
      .replace(/<at[^>]*>.*?<\/at>/gis, " ")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, "$2 $1")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import {
  isMSTeamsGroupAllowed,
  resolveMSTeamsAllowlistMatch,
  resolveMSTeamsReplyPolicy,
} from "../policy.js";
import { extractMSTeamsPollVote } from "../polls.js";
import { createMSTeamsReplyDispatcher } from "../reply-dispatcher.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { recordMSTeamsSentMessage, wasMSTeamsMessageSent } from "../sent-message-cache.js";
import { resolveMSTeamsSenderAccess } from "./access.js";
import { resolveMSTeamsInboundMedia } from "./inbound-media.js";

function buildStoredConversationReference(params: {
  activity: MSTeamsTurnContext["activity"];
  conversationId: string;
  conversationType: string;
  teamId?: string;
  /** Thread root message ID for channel thread messages. */
  threadId?: string;
}): StoredConversationReference {
  const { activity, conversationId, conversationType, teamId, threadId } = params;
  const {from} = activity;
  const {conversation} = activity;
  const agent = activity.recipient;
  const clientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  return {
    activityId: activity.id,
    agent,
    bot: agent ? { id: agent.id, name: agent.name } : undefined,
    channelId: activity.channelId,
    conversation: {
      conversationType,
      id: conversationId,
      tenantId: conversation?.tenantId,
    },
    locale: activity.locale,
    serviceUrl: activity.serviceUrl,
    teamId,
    user: from ? { aadObjectId: from.aadObjectId, id: from.id, name: from.name } : undefined,
    ...(clientInfo?.timezone ? { timezone: clientInfo.timezone } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function createMSTeamsMessageHandler(deps: MSTeamsMessageHandlerDeps) {
  const {
    cfg,
    runtime,
    appId,
    adapter,
    tokenProvider,
    textLimit,
    mediaMaxBytes,
    conversationStore,
    pollStore,
    log,
  } = deps;
  const core = getMSTeamsRuntime();
  const logVerboseMessage = (message: string) => {
    if (core.logging.shouldLogVerbose()) {
      log.debug?.(message);
    }
  };
  const msteamsCfg = cfg.channels?.msteams;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "msteams",
  });
  const historyLimit = Math.max(
    0,
    msteamsCfg?.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const conversationHistories = new Map<string, HistoryEntry[]>();
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "msteams",
  });

  interface MSTeamsDebounceEntry {
    context: MSTeamsTurnContext;
    rawText: string;
    text: string;
    attachments: MSTeamsAttachmentLike[];
    wasMentioned: boolean;
    implicitMentionKinds: "reply_to_bot"[];
  }

  const handleTeamsMessageNow = async (params: MSTeamsDebounceEntry) => {
    const {context} = params;
    const {activity} = context;
    const {rawText} = params;
    const {text} = params;
    const {attachments} = params;
    const attachmentPlaceholder = buildMSTeamsAttachmentPlaceholder(attachments, {
      maxInlineBytes: mediaMaxBytes,
      maxInlineTotalBytes: mediaMaxBytes,
    });
    const rawBody = text || attachmentPlaceholder;
    const quoteInfo = extractMSTeamsQuoteInfo(attachments);
    let quoteSenderId: string | undefined;
    let quoteSenderName: string | undefined;
    const {from} = activity;
    const {conversation} = activity;

    const attachmentTypes = attachments
      .map((att) => (typeof att.contentType === "string" ? att.contentType : undefined))
      .filter(Boolean)
      .slice(0, 3);
    const htmlSummary = summarizeMSTeamsHtmlAttachments(attachments);

    log.info("received message", {
      attachmentTypes,
      attachments: attachments.length,
      conversation: conversation?.id,
      from: from?.id,
      rawText: rawText.slice(0, 50),
      text: text.slice(0, 50),
    });
    if (htmlSummary) {
      log.debug?.("html attachment summary", htmlSummary);
    }

    if (!from?.id) {
      log.debug?.("skipping message without from.id");
      return;
    }

    // Teams conversation.id may include ";messageid=..." suffix - strip it for session key.
    const rawConversationId = conversation?.id ?? "";
    const conversationId = normalizeMSTeamsConversationId(rawConversationId);
    const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
    const conversationType = conversation?.conversationType ?? "personal";
    const teamId = activity.channelData?.team?.id;
    // For channel thread messages, resolve the thread root message ID so outbound
    // Replies land in the correct thread. The root ID comes from the `messageid=`
    // Portion of conversation.id (preferred) or from activity.replyToId.
    const threadId =
      conversationType === "channel"
        ? (conversationMessageId ?? activity.replyToId ?? undefined)
        : undefined;
    const conversationRef = buildStoredConversationReference({
      activity,
      conversationId,
      conversationType,
      teamId,
      threadId,
    });

    const {
      dmPolicy,
      senderId,
      senderName,
      pairing,
      isDirectMessage,
      channelGate,
      access,
      configuredDmAllowFrom,
      effectiveDmAllowFrom,
      effectiveGroupAllowFrom,
      allowNameMatching,
      groupPolicy,
    } = await resolveMSTeamsSenderAccess({
      activity,
      cfg,
    });
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const isChannel = conversationType === "channel";

    if (isDirectMessage && msteamsCfg && access.decision !== "allow") {
      if (access.reason === "dmPolicy=disabled") {
        log.info("dropping dm (dms disabled)", {
          label: senderName,
          sender: senderId,
        });
        log.debug?.("dropping dm (dms disabled)");
        return;
      }
      const allowMatch = resolveMSTeamsAllowlistMatch({
        allowFrom: effectiveDmAllowFrom,
        allowNameMatching,
        senderId,
        senderName,
      });
      if (access.decision === "pairing") {
        conversationStore.upsert(conversationId, conversationRef).catch((error) => {
          log.debug?.("failed to save conversation reference", {
            error: formatUnknownError(error),
          });
        });
        const request = await pairing.upsertPairingRequest({
          id: senderId,
          meta: { name: senderName },
        });
        if (request) {
          log.info("msteams pairing request created", {
            label: senderName,
            sender: senderId,
          });
        }
      }
      log.debug?.("dropping dm (not allowlisted)", {
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
        label: senderName,
        sender: senderId,
      });
      log.info("dropping dm (not allowlisted)", {
        allowlistMatch: formatAllowlistMatchMeta(allowMatch),
        dmPolicy,
        label: senderName,
        reason: access.reason,
        sender: senderId,
      });
      return;
    }

    if (!isDirectMessage && msteamsCfg) {
      if (channelGate.allowlistConfigured && !channelGate.allowed) {
        log.info("dropping group message (not in team/channel allowlist)", {
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
        });
        log.debug?.("dropping group message (not in team/channel allowlist)", {
          channelKey: channelGate.channelKey ?? "none",
          channelMatchKey: channelGate.channelMatchKey ?? "none",
          channelMatchSource: channelGate.channelMatchSource ?? "none",
          conversationId,
          teamKey: channelGate.teamKey ?? "none",
        });
        return;
      }
      const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
        groupAllowFrom: effectiveGroupAllowFrom,
        groupPolicy,
        isSenderAllowed: (_senderId, allowFrom) =>
          resolveMSTeamsAllowlistMatch({
            allowFrom,
            allowNameMatching,
            senderId,
            senderName,
          }).allowed,
        senderId,
      });

      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "disabled") {
        log.info("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: disabled)", {
          conversationId,
        });
        return;
      }
      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "empty_allowlist") {
        log.info("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        log.debug?.("dropping group message (groupPolicy: allowlist, no allowlist)", {
          conversationId,
        });
        return;
      }
      if (!senderGroupAccess.allowed && senderGroupAccess.reason === "sender_not_allowlisted") {
        const allowMatch = resolveMSTeamsAllowlistMatch({
          allowFrom: effectiveGroupAllowFrom,
          allowNameMatching,
          senderId,
          senderName,
        });
        log.debug?.("dropping group message (not in groupAllowFrom)", {
          allowlistMatch: formatAllowlistMatchMeta(allowMatch),
          label: senderName,
          sender: senderId,
        });
        log.info("dropping group message (not in groupAllowFrom)", {
          allowlistMatch: formatAllowlistMatchMeta(allowMatch),
          label: senderName,
          sender: senderId,
        });
        return;
      }
    }

    const commandDmAllowFrom = isDirectMessage ? effectiveDmAllowFrom : configuredDmAllowFrom;
    const ownerAllowedForCommands = isMSTeamsGroupAllowed({
      allowFrom: commandDmAllowFrom,
      allowNameMatching,
      groupPolicy: "allowlist",
      senderId,
      senderName,
    });
    const groupAllowedForCommands = isMSTeamsGroupAllowed({
      allowFrom: effectiveGroupAllowFrom,
      allowNameMatching,
      groupPolicy: "allowlist",
      senderId,
      senderName,
    });
    const { commandAuthorized, shouldBlock } = resolveDualTextControlCommandGate({
      hasControlCommand: core.channel.text.hasControlCommand(text, cfg),
      primaryAllowed: ownerAllowedForCommands,
      primaryConfigured: commandDmAllowFrom.length > 0,
      secondaryAllowed: groupAllowedForCommands,
      secondaryConfigured: effectiveGroupAllowFrom.length > 0,
      useAccessGroups,
    });
    if (shouldBlock) {
      logInboundDrop({
        channel: "msteams",
        log: logVerboseMessage,
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    conversationStore.upsert(conversationId, conversationRef).catch((error) => {
      log.debug?.("failed to save conversation reference", {
        error: formatUnknownError(error),
      });
    });

    const pollVote = extractMSTeamsPollVote(activity);
    if (pollVote) {
      try {
        const poll = await pollStore.recordVote({
          pollId: pollVote.pollId,
          selections: pollVote.selections,
          voterId: senderId,
        });
        if (!poll) {
          log.debug?.("poll vote ignored (poll not found)", {
            pollId: pollVote.pollId,
          });
        } else {
          log.info("recorded poll vote", {
            pollId: pollVote.pollId,
            selections: pollVote.selections,
            voter: senderId,
          });
        }
      } catch (error) {
        log.error("failed to record poll vote", {
          error: formatUnknownError(error),
          pollId: pollVote.pollId,
        });
      }
      return;
    }

    if (!rawBody) {
      log.debug?.("skipping empty message after stripping mentions");
      return;
    }

    const teamsFrom = isDirectMessage
      ? `msteams:${senderId}`
      : (isChannel
        ? `msteams:channel:${conversationId}`
        : `msteams:group:${conversationId}`);
    const teamsTo = isDirectMessage ? `user:${senderId}` : `conversation:${conversationId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      peer: {
        id: isDirectMessage ? senderId : conversationId,
        kind: isDirectMessage ? "direct" : (isChannel ? "channel" : "group"),
      },
      teamId,
    });

    // Isolate channel thread sessions: each thread gets its own session key so
    // Context does not bleed across threads. Prefer conversationMessageId (the
    // ;messageid= portion of conversation.id, i.e. the thread root) over
    // Activity.replyToId (which may point to a non-root parent in deep threads).
    // DMs and group chats are unaffected — only channel thread replies fork.
    const channelThreadId = isChannel
      ? (conversationMessageId ?? activity.replyToId ?? undefined)
      : undefined;
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey: route.sessionKey,
      parentSessionKey: channelThreadId ? route.sessionKey : undefined,
      threadId: channelThreadId,
    });
    route.sessionKey = threadKeys.sessionKey;

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Teams DM from ${senderName}`
      : `Teams message in ${conversationType} from ${senderName}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      contextKey: `msteams:message:${conversationId}:${activity.id ?? "unknown"}`,
      sessionKey: route.sessionKey,
    });

    const channelId = conversationId;
    const { teamConfig, channelConfig } = channelGate;
    const { requireMention, replyStyle } = resolveMSTeamsReplyPolicy({
      channelConfig,
      globalConfig: msteamsCfg,
      isDirectMessage,
      teamConfig,
    });
    const timestamp = parseMSTeamsActivityTimestamp(activity.timestamp);
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        implicitMentionKinds: params.implicitMentionKinds,
        wasMentioned: params.wasMentioned,
      },
      policy: {
        allowTextCommands: false,
        commandAuthorized: false,
        hasControlCommand: false,
        isGroup: !isDirectMessage,
        requireMention: Boolean(requireMention),
      },
    });

    if (!isDirectMessage) {
      const mentioned = mentionDecision.effectiveWasMentioned;
      if (requireMention && mentionDecision.shouldSkip) {
        log.debug?.("skipping message (mention required)", {
          channelId,
          mentioned,
          requireMention,
          teamId,
        });
        recordPendingHistoryEntryIfEnabled({
          entry: {
            body: rawBody,
            messageId: activity.id ?? undefined,
            sender: senderName,
            timestamp: timestamp?.getTime(),
          },
          historyKey: conversationId,
          historyMap: conversationHistories,
          limit: historyLimit,
        });
        return;
      }
    }
    let graphConversationId = translateMSTeamsDmConversationIdForGraph({
      aadObjectId: from.aadObjectId,
      appId,
      conversationId,
      isDirectMessage,
    });

    // For personal DMs the Bot Framework conversation ID (`a:...`) and the
    // Synthetic `19:{userId}_{appId}@unq.gbl.spaces` format produced by
    // TranslateMSTeamsDmConversationIdForGraph are not always accepted by the
    // Graph `/chats/{chatId}/messages` endpoint. Resolve the real Graph chat
    // ID via the API (with conversation store caching) so the Graph media
    // Download fallback works when the direct Bot Framework download fails.
    if (isDirectMessage && conversationId.startsWith("a:")) {
      const cached = await conversationStore.get(conversationId);
      if (cached?.graphChatId) {
        graphConversationId = cached.graphChatId;
      } else {
        try {
          const resolved = await resolveGraphChatId({
            botFrameworkConversationId: conversationId,
            tokenProvider,
            userAadObjectId: from.aadObjectId ?? undefined,
          });
          if (resolved) {
            graphConversationId = resolved;
            conversationStore
              .upsert(conversationId, { ...conversationRef, graphChatId: resolved })
              .catch(() => {});
          }
        } catch {
          log.debug?.("failed to resolve Graph chat ID for inbound media", { conversationId });
        }
      }
    }

    const mediaList = await resolveMSTeamsInboundMedia({
      activity: {
        channelData: activity.channelData,
        id: activity.id,
        replyToId: activity.replyToId,
      },
      allowHosts: msteamsCfg?.mediaAllowHosts,
      attachments,
      authAllowHosts: msteamsCfg?.mediaAuthAllowHosts,
      conversationId: graphConversationId,
      conversationMessageId: conversationMessageId ?? undefined,
      conversationType,
      htmlSummary: htmlSummary ?? undefined,
      log,
      maxBytes: mediaMaxBytes,
      preserveFilenames: (cfg as { media?: { preserveFilenames?: boolean } }).media
        ?.preserveFilenames,
      serviceUrl: activity.serviceUrl,
      tokenProvider,
    });

    const mediaPayload = buildMSTeamsMediaPayload(mediaList);

    // Fetch thread history when the message is a reply inside a Teams channel thread.
    // This is a best-effort enhancement; errors are logged and do not block the reply.
    let threadContext: string | undefined;
    if (activity.replyToId && isChannel && teamId) {
      try {
        const graphToken = await tokenProvider.getAccessToken("https://graph.microsoft.com");
        const groupId = await resolveTeamGroupId(graphToken, teamId);
        const [parentMsg, replies] = await Promise.all([
          fetchChannelMessage(graphToken, groupId, conversationId, activity.replyToId),
          fetchThreadReplies(graphToken, groupId, conversationId, activity.replyToId),
        ]);
        const allMessages = parentMsg ? [parentMsg, ...replies] : replies;
        quoteSenderId = parentMsg?.from?.user?.id ?? parentMsg?.from?.application?.id ?? undefined;
        quoteSenderName =
          parentMsg?.from?.user?.displayName ??
          parentMsg?.from?.application?.displayName ??
          quoteInfo?.sender;
        const { items: threadMessages } = filterSupplementalContextItems({
          isSenderAllowed: (msg) =>
            groupPolicy === "allowlist"
              ? resolveMSTeamsAllowlistMatch({
                  allowFrom: effectiveGroupAllowFrom,
                  allowNameMatching,
                  senderId: msg.from?.user?.id ?? "",
                  senderName: msg.from?.user?.displayName,
                }).allowed
              : true,
          items: allMessages,
          kind: "thread",
          mode: contextVisibilityMode,
        });
        const formatted = formatThreadContext(threadMessages, activity.id);
        if (formatted) {
          threadContext = formatted;
        }
      } catch (error) {
        log.debug?.("failed to fetch thread history", { error: formatUnknownError(error) });
        // Graceful degradation: thread history is an optional enhancement.
      }
    }
    quoteSenderName ??= quoteInfo?.sender;

    const envelopeFrom = isDirectMessage ? senderName : conversationType;
    const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      agentId: route.agentId,
      cfg,
      sessionKey: route.sessionKey,
    });
    const body = core.channel.reply.formatAgentEnvelope({
      body: rawBody,
      channel: "Teams",
      envelope: envelopeOptions,
      from: envelopeFrom,
      previousTimestamp,
      timestamp,
    });
    let combinedBody = body;
    const isRoomish = !isDirectMessage;
    const historyKey = isRoomish ? conversationId : undefined;
    if (isRoomish && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            body: `${entry.sender}: ${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
            channel: "Teams",
            envelope: envelopeOptions,
            from: conversationType,
            timestamp: entry.timestamp,
          }),
        historyKey,
        historyMap: conversationHistories,
        limit: historyLimit,
      });
    }

    const inboundHistory =
      isRoomish && historyKey && historyLimit > 0
        ? (conversationHistories.get(historyKey) ?? []).map((entry) => ({
            body: entry.body,
            sender: entry.sender,
            timestamp: entry.timestamp,
          }))
        : undefined;
    const commandBody = text.trim();
    const quoteSenderAllowed =
      quoteInfo && quoteInfo.sender
        ? (!isChannel || groupPolicy !== "allowlist"
          ? true
          : resolveMSTeamsAllowlistMatch({
              allowFrom: effectiveGroupAllowFrom,
              allowNameMatching,
              senderId: quoteSenderId ?? "",
              senderName: quoteSenderName,
            }).allowed)
        : true;
    const includeQuoteContext =
      quoteInfo &&
      shouldIncludeSupplementalContext({
        kind: "quote",
        mode: contextVisibilityMode,
        senderAllowed: quoteSenderAllowed,
      });

    // Prepend thread history to the agent body so the agent has full thread context.
    const bodyForAgent = threadContext
      ? `[Thread history]\n${threadContext}\n[/Thread history]\n\n${rawBody}`
      : rawBody;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      AccountId: route.accountId,
      Body: combinedBody,
      BodyForAgent: bodyForAgent,
      BodyForCommands: commandBody,
      ChatType: isDirectMessage ? "direct" : (isChannel ? "channel" : "group"),
      CommandAuthorized: commandAuthorized,
      CommandBody: commandBody,
      ConversationLabel: envelopeFrom,
      From: teamsFrom,
      GroupSubject: !isDirectMessage ? conversationType : undefined,
      InboundHistory: inboundHistory,
      MessageSid: activity.id,
      OriginatingChannel: "msteams" as const,
      OriginatingTo: teamsTo,
      Provider: "msteams" as const,
      RawBody: rawBody,
      ReplyToBody: includeQuoteContext ? quoteInfo?.body : undefined,
      ReplyToId: activity.replyToId ?? undefined,
      ReplyToIsQuote: quoteInfo ? true : undefined,
      ReplyToSender: includeQuoteContext ? quoteInfo?.sender : undefined,
      SenderId: senderId,
      SenderName: senderName,
      SessionKey: route.sessionKey,
      Surface: "msteams" as const,
      Timestamp: timestamp?.getTime() ?? Date.now(),
      To: teamsTo,
      WasMentioned: isDirectMessage || mentionDecision.effectiveWasMentioned,
      ...mediaPayload,
    });

    await core.channel.session.recordInboundSession({
      ctx: ctxPayload,
      onRecordError: (err) => {
        logVerboseMessage(`msteams: failed updating session meta: ${formatUnknownError(err)}`);
      },
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      storePath,
    });

    logVerboseMessage(`msteams inbound: from=${ctxPayload.From} preview="${preview}"`);

    const sharePointSiteId = msteamsCfg?.sharePointSiteId;
    const { dispatcher, replyOptions, markDispatchIdle } = createMSTeamsReplyDispatcher({
      accountId: route.accountId,
      adapter,
      agentId: route.agentId,
      appId,
      cfg,
      context,
      conversationRef,
      log,
      onSentMessageIds: (ids) => {
        for (const id of ids) {
          recordMSTeamsSentMessage(conversationId, id);
        }
      },
      replyStyle,
      runtime,
      sessionKey: route.sessionKey,
      sharePointSiteId,
      textLimit,
      tokenProvider,
    });

    // Use Teams clientInfo timezone if no explicit userTimezone is configured.
    // This ensures the agent knows the sender's timezone for time-aware responses
    // And proactive sends within the same session.
    const activityClientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
      | { timezone?: string }
      | undefined;
    const senderTimezone = activityClientInfo?.timezone || conversationRef.timezone;
    const configOverride =
      senderTimezone && !cfg.agents?.defaults?.userTimezone
        ? {
            agents: {
              defaults: { ...cfg.agents?.defaults, userTimezone: senderTimezone },
            },
          }
        : undefined;

    log.info("dispatching to agent", { sessionKey: route.sessionKey });
    try {
      const { queuedFinal, counts } = await dispatchReplyFromConfigWithSettledDispatcher({
        cfg,
        configOverride,
        ctxPayload,
        dispatcher,
        onSettled: () => markDispatchIdle(),
        replyOptions,
      });

      log.info("dispatch complete", { counts, queuedFinal });

      if (!queuedFinal) {
        if (isRoomish && historyKey) {
          clearHistoryEntriesIfEnabled({
            historyKey,
            historyMap: conversationHistories,
            limit: historyLimit,
          });
        }
        return;
      }
      const finalCount = counts.final;
      logVerboseMessage(
        `msteams: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${teamsTo}`,
      );
      if (isRoomish && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyKey,
          historyMap: conversationHistories,
          limit: historyLimit,
        });
      }
    } catch (error) {
      log.error("dispatch failed", { error: formatUnknownError(error) });
      runtime.error?.(`msteams dispatch failed: ${formatUnknownError(error)}`);
      try {
        await context.sendActivity("⚠️ Something went wrong. Please try again.");
      } catch {
        // Best effort.
      }
    }
  };

  const inboundDebouncer = core.channel.debounce.createInboundDebouncer<MSTeamsDebounceEntry>({
    buildKey: (entry) => {
      const conversationId = normalizeMSTeamsConversationId(
        entry.context.activity.conversation?.id ?? "",
      );
      const senderId =
        entry.context.activity.from?.aadObjectId ?? entry.context.activity.from?.id ?? "";
      if (!senderId || !conversationId) {
        return null;
      }
      return `msteams:${appId}:${conversationId}:${senderId}`;
    },
    debounceMs: inboundDebounceMs,
    onError: (err) => {
      runtime.error?.(`msteams debounce flush failed: ${formatUnknownError(err)}`);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleTeamsMessageNow(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n");
      if (!combinedText.trim()) {
        return;
      }
      const combinedRawText = entries
        .map((entry) => entry.rawText)
        .filter(Boolean)
        .join("\n");
      const wasMentioned = entries.some((entry) => entry.wasMentioned);
      const implicitMentionKinds = entries.flatMap((entry) => entry.implicitMentionKinds);
      await handleTeamsMessageNow({
        attachments: [],
        context: last.context,
        implicitMentionKinds,
        rawText: combinedRawText,
        text: combinedText,
        wasMentioned,
      });
    },
    shouldDebounce: (entry) => {
      if (!entry.text.trim()) {
        return false;
      }
      if (entry.attachments.length > 0) {
        return false;
      }
      return !core.channel.text.hasControlCommand(entry.text, cfg);
    },
  });

  return async function handleTeamsMessage(context: MSTeamsTurnContext) {
    const {activity} = context;
    const attachments = Array.isArray(activity.attachments)
      ? (activity.attachments as unknown as MSTeamsAttachmentLike[])
      : [];
    const rawText = activity.text?.trim() ?? "";
    const htmlText = extractTextFromHtmlAttachments(attachments);
    const text = stripMSTeamsMentionTags(rawText || htmlText);
    const wasMentioned = wasMSTeamsBotMentioned(activity);
    const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    const replyToId = activity.replyToId ?? undefined;
    const implicitMentionKinds: "reply_to_bot"[] =
      conversationId && replyToId && wasMSTeamsMessageSent(conversationId, replyToId)
        ? ["reply_to_bot"]
        : [];

    await inboundDebouncer.enqueue({
      attachments,
      context,
      implicitMentionKinds,
      rawText,
      text,
      wasMentioned,
    });
  };
}
