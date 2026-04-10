import { type Bot, GrammyError, InputFile } from "grammy";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-runtime";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { fireAndForgetHook } from "openclaw/plugin-sdk/hook-runtime";
import { createInternalHookEvent, triggerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "openclaw/plugin-sdk/hook-runtime";
import { buildOutboundMediaLoadOptions } from "openclaw/plugin-sdk/media-runtime";
import { isGifMedia, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { type ChunkMode, chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import type { TelegramInlineButtons } from "../button-types.js";
import { splitTelegramCaption } from "../caption.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  wrapFileReferencesInHtml,
} from "../format.js";
import { buildInlineKeyboard } from "../send.js";
import { resolveTelegramVoiceSend } from "../voice.js";
import {
  buildTelegramSendParams,
  sendTelegramText,
  sendTelegramWithThreadFallback,
} from "./delivery.send.js";
import { type TelegramThreadSpec, resolveTelegramReplyId } from "./helpers.js";
import {
  type DeliveryProgress as ReplyThreadDeliveryProgress,
  markReplyApplied,
  resolveReplyToForSend,
  sendChunkedTelegramReplyText,
} from "./reply-threading.js";

const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;
const CAPTION_TOO_LONG_RE = /caption is too long/i;
const GrammyErrorCtor: typeof GrammyError | undefined =
  typeof GrammyError === "function" ? GrammyError : undefined;

type DeliveryProgress = ReplyThreadDeliveryProgress & {
  deliveredCount: number;
};

interface TelegramReplyChannelData {
  buttons?: TelegramInlineButtons;
  pin?: boolean;
}

type ChunkTextFn = (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;

function buildChunkTextResolver(params: {
  textLimit: number;
  chunkMode: ChunkMode;
  tableMode?: MarkdownTableMode;
}): ChunkTextFn {
  return (markdown: string) => {
    const markdownChunks =
      params.chunkMode === "newline"
        ? chunkMarkdownTextWithMode(markdown, params.textLimit, params.chunkMode)
        : [markdown];
    const chunks: ReturnType<typeof markdownToTelegramChunks> = [];
    for (const chunk of markdownChunks) {
      const nested = markdownToTelegramChunks(chunk, params.textLimit, {
        tableMode: params.tableMode,
      });
      if (!nested.length && chunk) {
        chunks.push({
          html: wrapFileReferencesInHtml(
            markdownToTelegramHtml(chunk, { tableMode: params.tableMode, wrapFileRefs: false }),
          ),
          text: chunk,
        });
        continue;
      }
      chunks.push(...nested);
    }
    return chunks;
  };
}

function markDelivered(progress: DeliveryProgress): void {
  progress.hasDelivered = true;
  progress.deliveredCount += 1;
}

function filterEmptyTelegramTextChunks<T extends { text: string }>(chunks: readonly T[]): T[] {
  // Telegram rejects whitespace-only text payloads; drop them before sendMessage so
  // Hook-mutated or model-emitted empty replies become a no-op instead of a 400.
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

async function deliverTextReply(params: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  chunkText: ChunkTextFn;
  replyText: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.replyText));
  await sendChunkedTelegramReplyText({
    chunks,
    markDelivered,
    progress: params.progress,
    replyMarkup: params.replyMarkup,
    replyQuoteText: params.replyQuoteText,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
      const messageId = await sendTelegramText(
        params.bot,
        params.chatId,
        chunk.html,
        params.runtime,
        {
          linkPreview: params.linkPreview,
          plainText: chunk.text,
          replyMarkup,
          replyQuoteText,
          replyToMessageId,
          silent: params.silent,
          textMode: "html",
          thread: params.thread,
        },
      );
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = messageId;
      }
    },
  });
  return firstDeliveredMessageId;
}

async function sendPendingFollowUpText(params: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  chunkText: ChunkTextFn;
  text: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  linkPreview?: boolean;
  silent?: boolean;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<void> {
  const chunks = filterEmptyTelegramTextChunks(params.chunkText(params.text));
  await sendChunkedTelegramReplyText({
    chunks,
    markDelivered,
    progress: params.progress,
    replyMarkup: params.replyMarkup,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    sendChunk: async ({ chunk, replyToMessageId, replyMarkup }) => {
      await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
        linkPreview: params.linkPreview,
        plainText: chunk.text,
        replyMarkup,
        replyToMessageId,
        silent: params.silent,
        textMode: "html",
        thread: params.thread,
      });
    },
  });
}

function isVoiceMessagesForbidden(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return VOICE_FORBIDDEN_RE.test(err.description);
  }
  return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}

function isCaptionTooLong(err: unknown): boolean {
  if (GrammyErrorCtor && err instanceof GrammyErrorCtor) {
    return CAPTION_TOO_LONG_RE.test(err.description);
  }
  return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}

async function sendTelegramVoiceFallbackText(opts: {
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  text: string;
  chunkText: (markdown: string) => ReturnType<typeof markdownToTelegramChunks>;
  replyToId?: number;
  thread?: TelegramThreadSpec | null;
  linkPreview?: boolean;
  silent?: boolean;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyQuoteText?: string;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  const chunks = filterEmptyTelegramTextChunks(opts.chunkText(opts.text));
  let appliedReplyTo = false;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    // Only apply reply reference, quote text, and buttons to the first chunk.
    const replyToForChunk = !appliedReplyTo ? opts.replyToId : undefined;
    const messageId = await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
      linkPreview: opts.linkPreview,
      plainText: chunk.text,
      replyMarkup: !appliedReplyTo ? opts.replyMarkup : undefined,
      replyQuoteText: !appliedReplyTo ? opts.replyQuoteText : undefined,
      replyToMessageId: replyToForChunk,
      silent: opts.silent,
      textMode: "html",
      thread: opts.thread,
    });
    if (firstDeliveredMessageId == null) {
      firstDeliveredMessageId = messageId;
    }
    if (replyToForChunk) {
      appliedReplyTo = true;
    }
  }
  return firstDeliveredMessageId;
}

async function deliverMediaReply(params: {
  reply: ReplyPayload;
  mediaList: string[];
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  mediaLocalRoots?: readonly string[];
  chunkText: ChunkTextFn;
  mediaLoader: typeof loadWebMedia;
  onVoiceRecording?: () => Promise<void> | void;
  linkPreview?: boolean;
  silent?: boolean;
  replyQuoteText?: string;
  replyMarkup?: ReturnType<typeof buildInlineKeyboard>;
  replyToId?: number;
  replyToMode: ReplyToMode;
  progress: DeliveryProgress;
}): Promise<number | undefined> {
  let firstDeliveredMessageId: number | undefined;
  let first = true;
  let pendingFollowUpText: string | undefined;
  for (const mediaUrl of params.mediaList) {
    const isFirstMedia = first;
    const media = await params.mediaLoader(
      mediaUrl,
      buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots }),
    );
    const kind = kindFromMime(media.contentType ?? undefined);
    const isGif = isGifMedia({
      contentType: media.contentType,
      fileName: media.fileName,
    });
    const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
    const file = new InputFile(media.buffer, fileName);
    const { caption, followUpText } = splitTelegramCaption(
      isFirstMedia ? (params.reply.text ?? undefined) : undefined,
    );
    const htmlCaption = caption
      ? renderTelegramHtmlText(caption, { tableMode: params.tableMode })
      : undefined;
    if (followUpText) {
      pendingFollowUpText = followUpText;
    }
    first = false;
    const replyToMessageId = resolveReplyToForSend({
      progress: params.progress,
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
    });
    const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
    const mediaParams: Record<string, unknown> = {
      caption: htmlCaption,
      ...(htmlCaption ? { parse_mode: "HTML" } : {}),
      ...(shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {}),
      ...buildTelegramSendParams({
        replyToMessageId,
        silent: params.silent,
        thread: params.thread,
      }),
    };
    if (isGif) {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendAnimation",
        requestParams: mediaParams,
        runtime: params.runtime,
        send: (effectiveParams) =>
          params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams }),
        thread: params.thread,
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "image") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendPhoto",
        requestParams: mediaParams,
        runtime: params.runtime,
        send: (effectiveParams) =>
          params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams }),
        thread: params.thread,
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "video") {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendVideo",
        requestParams: mediaParams,
        runtime: params.runtime,
        send: (effectiveParams) =>
          params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams }),
        thread: params.thread,
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    } else if (kind === "audio") {
      const { useVoice } = resolveTelegramVoiceSend({
        contentType: media.contentType,
        fileName,
        logFallback: logVerbose,
        wantsVoice: params.reply.audioAsVoice === true,
      });
      if (useVoice) {
        const sendVoiceMedia = async (
          requestParams: typeof mediaParams,
          shouldLog?: (err: unknown) => boolean,
        ) => {
          const result = await sendTelegramWithThreadFallback({
            operation: "sendVoice",
            requestParams,
            runtime: params.runtime,
            send: (effectiveParams) =>
              params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams }),
            shouldLog,
            thread: params.thread,
          });
          if (firstDeliveredMessageId == null) {
            firstDeliveredMessageId = result.message_id;
          }
          markDelivered(params.progress);
        };
        await params.onVoiceRecording?.();
        try {
          await sendVoiceMedia(mediaParams, (err) => !isVoiceMessagesForbidden(err));
        } catch (error) {
          if (isVoiceMessagesForbidden(error)) {
            const fallbackText = params.reply.text;
            if (!fallbackText || !fallbackText.trim()) {
              throw error;
            }
            logVerbose(
              "telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text",
            );
            const voiceFallbackReplyTo = resolveReplyToForSend({
              progress: params.progress,
              replyToId: params.replyToId,
              replyToMode: params.replyToMode,
            });
            const fallbackMessageId = await sendTelegramVoiceFallbackText({
              bot: params.bot,
              chatId: params.chatId,
              chunkText: params.chunkText,
              linkPreview: params.linkPreview,
              replyMarkup: params.replyMarkup,
              replyQuoteText: params.replyQuoteText,
              replyToId: voiceFallbackReplyTo,
              runtime: params.runtime,
              silent: params.silent,
              text: fallbackText,
              thread: params.thread,
            });
            if (firstDeliveredMessageId == null) {
              firstDeliveredMessageId = fallbackMessageId;
            }
            markReplyApplied(params.progress, voiceFallbackReplyTo);
            markDelivered(params.progress);
            continue;
          }
          if (isCaptionTooLong(error)) {
            logVerbose(
              "telegram sendVoice caption too long; resending voice without caption + text separately",
            );
            const noCaptionParams = { ...mediaParams };
            delete noCaptionParams.caption;
            delete noCaptionParams.parse_mode;
            await sendVoiceMedia(noCaptionParams);
            const fallbackText = params.reply.text;
            if (fallbackText?.trim()) {
              await sendTelegramVoiceFallbackText({
                bot: params.bot,
                chatId: params.chatId,
                chunkText: params.chunkText,
                linkPreview: params.linkPreview,
                replyMarkup: params.replyMarkup,
                replyToId: undefined,
                runtime: params.runtime,
                silent: params.silent,
                text: fallbackText,
                thread: params.thread,
              });
            }
            markReplyApplied(params.progress, replyToMessageId);
            continue;
          }
          throw error;
        }
      } else {
        const result = await sendTelegramWithThreadFallback({
          operation: "sendAudio",
          requestParams: mediaParams,
          runtime: params.runtime,
          send: (effectiveParams) =>
            params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams }),
          thread: params.thread,
        });
        if (firstDeliveredMessageId == null) {
          firstDeliveredMessageId = result.message_id;
        }
        markDelivered(params.progress);
      }
    } else {
      const result = await sendTelegramWithThreadFallback({
        operation: "sendDocument",
        requestParams: mediaParams,
        runtime: params.runtime,
        send: (effectiveParams) =>
          params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams }),
        thread: params.thread,
      });
      if (firstDeliveredMessageId == null) {
        firstDeliveredMessageId = result.message_id;
      }
      markDelivered(params.progress);
    }
    markReplyApplied(params.progress, replyToMessageId);
    if (pendingFollowUpText && isFirstMedia) {
      await sendPendingFollowUpText({
        bot: params.bot,
        chatId: params.chatId,
        chunkText: params.chunkText,
        linkPreview: params.linkPreview,
        progress: params.progress,
        replyMarkup: params.replyMarkup,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        runtime: params.runtime,
        silent: params.silent,
        text: pendingFollowUpText,
        thread: params.thread,
      });
      pendingFollowUpText = undefined;
    }
  }
  return firstDeliveredMessageId;
}

async function maybePinFirstDeliveredMessage(params: {
  shouldPin: boolean;
  bot: Bot;
  chatId: string;
  runtime: RuntimeEnv;
  firstDeliveredMessageId?: number;
}): Promise<void> {
  if (!params.shouldPin || typeof params.firstDeliveredMessageId !== "number") {
    return;
  }
  try {
    await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, {
      disable_notification: true,
    });
  } catch (error) {
    logVerbose(
      `telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(error)}`,
    );
  }
}

interface EmitMessageSentHookParams {
  sessionKeyForInternalHooks?: string;
  chatId: string;
  accountId?: string;
  content: string;
  success: boolean;
  error?: string;
  messageId?: number;
  isGroup?: boolean;
  groupId?: string;
}

function buildTelegramSentHookContext(params: EmitMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    accountId: params.accountId,
    channelId: "telegram",
    content: params.content,
    conversationId: params.chatId,
    error: params.error,
    groupId: params.groupId,
    isGroup: params.isGroup,
    messageId: typeof params.messageId === "number" ? String(params.messageId) : undefined,
    success: params.success,
    to: params.chatId,
  });
}

export function emitInternalMessageSentHook(params: EmitMessageSentHookParams): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildTelegramSentHookContext(params);
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "telegram: message:sent internal hook failed",
  );
}

function emitMessageSentHooks(
  params: EmitMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildTelegramSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "telegram: message_sent plugin hook failed",
    );
  }
  emitInternalMessageSentHook(params);
}

export function emitTelegramMessageSentHooks(params: EmitMessageSentHookParams): void {
  const hookRunner = getGlobalHookRunner();
  emitMessageSentHooks({
    ...params,
    enabled: hookRunner?.hasHooks("message_sent") ?? false,
    hookRunner,
  });
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  chatId: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
  token: string;
  runtime: RuntimeEnv;
  bot: Bot;
  mediaLocalRoots?: readonly string[];
  replyToMode: ReplyToMode;
  textLimit: number;
  thread?: TelegramThreadSpec | null;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  /** Callback invoked before sending a voice message to switch typing indicator. */
  onVoiceRecording?: () => Promise<void> | void;
  /** Controls whether link previews are shown. Default: true (previews enabled). */
  linkPreview?: boolean;
  /** When true, messages are sent with disable_notification. */
  silent?: boolean;
  /** Optional quote text for Telegram reply_parameters. */
  replyQuoteText?: string;
  /** Override media loader (tests). */
  mediaLoader?: typeof loadWebMedia;
}): Promise<{ delivered: boolean }> {
  const progress: DeliveryProgress = {
    deliveredCount: 0,
    hasDelivered: false,
    hasReplied: false,
  };
  const mediaLoader = params.mediaLoader ?? loadWebMedia;
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
  const chunkText = buildChunkTextResolver({
    chunkMode: params.chunkMode ?? "length",
    tableMode: params.tableMode,
    textLimit: params.textLimit,
  });
  for (const originalReply of params.replies) {
    let reply = originalReply;
    const mediaList = reply?.mediaUrls?.length
      ? reply.mediaUrls
      : reply?.mediaUrl
        ? [reply.mediaUrl]
        : [];
    const hasMedia = mediaList.length > 0;
    if (!reply?.text && !hasMedia) {
      if (reply?.audioAsVoice) {
        logVerbose("telegram reply has audioAsVoice without media/text; skipping");
        continue;
      }
      params.runtime.error?.(danger("reply missing text/media"));
      continue;
    }

    const rawContent = reply.text || "";
    if (hasMessageSendingHooks) {
      const hookResult = await hookRunner?.runMessageSending(
        {
          content: rawContent,
          metadata: {
            channel: "telegram",
            mediaUrls: mediaList,
            threadId: params.thread?.id,
          },
          to: params.chatId,
        },
        {
          accountId: params.accountId,
          channelId: "telegram",
          conversationId: params.chatId,
        },
      );
      if (hookResult?.cancel) {
        continue;
      }
      if (typeof hookResult?.content === "string" && hookResult.content !== rawContent) {
        reply = { ...reply, text: hookResult.content };
      }
    }

    const contentForSentHook = reply.text || "";

    try {
      const deliveredCountBeforeReply = progress.deliveredCount;
      const replyToId =
        params.replyToMode === "off" ? undefined : resolveTelegramReplyId(reply.replyToId);
      const telegramData = reply.channelData?.telegram as TelegramReplyChannelData | undefined;
      const shouldPinFirstMessage = telegramData?.pin === true;
      const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
      let firstDeliveredMessageId: number | undefined;
      if (mediaList.length === 0) {
        firstDeliveredMessageId = await deliverTextReply({
          bot: params.bot,
          chatId: params.chatId,
          chunkText,
          linkPreview: params.linkPreview,
          progress,
          replyMarkup,
          replyQuoteText: params.replyQuoteText,
          replyText: reply.text || "",
          replyToId,
          replyToMode: params.replyToMode,
          runtime: params.runtime,
          silent: params.silent,
          thread: params.thread,
        });
      } else {
        firstDeliveredMessageId = await deliverMediaReply({
          bot: params.bot,
          chatId: params.chatId,
          chunkText,
          linkPreview: params.linkPreview,
          mediaList,
          mediaLoader,
          mediaLocalRoots: params.mediaLocalRoots,
          onVoiceRecording: params.onVoiceRecording,
          progress,
          reply,
          replyMarkup,
          replyQuoteText: params.replyQuoteText,
          replyToId,
          replyToMode: params.replyToMode,
          runtime: params.runtime,
          silent: params.silent,
          tableMode: params.tableMode,
          thread: params.thread,
        });
      }
      await maybePinFirstDeliveredMessage({
        bot: params.bot,
        chatId: params.chatId,
        firstDeliveredMessageId,
        runtime: params.runtime,
        shouldPin: shouldPinFirstMessage,
      });

      emitMessageSentHooks({
        accountId: params.accountId,
        chatId: params.chatId,
        content: contentForSentHook,
        enabled: hasMessageSentHooks,
        groupId: params.mirrorGroupId,
        hookRunner,
        isGroup: params.mirrorIsGroup,
        messageId: firstDeliveredMessageId,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        success: progress.deliveredCount > deliveredCountBeforeReply,
      });
    } catch (error) {
      emitMessageSentHooks({
        accountId: params.accountId,
        chatId: params.chatId,
        content: contentForSentHook,
        enabled: hasMessageSentHooks,
        error: formatErrorMessage(error),
        groupId: params.mirrorGroupId,
        hookRunner,
        isGroup: params.mirrorIsGroup,
        sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
        success: false,
      });
      throw error;
    }
  }

  return { delivered: progress.hasDelivered };
}
