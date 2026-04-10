import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveZaloAccount } from "./accounts.js";
import type { ZaloFetch } from "./api.js";
import { sendMessage, sendPhoto } from "./api.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import { resolveZaloToken } from "./token.js";

export interface ZaloSendOptions {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  mediaUrl?: string;
  caption?: string;
  verbose?: boolean;
  proxy?: string;
}

export interface ZaloSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

function toZaloSendResult(response: {
  ok?: boolean;
  result?: { message_id?: string };
}): ZaloSendResult {
  if (response.ok && response.result) {
    return { messageId: response.result.message_id, ok: true };
  }
  return { error: "Failed to send message", ok: false };
}

async function runZaloSend(
  failureMessage: string,
  send: () => Promise<{ ok?: boolean; result?: { message_id?: string } }>,
): Promise<ZaloSendResult> {
  try {
    const result = toZaloSendResult(await send());
    return result.ok ? result : { error: failureMessage, ok: false };
  } catch (error) {
    return { error: formatErrorMessage(error), ok: false };
  }
}

function resolveSendContext(options: ZaloSendOptions): {
  token: string;
  fetcher?: ZaloFetch;
} {
  if (options.cfg) {
    const account = resolveZaloAccount({
      accountId: options.accountId,
      cfg: options.cfg,
    });
    const token = options.token || account.token;
    const proxy = options.proxy ?? account.config.proxy;
    return { fetcher: resolveZaloProxyFetch(proxy), token };
  }

  const token = options.token ?? resolveZaloToken(undefined, options.accountId).token;
  const {proxy} = options;
  return { fetcher: resolveZaloProxyFetch(proxy), token };
}

function resolveValidatedSendContext(
  chatId: string,
  options: ZaloSendOptions,
): { ok: true; chatId: string; token: string; fetcher?: ZaloFetch } | { ok: false; error: string } {
  const { token, fetcher } = resolveSendContext(options);
  if (!token) {
    return { error: "No Zalo bot token configured", ok: false };
  }
  const trimmedChatId = chatId?.trim();
  if (!trimmedChatId) {
    return { error: "No chat_id provided", ok: false };
  }
  return { chatId: trimmedChatId, fetcher, ok: true, token };
}

function resolveSendContextOrFailure(
  chatId: string,
  options: ZaloSendOptions,
):
  | { context: { chatId: string; token: string; fetcher?: ZaloFetch } }
  | { failure: ZaloSendResult } {
  const context = resolveValidatedSendContext(chatId, options);
  return context.ok
    ? { context }
    : {
        failure: { error: context.error, ok: false },
      };
}

export async function sendMessageZalo(
  chatId: string,
  text: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const resolved = resolveSendContextOrFailure(chatId, options);
  if ("failure" in resolved) {
    return resolved.failure;
  }
  const { context } = resolved;

  if (options.mediaUrl) {
    return sendPhotoZalo(context.chatId, options.mediaUrl, {
      ...options,
      caption: text || options.caption,
      token: context.token,
    });
  }

  return await runZaloSend("Failed to send message", () =>
    sendMessage(
      context.token,
      {
        chat_id: context.chatId,
        text: text.slice(0, 2000),
      },
      context.fetcher,
    ),
  );
}

export async function sendPhotoZalo(
  chatId: string,
  photoUrl: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const resolved = resolveSendContextOrFailure(chatId, options);
  if ("failure" in resolved) {
    return resolved.failure;
  }
  const { context } = resolved;

  if (!photoUrl?.trim()) {
    return { error: "No photo URL provided", ok: false };
  }

  return await runZaloSend("Failed to send photo", () =>
    sendPhoto(
      context.token,
      {
        caption: options.caption?.slice(0, 2000),
        chat_id: context.chatId,
        photo: photoUrl.trim(),
      },
      context.fetcher,
    ),
  );
}
