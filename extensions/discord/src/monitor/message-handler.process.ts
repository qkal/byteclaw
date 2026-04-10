import { ChannelType, type RequestClient } from "@buape/carbon";
import {
  EmbeddedBlockChunker,
  resolveAckReaction,
  resolveHumanDelayConfig,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  DEFAULT_TIMING,
  createStatusReactionController,
  logAckFailure,
  logTypingFailure,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import {
  isDangerousNameMatchingEnabled,
  readSessionUpdatedAt,
  resolveChannelContextVisibilityMode,
  resolveMarkdownTableMode,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { buildAgentSessionKey, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
  stripReasoningTagsFromText,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { createDiscordRestClient } from "../client.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import { resolveDiscordDraftStreamingChunking } from "../draft-chunking.js";
import { createDiscordDraftStream } from "../draft-stream.js";
import { resolveDiscordPreviewStreamMode } from "../preview-streaming.js";
import { removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import { normalizeDiscordSlug } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
import {
  buildDiscordInboundAccessContext,
  createDiscordSupplementalContextAccessChecker,
} from "./inbound-context.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  resolveForwardedMediaList,
  resolveMediaList,
} from "./message-utils.js";
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
} from "./timeouts.js";
import { sendTyping } from "./typing.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DISCORD_TYPING_MAX_DURATION_MS = 20 * 60_000;
let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;

async function loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

interface DiscordMessageProcessObserver {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: { createdThreadId?: string; sessionKey?: string }) => void;
}

export async function processDiscordMessage(
  ctx: DiscordMessagePreflightContext,
  observer?: DiscordMessageProcessObserver,
) {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    author,
    sender,
    data,
    client,
    channelInfo,
    channelName,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    baseText,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    displayChannelSlug,
    guildInfo,
    guildSlug,
    channelConfig,
    baseSessionKey,
    boundSessionKey,
    threadBindings,
    route,
    commandAuthorized,
    discordRestFetch,
    abortSignal,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }

  const ssrfPolicy = cfg.browser?.ssrfPolicy;
  const mediaResolveOptions = {
    abortSignal,
    fetchImpl: discordRestFetch,
    readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
    ssrfPolicy,
    totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
  };
  const mediaList = await resolveMediaList(message, mediaMaxBytes, mediaResolveOptions);
  if (isProcessAborted(abortSignal)) {
    return;
  }
  const forwardedMediaList = await resolveForwardedMediaList(
    message,
    mediaMaxBytes,
    mediaResolveOptions,
  );
  if (isProcessAborted(abortSignal)) {
    return;
  }
  mediaList.push(...forwardedMediaList);
  const text = messageText;
  if (!text) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    threadBindings.touchThread({ threadId: boundThreadId });
  }
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    accountId,
    channel: "discord",
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        canDetectMention,
        effectiveWasMentioned,
        isDirect: isDirectMessage,
        isGroup: isGuildMessage || isGroupDm,
        isMentionableGroup: isGuildMessage,
        requireMention: Boolean(shouldRequireMention),
        scope: ackReactionScope,
        shouldBypassMention,
      }),
    );
  const shouldSendAckReaction = shouldAckReaction();
  const statusReactionsEnabled =
    shouldSendAckReaction && cfg.messages?.statusReactions?.enabled !== false;
  const feedbackRest = createDiscordRestClient({
    accountId,
    cfg,
    token,
  }).rest as unknown as RequestClient;
  const deliveryRest = createDiscordRestClient({
    accountId,
    cfg,
    token,
  }).rest as unknown as RequestClient;
  // Discord outbound helpers expect Carbon's request client shape explicitly.
  const ackReactionContext = createDiscordAckReactionContext({
    accountId,
    cfg,
    rest: feedbackRest,
  });
  const discordAdapter = createDiscordAckReactionAdapter({
    channelId: messageChannelId,
    messageId: message.id,
    reactionContext: ackReactionContext,
  });
  const statusReactions = createStatusReactionController({
    adapter: discordAdapter,
    emojis: cfg.messages?.statusReactions?.emojis,
    enabled: statusReactionsEnabled,
    initialEmoji: ackReaction,
    onError: (err) => {
      logAckFailure({
        channel: "discord",
        error: err,
        log: logVerbose,
        target: `${messageChannelId}/${message.id}`,
      });
    },
    timing: cfg.messages?.statusReactions?.timing,
  });
  queueInitialDiscordAckReaction({
    ackReaction,
    enabled: statusReactionsEnabled,
    reactionAdapter: discordAdapter,
    shouldSendAckReaction,
    statusReactions,
    target: `${messageChannelId}/${message.id}`,
  });
  const { createReplyDispatcherWithTyping, dispatchInboundMessage } = await loadReplyRuntime();

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        channelId: messageChannelId,
        channelName: channelName ?? messageChannelId,
        guild: data.guild ?? undefined,
      });
  const senderLabel = sender.label;
  const isForumParent =
    threadParentType === ChannelType.GuildForum || threadParentType === ChannelType.GuildMedia;
  const forumParentSlug =
    isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  const threadChannelId = threadChannel?.id;
  const isForumStarter =
    Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId;
  const forumContextLine = isForumStarter ? `[Forum parent: #${forumParentSlug}]` : null;
  const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupChannel;
  const senderName = sender.isPluralKit
    ? (sender.name ?? author.username)
    : (data.member?.nickname ?? author.globalName ?? author.username);
  const senderUsername = sender.isPluralKit
    ? (sender.tag ?? sender.name ?? author.username)
    : author.username;
  const senderTag = sender.tag;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
    channelConfig,
    channelTopic: channelInfo?.topic,
    guildInfo,
    isGuild: isGuildMessage,
    messageBody: text,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
  });
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    accountId,
    cfg,
    channel: "discord",
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const isSupplementalContextSenderAllowed = createDiscordSupplementalContextAccessChecker({
    allowNameMatching,
    channelConfig,
    guildInfo,
    isGuild: isGuildMessage,
  });
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    sessionKey: route.sessionKey,
    storePath,
  });
  let combinedBody = formatInboundEnvelope({
    body: text,
    channel: "Discord",
    chatType: isDirectMessage ? "direct" : "channel",
    envelope: envelopeOptions,
    from: fromLabel,
    previousTimestamp,
    senderLabel,
    timestamp: resolveTimestampMs(message.timestamp),
  });
  const shouldIncludeChannelHistory =
    !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
  if (shouldIncludeChannelHistory) {
    combinedBody = buildPendingHistoryContextFromMap({
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${messageChannelId}]`,
          channel: "Discord",
          chatType: "channel",
          envelope: envelopeOptions,
          from: fromLabel,
          senderLabel: entry.sender,
          timestamp: entry.timestamp,
        }),
      historyKey: messageChannelId,
      historyMap: guildHistories,
      limit: historyLimit,
    });
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
  const replyVisibility = replyContext
    ? evaluateSupplementalContextVisibility({
        kind: "quote",
        mode: contextVisibilityMode,
        senderAllowed: isSupplementalContextSenderAllowed({
          id: replyContext.senderId,
          memberRoleIds: replyContext.memberRoleIds,
          name: replyContext.senderName,
          tag: replyContext.senderTag,
        }),
      })
    : null;
  const filteredReplyContext = replyContext && replyVisibility?.include ? replyContext : null;
  if (replyContext && !filteredReplyContext && isGuildMessage) {
    logVerbose(`discord: drop reply context (mode=${contextVisibilityMode})`);
  }
  if (forumContextLine) {
    combinedBody = `${combinedBody}\n${forumContextLine}`;
  }

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  let parentSessionKey: string | undefined;
  if (threadChannel) {
    const includeThreadStarter = channelConfig?.includeThreadStarter !== false;
    if (includeThreadStarter) {
      const starter = await resolveDiscordThreadStarter({
        channel: threadChannel,
        client,
        parentId: threadParentId,
        parentType: threadParentType,
        resolveTimestampMs,
      });
      if (starter?.text) {
        const starterVisibility = evaluateSupplementalContextVisibility({
          kind: "thread",
          mode: contextVisibilityMode,
          senderAllowed: isSupplementalContextSenderAllowed({
            id: starter.authorId,
            memberRoleIds: starter.memberRoleIds,
            name: starter.authorName ?? starter.author,
            tag: starter.authorTag,
          }),
        });
        if (starterVisibility.include) {
          // Keep thread starter as raw text; metadata is provided out-of-band in the system prompt.
          threadStarterBody = starter.text;
        } else {
          logVerbose(`discord: drop thread starter context (mode=${contextVisibilityMode})`);
        }
      }
    }
    const parentName = threadParentName ?? "parent";
    threadLabel = threadName
      ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}`
      : `Discord thread #${normalizeDiscordSlug(parentName)}`;
    if (threadParentId) {
      parentSessionKey = buildAgentSessionKey({
        agentId: route.agentId,
        channel: route.channel,
        peer: { id: threadParentId, kind: "channel" },
      });
    }
  }
  const mediaPayload = buildDiscordMediaPayload(mediaList);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    parentSessionKey,
    threadId: threadChannel ? messageChannelId : undefined,
    useSuffix: false,
  });
  const replyPlan = await resolveDiscordAutoThreadReplyPlan({
    agentId: route.agentId,
    baseText: baseText ?? "",
    cfg,
    channel: route.channel,
    channelConfig,
    channelDescription: channelInfo?.topic,
    channelName: channelInfo?.name,
    channelType: channelInfo?.type,
    client,
    combinedBody,
    isGuildMessage,
    message,
    messageChannelId,
    replyToMode,
    threadChannel,
  });
  const {deliverTarget} = replyPlan;
  const {replyTarget} = replyPlan;
  const {replyReference} = replyPlan;
  const {autoThreadContext} = replyPlan;

  const effectiveFrom = isDirectMessage
    ? `discord:${author.id}`
    : (autoThreadContext?.From ?? `discord:channel:${messageChannelId}`);
  const effectiveTo = autoThreadContext?.To ?? replyTarget;
  if (!effectiveTo) {
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }
  const dmConversationTarget = isDirectMessage
    ? resolveDiscordConversationIdentity({
        isDirectMessage,
        userId: author.id,
      })
    : undefined;
  // Keep DM routes user-addressed so follow-up sends resolve direct session keys.
  const lastRouteTo = dmConversationTarget ?? effectiveTo;

  const inboundHistory =
    shouldIncludeChannelHistory && historyLimit > 0
      ? (guildHistories.get(messageChannelId) ?? []).map((entry) => ({
          body: entry.body,
          sender: entry.sender,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const originatingTo = autoThreadContext?.OriginatingTo ?? dmConversationTarget ?? replyTarget;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: baseText ?? text,
    InboundHistory: inboundHistory,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: sender.id,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    UntrustedContext: untrustedContext,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ReplyToId: filteredReplyContext?.id,
    ReplyToBody: filteredReplyContext?.body,
    ReplyToSender: filteredReplyContext?.sender,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    MessageThreadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? undefined,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: originatingTo,
  });
  const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
  observer?.onReplyPlanResolved?.({
    createdThreadId: replyPlan.createdThreadId,
    sessionKey: persistedSessionKey,
  });

  await recordInboundSession({
    ctx: ctxPayload,
    onRecordError: (err) => {
      logVerbose(`discord: failed updating session meta: ${String(err)}`);
    },
    sessionKey: persistedSessionKey,
    storePath,
    updateLastRoute: {
      accountId: route.accountId,
      channel: "discord",
      sessionKey: persistedSessionKey,
      to: lastRouteTo,
    },
  });

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, String.raw`\n`);
    logVerbose(
      `discord inbound: channel=${messageChannelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: route.accountId,
    agentId: route.agentId,
    cfg,
    channel: "discord",
    typing: {
      start: () => sendTyping({ channelId: typingChannelId, rest: feedbackRest }),
      onStartError: (err) => {
        logTypingFailure({
          channel: "discord",
          error: err,
          log: logVerbose,
          target: typingChannelId,
        });
      },
      // Long tool-heavy runs are expected on Discord; keep heartbeats alive.
      maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS,
    },
  });
  const tableMode = resolveMarkdownTableMode({
    accountId,
    cfg,
    channel: "discord",
  });
  const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
    accountId,
    cfg,
    discordConfig,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountId);

  // --- Discord draft stream (edit-based preview streaming) ---
  const discordStreamMode = resolveDiscordPreviewStreamMode(discordConfig);
  const draftMaxChars = Math.min(textLimit, 2000);
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(discordConfig) ??
    cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft = discordStreamMode !== "off" && !accountBlockStreamingEnabled;
  const draftReplyToMessageId = () => replyReference.use();
  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftStream = canStreamDraft
    ? createDiscordDraftStream({
        channelId: deliverChannelId,
        log: logVerbose,
        maxChars: draftMaxChars,
        minInitialChars: 30,
        replyToMessageId: draftReplyToMessageId,
        rest: deliveryRest,
        throttleMs: 1200,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && discordStreamMode === "block"
      ? resolveDiscordDraftStreamingChunking(cfg, accountId)
      : undefined;
  const shouldSplitPreviewMessages = discordStreamMode === "block";
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedMessage = false;
  let finalizedViaPreviewMessage = false;

  const resolvePreviewFinalText = (text?: string) => {
    if (typeof text !== "string") {
      return undefined;
    }
    const formatted = convertMarkdownTables(
      stripInlineDirectiveTagsForDelivery(text).text,
      tableMode,
    );
    const chunks = chunkDiscordTextWithMode(formatted, {
      chunkMode,
      maxChars: draftMaxChars,
      maxLines: maxLinesPerMessage,
    });
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return undefined;
    }
    const trimmed = chunks[0].trim();
    if (!trimmed) {
      return undefined;
    }
    const currentPreviewText = discordStreamMode === "block" ? draftText : lastPartialText;
    if (
      currentPreviewText &&
      currentPreviewText.startsWith(trimmed) &&
      trimmed.length < currentPreviewText.length
    ) {
      return undefined;
    }
    return trimmed;
  };

  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    // Strip reasoning/thinking tags that may leak through the stream.
    const cleaned = stripInlineDirectiveTagsForDelivery(
      stripReasoningTagsFromText(text, { mode: "strict", trim: "both" }),
    ).text;
    // Skip pure-reasoning messages (e.g. "Reasoning:\n…") that contain no answer text.
    if (!cleaned || cleaned.startsWith("Reasoning:\n")) {
      return;
    }
    if (cleaned === lastPartialText) {
      return;
    }
    hasStreamedMessage = true;
    if (discordStreamMode === "partial") {
      // Keep the longer preview to avoid visible punctuation flicker.
      if (
        lastPartialText &&
        lastPartialText.startsWith(cleaned) &&
        cleaned.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = cleaned;
      draftStream.update(cleaned);
      return;
    }

    let delta = cleaned;
    if (cleaned.startsWith(lastPartialText)) {
      delta = cleaned.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = cleaned;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = cleaned;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
      force: false,
    });
  };

  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        emit: (chunk) => {
          draftText += chunk;
        },
        force: true,
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  // When draft streaming is active, suppress block streaming to avoid double-streaming.
  const disableBlockStreamingForDraft = draftStream ? true : undefined;
  let finalReplyStartNotified = false;
  const notifyFinalReplyStart = () => {
    if (finalReplyStartNotified) {
      return;
    }
    finalReplyStartNotified = true;
    observer?.onFinalReplyStart?.();
  };

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...replyPipeline,
      deliver: async (payload: ReplyPayload, info) => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        const isFinal = info.kind === "final";
        if (payload.isReasoning) {
          // Reasoning/thinking payloads should not be delivered to Discord.
          return;
        }
        if (draftStream && isFinal) {
          await flushDraft();
          const reply = resolveSendableOutboundReplyParts(payload);
          const {hasMedia} = reply;
          const finalText = payload.text;
          const previewFinalText = resolvePreviewFinalText(finalText);
          const hasExplicitReplyDirective =
            Boolean(payload.replyToTag || payload.replyToCurrent) ||
            (typeof finalText === "string" && /\[\[\s*reply_to(?:_current|\s*:)/i.test(finalText));
          const previewMessageId = draftStream.messageId();

          // Try to finalize via preview edit (text-only, fits in 2000 chars, not an error)
          const canFinalizeViaPreviewEdit =
            !finalizedViaPreviewMessage &&
            !hasMedia &&
            typeof previewFinalText === "string" &&
            typeof previewMessageId === "string" &&
            !hasExplicitReplyDirective &&
            !payload.isError;

          if (canFinalizeViaPreviewEdit) {
            await draftStream.stop();
            if (isProcessAborted(abortSignal)) {
              return;
            }
            try {
              notifyFinalReplyStart();
              await editMessageDiscord(
                deliverChannelId,
                previewMessageId,
                { content: previewFinalText },
                { rest: deliveryRest },
              );
              finalizedViaPreviewMessage = true;
              replyReference.markSent();
              observer?.onFinalReplyDelivered?.();
              return;
            } catch (error) {
              logVerbose(
                `discord: preview final edit failed; falling back to standard send (${String(error)})`,
              );
            }
          }

          // Check if stop() flushed a message we can edit
          if (!finalizedViaPreviewMessage) {
            await draftStream.stop();
            if (isProcessAborted(abortSignal)) {
              return;
            }
            const messageIdAfterStop = draftStream.messageId();
            if (
              typeof messageIdAfterStop === "string" &&
              typeof previewFinalText === "string" &&
              !hasMedia &&
              !hasExplicitReplyDirective &&
              !payload.isError
            ) {
              try {
                notifyFinalReplyStart();
                await editMessageDiscord(
                  deliverChannelId,
                  messageIdAfterStop,
                  { content: previewFinalText },
                  { rest: deliveryRest },
                );
                finalizedViaPreviewMessage = true;
                replyReference.markSent();
                observer?.onFinalReplyDelivered?.();
                return;
              } catch (error) {
                logVerbose(
                  `discord: post-stop preview edit failed; falling back to standard send (${String(error)})`,
                );
              }
            }
          }

          // Clear the preview and fall through to standard delivery
          if (!finalizedViaPreviewMessage) {
            await draftStream.clear();
          }
        }
        if (isProcessAborted(abortSignal)) {
          return;
        }

        const replyToId = replyReference.use();
        if (isFinal) {
          notifyFinalReplyStart();
        }
        await deliverDiscordReply({
          accountId,
          cfg,
          chunkMode,
          maxLinesPerMessage,
          mediaLocalRoots,
          replies: [payload],
          replyToId,
          replyToMode,
          rest: deliveryRest,
          runtime,
          sessionKey: ctxPayload.SessionKey,
          tableMode,
          target: deliverTarget,
          textLimit,
          threadBindings,
          token,
        });
        replyReference.markSent();
        if (isFinal) {
          observer?.onFinalReplyDelivered?.();
        }
      },
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      onError: (err, info) => {
        runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: async () => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        await replyPipeline.typingCallbacks?.onReplyStart();
        await statusReactions.setThinking();
      },
    });

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  try {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchResult = await dispatchInboundMessage({
      cfg,
      ctx: ctxPayload,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        abortSignal,
        disableBlockStreaming:
          disableBlockStreamingForDraft ??
          (typeof resolvedBlockStreamingEnabled === "boolean"
            ? !resolvedBlockStreamingEnabled
            : undefined),
        onAssistantMessageStart: draftStream
          ? () => {
              if (shouldSplitPreviewMessages && hasStreamedMessage) {
                logVerbose("discord: calling forceNewMessage() for draft stream");
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
            }
          : undefined,
        onCompactionEnd: async () => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          statusReactions.cancelPending();
          await statusReactions.setThinking();
        },
        onCompactionStart: async () => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await statusReactions.setCompacting();
        },
        onModelSelected,
        onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
        onReasoningEnd: draftStream
          ? () => {
              if (shouldSplitPreviewMessages && hasStreamedMessage) {
                logVerbose("discord: calling forceNewMessage() for draft stream");
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
            }
          : undefined,
        onReasoningStream: async () => {
          await statusReactions.setThinking();
        },
        onToolStart: async (payload) => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await statusReactions.setTool(payload.name);
        },
        skillFilter: channelConfig?.skills,
      },
    });
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
  } catch (error) {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchError = true;
    throw error;
  } finally {
    try {
      // Must stop() first to flush debounced content before clear() wipes state.
      await draftStream?.stop();
      if (!finalizedViaPreviewMessage) {
        await draftStream?.clear();
      }
    } catch (error) {
      // Draft cleanup should never keep typing alive.
      logVerbose(`discord: draft cleanup failed: ${String(error)}`);
    } finally {
      markRunComplete();
      markDispatchIdle();
    }
    if (statusReactionsEnabled) {
      if (dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      } else {
        if (dispatchError) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
        if (removeAckAfterReply) {
          void (async () => {
            await sleep(dispatchError ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
            await statusReactions.clear();
          })();
        } else {
          void statusReactions.restoreInitial();
        }
      }
    } else if (shouldSendAckReaction && ackReaction && removeAckAfterReply) {
      void removeReactionDiscord(
        messageChannelId,
        message.id,
        ackReaction,
        ackReactionContext,
      ).catch((error: unknown) => {
        logAckFailure({
          channel: "discord",
          error: error,
          log: logVerbose,
          target: `${messageChannelId}/${message.id}`,
        });
      });
    }
  }
  if (dispatchAborted) {
    return;
  }

  if (!dispatchResult?.queuedFinal) {
    if (isGuildMessage) {
      clearHistoryEntriesIfEnabled({
        historyKey: messageChannelId,
        historyMap: guildHistories,
        limit: historyLimit,
      });
    }
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = dispatchResult.counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
  if (isGuildMessage) {
    clearHistoryEntriesIfEnabled({
      historyKey: messageChannelId,
      historyMap: guildHistories,
      limit: historyLimit,
    });
  }
}
