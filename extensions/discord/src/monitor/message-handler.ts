import type { Client } from "@buape/carbon";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { buildDiscordInboundJob } from "./inbound-job.js";
import {
  type DiscordInboundWorkerTestingHooks,
  createDiscordInboundWorker,
} from "./inbound-worker.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  workerRunTimeoutMs?: number;
  __testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordInboundWorkerTestingHooks & {
  preflightDiscordMessage?: typeof preflightDiscordMessage;
};

export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};

const RECENT_DISCORD_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_DISCORD_MESSAGE_MAX = 5000;

function buildDiscordInboundDedupeKey(params: {
  accountId: string;
  data: DiscordMessageEvent;
}): string | null {
  const messageId = params.data.message?.id?.trim();
  if (!messageId) {
    return null;
  }
  const channelId = resolveDiscordMessageChannelId({
    eventChannelId: params.data.channel_id,
    message: params.data.message,
  });
  if (!channelId) {
    return null;
  }
  return `${params.accountId}:${channelId}:${messageId}`;
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
    groupPolicy: params.discordConfig?.groupPolicy,
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const preflightDiscordMessageImpl =
    params.__testing?.preflightDiscordMessage ?? preflightDiscordMessage;
  const inboundWorker = createDiscordInboundWorker({
    __testing: params.__testing,
    abortSignal: params.abortSignal,
    runTimeoutMs: params.workerRunTimeoutMs,
    runtime: params.runtime,
    setStatus: params.setStatus,
  });
  const recentInboundMessages = createDedupeCache({
    maxSize: RECENT_DISCORD_MESSAGE_MAX,
    ttlMs: RECENT_DISCORD_MESSAGE_TTL_MS,
  });

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
  }>({
    buildKey: (entry) => {
      const {message} = entry.data;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        eventChannelId: entry.data.channel_id,
        message,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    cfg: params.cfg,
    channel: "discord",
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const {abortSignal} = last;
      if (abortSignal?.aborted) {
        return;
      }
      if (entries.length === 1) {
        const ctx = await preflightDiscordMessageImpl({
          ...params,
          abortSignal,
          ackReactionScope,
          client: last.client,
          data: last.data,
          groupPolicy,
        });
        if (!ctx) {
          return;
        }
        applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
        inboundWorker.enqueue(buildDiscordInboundJob(ctx));
        return;
      }
      const combinedBaseText = entries
        .map((entry) => resolveDiscordMessageText(entry.data.message, { includeForwarded: false }))
        .filter(Boolean)
        .join("\n");
      const syntheticMessage = {
        ...last.data.message,
        attachments: [],
        content: combinedBaseText,
        messageSnapshots: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
        message_snapshots: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
        rawData: {
          ...(last.data.message as { rawData?: Record<string, unknown> }).rawData,
        },
      };
      const syntheticData: DiscordMessageEvent = {
        ...last.data,
        message: syntheticMessage,
      };
      const ctx = await preflightDiscordMessageImpl({
        ...params,
        abortSignal,
        ackReactionScope,
        client: last.client,
        data: syntheticData,
        groupPolicy,
      });
      if (!ctx) {
        return;
      }
      applyImplicitReplyBatchGate(ctx, params.replyToMode, true);
      if (entries.length > 1) {
        const ids = entries.map((entry) => entry.data.message?.id).filter(Boolean) as string[];
        if (ids.length > 0) {
          const ctxBatch = ctx as typeof ctx & {
            MessageSids?: string[];
            MessageSidFirst?: string;
            MessageSidLast?: string;
          };
          ctxBatch.MessageSids = ids;
          ctxBatch.MessageSidFirst = ids[0];
          ctxBatch.MessageSidLast = ids[ids.length - 1];
        }
      }
      inboundWorker.enqueue(buildDiscordInboundJob(ctx));
    },
    shouldDebounce: (entry) => {
      const {message} = entry.data;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        cfg: params.cfg,
        hasMedia: Boolean(
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
        ),
        text: baseText,
      });
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // The message has already consumed debounce capacity and blocked
      // Legitimate user messages. On active servers this causes cumulative
      // Slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      const dedupeKey = buildDiscordInboundDedupeKey({
        accountId: params.accountId,
        data,
      });
      if (dedupeKey && recentInboundMessages.check(dedupeKey)) {
        return;
      }

      await debouncer.enqueue({ abortSignal: options?.abortSignal, client, data });
    } catch (error) {
      params.runtime.error?.(danger(`handler failed: ${String(error)}`));
    }
  };

  handler.deactivate = inboundWorker.deactivate;

  return handler;
}
