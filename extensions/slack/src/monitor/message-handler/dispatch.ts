import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  DEFAULT_TIMING,
  type StatusReactionAdapter,
  createStatusReactionController,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
} from "openclaw/plugin-sdk/channel-streaming";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig,
} from "../../stream-mode.js";
import type { SlackStreamSession } from "../../streaming.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import { resolveStorePath, updateLastRoute } from "../config.runtime.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveSlackThreadTs,
} from "../replies.js";
import { createReplyDispatcherWithTyping, dispatchInboundMessage } from "../reply.runtime.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import type { PreparedSlackMessage } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slack reactions.add/remove expect shortcode names, not raw unicode emoji.
const UNICODE_TO_SLACK: Record<string, string> = {
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "⚡": "zap",
  "✅": "white_check_mark",
  "✍": "writing_hand",
  "❌": "x",
  "🌐": "globe_with_meridians",
  "👀": "eyes",
  "👍": "thumbsup",
  "👨‍💻": "male-technologist",
  "👨💻": "male-technologist",
  "👩‍💻": "female-technologist",
  "💻": "computer",
  "🔥": "fire",
  "😨": "fearful",
  "😱": "scream",
  "🛠️": "hammer_and_wrench",
  "🤔": "thinking_face",
  "🥱": "yawning_face",
  "🧠": "brain",
};

function toSlackEmojiName(emoji: string): string {
  const trimmed = emoji.trim().replace(/^:+|:+$/g, "");
  return UNICODE_TO_SLACK[trimmed] ?? trimmed;
}

export function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
}): boolean {
  if (params.mode !== "partial") {
    return false;
  }
  return params.nativeStreaming;
}

export function shouldEnableSlackPreviewStreaming(params: {
  mode: "off" | "partial" | "block" | "progress";
  isDirectMessage: boolean;
  threadTs?: string;
}): boolean {
  if (params.mode === "off") {
    return false;
  }
  if (!params.isDirectMessage) {
    return true;
  }
  return Boolean(params.threadTs);
}

export function shouldInitializeSlackDraftStream(params: {
  previewStreamingEnabled: boolean;
  useStreaming: boolean;
}): boolean {
  return params.previewStreamingEnabled && !params.useStreaming;
}

export function resolveSlackStreamingThreadHint(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  isThreadReply?: boolean;
}): string | undefined {
  return resolveSlackThreadTs({
    hasReplied: false,
    incomingThreadTs: params.incomingThreadTs,
    isThreadReply: params.isThreadReply,
    messageTs: params.messageTs,
    replyToMode: params.replyToMode,
  });
}

interface SlackTurnDeliveryAttempt {
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  threadTs?: string;
  textOverride?: string;
}

function buildSlackTurnDeliveryKey(params: SlackTurnDeliveryAttempt): string | null {
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.textOverride,
  });
  const slackBlocks = readSlackReplyBlocks(params.payload);
  if (!reply.hasContent && !slackBlocks?.length) {
    return null;
  }
  return JSON.stringify({
    blocks: slackBlocks ?? null,
    kind: params.kind,
    mediaUrls: reply.mediaUrls,
    replyToId: params.payload.replyToId ?? null,
    text: reply.trimmedText,
    threadTs: params.threadTs ?? "",
  });
}

export function createSlackTurnDeliveryTracker() {
  const deliveredKeys = new Set<string>();
  return {
    hasDelivered(params: SlackTurnDeliveryAttempt) {
      const key = buildSlackTurnDeliveryKey(params);
      return key ? deliveredKeys.has(key) : false;
    },
    markDelivered(params: SlackTurnDeliveryAttempt) {
      const key = buildSlackTurnDeliveryKey(params);
      if (key) {
        deliveredKeys.add(key);
      }
    },
  };
}

function shouldUseStreaming(params: {
  streamingEnabled: boolean;
  threadTs: string | undefined;
}): boolean {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled — no reply thread target available");
    return false;
  }
  return true;
}

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const { cfg } = ctx;
  const { runtime } = ctx;

  // Resolve agent identity for Slack chat:write.customize overrides.
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
  const slackIdentity = outboundIdentity
    ? {
        iconEmoji: outboundIdentity.emoji,
        iconUrl: outboundIdentity.avatarUrl,
        username: outboundIdentity.name,
      }
    : undefined;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      allowFrom: ctx.allowFrom,
      dmScope: cfg.session?.dmScope,
      normalizeEntry: normalizeSlackAllowOwnerEntry,
    });
    const senderRecipient = normalizeOptionalLowercaseString(message.user);
    const skipMainUpdate =
      pinnedMainDmOwner &&
      senderRecipient &&
      normalizeOptionalLowercaseString(pinnedMainDmOwner) !== senderRecipient;
    if (skipMainUpdate) {
      logVerbose(
        `slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
      );
    } else {
      await updateLastRoute({
        ctx: prepared.ctxPayload,
        deliveryContext: {
          accountId: route.accountId,
          channel: "slack",
          threadId: prepared.ctxPayload.MessageThreadId,
          to: `user:${message.user}`,
        },
        sessionKey: route.mainSessionKey,
        storePath,
      });
    }
  }

  const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode,
  });

  const reactionMessageTs = prepared.ackReactionMessageTs;
  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;
  const statusReactionsEnabled =
    Boolean(prepared.ackReactionPromise) &&
    Boolean(reactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false;
  const slackStatusAdapter: StatusReactionAdapter = {
    removeReaction: async (emoji) => {
      await removeSlackReaction(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        client: ctx.app.client,
        token: ctx.botToken,
      }).catch((error) => {
        if (String(error).includes("no_reaction")) {
          return;
        }
        throw error;
      });
    },
    setReaction: async (emoji) => {
      await reactSlackMessage(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        client: ctx.app.client,
        token: ctx.botToken,
      }).catch((error) => {
        if (String(error).includes("already_reacted")) {
          return;
        }
        throw error;
      });
    },
  };
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const statusReactions = createStatusReactionController({
    adapter: slackStatusAdapter,
    emojis: cfg.messages?.statusReactions?.emojis,
    enabled: statusReactionsEnabled,
    initialEmoji: prepared.ackReactionValue || "eyes",
    onError: (err) => {
      logAckFailure({
        channel: "slack",
        error: err,
        log: logVerbose,
        target: `${message.channel}/${message.ts}`,
      });
    },
    timing: cfg.messages?.statusReactions?.timing,
  });

  if (statusReactionsEnabled) {
    void statusReactions.setQueued();
  }

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // Mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    hasRepliedRef,
    incomingThreadTs,
    isThreadReply,
    messageTs,
    replyToMode: prepared.replyToMode,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const { typingReaction } = ctx;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    accountId: route.accountId,
    agentId: route.agentId,
    cfg,
    channel: "slack",
    typing: {
      onStartError: (err) => {
        logTypingFailure({
          action: "start",
          channel: "slack",
          error: err,
          log: (message) => runtime.error?.(danger(message)),
          target: typingTarget,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          action: "stop",
          channel: "slack",
          error: err,
          log: (message) => runtime.error?.(danger(message)),
          target: typingTarget,
        });
      },
      start: async () => {
        didSetStatus = true;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          status: "is typing...",
          threadTs: statusThreadTs,
        });
        if (typingReaction && message.ts) {
          await reactSlackMessage(message.channel, message.ts, typingReaction, {
            client: ctx.app.client,
            token: ctx.botToken,
          }).catch(() => {});
        }
      },
      stop: async () => {
        if (!didSetStatus) {
          return;
        }
        didSetStatus = false;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          status: "",
          threadTs: statusThreadTs,
        });
        if (typingReaction && message.ts) {
          await removeSlackReaction(message.channel, message.ts, typingReaction, {
            client: ctx.app.client,
            token: ctx.botToken,
          }).catch(() => {});
        }
      },
    },
  });

  const slackStreaming = resolveSlackStreamingConfig({
    nativeStreaming: resolveChannelStreamingNativeTransport(account.config),
    streaming: account.config.streaming,
  });
  const streamThreadHint = resolveSlackStreamingThreadHint({
    incomingThreadTs,
    isThreadReply,
    messageTs,
    replyToMode: prepared.replyToMode,
  });
  const previewStreamingEnabled = shouldEnableSlackPreviewStreaming({
    isDirectMessage: prepared.isDirectMessage,
    mode: slackStreaming.mode,
    threadTs: streamThreadHint,
  });
  const streamingEnabled = isSlackStreamingEnabled({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming,
  });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  const shouldUseDraftStream = shouldInitializeSlackDraftStream({
    previewStreamingEnabled,
    useStreaming,
  });
  let streamSession: SlackStreamSession | null = null;
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;
  let observedReplyDelivery = false;
  const deliveryTracker = createSlackTurnDeliveryTracker();

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<void> => {
    const replyThreadTs = params.forcedThreadTs ?? replyPlan.nextThreadTs();
    if (
      deliveryTracker.hasDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: replyThreadTs,
      })
    ) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return;
    }
    await deliverReplies({
      accountId: account.accountId,
      replies: [params.payload],
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      runtime,
      target: prepared.replyTarget,
      textLimit: ctx.textLimit,
      token: ctx.botToken,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    observedReplyDelivery = true;
    // Record the thread ts only after confirmed delivery success.
    if (replyThreadTs) {
      usedReplyThreadTs ??= replyThreadTs;
    }
    replyPlan.markSent();
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: replyThreadTs,
    });
  };

  const deliverWithStreaming = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
  }): Promise<void> => {
    const reply = resolveSendableOutboundReplyParts(params.payload);
    if (
      streamFailed ||
      reply.hasMedia ||
      readSlackReplyBlocks(params.payload)?.length ||
      !reply.hasText
    ) {
      await deliverNormally({
        forcedThreadTs: streamSession?.threadTs,
        kind: params.kind,
        payload: params.payload,
      });
      return;
    }

    const text = reply.trimmedText;
    let plannedThreadTs: string | undefined;
    try {
      if (!streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery",
          );
          streamFailed = true;
          await deliverNormally({ kind: params.kind, payload: params.payload });
          return;
        }
        if (
          deliveryTracker.hasDelivered({
            kind: params.kind,
            payload: params.payload,
            textOverride: text,
            threadTs: streamThreadTs,
          })
        ) {
          logVerbose("slack-stream: suppressed duplicate stream start payload");
          return;
        }

        streamSession = await startSlackStream({
          channel: message.channel,
          client: ctx.app.client,
          teamId: ctx.teamId,
          text,
          threadTs: streamThreadTs,
          userId: message.user,
        });
        observedReplyDelivery = true;
        usedReplyThreadTs ??= streamThreadTs;
        replyPlan.markSent();
        deliveryTracker.markDelivered({
          kind: params.kind,
          payload: params.payload,
          textOverride: text,
          threadTs: streamThreadTs,
        });
        return;
      }
      if (
        deliveryTracker.hasDelivered({
          kind: params.kind,
          payload: params.payload,
          textOverride: text,
          threadTs: streamSession.threadTs,
        })
      ) {
        logVerbose("slack-stream: suppressed duplicate append payload");
        return;
      }

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
      deliveryTracker.markDelivered({
        kind: params.kind,
        payload: params.payload,
        textOverride: text,
        threadTs: streamSession.threadTs,
      });
    } catch (error) {
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${String(error)}, falling back`),
      );
      streamFailed = true;
      await deliverNormally({
        forcedThreadTs: streamSession?.threadTs ?? plannedThreadTs,
        kind: params.kind,
        payload: params.payload,
      });
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...replyPipeline,
    deliver: async (payload, info) => {
      if (useStreaming) {
        await deliverWithStreaming({ kind: info.kind, payload });
        return;
      }

      const reply = resolveSendableOutboundReplyParts(payload);
      const slackBlocks = readSlackReplyBlocks(payload);
      const draftMessageId = draftStream?.messageId();
      const draftChannelId = draftStream?.channelId();
      const trimmedFinalText = reply.trimmedText;
      const canFinalizeViaPreviewEdit =
        previewStreamingEnabled &&
        streamMode !== "status_final" &&
        !reply.hasMedia &&
        !payload.isError &&
        (trimmedFinalText.length > 0 || Boolean(slackBlocks?.length)) &&
        typeof draftMessageId === "string" &&
        typeof draftChannelId === "string";

      if (canFinalizeViaPreviewEdit) {
        const finalThreadTs = usedReplyThreadTs ?? statusThreadTs;
        if (deliveryTracker.hasDelivered({ kind: info.kind, payload, threadTs: finalThreadTs })) {
          observedReplyDelivery = true;
          return;
        }
        draftStream?.stop();
        try {
          await finalizeSlackPreviewEdit({
            client: ctx.app.client,
            token: ctx.botToken,
            accountId: account.accountId,
            channelId: draftChannelId,
            messageId: draftMessageId,
            text: normalizeSlackOutboundText(trimmedFinalText),
            ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
            threadTs: finalThreadTs,
          });
          observedReplyDelivery = true;
          deliveryTracker.markDelivered({ kind: info.kind, payload, threadTs: finalThreadTs });
          return;
        } catch (error) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${String(error)})`,
          );
        }
      } else if (previewStreamingEnabled && streamMode === "status_final" && hasStreamedMessage) {
        try {
          const statusChannelId = draftStream?.channelId();
          const statusMessageId = draftStream?.messageId();
          if (statusChannelId && statusMessageId) {
            await ctx.app.client.chat.update({
              channel: statusChannelId,
              text: "Status: complete. Final answer posted below.",
              token: ctx.botToken,
              ts: statusMessageId,
            });
          }
        } catch (error) {
          logVerbose(`slack: status_final completion update failed (${String(error)})`);
        }
      } else if (reply.hasMedia) {
        await draftStream?.clear();
        hasStreamedMessage = false;
      }

      await deliverNormally({ kind: info.kind, payload });
    },
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      replyPipeline.typingCallbacks?.onIdle?.();
    },
  });

  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
        accountId: account.accountId,
        log: logVerbose,
        maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
        onMessageSent: () => replyPlan.markSent(),
        resolveThreadTs: () => {
          const ts = replyPlan.nextThreadTs();
          if (ts) {
            usedReplyThreadTs ??= ts;
          }
          return ts;
        },
        target: prepared.replyTarget,
        token: ctx.botToken,
        warn: logVerbose,
      })
    : undefined;
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
  let appendRenderedText = "";
  let appendSourceText = "";
  let statusUpdateCount = 0;
  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    if (streamMode === "append") {
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return;
      }
      draftStream?.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }

    if (streamMode === "status_final") {
      statusUpdateCount += 1;
      if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) {
        return;
      }
      draftStream?.update(buildStatusFinalPreviewText(statusUpdateCount));
      hasStreamedMessage = true;
      return;
    }

    draftStream?.update(trimmed);
    hasStreamedMessage = true;
  };
  const onDraftBoundary = !shouldUseDraftStream
    ? undefined
    : async () => {
        if (hasStreamedMessage) {
          draftStream?.forceNewMessage();
          hasStreamedMessage = false;
          appendRenderedText = "";
          appendSourceText = "";
          statusUpdateCount = 0;
        }
      };

  let dispatchError: unknown;
  let queuedFinal = false;
  let counts: { final?: number; block?: number } = {};
  try {
    const result = await dispatchInboundMessage({
      cfg,
      ctx: prepared.ctxPayload,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming: useStreaming
          ? true
          : typeof resolveChannelStreamingBlockEnabled(account.config) === "boolean"
            ? !resolveChannelStreamingBlockEnabled(account.config)
            : undefined,
        hasRepliedRef,
        onAssistantMessageStart: onDraftBoundary,
        onModelSelected,
        onPartialReply: useStreaming
          ? undefined
          : !previewStreamingEnabled
            ? undefined
            : async (payload) => {
                updateDraftFromPartial(payload.text);
              },
        onReasoningEnd: onDraftBoundary,
        onReasoningStream: statusReactionsEnabled
          ? async () => {
              await statusReactions.setThinking();
            }
          : undefined,
        onToolStart: statusReactionsEnabled
          ? async (payload) => {
              await statusReactions.setTool(payload.name);
            }
          : undefined,
        skillFilter: prepared.channelConfig?.skills,
      },
    });
    ({ queuedFinal } = result);
    ({ counts } = result);
  } catch (error) {
    dispatchError = error;
  } finally {
    await draftStream?.flush();
    draftStream?.stop();
    markDispatchIdle();
  }

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  const finalStream = streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      await stopSlackStream({ session: finalStream });
    } catch (error) {
      runtime.error?.(danger(`slack-stream: failed to stop stream: ${String(error)}`));
    }
  }

  const anyReplyDelivered =
    observedReplyDelivery || queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;

  if (statusReactionsEnabled) {
    if (dispatchError) {
      await statusReactions.setError();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.errorHoldMs);
          if (anyReplyDelivered) {
            await statusReactions.clear();
            return;
          }
          await statusReactions.restoreInitial();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else if (anyReplyDelivered) {
      await statusReactions.setDone();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.doneHoldMs);
          await statusReactions.clear();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else {
      // Silent success should preserve queued state and clear any stall timers
      // Instead of transitioning to terminal/stall reactions after return.
      await statusReactions.restoreInitial();
    }
  }

  if (dispatchError) {
    throw dispatchError;
  }

  // Record thread participation only when we actually delivered a reply and
  // Know the thread ts that was used (set by deliverNormally, streaming start,
  // Or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);
  }

  if (!anyReplyDelivered) {
    await draftStream?.clear();
    if (prepared.isRoomish) {
      clearHistoryEntriesIfEnabled({
        historyKey: prepared.historyKey,
        historyMap: ctx.channelHistories,
        limit: ctx.historyLimit,
      });
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  if (!statusReactionsEnabled) {
    removeAckReactionAfterReply({
      ackReactionPromise: prepared.ackReactionPromise,
      ackReactionValue: prepared.ackReactionValue,
      onError: (err) => {
        logAckFailure({
          channel: "slack",
          error: err,
          log: logVerbose,
          target: `${message.channel}/${message.ts}`,
        });
      },
      remove: () =>
        removeSlackReaction(
          message.channel,
          prepared.ackReactionMessageTs ?? "",
          prepared.ackReactionValue,
          {
            client: ctx.app.client,
            token: ctx.botToken,
          },
        ),
      removeAfterReply: ctx.removeAckAfterReply && anyReplyDelivered,
    });
  }

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyKey: prepared.historyKey,
      historyMap: ctx.channelHistories,
      limit: ctx.historyLimit,
    });
  }
}
