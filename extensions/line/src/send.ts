import { messagingApi } from "@line/bot-sdk";
import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { resolveLineChannelAccessToken } from "./channel-access-token.js";
import type { LineSendResult } from "./types.js";

type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type ImageMessage = messagingApi.ImageMessage;
type VideoMessage = messagingApi.VideoMessage & { trackingId?: string };
type AudioMessage = messagingApi.AudioMessage;
type LocationMessage = messagingApi.LocationMessage;
type FlexMessage = messagingApi.FlexMessage;
type FlexContainer = messagingApi.FlexContainer;
type TemplateMessage = messagingApi.TemplateMessage;
type QuickReply = messagingApi.QuickReply;
type QuickReplyItem = messagingApi.QuickReplyItem;

const userProfileCache = new Map<
  string,
  { displayName: string; pictureUrl?: string; fetchedAt: number }
>();
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

interface LineSendOpts {
  cfg?: OpenClawConfig;
  channelAccessToken?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaKind?: "image" | "video" | "audio";
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
  replyToken?: string;
}

type LineClientOpts = Pick<LineSendOpts, "cfg" | "channelAccessToken" | "accountId">;
type LinePushOpts = Pick<LineSendOpts, "cfg" | "channelAccessToken" | "accountId" | "verbose">;

interface LinePushBehavior {
  errorContext?: string;
  verboseMessage?: (chatId: string, messageCount: number) => string;
}

interface LineReplyBehavior {
  verboseMessage?: (messageCount: number) => string;
}

function normalizeTarget(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for LINE sends");
  }

  const normalized = trimmed
    .replace(/^line:group:/i, "")
    .replace(/^line:room:/i, "")
    .replace(/^line:user:/i, "")
    .replace(/^line:/i, "");

  if (!normalized) {
    throw new Error("Recipient is required for LINE sends");
  }

  return normalized;
}

function isLineUserChatId(chatId: string): boolean {
  return /^U/i.test(chatId);
}

function createLineMessagingClient(opts: LineClientOpts): {
  account: ReturnType<typeof resolveLineAccount>;
  client: messagingApi.MessagingApiClient;
} {
  const cfg = opts.cfg ?? loadConfig();
  const account = resolveLineAccount({
    accountId: opts.accountId,
    cfg,
  });
  const token = resolveLineChannelAccessToken(opts.channelAccessToken, account);
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });
  return { account, client };
}

function createLinePushContext(
  to: string,
  opts: LineClientOpts,
): {
  account: ReturnType<typeof resolveLineAccount>;
  client: messagingApi.MessagingApiClient;
  chatId: string;
} {
  const { account, client } = createLineMessagingClient(opts);
  const chatId = normalizeTarget(to);
  return { account, chatId, client };
}

function createTextMessage(text: string): TextMessage {
  return { text, type: "text" };
}

export function createImageMessage(
  originalContentUrl: string,
  previewImageUrl?: string,
): ImageMessage {
  return {
    originalContentUrl,
    previewImageUrl: previewImageUrl ?? originalContentUrl,
    type: "image",
  };
}

export function createVideoMessage(
  originalContentUrl: string,
  previewImageUrl: string,
  trackingId?: string,
): VideoMessage {
  return {
    originalContentUrl,
    previewImageUrl,
    type: "video",
    ...(trackingId ? { trackingId } : {}),
  };
}

export function createAudioMessage(originalContentUrl: string, durationMs: number): AudioMessage {
  return {
    duration: durationMs,
    originalContentUrl,
    type: "audio",
  };
}

export function createLocationMessage(location: {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}): LocationMessage {
  return {
    address: location.address.slice(0, 100),
    latitude: location.latitude,
    longitude: location.longitude,
    title: location.title.slice(0, 100),
    type: "location",
  };
}

function logLineHttpError(err: unknown, context: string): void {
  if (!err || typeof err !== "object") {
    return;
  }
  const { status, statusText, body } = err as {
    status?: number;
    statusText?: string;
    body?: string;
  };
  if (typeof body === "string") {
    const summary = status ? `${status} ${statusText ?? ""}`.trim() : "unknown status";
    logVerbose(`line: ${context} failed (${summary}): ${body}`);
  }
}

function recordLineOutboundActivity(accountId: string): void {
  recordChannelActivity({
    accountId,
    channel: "line",
    direction: "outbound",
  });
}

async function pushLineMessages(
  to: string,
  messages: Message[],
  opts: LinePushOpts = {},
  behavior: LinePushBehavior = {},
): Promise<LineSendResult> {
  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  const { account, client, chatId } = createLinePushContext(to, opts);
  const pushRequest = client.pushMessage({
    messages,
    to: chatId,
  });

  if (behavior.errorContext) {
    await pushRequest.catch((error) => {
      logLineHttpError(error, behavior.errorContext!);
      throw error;
    });
  } else {
    await pushRequest;
  }

  recordLineOutboundActivity(account.accountId);

  if (opts.verbose) {
    const logMessage =
      behavior.verboseMessage?.(chatId, messages.length) ??
      `line: pushed ${messages.length} messages to ${chatId}`;
    logVerbose(logMessage);
  }

  return {
    chatId,
    messageId: "push",
  };
}

async function replyLineMessages(
  replyToken: string,
  messages: Message[],
  opts: LinePushOpts = {},
  behavior: LineReplyBehavior = {},
): Promise<void> {
  const { account, client } = createLineMessagingClient(opts);

  await client.replyMessage({
    messages,
    replyToken,
  });

  recordLineOutboundActivity(account.accountId);

  if (opts.verbose) {
    logVerbose(
      behavior.verboseMessage?.(messages.length) ??
        `line: replied with ${messages.length} messages`,
    );
  }
}

export async function sendMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts = {},
): Promise<LineSendResult> {
  const chatId = normalizeTarget(to);
  const messages: Message[] = [];

  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    switch (opts.mediaKind) {
      case "video": {
        const previewImageUrl = opts.previewImageUrl?.trim();
        if (!previewImageUrl) {
          throw new Error("LINE video messages require previewImageUrl to reference an image URL");
        }
        const trackingId = isLineUserChatId(chatId) ? opts.trackingId : undefined;
        messages.push(createVideoMessage(mediaUrl, previewImageUrl, trackingId));
        break;
      }
      case "audio": {
        messages.push(createAudioMessage(mediaUrl, opts.durationMs ?? 60_000));
        break;
      }
      case "image":
      default: {
        // Backward compatibility: keep image as default when media kind is unspecified.
        messages.push(createImageMessage(mediaUrl, opts.previewImageUrl?.trim() || mediaUrl));
        break;
      }
    }
  }

  if (text?.trim()) {
    messages.push(createTextMessage(text.trim()));
  }

  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  if (opts.replyToken) {
    await replyLineMessages(opts.replyToken, messages, opts, {
      verboseMessage: () => `line: replied to ${chatId}`,
    });

    return {
      chatId,
      messageId: "reply",
    };
  }

  return pushLineMessages(chatId, messages, opts, {
    verboseMessage: (resolvedChatId) => `line: pushed message to ${resolvedChatId}`,
  });
}

export async function pushMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts = {},
): Promise<LineSendResult> {
  return sendMessageLine(to, text, { ...opts, replyToken: undefined });
}

export async function replyMessageLine(
  replyToken: string,
  messages: Message[],
  opts: LinePushOpts = {},
): Promise<void> {
  await replyLineMessages(replyToken, messages, opts);
}

export async function pushMessagesLine(
  to: string,
  messages: Message[],
  opts: LinePushOpts = {},
): Promise<LineSendResult> {
  return pushLineMessages(to, messages, opts, {
    errorContext: "push message",
  });
}

export function createFlexMessage(
  altText: string,
  contents: messagingApi.FlexContainer,
): messagingApi.FlexMessage {
  return {
    altText,
    contents,
    type: "flex",
  };
}

export async function pushImageMessage(
  to: string,
  originalContentUrl: string,
  previewImageUrl?: string,
  opts: LinePushOpts = {},
): Promise<LineSendResult> {
  return pushLineMessages(to, [createImageMessage(originalContentUrl, previewImageUrl)], opts, {
    verboseMessage: (chatId) => `line: pushed image to ${chatId}`,
  });
}

export async function pushLocationMessage(
  to: string,
  location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  },
  opts: LinePushOpts = {},
): Promise<LineSendResult> {
  return pushLineMessages(to, [createLocationMessage(location)], opts, {
    verboseMessage: (chatId) => `line: pushed location to ${chatId}`,
  });
}

export async function pushFlexMessage(
  to: string,
  altText: string,
  contents: FlexContainer,
  opts: LinePushOpts = {},
): Promise<LineSendResult> {
  const flexMessage: FlexMessage = {
    altText: altText.slice(0, 400),
    contents,
    type: "flex",
  };

  return pushLineMessages(to, [flexMessage], opts, {
    errorContext: "push flex message",
    verboseMessage: (chatId) => `line: pushed flex message to ${chatId}`,
  });
}

export async function pushTemplateMessage(
  to: string,
  template: TemplateMessage,
  opts: LinePushOpts = {},
): Promise<LineSendResult> {
  return pushLineMessages(to, [template], opts, {
    verboseMessage: (chatId) => `line: pushed template message to ${chatId}`,
  });
}

export async function pushTextMessageWithQuickReplies(
  to: string,
  text: string,
  quickReplyLabels: string[],
  opts: LinePushOpts = {},
): Promise<LineSendResult> {
  const message = createTextMessageWithQuickReplies(text, quickReplyLabels);

  return pushLineMessages(to, [message], opts, {
    verboseMessage: (chatId) => `line: pushed message with quick replies to ${chatId}`,
  });
}

export function createQuickReplyItems(labels: string[]): QuickReply {
  const items: QuickReplyItem[] = labels.slice(0, 13).map((label) => ({
    action: {
      label: label.slice(0, 20),
      text: label,
      type: "message",
    },
    type: "action",
  }));
  return { items };
}

export function createTextMessageWithQuickReplies(
  text: string,
  quickReplyLabels: string[],
): TextMessage & { quickReply: QuickReply } {
  return {
    quickReply: createQuickReplyItems(quickReplyLabels),
    text,
    type: "text",
  };
}

export async function showLoadingAnimation(
  chatId: string,
  opts: { channelAccessToken?: string; accountId?: string; loadingSeconds?: number } = {},
): Promise<void> {
  const { client } = createLineMessagingClient(opts);

  try {
    await client.showLoadingAnimation({
      chatId: normalizeTarget(chatId),
      loadingSeconds: opts.loadingSeconds ?? 20,
    });
    logVerbose(`line: showing loading animation to ${chatId}`);
  } catch (error) {
    logVerbose(`line: loading animation failed (non-fatal): ${String(error)}`);
  }
}

export async function getUserProfile(
  userId: string,
  opts: { channelAccessToken?: string; accountId?: string; useCache?: boolean } = {},
): Promise<{ displayName: string; pictureUrl?: string } | null> {
  const useCache = opts.useCache ?? true;

  if (useCache) {
    const cached = userProfileCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
      return { displayName: cached.displayName, pictureUrl: cached.pictureUrl };
    }
  }

  const { client } = createLineMessagingClient(opts);

  try {
    const profile = await client.getProfile(userId);
    const result = {
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
    };

    userProfileCache.set(userId, {
      ...result,
      fetchedAt: Date.now(),
    });

    return result;
  } catch (error) {
    logVerbose(`line: failed to fetch profile for ${userId}: ${String(error)}`);
    return null;
  }
}

export async function getUserDisplayName(
  userId: string,
  opts: { channelAccessToken?: string; accountId?: string } = {},
): Promise<string> {
  const profile = await getUserProfile(userId, opts);
  return profile?.displayName ?? userId;
}
