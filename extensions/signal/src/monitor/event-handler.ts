import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  createChannelInboundDebouncer,
  formatInboundEnvelope,
  formatInboundFromLabel,
  matchesMentionPatterns,
  resolveEnvelopeFormatOptions,
  resolveInboundMentionDecision,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/config-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  DM_GROUP_ACCESS_REASON,
  resolvePinnedMainDmOwnerFromAllowlist,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeE164, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type SignalSender,
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "../identity.js";
import { normalizeSignalMessagingTarget } from "../normalize.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import type {
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalReactionMessage,
  SignalReceivePayload,
} from "./event-handler.types.js";
import { resolveSignalQuoteContext } from "./inbound-context.js";
import { renderSignalMentions } from "./mentions.js";

function formatAttachmentKindCount(kind: string, count: number): string {
  if (kind === "attachment") {
    return `${count} file${count > 1 ? "s" : ""}`;
  }
  return `${count} ${kind}${count > 1 ? "s" : ""}`;
}

function formatAttachmentSummaryPlaceholder(contentTypes: (string | undefined)[]): string {
  const kindCounts = new Map<string, number>();
  for (const contentType of contentTypes) {
    const kind = kindFromMime(contentType) ?? "attachment";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(([kind, count]) =>
    formatAttachmentKindCount(kind, count),
  );
  return `[${parts.join(" + ")} attached]`;
}

function resolveSignalInboundRoute(params: {
  cfg: SignalEventHandlerDeps["cfg"];
  accountId: SignalEventHandlerDeps["accountId"];
  isGroup: boolean;
  groupId?: string;
  senderPeerId: string;
}) {
  return resolveAgentRoute({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "signal",
    peer: {
      id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
      kind: params.isGroup ? "group" : "direct",
    },
  });
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  interface SignalInboundEntry {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    commandBody: string;
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    commandAuthorized: boolean;
    wasMentioned?: boolean;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  }

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const fromLabel = formatInboundFromLabel({
      directId: entry.senderDisplay,
      directLabel: entry.senderName,
      groupFallback: "Group",
      groupId: entry.groupId ?? "unknown",
      groupLabel: entry.groupName ?? undefined,
      isGroup: entry.isGroup,
    });
    const route = resolveSignalInboundRoute({
      accountId: deps.accountId,
      cfg: deps.cfg,
      groupId: entry.groupId,
      isGroup: entry.isGroup,
      senderPeerId: entry.senderPeerId,
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      sessionKey: route.sessionKey,
      storePath,
    });
    const body = formatInboundEnvelope({
      body: entry.bodyText,
      channel: "Signal",
      chatType: entry.isGroup ? "group" : "direct",
      envelope: envelopeOptions,
      from: fromLabel,
      previousTimestamp,
      sender: { id: entry.senderDisplay, name: entry.senderName },
      timestamp: entry.timestamp ?? undefined,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? String(entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          formatInboundEnvelope({
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            channel: "Signal",
            chatType: "group",
            envelope: envelopeOptions,
            from: fromLabel,
            senderLabel: historyEntry.sender,
            timestamp: historyEntry.timestamp,
          }),
        historyKey,
        historyMap: deps.groupHistories,
        limit: deps.historyLimit,
      });
    }
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? (deps.groupHistories.get(historyKey) ?? []).map((historyEntry) => ({
            body: historyEntry.body,
            sender: historyEntry.sender,
            timestamp: historyEntry.timestamp,
          }))
        : undefined;
    const ctxPayload = finalizeInboundContext({
      AccountId: route.accountId,
      Body: combinedBody,
      BodyForAgent: entry.bodyText,
      BodyForCommands: entry.commandBody,
      ChatType: entry.isGroup ? "group" : "direct",
      CommandAuthorized: entry.commandAuthorized,
      CommandBody: entry.commandBody,
      ConversationLabel: fromLabel,
      From: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `signal:${entry.senderRecipient}`,
      GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      InboundHistory: inboundHistory,
      MediaPath: entry.mediaPath,
      MediaPaths: entry.mediaPaths,
      MediaType: entry.mediaType,
      MediaTypes: entry.mediaTypes,
      MediaUrl: entry.mediaPath,
      MediaUrls: entry.mediaPaths,
      MessageSid: entry.messageId,
      OriginatingChannel: "signal" as const,
      OriginatingTo: signalTo,
      Provider: "signal" as const,
      RawBody: entry.bodyText,
      ReplyToBody: entry.replyToBody,
      ReplyToIsQuote: entry.replyToIsQuote,
      ReplyToSender: entry.replyToSender,
      SenderId: entry.senderDisplay,
      SenderName: entry.senderName,
      SessionKey: route.sessionKey,
      Surface: "signal" as const,
      Timestamp: entry.timestamp ?? undefined,
      To: signalTo,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
    });

    await recordInboundSession({
      ctx: ctxPayload,
      onRecordError: (err) => {
        logVerbose(`signal: failed updating session meta: ${String(err)}`);
      },
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      storePath,
      updateLastRoute: !entry.isGroup
        ? {
            accountId: route.accountId,
            channel: "signal",
            mainDmOwnerPin: (() => {
              const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
                dmScope: deps.cfg.session?.dmScope,
                allowFrom: deps.allowFrom,
                normalizeEntry: normalizeSignalAllowRecipient,
              });
              if (!pinnedOwner) {
                return undefined;
              }
              return {
                ownerRecipient: pinnedOwner,
                senderRecipient: entry.senderRecipient,
                onSkip: ({ ownerRecipient, senderRecipient }) => {
                  logVerbose(
                    `signal: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                  );
                },
              };
            })(),
            sessionKey: route.mainSessionKey,
            to: entry.senderRecipient,
          }
        : undefined,
    });

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, String.raw`\\n`);
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
      accountId: route.accountId,
      agentId: route.agentId,
      cfg: deps.cfg,
      channel: "signal",
      typing: {
        onStartError: (err) => {
          logTypingFailure({
            channel: "signal",
            error: err,
            log: logVerbose,
            target: ctxPayload.To ?? undefined,
          });
        },
        start: async () => {
          if (!ctxPayload.To) {
            return;
          }
          await sendTypingSignal(ctxPayload.To, {
            account: deps.account,
            accountId: deps.accountId,
            baseUrl: deps.baseUrl,
          });
        },
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...replyPipeline,
      deliver: async (payload) => {
        await deps.deliverReplies({
          account: deps.account,
          accountId: deps.accountId,
          baseUrl: deps.baseUrl,
          maxBytes: deps.mediaMaxBytes,
          replies: [payload],
          runtime: deps.runtime,
          target: ctxPayload.To,
          textLimit: deps.textLimit,
        });
      },
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      },
      typingCallbacks,
    });

    const { queuedFinal } = await dispatchInboundMessage({
      cfg: deps.cfg,
      ctx: ctxPayload,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming:
          typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
        onModelSelected,
      },
    });
    markDispatchIdle();
    if (!queuedFinal) {
      if (entry.isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyKey,
          historyMap: deps.groupHistories,
          limit: deps.historyLimit,
        });
      }
      return;
    }
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyKey,
        historyMap: deps.groupHistories,
        limit: deps.historyLimit,
      });
    }
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    cfg: deps.cfg,
    channel: "signal",
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join(String.raw`\n`);
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaPaths: undefined,
        mediaType: undefined,
        mediaTypes: undefined,
      });
    },
    shouldDebounce: (entry) =>
      shouldDebounceTextInbound({
        text: entry.bodyText,
        cfg: deps.cfg,
        hasMedia: Boolean(entry.mediaPath || entry.mediaType || entry.mediaPaths?.length),
      }),
  });

  function handleReactionOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    senderDisplay: string;
    reaction: SignalReactionMessage;
    hasBodyContent: boolean;
    resolveAccessDecision: (isGroup: boolean) => {
      decision: "allow" | "block" | "pairing";
      reason: string;
    };
  }): boolean {
    if (params.hasBodyContent) {
      return false;
    }
    if (params.reaction.isRemove) {
      return true; // Ignore reaction removals
    }
    const emojiLabel = normalizeOptionalString(params.reaction.emoji) ?? "emoji";
    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
    const groupId = params.reaction.groupInfo?.groupId ?? undefined;
    const groupName = params.reaction.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const reactionAccess = params.resolveAccessDecision(isGroup);
    if (reactionAccess.decision !== "allow") {
      logVerbose(
        `Blocked signal reaction sender ${params.senderDisplay} (${reactionAccess.reason})`,
      );
      return true;
    }
    const targets = deps.resolveSignalReactionTargets(params.reaction);
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      account: deps.account,
      allowlist: deps.reactionAllowlist,
      mode: deps.reactionMode,
      sender: params.sender,
      targets,
    });
    if (!shouldNotify) {
      return true;
    }

    const senderPeerId = resolveSignalPeerId(params.sender);
    const route = resolveSignalInboundRoute({
      accountId: deps.accountId,
      cfg: deps.cfg,
      groupId,
      isGroup,
      senderPeerId,
    });
    const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
    const messageId = params.reaction.targetSentTimestamp
      ? String(params.reaction.targetSentTimestamp)
      : "unknown";
    const text = deps.buildSignalReactionSystemEventText({
      actorLabel: senderName,
      emojiLabel,
      groupLabel,
      messageId,
      targetLabel: targets[0]?.display,
    });
    const senderId = formatSignalSenderId(params.sender);
    const contextKey = [
      "signal",
      "reaction",
      "added",
      messageId,
      senderId,
      emojiLabel,
      groupId ?? "",
    ]
      .filter(Boolean)
      .join(":");
    enqueueSystemEvent(text, { contextKey, sessionKey: route.sessionKey });
    return true;
  }

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null = null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (error) {
      deps.runtime.error?.(`failed to parse event: ${String(error)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }

    // Check for syncMessage (e.g., sentTranscript from other devices)
    // We need to check if it's from our own account to prevent self-reply loops
    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }

    // Check if the message is from our own account to prevent loop/self-reply
    // This handles both phone number and UUID based identification
    const normalizedAccount = deps.account ? normalizeE164(deps.account) : undefined;
    const isOwnMessage =
      (sender.kind === "phone" && normalizedAccount != null && sender.e164 === normalizedAccount) ||
      (sender.kind === "uuid" && deps.accountUuid != null && sender.raw === deps.accountUuid);
    if (isOwnMessage) {
      return;
    }

    // Filter all sync messages (sentTranscript, readReceipts, etc.).
    // Signal-cli may set syncMessage to null instead of omitting it, so
    // Check property existence rather than truthiness to avoid replaying
    // The bot's own sent messages on daemon restart.
    if ("syncMessage" in envelope) {
      return;
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();
    const groupId = dataMessage?.groupInfo?.groupId ?? undefined;
    const isGroup = Boolean(groupId);

    const senderDisplay = formatSignalSenderDisplay(sender);
    const { resolveAccessDecision, dmAccess, effectiveDmAllow, effectiveGroupAllow } =
      await resolveSignalAccessState({
        accountId: deps.accountId,
        allowFrom: deps.allowFrom,
        dmPolicy: deps.dmPolicy,
        groupAllowFrom: deps.groupAllowFrom,
        groupPolicy: deps.groupPolicy,
        sender,
      });
    const quoteText = normalizeOptionalString(dataMessage?.quote?.text) ?? "";
    const { contextVisibilityMode, quoteSenderAllowed, visibleQuoteText, visibleQuoteSender } =
      resolveSignalQuoteContext({
        accountId: deps.accountId,
        cfg: deps.cfg,
        dataMessage,
        effectiveGroupAllow,
        isGroup,
      });
    if (quoteText && !visibleQuoteText && isGroup) {
      logVerbose(
        `signal: drop quote context (mode=${contextVisibilityMode}, sender_allowed=${quoteSenderAllowed ? "yes" : "no"})`,
      );
    }
    const hasBodyContent =
      Boolean(messageText || visibleQuoteText) ||
      Boolean(!reaction && dataMessage?.attachments?.length);

    if (
      reaction &&
      handleReactionOnlyInbound({
        envelope,
        hasBodyContent,
        reaction,
        resolveAccessDecision,
        sender,
        senderDisplay,
      })
    ) {
      return;
    }
    if (!dataMessage) {
      return;
    }

    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;

    if (!isGroup) {
      const allowedDirectMessage = await handleSignalDirectMessageAccess({
        accountId: deps.accountId,
        dmAccessDecision: dmAccess.decision,
        dmPolicy: deps.dmPolicy,
        log: logVerbose,
        sendPairingReply: async (text) => {
          await sendMessageSignal(`signal:${senderRecipient}`, text, {
            account: deps.account,
            accountId: deps.accountId,
            baseUrl: deps.baseUrl,
            maxBytes: deps.mediaMaxBytes,
          });
        },
        senderDisplay,
        senderId: senderAllowId,
        senderIdLine,
        senderName: envelope.sourceName ?? undefined,
      });
      if (!allowedDirectMessage) {
        return;
      }
    }
    if (isGroup) {
      const groupAccess = resolveAccessDecision(true);
      if (groupAccess.decision !== "allow") {
        if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED) {
          logVerbose("Blocked signal group message (groupPolicy: disabled)");
        } else if (groupAccess.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
          logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        } else {
          logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        }
        return;
      }
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const commandDmAllow = isGroup ? deps.allowFrom : effectiveDmAllow;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, commandDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);
    const commandGate = resolveControlCommandGate({
      allowTextCommands: true,
      authorizers: [
        { allowed: ownerAllowedForCommands, configured: commandDmAllow.length > 0 },
        { allowed: groupAllowedForCommands, configured: effectiveGroupAllow.length > 0 },
      ],
      hasControlCommand: hasControlCommandInMessage,
      useAccessGroups,
    });
    const { commandAuthorized } = commandGate;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        channel: "signal",
        log: logVerbose,
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveSignalInboundRoute({
      accountId: deps.accountId,
      cfg: deps.cfg,
      groupId,
      isGroup,
      senderPeerId,
    });
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const wasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const requireMention =
      isGroup &&
      resolveChannelGroupRequireMention({
        accountId: deps.accountId,
        cfg: deps.cfg,
        channel: "signal",
        groupId,
      });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention,
        hasAnyMention: false,
        implicitMentionKinds: [],
        wasMentioned,
      },
      policy: {
        allowTextCommands: true,
        commandAuthorized,
        hasControlCommand: hasControlCommandInMessage,
        isGroup,
        requireMention: Boolean(requireMention),
      },
    });
    const { effectiveWasMentioned } = mentionDecision;
    if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
      logInboundDrop({
        channel: "signal",
        log: logVerbose,
        reason: "no mention",
        target: senderDisplay,
      });
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const attachmentTypes = (dataMessage.attachments ?? []).map((attachment) =>
          typeof attachment?.contentType === "string" ? attachment.contentType : undefined,
        );
        if (attachmentTypes.length > 1) {
          return formatAttachmentSummaryPlaceholder(attachmentTypes);
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = kindFromMime(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || visibleQuoteText;
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        entry: {
          body: pendingBodyText,
          messageId:
            typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
          sender: envelope.sourceName ?? senderDisplay,
          timestamp: envelope.timestamp ?? undefined,
        },
        historyKey,
        historyMap: deps.groupHistories,
        limit: deps.historyLimit,
      });
      const signalGroupPolicy = resolveChannelGroupPolicy({
        accountId: deps.accountId,
        cfg: deps.cfg,
        channel: "signal",
        groupId,
      });
      if (
        (signalGroupPolicy.groupConfig?.ingest ?? signalGroupPolicy.defaultConfig?.ingest) === true
      ) {
        const canonicalGroupTarget =
          normalizeSignalMessagingTarget(`group:${groupId}`) ?? `group:${groupId}`;
        fireAndForgetHook(
          triggerInternalHook(
            createInternalHookEvent(
              "message",
              "received",
              route.sessionKey,
              toInternalMessageReceivedContext({
                accountId: deps.accountId,
                channelId: "signal",
                content: pendingBodyText,
                conversationId: canonicalGroupTarget,
                from: `group:${groupId}`,
                groupId: canonicalGroupTarget,
                isGroup: true,
                messageId:
                  typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
                originatingChannel: "signal",
                originatingTo: canonicalGroupTarget,
                provider: "signal",
                senderId: senderDisplay,
                senderName: envelope.sourceName ?? undefined,
                surface: "signal",
                timestamp: envelope.timestamp ?? undefined,
                to: canonicalGroupTarget,
              }),
            ),
          ),
          "signal: mention-skip message hook failed",
        );
      }
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    let placeholder = "";
    const attachments = dataMessage.attachments ?? [];
    if (!deps.ignoreAttachments) {
      for (const attachment of attachments) {
        if (!attachment?.id) {
          continue;
        }
        try {
          const fetched = await deps.fetchAttachment({
            account: deps.account,
            attachment,
            baseUrl: deps.baseUrl,
            groupId,
            maxBytes: deps.mediaMaxBytes,
            sender: senderRecipient,
          });
          if (fetched) {
            mediaPaths.push(fetched.path);
            mediaTypes.push(
              fetched.contentType ?? attachment.contentType ?? "application/octet-stream",
            );
            if (!mediaPath) {
              mediaPath = fetched.path;
              mediaType = fetched.contentType ?? attachment.contentType ?? undefined;
            }
          }
        } catch (error) {
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(error)}`));
        }
      }
    }

    if (mediaPaths.length > 1) {
      placeholder = formatAttachmentSummaryPlaceholder(mediaTypes);
    } else {
      const kind = kindFromMime(mediaType ?? undefined);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (attachments.length) {
        placeholder = "<media:attachment>";
      }
    }

    const bodyText = messageText || placeholder || visibleQuoteText || "";
    if (!bodyText) {
      return;
    }

    const receiptTimestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, receiptTimestamp, {
          account: deps.account,
          accountId: deps.accountId,
          baseUrl: deps.baseUrl,
        });
      } catch (error) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(error)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const senderName = envelope.sourceName ?? senderDisplay;
    const messageId =
      typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined;
    await inboundDebouncer.enqueue({
      bodyText,
      commandAuthorized,
      commandBody: messageText,
      groupId,
      groupName,
      isGroup,
      mediaPath,
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      mediaType,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      messageId,
      replyToBody: visibleQuoteText || undefined,
      replyToIsQuote: visibleQuoteText ? true : undefined,
      replyToSender: visibleQuoteSender,
      senderDisplay,
      senderName,
      senderPeerId,
      senderRecipient,
      timestamp: envelope.timestamp ?? undefined,
      wasMentioned: effectiveWasMentioned,
    });
  };
}
