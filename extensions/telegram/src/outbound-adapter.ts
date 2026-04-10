import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import {
  type OutboundSendDeps,
  resolveOutboundSendDep,
  sanitizeForPlainText,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { markdownToTelegramHtmlChunks } from "./format.js";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";

export const TELEGRAM_TEXT_CHUNK_LIMIT = 4000;

type TelegramSendFn = typeof import("./send.js").sendMessageTelegram;
type TelegramSendOpts = Parameters<TelegramSendFn>[2];

let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}

async function resolveTelegramSendContext(params: {
  cfg: NonNullable<TelegramSendOpts>["cfg"];
  deps?: OutboundSendDeps;
  accountId?: string | null;
  replyToId?: string | null;
  threadId?: string | number | null;
  gatewayClientScopes?: readonly string[];
}): Promise<{
  send: TelegramSendFn;
  baseOpts: {
    cfg: NonNullable<TelegramSendOpts>["cfg"];
    verbose: false;
    textMode: "html";
    messageThreadId?: number;
    replyToMessageId?: number;
    accountId?: string;
    gatewayClientScopes?: readonly string[];
  };
}> {
  const send =
    resolveOutboundSendDep<TelegramSendFn>(params.deps, "telegram") ??
    (await loadTelegramSendModule()).sendMessageTelegram;
  return {
    baseOpts: {
      accountId: params.accountId ?? undefined,
      cfg: params.cfg,
      gatewayClientScopes: params.gatewayClientScopes,
      messageThreadId: parseTelegramThreadId(params.threadId),
      replyToMessageId: parseTelegramReplyToMessageId(params.replyToId),
      textMode: "html",
      verbose: false,
    },
    send,
  };
}

export async function sendTelegramPayloadMessages(params: {
  send: TelegramSendFn;
  to: string;
  payload: ReplyPayload;
  baseOpts: Omit<NonNullable<TelegramSendOpts>, "buttons" | "mediaUrl" | "quoteText">;
}): Promise<Awaited<ReturnType<TelegramSendFn>>> {
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons; quoteText?: string }
    | undefined;
  const quoteText =
    typeof telegramData?.quoteText === "string" ? telegramData.quoteText : undefined;
  const text =
    resolveInteractiveTextFallback({
      interactive: params.payload.interactive,
      text: params.payload.text,
    }) ?? "";
  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const buttons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    interactive: params.payload.interactive,
  });
  const payloadOpts = {
    ...params.baseOpts,
    quoteText,
  };

  // Telegram allows reply_markup on media; attach buttons only to the first send.
  return await sendPayloadMediaSequenceOrFallback({
    fallbackResult: { chatId: params.to, messageId: "unknown" },
    mediaUrls,
    send: async ({ text, mediaUrl, isFirst }) =>
      await params.send(params.to, text, {
        ...payloadOpts,
        mediaUrl,
        ...(isFirst ? { buttons } : {}),
      }),
    sendNoMedia: async () =>
      await params.send(params.to, text, {
        ...payloadOpts,
        buttons,
      }),
    text,
  });
}

export const telegramOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: markdownToTelegramHtmlChunks,
  chunkerMode: "markdown",
  textChunkLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  shouldSkipPlainTextSanitization: ({ payload }) => Boolean(payload.channelData),
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    typeof fallbackLimit === "number" ? Math.min(fallbackLimit, 4096) : 4096,
  ...createAttachedChannelResultAdapter({
    channel: "telegram",
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      forceDocument,
      gatewayClientScopes,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        accountId,
        cfg,
        deps,
        gatewayClientScopes,
        replyToId,
        threadId,
      });
      return await send(to, text, {
        ...baseOpts,
        forceDocument: forceDocument ?? false,
        mediaLocalRoots,
        mediaReadFile,
        mediaUrl,
      });
    },
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      threadId,
      gatewayClientScopes,
    }) => {
      const { send, baseOpts } = await resolveTelegramSendContext({
        accountId,
        cfg,
        deps,
        gatewayClientScopes,
        replyToId,
        threadId,
      });
      return await send(to, text, {
        ...baseOpts,
      });
    },
  }),
  sendPayload: async ({
    cfg,
    to,
    payload,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    replyToId,
    threadId,
    forceDocument,
    gatewayClientScopes,
  }) => {
    const { send, baseOpts } = await resolveTelegramSendContext({
      accountId,
      cfg,
      deps,
      gatewayClientScopes,
      replyToId,
      threadId,
    });
    const result = await sendTelegramPayloadMessages({
      baseOpts: {
        ...baseOpts,
        forceDocument: forceDocument ?? false,
        mediaLocalRoots,
        mediaReadFile,
      },
      payload,
      send,
      to,
    });
    return attachChannelToResult("telegram", result);
  },
};
