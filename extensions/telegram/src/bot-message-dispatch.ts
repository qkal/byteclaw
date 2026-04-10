import type { Bot } from "grammy";
import {
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
  TelegramDirectConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { type TelegramBotDeps, defaultTelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import {
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  loadSessionStore,
  resolveAutoTopicLabelConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
  resolveSessionStoreEntry,
} from "./bot-message-dispatch.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { deliverReplies, emitInternalMessageSentHook } from "./bot/delivery.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  type ArchivedPreview,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
  type LanePreviewLifecycle,
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
} from "./lane-delivery.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ agentId, cfg });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export function pruneStickerMediaFromContext(
  ctxPayload: {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
  },
  opts?: { stickerMediaIncluded?: boolean },
) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths)
    ? ctxPayload.MediaPaths.slice(1)
    : undefined;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls)
    ? ctxPayload.MediaUrls.slice(1)
    : undefined;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes)
    ? ctxPayload.MediaTypes.slice(1)
    : undefined;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : undefined;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : undefined;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : undefined;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}

interface DispatchTelegramMessageParams {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token">;
}

type TelegramReasoningLevel = "off" | "on" | "stream";

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
  telegramDeps: TelegramBotDeps;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId, telegramDeps } = params;
  if (!sessionKey) {
    return "off";
  }
  try {
    const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
    const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
      skipCache: true,
    });
    const entry = resolveSessionStoreEntry({ sessionKey, store }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream") {
      return level;
    }
  } catch {
    // Fall through to default.
  }
  return "off";
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  telegramDeps = defaultTelegramBotDeps,
  opts,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    groupConfig,
    topicConfig,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
  } = context;

  const draftMaxChars = Math.min(textLimit, 4096);
  const tableMode = resolveMarkdownTableMode({
    accountId: route.accountId,
    cfg,
    channel: "telegram",
  });
  const renderDraftPreview = (text: string) => ({
    parseMode: "HTML" as const,
    text: renderTelegramHtmlText(text, { tableMode }),
  });
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(telegramCfg) ??
    cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    agentId: route.agentId,
    cfg,
    sessionKey: ctxPayload.SessionKey,
    telegramDeps,
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const previewStreamingEnabled = streamMode !== "off";
  const canStreamAnswerDraft =
    previewStreamingEnabled && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS;
  // Keep DM preview lanes on real message transport. Native draft previews still
  // Require a draft->message materialize hop, and that overlap keeps reintroducing
  // A visible duplicate flash at finalize time.
  const useMessagePreviewTransportForDm = threadSpec?.scope === "dm" && canStreamAnswerDraft;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const archivedAnswerPreviews: ArchivedPreview[] = [];
  const archivedReasoningPreviewIds: number[] = [];
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: bot.api,
          chatId,
          log: logVerbose,
          maxChars: draftMaxChars,
          minInitialChars: draftMinInitialChars,
          onSupersededPreview:
            laneName === "answer" || laneName === "reasoning"
              ? (preview) => {
                  if (laneName === "reasoning") {
                    if (!archivedReasoningPreviewIds.includes(preview.messageId)) {
                      archivedReasoningPreviewIds.push(preview.messageId);
                    }
                    return;
                  }
                  archivedAnswerPreviews.push({
                    deleteIfUnused: true,
                    messageId: preview.messageId,
                    textSnapshot: preview.textSnapshot,
                  });
                }
              : undefined,
          previewTransport: useMessagePreviewTransportForDm ? "message" : "auto",
          renderText: renderDraftPreview,
          replyToMessageId: draftReplyToMessageId,
          thread: threadSpec,
          warn: logVerbose,
        })
      : undefined;
    return {
      hasStreamedMessage: false,
      lastPartialText: "",
      stream,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  // Active preview lifecycle answers "can this current preview still be
  // Finalized?" Cleanup retention is separate so archived-preview decisions do
  // Not poison the active lane.
  const activePreviewLifecycleByLane: Record<LaneName, LanePreviewLifecycle> = {
    answer: "transient",
    reasoning: "transient",
  };
  const retainPreviewOnCleanupByLane: Record<LaneName, boolean> = {
    answer: false,
    reasoning: false,
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  let splitReasoningOnNextStream = false;
  let skipNextAnswerMessageStartRotation = false;
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(task);
    draftLaneEventQueue = next.catch((error) => {
      logVerbose(`telegram: draft lane callback failed: ${String(error)}`);
    });
    return draftLaneEventQueue;
  };
  interface SplitLaneSegment { lane: LaneName; text: string }
  interface SplitLaneSegmentsResult {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  }
  const splitTextIntoLaneSegments = (text?: string): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(text);
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      segments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      segments.push({ lane: "answer", text: split.answerText });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };
  const rotateAnswerLaneForNewAssistantMessage = async () => {
    let didForceNewMessage = false;
    if (answerLane.hasStreamedMessage) {
      // Materialize the current streamed draft into a permanent message
      // So it remains visible across tool boundaries.
      const materializedId = await answerLane.stream?.materialize?.();
      const previewMessageId = materializedId ?? answerLane.stream?.messageId();
      if (
        typeof previewMessageId === "number" &&
        activePreviewLifecycleByLane.answer === "transient"
      ) {
        archivedAnswerPreviews.push({
          deleteIfUnused: false,
          messageId: previewMessageId,
          textSnapshot: answerLane.lastPartialText,
        });
      }
      answerLane.stream?.forceNewMessage();
      didForceNewMessage = true;
    }
    resetDraftLaneState(answerLane);
    if (didForceNewMessage) {
      // New assistant message boundary: this lane now tracks a fresh preview lifecycle.
      activePreviewLifecycleByLane.answer = "transient";
      retainPreviewOnCleanupByLane.answer = false;
    }
    return didForceNewMessage;
  };
  const updateDraftFromPartial = (lane: DraftLaneState, text: string | undefined) => {
    const laneStream = lane.stream;
    if (!laneStream || !text) {
      return;
    }
    if (text === lane.lastPartialText) {
      return;
    }
    // Mark that we've received streaming content (for forceNewMessage decision).
    lane.hasStreamedMessage = true;
    // Some providers briefly emit a shorter prefix snapshot (for example
    // "Sure." -> "Sure" -> "Sure."). Keep the longer preview to avoid
    // Visible punctuation flicker.
    if (
      lane.lastPartialText &&
      lane.lastPartialText.startsWith(text) &&
      text.length < lane.lastPartialText.length
    ) {
      return;
    }
    lane.lastPartialText = text;
    laneStream.update(text);
  };
  const ingestDraftLaneSegments = async (text: string | undefined) => {
    const split = splitTextIntoLaneSegments(text);
    const hasAnswerSegment = split.segments.some((segment) => segment.lane === "answer");
    if (hasAnswerSegment && activePreviewLifecycleByLane.answer !== "transient") {
      // Some providers can emit the first partial of a new assistant message before
      // OnAssistantMessageStart() arrives. Rotate preemptively so we do not edit
      // The previously finalized preview message with the next message's text.
      skipNextAnswerMessageStartRotation = await rotateAnswerLaneForNewAssistantMessage();
    }
    for (const segment of split.segments) {
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.text);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  const disableBlockStreaming = !previewStreamingEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : typeof resolvedBlockStreamingEnabled === "boolean"
        ? !resolvedBlockStreamingEnabled
        : canStreamAnswerDraft
          ? true
          : undefined;

  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        agentDir,
        agentId: route.agentId,
        cfg,
        imagePath: ctxPayload.MediaPath,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Drop only the sticker attachment; keep replied media context if present.
        pruneStickerMediaFromContext(ctxPayload, {
          stickerMediaIncluded: ctxPayload.StickerMediaIncluded,
        });
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          cachedAt: new Date().toISOString(),
          description,
          emoji: sticker.emoji,
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          receivedFrom: ctxPayload.From,
          setName: sticker.setName,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyKey, historyMap: groupHistories, limit: historyLimit });
    }
  };
  const deliveryBaseOptions = {
    accountId: route.accountId,
    bot,
    chatId: String(chatId),
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    mediaLocalRoots,
    mirrorGroupId: isGroup ? String(chatId) : undefined,
    mirrorIsGroup: isGroup,
    replyQuoteText,
    replyToMode,
    runtime,
    sessionKeyForInternalHooks: ctxPayload.SessionKey,
    tableMode,
    textLimit,
    thread: threadSpec,
    token: opts.token,
  };
  const silentErrorReplies = telegramCfg.silentErrorReplies === true;
  const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
    if (payload.text === text) {
      return payload;
    }
    return { ...payload, text };
  };
  const sendPayload = async (payload: ReplyPayload) => {
    const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
      ...deliveryBaseOptions,
      mediaLoader: telegramDeps.loadWebMedia,
      onVoiceRecording: sendRecordVoice,
      replies: [payload],
      silent: silentErrorReplies && payload.isError === true,
    });
    if (result.delivered) {
      deliveryState.markDelivered();
    }
    return result.delivered;
  };
  const emitPreviewFinalizedHook = (result: LaneDeliveryResult) => {
    if (result.kind !== "preview-finalized") {
      return;
    }
    (telegramDeps.emitInternalMessageSentHook ?? emitInternalMessageSentHook)({
      accountId: deliveryBaseOptions.accountId,
      chatId: deliveryBaseOptions.chatId,
      content: result.delivery.content,
      groupId: deliveryBaseOptions.mirrorGroupId,
      isGroup: deliveryBaseOptions.mirrorIsGroup,
      messageId: result.delivery.messageId,
      sessionKeyForInternalHooks: deliveryBaseOptions.sessionKeyForInternalHooks,
      success: true,
    });
  };
  const deliverLaneText = createLaneTextDeliverer({
    activePreviewLifecycleByLane,
    applyTextToPayload,
    archivedAnswerPreviews,
    deletePreviewMessage: async (messageId) => {
      await bot.api.deleteMessage(chatId, messageId);
    },
    draftMaxChars,
    editPreview: async ({ messageId, text, previewButtons }) => {
      await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
        accountId: route.accountId,
        api: bot.api,
        buttons: previewButtons,
        cfg,
        linkPreview: telegramCfg.linkPreview,
      });
    },
    flushDraftLane,
    lanes,
    log: logVerbose,
    markDelivered: () => {
      deliveryState.markDelivered();
    },
    retainPreviewOnCleanupByLane,
    sendPayload,
    stopDraftLane: async (lane) => {
      await lane.stream?.stop();
    },
  });

  let queuedFinal = false;
  let hadErrorReplyFailureOrSkip = false;

  // Determine if this is the first turn in session (for auto-topic-label).
  const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;

  let isFirstTurnInSession = false;
  if (isDmTopic) {
    try {
      const storePath = telegramDeps.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });
      const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
        skipCache: true,
      });
      const sessionKey = ctxPayload.SessionKey;
      if (sessionKey) {
        const entry = resolveSessionStoreEntry({ sessionKey, store }).existing;
        isFirstTurnInSession = !entry?.systemSent;
      } else {
        logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
      }
    } catch (error) {
      logVerbose(`auto-topic-label: session store error: ${formatErrorMessage(error)}`);
    }
  }

  if (statusReactionController) {
    void statusReactionController.setThinking();
  }

  const { onModelSelected, ...replyPipeline } = (
    telegramDeps.createChannelReplyPipeline ?? createChannelReplyPipeline
  )({
    accountId: route.accountId,
    agentId: route.agentId,
    cfg,
    channel: "telegram",
    typing: {
      onStartError: (err) => {
        logTypingFailure({
          channel: "telegram",
          error: err,
          log: logVerbose,
          target: String(chatId),
        });
      },
      start: sendTyping,
    },
  });

  let dispatchError: unknown;
  try {
    ({ queuedFinal } = await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
      cfg,
      ctx: ctxPayload,
      dispatcherOptions: {
        ...replyPipeline,
        deliver: async (payload, info) => {
          if (payload.isError === true) {
            hadErrorReplyFailureOrSkip = true;
          }
          if (info.kind === "final") {
            // Assistant callbacks are fire-and-forget; ensure queued boundary
            // Rotations/partials are applied before final delivery mapping.
            await enqueueDraftLaneEvent(async () => {});
          }
          if (
            shouldSuppressLocalTelegramExecApprovalPrompt({
              accountId: route.accountId,
              cfg,
              payload,
            })
          ) {
            queuedFinal = true;
            return;
          }
          const previewButtons = (
            payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
          )?.buttons;
          const split = splitTextIntoLaneSegments(payload.text);
          const {segments} = split;
          const reply = resolveSendableOutboundReplyParts(payload);
          const _hasMedia = reply.hasMedia;

          const flushBufferedFinalAnswer = async () => {
            const buffered = reasoningStepState.takeBufferedFinalAnswer();
            if (!buffered) {
              return;
            }
            const bufferedButtons = (
              buffered.payload.channelData?.telegram as
                | { buttons?: TelegramInlineButtons }
                | undefined
            )?.buttons;
            await deliverLaneText({
              infoKind: "final",
              laneName: "answer",
              payload: buffered.payload,
              previewButtons: bufferedButtons,
              text: buffered.text,
            });
            reasoningStepState.resetForNextStep();
          };

          for (const segment of segments) {
            if (
              segment.lane === "answer" &&
              info.kind === "final" &&
              reasoningStepState.shouldBufferFinalAnswer()
            ) {
              reasoningStepState.bufferFinalAnswer({
                payload,
                text: segment.text,
              });
              continue;
            }
            if (segment.lane === "reasoning") {
              reasoningStepState.noteReasoningHint();
            }
            const result = await deliverLaneText({
              allowPreviewUpdateForNonFinal: segment.lane === "reasoning",
              infoKind: info.kind,
              laneName: segment.lane,
              payload,
              previewButtons,
              text: segment.text,
            });
            if (info.kind === "final") {
              emitPreviewFinalizedHook(result);
            }
            if (segment.lane === "reasoning") {
              if (result.kind !== "skipped") {
                reasoningStepState.noteReasoningDelivered();
                await flushBufferedFinalAnswer();
              }
              continue;
            }
            if (info.kind === "final") {
              if (reasoningLane.hasStreamedMessage) {
                activePreviewLifecycleByLane.reasoning = "complete";
                retainPreviewOnCleanupByLane.reasoning = true;
              }
              reasoningStepState.resetForNextStep();
            }
          }
          if (segments.length > 0) {
            return;
          }
          if (split.suppressedReasoningOnly) {
            if (reply.hasMedia) {
              const payloadWithoutSuppressedReasoning =
                typeof payload.text === "string" ? { ...payload, text: "" } : payload;
              await sendPayload(payloadWithoutSuppressedReasoning);
            }
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
            }
            return;
          }

          if (info.kind === "final") {
            await answerLane.stream?.stop();
            await reasoningLane.stream?.stop();
            reasoningStepState.resetForNextStep();
          }
          const canSendAsIs = reply.hasMedia || reply.text.length > 0;
          if (!canSendAsIs) {
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
            }
            return;
          }
          await sendPayload(payload);
          if (info.kind === "final") {
            await flushBufferedFinalAnswer();
          }
        },
        onError: (err, info) => {
          const errorPolicy = resolveTelegramErrorPolicy({
            accountConfig: telegramCfg,
            groupConfig,
            topicConfig,
          });
          if (isSilentErrorPolicy(errorPolicy.policy)) {
            return;
          }
          if (
            errorPolicy.policy === "once" &&
            shouldSuppressTelegramError({
              cooldownMs: errorPolicy.cooldownMs,
              errorMessage: String(err),
              scopeKey: buildTelegramErrorScopeKey({
                accountId: route.accountId,
                chatId,
                threadId: threadSpec.id,
              }),
            })
          ) {
            return;
          }
          deliveryState.markNonSilentFailure();
          runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
        },
        onSkip: (payload, info) => {
          if (payload.isError === true) {
            hadErrorReplyFailureOrSkip = true;
          }
          if (info.reason !== "silent") {
            deliveryState.markNonSilentSkip();
          }
        },
      },
      replyOptions: {
        disableBlockStreaming,
        onAssistantMessageStart: answerLane.stream
          ? () =>
              enqueueDraftLaneEvent(async () => {
                reasoningStepState.resetForNextStep();
                if (skipNextAnswerMessageStartRotation) {
                  skipNextAnswerMessageStartRotation = false;
                  activePreviewLifecycleByLane.answer = "transient";
                  retainPreviewOnCleanupByLane.answer = false;
                  return;
                }
                await rotateAnswerLaneForNewAssistantMessage();
                // Message-start is an explicit assistant-message boundary.
                // Even when no forceNewMessage happened (e.g. prior answer had no
                // Streamed partials), the next partial belongs to a fresh lifecycle
                // And must not trigger late pre-rotation mid-message.
                activePreviewLifecycleByLane.answer = "transient";
                retainPreviewOnCleanupByLane.answer = false;
              })
          : undefined,
        onCompactionEnd: statusReactionController
          ? async () => {
              statusReactionController.cancelPending();
              await statusReactionController.setThinking();
            }
          : undefined,
        onCompactionStart: statusReactionController
          ? () => statusReactionController.setCompacting()
          : undefined,
        onModelSelected,
        onPartialReply:
          answerLane.stream || reasoningLane.stream
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  await ingestDraftLaneSegments(payload.text);
                })
            : undefined,
        onReasoningEnd: reasoningLane.stream
          ? () =>
              enqueueDraftLaneEvent(async () => {
                // Split when/if a later reasoning block begins.
                splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
              })
          : undefined,
        onReasoningStream: reasoningLane.stream
          ? (payload) =>
              enqueueDraftLaneEvent(async () => {
                // Split between reasoning blocks only when the next reasoning
                // Stream starts. Splitting at reasoning-end can orphan the active
                // Preview and cause duplicate reasoning sends on reasoning final.
                if (splitReasoningOnNextStream) {
                  reasoningLane.stream?.forceNewMessage();
                  resetDraftLaneState(reasoningLane);
                  splitReasoningOnNextStream = false;
                }
                await ingestDraftLaneSegments(payload.text);
              })
          : undefined,
        onToolStart: statusReactionController
          ? async (payload) => {
              await statusReactionController.setTool(payload.name);
            }
          : undefined,
        skillFilter,
      },
    }));
  } catch (error) {
    dispatchError = error;
    runtime.error?.(danger(`telegram dispatch failed: ${String(error)}`));
  } finally {
    // Upstream assistant callbacks are fire-and-forget; drain queued lane work
    // Before stream cleanup so boundary rotations/materialization complete first.
    await draftLaneEventQueue;
    // Must stop() first to flush debounced content before clear() wipes state.
    const streamCleanupStates = new Map<
      NonNullable<DraftLaneState["stream"]>,
      { shouldClear: boolean }
    >();
    const lanesToCleanup: { laneName: LaneName; lane: DraftLaneState }[] = [
      { lane: answerLane, laneName: "answer" },
      { lane: reasoningLane, laneName: "reasoning" },
    ];
    for (const laneState of lanesToCleanup) {
      const {stream} = laneState.lane;
      if (!stream) {
        continue;
      }
      // Don't clear (delete) the stream if: (a) it was finalized, or
      // (b) the active stream message is itself a boundary-finalized archive.
      const activePreviewMessageId = stream.messageId();
      const hasBoundaryFinalizedActivePreview =
        laneState.laneName === "answer" &&
        typeof activePreviewMessageId === "number" &&
        archivedAnswerPreviews.some(
          (p) => p.deleteIfUnused === false && p.messageId === activePreviewMessageId,
        );
      const shouldClear =
        !retainPreviewOnCleanupByLane[laneState.laneName] && !hasBoundaryFinalizedActivePreview;
      const existing = streamCleanupStates.get(stream);
      if (!existing) {
        streamCleanupStates.set(stream, { shouldClear });
        continue;
      }
      existing.shouldClear = existing.shouldClear && shouldClear;
    }
    for (const [stream, cleanupState] of streamCleanupStates) {
      await stream.stop();
      if (cleanupState.shouldClear) {
        await stream.clear();
      }
    }
    for (const archivedPreview of archivedAnswerPreviews) {
      if (archivedPreview.deleteIfUnused === false) {
        continue;
      }
      try {
        await bot.api.deleteMessage(chatId, archivedPreview.messageId);
      } catch (error) {
        logVerbose(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(error)}`,
        );
      }
    }
    for (const messageId of archivedReasoningPreviewIds) {
      try {
        await bot.api.deleteMessage(chatId, messageId);
      } catch (error) {
        logVerbose(
          `telegram: archived reasoning preview cleanup failed (${messageId}): ${String(error)}`,
        );
      }
    }
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  if (
    dispatchError ||
    (!deliverySummary.delivered &&
      (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0))
  ) {
    const fallbackText = dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
      silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip),
      mediaLoader: telegramDeps.loadWebMedia,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;

  if (statusReactionController && !hasFinalResponse) {
    void statusReactionController.setError().catch((error) => {
      logVerbose(`telegram: status reaction error finalize failed: ${String(error)}`);
    });
  }

  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }

  // Fire-and-forget: auto-rename DM topic on first message.
  if (isDmTopic && isFirstTurnInSession) {
    const userMessage = (ctxPayload.RawBody ?? ctxPayload.Body ?? "").slice(0, 500);
    if (userMessage.trim()) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const directConfig = !isGroup ? (groupConfig as TelegramDirectConfig | undefined) : undefined;
      const directAutoTopicLabel = directConfig?.autoTopicLabel;
      const accountAutoTopicLabel = telegramCfg?.autoTopicLabel;
      const autoTopicConfig = resolveAutoTopicLabelConfig(
        directAutoTopicLabel,
        accountAutoTopicLabel,
      );
      if (autoTopicConfig) {
        const topicThreadId = threadSpec.id!;
        void (async () => {
          try {
            const label = await generateTopicLabel({
              agentDir,
              agentId: route.agentId,
              cfg,
              prompt: autoTopicConfig.prompt,
              userMessage,
            });
            if (!label) {
              logVerbose("auto-topic-label: LLM returned empty label");
              return;
            }
            logVerbose(`auto-topic-label: generated label (len=${label.length})`);
            await bot.api.editForumTopic(chatId, topicThreadId, { name: label });
            logVerbose(`auto-topic-label: renamed topic ${chatId}/${topicThreadId}`);
          } catch (error) {
            logVerbose(`auto-topic-label: failed: ${formatErrorMessage(error)}`);
          }
        })();
      }
    }
  }

  if (statusReactionController) {
    void statusReactionController.setDone().catch((error) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(error)}`);
    });
  } else {
    removeAckReactionAfterReply({
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          channel: "telegram",
          error: err,
          log: logVerbose,
          target: `${chatId}/${msg.message_id}`,
        });
      },
      remove: () =>
        (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
      removeAfterReply: removeAckAfterReply,
    });
  }
  clearGroupHistory();
};
