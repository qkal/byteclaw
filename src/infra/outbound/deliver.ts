import {
  resolveSendableOutboundReplyParts,
  sendMediaWithLeadingCaption,
} from 'openclaw/plugin-sdk/reply-payload';
import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from '../../auto-reply/chunk.js';
import type { ReplyPayload } from '../../auto-reply/types.js';
import { loadChannelOutboundAdapter } from '../../channels/plugins/outbound/load.js';
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from '../../channels/plugins/types.js';
import type { OpenClawConfig } from '../../config/config.js';
import { resolveMirroredTranscriptText } from '../../config/sessions/transcript-mirror.js';
import { fireAndForgetHook } from '../../hooks/fire-and-forget.js';
import {
  createInternalHookEvent,
  triggerInternalHook,
} from '../../hooks/internal-hooks.js';
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from '../../hooks/message-hook-mappers.js';
import { hasReplyPayloadContent } from '../../interactive/payload.js';
import { createSubsystemLogger } from '../../logging/subsystem.js';
import type { OutboundMediaAccess } from '../../media/load-options.js';
import { resolveAgentScopedOutboundMediaAccess } from '../../media/read-capability.js';
import { getGlobalHookRunner } from '../../plugins/hook-runner-global.js';
import { formatErrorMessage } from '../errors.js';
import { throwIfAborted } from './abort.js';
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
} from './delivery-queue.js';
import type { OutboundIdentity } from './identity.js';
import type { DeliveryMirror } from './mirror.js';
import type { NormalizedOutboundPayload } from './payloads.js';
import { normalizeReplyPayloadsForDelivery } from './payloads.js';
import { type OutboundSendDeps, resolveOutboundSendDep } from './send-deps.js';
import type { OutboundSessionContext } from './session-context.js';
import type { OutboundChannel } from './targets.js';

export type { NormalizedOutboundPayload } from './payloads.js';
export { normalizeOutboundPayloads } from './payloads.js';
export { resolveOutboundSendDep, type OutboundSendDeps } from './send-deps.js';

const log = createSubsystemLogger('outbound/deliver');
let transcriptRuntimePromise:
  | Promise<typeof import('../../config/sessions/transcript.runtime.js')>
  | undefined;

async function loadTranscriptRuntime() {
  transcriptRuntimePromise ??=
    import('../../config/sessions/transcript.runtime.js');
  return await transcriptRuntimePromise;
}

let channelBootstrapRuntimePromise:
  | Promise<typeof import('./channel-bootstrap.runtime.js')>
  | undefined;

async function loadChannelBootstrapRuntime() {
  channelBootstrapRuntimePromise ??= import('./channel-bootstrap.runtime.js');
  return await channelBootstrapRuntimePromise;
}

export interface OutboundDeliveryResult {
  channel: Exclude<OutboundChannel, 'none'>;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
}

type Chunker = (text: string, limit: number) => string[];

interface ChannelHandler {
  chunker: Chunker | null;
  chunkerMode?: 'text' | 'markdown';
  textChunkLimit?: number;
  supportsMedia: boolean;
  sanitizeText?: (payload: ReplyPayload) => string;
  normalizePayload?: (payload: ReplyPayload) => ReplyPayload | null;
  shouldSkipPlainTextSanitization?: (payload: ReplyPayload) => boolean;
  resolveEffectiveTextChunkLimit?: (
    fallbackLimit?: number,
  ) => number | undefined;
  sendPayload?: (
    payload: ReplyPayload,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendFormattedText?: (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult[]>;
  sendFormattedMedia?: (
    caption: string,
    mediaUrl: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendText: (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
}

interface ChannelHandlerParams {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, 'none'>;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mediaAccess?: OutboundMediaAccess;
  gatewayClientScopes?: readonly string[];
}

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(
  params: ChannelHandlerParams,
): Promise<ChannelHandler> {
  let outbound = await loadChannelOutboundAdapter(params.channel);
  if (!outbound) {
    const { bootstrapOutboundChannelPlugin } =
      await loadChannelBootstrapRuntime();
    bootstrapOutboundChannelPlugin({
      cfg: params.cfg,
      channel: params.channel,
    });
    outbound = await loadChannelOutboundAdapter(params.channel);
  }
  const handler = createPluginHandler({ ...params, outbound });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

function createPluginHandler(
  params: ChannelHandlerParams & { outbound?: ChannelOutboundAdapter },
): ChannelHandler | null {
  const { outbound } = params;
  if (!outbound?.sendText) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const { sendText } = outbound;
  const { sendMedia } = outbound;
  const chunker = outbound.chunker ?? null;
  const { chunkerMode } = outbound;
  const resolveCtx = (overrides?: {
    replyToId?: string | null;
    threadId?: string | number | null;
    audioAsVoice?: boolean;
  }): Omit<ChannelOutboundContext, 'text' | 'mediaUrl'> => ({
    ...baseCtx,
    audioAsVoice: overrides?.audioAsVoice,
    replyToId: overrides?.replyToId ?? baseCtx.replyToId,
    threadId: overrides?.threadId ?? baseCtx.threadId,
  });
  return {
    chunker,
    chunkerMode,
    normalizePayload: outbound.normalizePayload
      ? (payload) => outbound.normalizePayload!({ payload })
      : undefined,
    resolveEffectiveTextChunkLimit: outbound.resolveEffectiveTextChunkLimit
      ? (fallbackLimit) =>
          outbound.resolveEffectiveTextChunkLimit!({
            accountId: params.accountId ?? undefined,
            cfg: params.cfg,
            fallbackLimit,
          })
      : undefined,
    sanitizeText: outbound.sanitizeText
      ? (payload) =>
          outbound.sanitizeText!({ payload, text: payload.text ?? '' })
      : undefined,
    sendFormattedMedia: outbound.sendFormattedMedia
      ? async (caption, mediaUrl, overrides) =>
          outbound.sendFormattedMedia!({
            ...resolveCtx(overrides),
            mediaUrl,
            text: caption,
          })
      : undefined,
    sendFormattedText: outbound.sendFormattedText
      ? async (text, overrides) =>
          outbound.sendFormattedText!({
            ...resolveCtx(overrides),
            text,
          })
      : undefined,
    sendMedia: async (caption, mediaUrl, overrides) => {
      if (sendMedia) {
        return sendMedia({
          ...resolveCtx(overrides),
          mediaUrl,
          text: caption,
        });
      }
      return sendText({
        ...resolveCtx(overrides),
        text: caption,
      });
    },
    sendPayload: outbound.sendPayload
      ? async (payload, overrides) =>
          outbound.sendPayload!({
            ...resolveCtx(overrides),
            mediaUrl: payload.mediaUrl,
            payload,
            text: payload.text ?? '',
          })
      : undefined,
    sendText: async (text, overrides) =>
      sendText({
        ...resolveCtx(overrides),
        text,
      }),
    shouldSkipPlainTextSanitization: outbound.shouldSkipPlainTextSanitization
      ? (payload) => outbound.shouldSkipPlainTextSanitization!({ payload })
      : undefined,
    supportsMedia: Boolean(sendMedia),
    textChunkLimit: outbound.textChunkLimit,
  };
}

function createChannelOutboundContextBase(
  params: ChannelHandlerParams,
): Omit<ChannelOutboundContext, 'text' | 'mediaUrl'> {
  return {
    accountId: params.accountId,
    cfg: params.cfg,
    deps: params.deps,
    forceDocument: params.forceDocument,
    gatewayClientScopes: params.gatewayClientScopes,
    gifPlayback: params.gifPlayback,
    identity: params.identity,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaAccess?.localRoots,
    mediaReadFile: params.mediaAccess?.readFile,
    replyToId: params.replyToId,
    silent: params.silent,
    threadId: params.threadId,
    to: params.to,
  };
}

const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'AbortError';

interface DeliverOutboundPayloadsCoreParams {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, 'none'>;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
}

function collectPayloadMediaSources(payloads: ReplyPayload[]): string[] {
  const mediaSources: string[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    mediaSources.push(...resolveSendableOutboundReplyParts(payload).mediaUrls);
  }
  return mediaSources;
}

export type DeliverOutboundPayloadsParams =
  DeliverOutboundPayloadsCoreParams & {
    /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
    skipQueue?: boolean;
  };

interface MessageSentEvent {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
}

function normalizeEmptyPayloadForDelivery(
  payload: ReplyPayload,
): ReplyPayload | null {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text.trim()) {
    if (!hasReplyPayloadContent({ ...payload, text })) {
      return null;
    }
    if (text) {
      return {
        ...payload,
        text: '',
      };
    }
  }
  return payload;
}

function normalizePayloadsForChannelDelivery(
  payloads: ReplyPayload[],
  handler: ChannelHandler,
): ReplyPayload[] {
  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of normalizeReplyPayloadsForDelivery(payloads)) {
    let sanitizedPayload = payload;
    if (handler.sanitizeText && sanitizedPayload.text) {
      if (!handler.shouldSkipPlainTextSanitization?.(sanitizedPayload)) {
        sanitizedPayload = {
          ...sanitizedPayload,
          text: handler.sanitizeText(sanitizedPayload),
        };
      }
    }
    const normalizedPayload = handler.normalizePayload
      ? handler.normalizePayload(sanitizedPayload)
      : sanitizedPayload;
    const normalized = normalizedPayload
      ? normalizeEmptyPayloadForDelivery(normalizedPayload)
      : null;
    if (normalized) {
      normalizedPayloads.push(normalized);
    }
  }
  return normalizedPayloads;
}

function buildPayloadSummary(payload: ReplyPayload): NormalizedOutboundPayload {
  const parts = resolveSendableOutboundReplyParts(payload);
  return {
    audioAsVoice: payload.audioAsVoice === true ? true : undefined,
    channelData: payload.channelData,
    interactive: payload.interactive,
    mediaUrls: parts.mediaUrls,
    text: parts.text,
  };
}

function createMessageSentEmitter(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  channel: Exclude<OutboundChannel, 'none'>;
  to: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
}): {
  emitMessageSent: (event: MessageSentEvent) => void;
  hasMessageSentHooks: boolean;
} {
  const hasMessageSentHooks =
    params.hookRunner?.hasHooks('message_sent') ?? false;
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  const emitMessageSent = (event: MessageSentEvent) => {
    if (!hasMessageSentHooks && !canEmitInternalHook) {
      return;
    }
    const canonical = buildCanonicalSentMessageHookContext({
      accountId: params.accountId ?? undefined,
      channelId: params.channel,
      content: event.content,
      conversationId: params.to,
      error: event.error,
      groupId: params.mirrorGroupId,
      isGroup: params.mirrorIsGroup,
      messageId: event.messageId,
      success: event.success,
      to: params.to,
    });
    if (hasMessageSentHooks) {
      fireAndForgetHook(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        'deliverOutboundPayloads: message_sent plugin hook failed',
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          'message',
          'sent',
          params.sessionKeyForInternalHooks!,
          toInternalMessageSentContext(
            canonical as unknown as Record<string, unknown>,
          ),
        ),
      ),
      'deliverOutboundPayloads: message:sent internal hook failed',
      (message) => {
        log.warn(message);
      },
    );
  };
  return { emitMessageSent, hasMessageSentHooks };
}

async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: Exclude<OutboundChannel, 'none'>;
  accountId?: string;
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
  if (!params.enabled) {
    return {
      cancelled: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        content: params.payloadSummary.text,
        metadata: {
          accountId: params.accountId,
          channel: params.channel,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
        to: params.to,
      },
      {
        accountId: params.accountId ?? undefined,
        channelId: params.channel,
      },
    );
    if (sendingResult?.cancel) {
      return {
        cancelled: true,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (sendingResult?.content == null) {
      return {
        cancelled: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    const payload = {
      ...params.payload,
      text: sendingResult.content,
    };
    return {
      cancelled: false,
      payload,
      payloadSummary: {
        ...params.payloadSummary,
        text: sendingResult.content,
      },
    };
  } catch {
    // Don't block delivery on hook failure.
    return {
      cancelled: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const { channel, to, payloads } = params;

  // Write-ahead delivery queue: persist before sending, remove after success.
  const queueId = params.skipQueue
    ? null
    : await enqueueDelivery({
        accountId: params.accountId,
        bestEffort: params.bestEffort,
        channel,
        forceDocument: params.forceDocument,
        gatewayClientScopes: params.gatewayClientScopes,
        gifPlayback: params.gifPlayback,
        mirror: params.mirror,
        payloads,
        replyToId: params.replyToId,
        silent: params.silent,
        threadId: params.threadId,
        to,
      }).catch(() => null); // Best-effort — don't block delivery if queue write fails.

  // Wrap onError to detect partial failures under bestEffort mode.
  // When bestEffort is true, per-payload errors are caught and passed to onError
  // Without throwing — so the outer try/catch never fires. We track whether any
  // Payload failed so we can call failDelivery instead of ackDelivery.
  let hadPartialFailure = false;
  const wrappedParams = params.onError
    ? {
        ...params,
        onError: (err: unknown, payload: NormalizedOutboundPayload) => {
          hadPartialFailure = true;
          params.onError!(err, payload);
        },
      }
    : params;

  try {
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    if (queueId) {
      if (hadPartialFailure) {
        await failDelivery(
          queueId,
          'partial delivery failure (bestEffort)',
        ).catch(() => {});
      } else {
        await ackDelivery(queueId).catch(() => {}); // Best-effort cleanup.
      }
    }
    return results;
  } catch (error) {
    if (queueId) {
      if (isAbortError(error)) {
        await ackDelivery(queueId).catch(() => {});
      } else {
        await failDelivery(queueId, formatErrorMessage(error)).catch(() => {});
      }
    }
    throw error;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const { accountId } = params;
  const { deps } = params;
  const { abortSignal } = params;
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    agentId: params.session?.agentId ?? params.mirror?.agentId,
    cfg,
    mediaSources: collectPayloadMediaSources(payloads),
  });
  const results: OutboundDeliveryResult[] = [];
  const handler = await createChannelHandler({
    accountId,
    cfg,
    channel,
    deps,
    forceDocument: params.forceDocument,
    gatewayClientScopes: params.gatewayClientScopes,
    gifPlayback: params.gifPlayback,
    identity: params.identity,
    mediaAccess,
    replyToId: params.replyToId,
    silent: params.silent,
    threadId: params.threadId,
    to,
  });
  const configuredTextLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const textLimit = handler.resolveEffectiveTextChunkLimit
    ? handler.resolveEffectiveTextChunkLimit(configuredTextLimit)
    : configuredTextLimit;
  const chunkMode = handler.chunker
    ? resolveChunkMode(cfg, channel, accountId)
    : 'length';

  const sendTextChunks = async (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text, overrides));
      return;
    }
    if (chunkMode === 'newline') {
      const mode = handler.chunkerMode ?? 'text';
      const blockChunks =
        mode === 'markdown'
          ? chunkMarkdownTextWithMode(text, textLimit, 'newline')
          : chunkByParagraph(text, textLimit);

      if (!blockChunks.length && text) {
        blockChunks.push(text);
      }
      for (const blockChunk of blockChunks) {
        const chunks = handler.chunker(blockChunk, textLimit);
        if (!chunks.length && blockChunk) {
          chunks.push(blockChunk);
        }
        for (const chunk of chunks) {
          throwIfAborted(abortSignal);
          results.push(await handler.sendText(chunk, overrides));
        }
      }
      return;
    }
    const chunks = handler.chunker(text, textLimit);
    for (const chunk of chunks) {
      throwIfAborted(abortSignal);
      results.push(await handler.sendText(chunk, overrides));
    }
  };
  const normalizedPayloads = normalizePayloadsForChannelDelivery(
    payloads,
    handler,
  );
  const hookRunner = getGlobalHookRunner();
  const sessionKeyForInternalHooks =
    params.mirror?.sessionKey ?? params.session?.key;
  const mirrorIsGroup = params.mirror?.isGroup;
  const mirrorGroupId = params.mirror?.groupId;
  const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
    accountId,
    channel,
    hookRunner,
    mirrorGroupId,
    mirrorIsGroup,
    sessionKeyForInternalHooks,
    to,
  });
  const hasMessageSendingHooks =
    hookRunner?.hasHooks('message_sending') ?? false;
  if (
    hasMessageSentHooks &&
    params.session?.agentId &&
    !sessionKeyForInternalHooks
  ) {
    log.warn(
      'deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped',
      {
        agentId: params.session.agentId,
        channel,
        to,
      },
    );
  }
  for (const payload of normalizedPayloads) {
    let payloadSummary = buildPayloadSummary(payload);
    try {
      throwIfAborted(abortSignal);

      // Run message_sending plugin hook (may modify content or cancel)
      const hookResult = await applyMessageSendingHook({
        accountId,
        channel,
        enabled: hasMessageSendingHooks,
        hookRunner,
        payload,
        payloadSummary,
        to,
      });
      if (hookResult.cancelled) {
        continue;
      }
      const effectivePayload = hookResult.payload;
      ({ payloadSummary } = hookResult);

      params.onPayload?.(payloadSummary);
      const sendOverrides = {
        audioAsVoice: effectivePayload.audioAsVoice === true ? true : undefined,
        forceDocument: params.forceDocument,
        replyToId: effectivePayload.replyToId ?? params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
      };
      if (
        handler.sendPayload &&
        hasReplyPayloadContent({
          channelData: effectivePayload.channelData,
          interactive: effectivePayload.interactive,
        })
      ) {
        const delivery = await handler.sendPayload(
          effectivePayload,
          sendOverrides,
        );
        results.push(delivery);
        emitMessageSent({
          content: payloadSummary.text,
          messageId: delivery.messageId,
          success: true,
        });
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (handler.sendFormattedText) {
          results.push(
            ...(await handler.sendFormattedText(
              payloadSummary.text,
              sendOverrides,
            )),
          );
        } else {
          await sendTextChunks(payloadSummary.text, sendOverrides);
        }
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          content: payloadSummary.text,
          messageId,
          success: results.length > beforeCount,
        });
        continue;
      }

      if (!handler.supportsMedia) {
        log.warn(
          'Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used',
          {
            channel,
            mediaCount: payloadSummary.mediaUrls.length,
            to,
          },
        );
        const fallbackText = payloadSummary.text.trim();
        if (!fallbackText) {
          throw new Error(
            'Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload',
          );
        }
        const beforeCount = results.length;
        await sendTextChunks(fallbackText, sendOverrides);
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          content: payloadSummary.text,
          messageId,
          success: results.length > beforeCount,
        });
        continue;
      }

      let lastMessageId: string | undefined;
      await sendMediaWithLeadingCaption({
        caption: payloadSummary.text,
        mediaUrls: payloadSummary.mediaUrls,
        send: async ({ mediaUrl, caption }) => {
          throwIfAborted(abortSignal);
          if (handler.sendFormattedMedia) {
            const delivery = await handler.sendFormattedMedia(
              caption ?? '',
              mediaUrl,
              sendOverrides,
            );
            results.push(delivery);
            lastMessageId = delivery.messageId;
            return;
          }
          const delivery = await handler.sendMedia(
            caption ?? '',
            mediaUrl,
            sendOverrides,
          );
          results.push(delivery);
          lastMessageId = delivery.messageId;
        },
      });
      emitMessageSent({
        content: payloadSummary.text,
        messageId: lastMessageId,
        success: true,
      });
    } catch (error) {
      emitMessageSent({
        content: payloadSummary.text,
        error: formatErrorMessage(error),
        success: false,
      });
      if (!params.bestEffort) {
        throw error;
      }
      params.onError?.(error, payloadSummary);
    }
  }
  if (params.mirror && results.length > 0) {
    const mirrorText = resolveMirroredTranscriptText({
      mediaUrls: params.mirror.mediaUrls,
      text: params.mirror.text,
    });
    if (mirrorText) {
      const { appendAssistantMessageToSessionTranscript } =
        await loadTranscriptRuntime();
      await appendAssistantMessageToSessionTranscript({
        agentId: params.mirror.agentId,
        idempotencyKey: params.mirror.idempotencyKey,
        sessionKey: params.mirror.sessionKey,
        text: mirrorText,
      });
    }
  }

  return results;
}
