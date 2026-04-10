import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  type MSTeamsReplyStyle,
  type OpenClawConfig,
  type RuntimeEnv,
  createChannelReplyPipeline,
  logTypingFailure,
  resolveChannelMediaMaxBytes,
} from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { StoredConversationReference } from "./conversation-store.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  type MSTeamsAdapter,
  type MSTeamsRenderedMessage,
  buildConversationReference,
  renderReplyPayloadsToMessages,
  sendMSTeamsMessages,
} from "./messenger.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export { pickInformativeStatusText } from "./reply-stream-controller.js";

export function createMSTeamsReplyDispatcher(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  accountId?: string;
  runtime: RuntimeEnv;
  log: MSTeamsMonitorLogger;
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  context: MSTeamsTurnContext;
  replyStyle: MSTeamsReplyStyle;
  textLimit: number;
  onSentMessageIds?: (ids: string[]) => void;
  tokenProvider?: MSTeamsAccessTokenProvider;
  sharePointSiteId?: string;
}) {
  const core = getMSTeamsRuntime();
  const msteamsCfg = params.cfg.channels?.msteams;
  const conversationType = normalizeOptionalLowercaseString(
    params.conversationRef.conversation?.conversationType,
  );
  const isTypingSupported = conversationType === "personal" || conversationType === "groupchat";

  const sendTypingIndicator = isTypingSupported
    ? async () => {
        await withRevokedProxyFallback({
          onRevoked: async () => {
            const baseRef = buildConversationReference(params.conversationRef);
            await params.adapter.continueConversation(
              params.appId,
              { ...baseRef, activityId: undefined },
              async (ctx) => {
                await ctx.sendActivity({ type: "typing" });
              },
            );
          },
          onRevokedLog: () => {
            params.log.debug?.("turn context revoked, sending typing via proactive messaging");
          },
          run: async () => {
            await params.context.sendActivity({ type: "typing" });
          },
        });
      }
    : async () => {};

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "msteams",
    typing: {
      onStartError: (err) => {
        logTypingFailure({
          action: "start",
          channel: "msteams",
          error: err,
          log: (message) => params.log.debug?.(message),
        });
      },
      start: sendTypingIndicator,
    },
  });

  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "msteams");
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "msteams",
  });
  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb,
  });
  const feedbackLoopEnabled = params.cfg.channels?.msteams?.feedbackEnabled !== false;
  const streamController = createTeamsReplyStreamController({
    context: params.context,
    conversationType,
    feedbackLoopEnabled,
    log: params.log,
  });

  const blockStreamingEnabled =
    typeof msteamsCfg?.blockStreaming === "boolean" ? msteamsCfg.blockStreaming : false;
  const typingIndicatorEnabled =
    typeof msteamsCfg?.typingIndicator === "boolean" ? msteamsCfg.typingIndicator : true;

  const pendingMessages: MSTeamsRenderedMessage[] = [];

  const sendMessages = async (messages: MSTeamsRenderedMessage[]): Promise<string[]> =>
    sendMSTeamsMessages({
      adapter: params.adapter,
      appId: params.appId,
      context: params.context,
      conversationRef: params.conversationRef,
      feedbackLoopEnabled,
      mediaMaxBytes,
      messages,
      onRetry: (event) => {
        params.log.debug?.("retrying send", {
          replyStyle: params.replyStyle,
          ...event,
        });
      },
      replyStyle: params.replyStyle,
      retry: {},
      sharePointSiteId: params.sharePointSiteId,
      tokenProvider: params.tokenProvider,
    });

  const queueDeliveryFailureSystemEvent = (failure: {
    failed: number;
    total: number;
    error: unknown;
  }) => {
    const classification = classifyMSTeamsSendError(failure.error);
    const errorText = formatUnknownError(failure.error);
    const failedAll = failure.failed >= failure.total;
    const summary = failedAll
      ? "the previous reply was not delivered"
      : `${failure.failed} of ${failure.total} message blocks were not delivered`;
    const sentences = [
      `Microsoft Teams delivery failed: ${summary}.`,
      `The user may not have received ${failedAll ? "that reply" : "the full reply"}.`,
      `Error: ${errorText}.`,
      classification.statusCode != null ? `Status: ${classification.statusCode}.` : undefined,
      classification.kind === "transient" || classification.kind === "throttled"
        ? "Retrying later may succeed."
        : undefined,
    ].filter(Boolean);
    core.system.enqueueSystemEvent(sentences.join(" "), {
      contextKey: `msteams:delivery-failure:${params.conversationRef.conversation?.id ?? "unknown"}`,
      sessionKey: params.sessionKey,
    });
  };

  const flushPendingMessages = async () => {
    if (pendingMessages.length === 0) {
      return;
    }
    const toSend = pendingMessages.splice(0);
    const total = toSend.length;
    let ids: string[];
    try {
      ids = await sendMessages(toSend);
    } catch (batchError) {
      ids = [];
      let failed = 0;
      let lastFailedError: unknown = batchError;
      for (const msg of toSend) {
        try {
          const msgIds = await sendMessages([msg]);
          ids.push(...msgIds);
        } catch (msgError) {
          failed += 1;
          lastFailedError = msgError;
          params.log.debug?.("individual message send failed, continuing with remaining blocks");
        }
      }
      if (failed > 0) {
        params.log.warn?.(`failed to deliver ${failed} of ${total} message blocks`, {
          failed,
          total,
        });
        queueDeliveryFailureSystemEvent({
          error: lastFailedError,
          failed,
          total,
        });
      }
    }
    if (ids.length > 0) {
      params.onSentMessageIds?.(ids);
    }
  };

  const {
    dispatcher,
    replyOptions,
    markDispatchIdle: baseMarkDispatchIdle,
  } = core.channel.reply.createReplyDispatcherWithTyping({
    ...replyPipeline,
    deliver: async (payload) => {
      const preparedPayload = streamController.preparePayload(payload);
      if (!preparedPayload) {
        return;
      }

      const messages = renderReplyPayloadsToMessages([preparedPayload], {
        chunkMode,
        chunkText: true,
        mediaMode: "split",
        tableMode,
        textChunkLimit: params.textLimit,
      });
      pendingMessages.push(...messages);

      // When block streaming is enabled, flush immediately so blocks are
      // Delivered progressively instead of batching until markDispatchIdle.
      if (blockStreamingEnabled) {
        await flushPendingMessages();
      }
    },
    humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
    onError: (err, info) => {
      const errMsg = formatUnknownError(err);
      const classification = classifyMSTeamsSendError(err);
      const hint = formatMSTeamsSendErrorHint(classification);
      params.runtime.error?.(
        `msteams ${info.kind} reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`,
      );
      params.log.error("reply failed", {
        classification,
        error: errMsg,
        hint,
        kind: info.kind,
      });
    },
    onReplyStart: async () => {
      await streamController.onReplyStart();
      // Avoid duplicate typing UX in DMs: stream status already shows progress.
      if (typingIndicatorEnabled && !streamController.hasStream()) {
        await typingCallbacks?.onReplyStart?.();
      }
    },
    typingCallbacks,
  });

  const markDispatchIdle = (): Promise<void> =>
    flushPendingMessages()
      .catch((error) => {
        const errMsg = formatUnknownError(error);
        const classification = classifyMSTeamsSendError(error);
        const hint = formatMSTeamsSendErrorHint(classification);
        params.runtime.error?.(`msteams flush reply failed: ${errMsg}${hint ? ` (${hint})` : ""}`);
        params.log.error("flush reply failed", {
          classification,
          error: errMsg,
          hint,
        });
      })
      .then(() =>
        streamController.finalize().catch((err) => {
          params.log.debug?.("stream finalize failed", { error: formatUnknownError(err) });
        }),
      )
      .finally(() => {
        baseMarkDispatchIdle();
      });

  return {
    dispatcher,
    markDispatchIdle,
    replyOptions: {
      ...replyOptions,
      ...(streamController.hasStream()
        ? {
            onPartialReply: (payload: { text?: string }) =>
              streamController.onPartialReply(payload),
          }
        : {}),
      disableBlockStreaming:
        typeof msteamsCfg?.blockStreaming === "boolean" ? !msteamsCfg.blockStreaming : undefined,
      onModelSelected,
    },
  };
}
