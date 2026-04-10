import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;

export interface DiscordDraftStream {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
}

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const { minInitialChars } = params;
  const { channelId } = params;
  const { rest } = params;
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  const streamState = { final: false, stopped: false };
  let streamMessageId: string | undefined;
  let lastSentText = "";

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Discord messages cap at 2000 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (streamMessageId === undefined && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (streamMessageId !== undefined) {
        // Edit existing message
        await rest.patch(Routes.channelMessage(channelId, streamMessageId), {
          body: { content: trimmed },
        });
        return true;
      }
      // Send new message
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { fail_if_not_exists: false, message_id: replyToMessageId }
        : undefined;
      const sent = (await rest.post(Routes.channelMessages(channelId), {
        body: {
          content: trimmed,
          ...(messageReference ? { message_reference: messageReference } : {}),
        },
      })) as { id?: string } | undefined;
      const sentMessageId = sent?.id;
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        streamState.stopped = true;
        params.warn?.("discord stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sentMessageId;
      return true;
    } catch (error) {
      streamState.stopped = true;
      params.warn?.(`discord stream preview failed: ${formatErrorMessage(error)}`);
      return false;
    }
  };

  const readMessageId = () => streamMessageId;
  const clearMessageId = () => {
    streamMessageId = undefined;
  };
  const isValidStreamMessageId = (value: unknown): value is string => typeof value === "string";
  const deleteStreamMessage = async (messageId: string) => {
    await rest.delete(Routes.channelMessage(channelId, messageId));
  };

  const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
    clearMessageId,
    deleteMessage: deleteStreamMessage,
    isValidMessageId: isValidStreamMessageId,
    readMessageId,
    sendOrEditStreamMessage,
    state: streamState,
    throttleMs,
    warn: params.warn,
    warnPrefix: "discord stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    clear,
    flush: loop.flush,
    forceNewMessage,
    messageId: () => streamMessageId,
    stop,
    update,
  };
}
