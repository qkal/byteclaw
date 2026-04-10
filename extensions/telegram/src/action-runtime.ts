import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
  resolvePollMaxSelections,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { createTelegramActionGate, resolveTelegramPollActionGateState } from "./accounts.js";
import {
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  fitsTelegramCallbackData,
} from "./approval-callback-data.js";
import type { TelegramButtonStyle, TelegramInlineButtons } from "./button-types.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import {
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "./inline-buttons.js";
import { resolveTelegramPollVisibility } from "./poll-visibility.js";
import { resolveTelegramReactionLevel } from "./reaction-level.js";
import {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageTelegram,
  reactMessageTelegram,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
} from "./send.js";
import { getCacheStats, searchStickers } from "./sticker-cache.js";
import { resolveTelegramToken } from "./token.js";

export const telegramActionRuntime = {
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageTelegram,
  getCacheStats,
  reactMessageTelegram,
  searchStickers,
  sendMessageTelegram,
  sendPollTelegram,
  sendStickerTelegram,
};

const TELEGRAM_BUTTON_STYLES: readonly TelegramButtonStyle[] = ["danger", "success", "primary"];
const TELEGRAM_FORUM_TOPIC_ICON_COLORS = [
  0x6F_B9_F0, 0xFF_D6_7E, 0xCB_86_DB, 0x8E_EE_98, 0xFF_93_B2, 0xFB_6F_5F,
] as const;
const TELEGRAM_ACTION_ALIASES = {
  createForumTopic: "createForumTopic",
  delete: "deleteMessage",
  deleteMessage: "deleteMessage",
  edit: "editMessage",
  editForumTopic: "editForumTopic",
  editMessage: "editMessage",
  poll: "poll",
  react: "react",
  searchSticker: "searchSticker",
  send: "sendMessage",
  sendMessage: "sendMessage",
  sendSticker: "sendSticker",
  sticker: "sendSticker",
  "sticker-search": "searchSticker",
  stickerCacheStats: "stickerCacheStats",
  "topic-create": "createForumTopic",
  "topic-edit": "editForumTopic",
} as const;

type TelegramActionName = (typeof TELEGRAM_ACTION_ALIASES)[keyof typeof TELEGRAM_ACTION_ALIASES];
type TelegramForumTopicIconColor = (typeof TELEGRAM_FORUM_TOPIC_ICON_COLORS)[number];
interface RawTelegramButton {
  callback_data?: unknown;
  style?: unknown;
  text?: unknown;
}

function readTelegramForumTopicIconColor(
  params: Record<string, unknown>,
): TelegramForumTopicIconColor | undefined {
  const iconColor = readNumberParam(params, "iconColor", { integer: true });
  if (iconColor == null) {
    return undefined;
  }
  if (!TELEGRAM_FORUM_TOPIC_ICON_COLORS.includes(iconColor as TelegramForumTopicIconColor)) {
    throw new Error("iconColor must be one of Telegram's supported forum topic colors.");
  }
  return iconColor as TelegramForumTopicIconColor;
}
export function readTelegramButtons(
  params: Record<string, unknown>,
): TelegramInlineButtons | undefined {
  const raw = params.buttons;
  if (raw == null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("buttons must be an array of button rows");
  }
  const rows = raw.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(`buttons[${rowIndex}] must be an array`);
    }
    return row.map((button, buttonIndex) => {
      if (!button || typeof button !== "object") {
        throw new Error(`buttons[${rowIndex}][${buttonIndex}] must be an object`);
      }
      const rawButton = button as RawTelegramButton;
      const text = normalizeOptionalString(rawButton.text) ?? "";
      const callbackData = normalizeOptionalString(rawButton.callback_data) ?? "";
      if (!text || !callbackData) {
        throw new Error(`buttons[${rowIndex}][${buttonIndex}] requires text and callback_data`);
      }
      if (!fitsTelegramCallbackData(callbackData)) {
        throw new Error(
          `buttons[${rowIndex}][${buttonIndex}] callback_data too long (max ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes)`,
        );
      }
      const styleRaw = rawButton.style;
      const style = normalizeOptionalLowercaseString(styleRaw);
      if (styleRaw !== undefined && !style) {
        throw new Error(`buttons[${rowIndex}][${buttonIndex}] style must be string`);
      }
      if (style && !TELEGRAM_BUTTON_STYLES.includes(style as TelegramButtonStyle)) {
        throw new Error(
          `buttons[${rowIndex}][${buttonIndex}] style must be one of ${TELEGRAM_BUTTON_STYLES.join(", ")}`,
        );
      }
      return {
        callback_data: callbackData,
        text,
        ...(style ? { style: style as TelegramButtonStyle } : {}),
      };
    });
  });
  const filtered = rows.filter((row) => row.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}

function normalizeTelegramActionName(action: string): TelegramActionName {
  const normalized = TELEGRAM_ACTION_ALIASES[action as keyof typeof TELEGRAM_ACTION_ALIASES];
  if (!normalized) {
    throw new Error(`Unsupported Telegram action: ${action}`);
  }
  return normalized;
}

function readTelegramChatId(params: Record<string, unknown>) {
  return (
    readStringOrNumberParam(params, "chatId") ??
    readStringOrNumberParam(params, "channelId") ??
    readStringOrNumberParam(params, "to", { required: true })
  );
}

function readTelegramThreadId(params: Record<string, unknown>) {
  return (
    readNumberParam(params, "messageThreadId", { integer: true }) ??
    readNumberParam(params, "threadId", { integer: true })
  );
}

function readTelegramReplyToMessageId(params: Record<string, unknown>) {
  return (
    readNumberParam(params, "replyToMessageId", { integer: true }) ??
    readNumberParam(params, "replyTo", { integer: true })
  );
}

function resolveTelegramButtonsFromParams(params: Record<string, unknown>) {
  return resolveTelegramInlineButtons({
    buttons: readTelegramButtons(params),
    interactive: params.interactive,
  });
}

function readTelegramSendContent(params: {
  args: Record<string, unknown>;
  mediaUrl?: string;
  hasButtons: boolean;
}) {
  const content =
    readStringParam(params.args, "content", { allowEmpty: true }) ??
    readStringParam(params.args, "message", { allowEmpty: true }) ??
    readStringParam(params.args, "caption", { allowEmpty: true });
  if (content == null && !params.mediaUrl && !params.hasButtons) {
    throw new Error("content required.");
  }
  return content ?? "";
}

export async function handleTelegramAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  options?: {
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
  },
): Promise<AgentToolResult<unknown>> {
  const { action, accountId } = {
    accountId: readStringParam(params, "accountId"),
    action: normalizeTelegramActionName(readStringParam(params, "action", { required: true })),
  };
  const isActionEnabled = createTelegramActionGate({
    accountId,
    cfg,
  });

  if (action === "react") {
    // All react failures return soft results (jsonResult with ok:false) instead
    // Of throwing, because hard tool errors can trigger model re-generation
    // Loops and duplicate content.
    const reactionLevelInfo = resolveTelegramReactionLevel({
      accountId: accountId ?? undefined,
      cfg,
    });
    if (!reactionLevelInfo.agentReactionsEnabled) {
      return jsonResult({
        hint: `Telegram agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). Do not retry.`,
        ok: false,
        reason: "disabled",
      });
    }
    if (!isActionEnabled("reactions")) {
      return jsonResult({
        hint: "Telegram reactions are disabled via actions.reactions. Do not retry.",
        ok: false,
        reason: "disabled",
      });
    }
    const chatId = readTelegramChatId(params);
    const messageId =
      readNumberParam(params, "messageId", { integer: true }) ??
      resolveReactionMessageId({ args: params });
    if (typeof messageId !== "number" || !Number.isFinite(messageId) || messageId <= 0) {
      return jsonResult({
        hint: "Telegram reaction requires a valid messageId (or inbound context fallback). Do not retry.",
        ok: false,
        reason: "missing_message_id",
      });
    }
    const { emoji, remove, isEmpty } = readReactionParams(params, {
      removeErrorMessage: "Emoji is required to remove a Telegram reaction.",
    });
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      return jsonResult({
        hint: "Telegram bot token missing. Do not retry.",
        ok: false,
        reason: "missing_token",
      });
    }
    let reactionResult: Awaited<ReturnType<typeof telegramActionRuntime.reactMessageTelegram>>;
    try {
      reactionResult = await telegramActionRuntime.reactMessageTelegram(
        chatId ?? "",
        messageId ?? 0,
        emoji ?? "",
        {
          accountId: accountId ?? undefined,
          cfg,
          remove,
          token,
        },
      );
    } catch (error) {
      const isInvalid = String(error).includes("REACTION_INVALID");
      return jsonResult({
        emoji,
        hint: isInvalid
          ? "This emoji is not supported for Telegram reactions. Add it to your reaction disallow list so you do not try it again."
          : "Reaction failed. Do not retry.",
        ok: false,
        reason: isInvalid ? "REACTION_INVALID" : "error",
      });
    }
    if (!reactionResult.ok) {
      return jsonResult({
        ok: false,
        warning: reactionResult.warning,
        ...(remove || isEmpty ? { removed: true } : { added: emoji }),
      });
    }
    if (!remove && !isEmpty) {
      return jsonResult({ added: emoji, ok: true });
    }
    return jsonResult({ ok: true, removed: true });
  }

  if (action === "sendMessage") {
    if (!isActionEnabled("sendMessage")) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const mediaUrl =
      readStringParam(params, "mediaUrl") ??
      readStringParam(params, "media", {
        trim: false,
      });
    const buttons = resolveTelegramButtonsFromParams(params);
    const content = readTelegramSendContent({
      args: params,
      hasButtons: Array.isArray(buttons) && buttons.length > 0,
      mediaUrl: mediaUrl ?? undefined,
    });
    if (buttons) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        accountId: accountId ?? undefined,
        cfg,
      });
      if (inlineButtonsScope === "off") {
        throw new Error(
          'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
        );
      }
      if (inlineButtonsScope === "dm" || inlineButtonsScope === "group") {
        const targetType = resolveTelegramTargetChatType(to);
        if (targetType === "unknown") {
          throw new Error(
            `Telegram inline buttons require a numeric chat id when inlineButtons="${inlineButtonsScope}".`,
          );
        }
        if (inlineButtonsScope === "dm" && targetType !== "direct") {
          throw new Error('Telegram inline buttons are limited to DMs when inlineButtons="dm".');
        }
        if (inlineButtonsScope === "group" && targetType !== "group") {
          throw new Error(
            'Telegram inline buttons are limited to groups when inlineButtons="group".',
          );
        }
      }
    }
    // Optional threading parameters for forum topics and reply chains
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const quoteText = readStringParam(params, "quoteText");
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendMessageTelegram(to, content, {
      accountId: accountId ?? undefined,
      asVoice: readBooleanParam(params, "asVoice"),
      buttons,
      cfg,
      forceDocument:
        readBooleanParam(params, "forceDocument") ??
        readBooleanParam(params, "asDocument") ??
        false,
      mediaLocalRoots: options?.mediaLocalRoots,
      mediaReadFile: options?.mediaReadFile,
      mediaUrl: mediaUrl || undefined,
      messageThreadId: messageThreadId ?? undefined,
      quoteText: quoteText ?? undefined,
      replyToMessageId: replyToMessageId ?? undefined,
      silent: readBooleanParam(params, "silent"),
      token,
    });
    return jsonResult({
      chatId: result.chatId,
      messageId: result.messageId,
      ok: true,
    });
  }

  if (action === "poll") {
    const pollActionState = resolveTelegramPollActionGateState(isActionEnabled);
    if (!pollActionState.sendMessageEnabled) {
      throw new Error("Telegram sendMessage is disabled.");
    }
    if (!pollActionState.pollEnabled) {
      throw new Error("Telegram polls are disabled.");
    }
    const to = readStringParam(params, "to", { required: true });
    const question =
      readStringParam(params, "question") ??
      readStringParam(params, "pollQuestion", { required: true });
    const answers =
      readStringArrayParam(params, "answers") ??
      readStringArrayParam(params, "pollOption", { required: true });
    const allowMultiselect =
      readBooleanParam(params, "allowMultiselect") ?? readBooleanParam(params, "pollMulti");
    const durationSeconds =
      readNumberParam(params, "durationSeconds", { integer: true }) ??
      readNumberParam(params, "pollDurationSeconds", {
        integer: true,
        strict: true,
      });
    const durationHours =
      readNumberParam(params, "durationHours", { integer: true }) ??
      readNumberParam(params, "pollDurationHours", {
        integer: true,
        strict: true,
      });
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const isAnonymous =
      readBooleanParam(params, "isAnonymous") ??
      resolveTelegramPollVisibility({
        pollAnonymous: readBooleanParam(params, "pollAnonymous"),
        pollPublic: readBooleanParam(params, "pollPublic"),
      });
    const silent = readBooleanParam(params, "silent");
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendPollTelegram(
      to,
      {
        durationHours: durationHours ?? undefined,
        durationSeconds: durationSeconds ?? undefined,
        maxSelections: resolvePollMaxSelections(answers.length, allowMultiselect ?? false),
        options: answers,
        question,
      },
      {
        accountId: accountId ?? undefined,
        cfg,
        isAnonymous: isAnonymous ?? undefined,
        messageThreadId: messageThreadId ?? undefined,
        replyToMessageId: replyToMessageId ?? undefined,
        silent: silent ?? undefined,
        token,
      },
    );
    return jsonResult({
      chatId: result.chatId,
      messageId: result.messageId,
      ok: true,
      pollId: result.pollId,
    });
  }

  if (action === "deleteMessage") {
    if (!isActionEnabled("deleteMessage")) {
      throw new Error("Telegram deleteMessage is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageId = readNumberParam(params, "messageId", {
      integer: true,
      required: true,
    });
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    await telegramActionRuntime.deleteMessageTelegram(chatId ?? "", messageId ?? 0, {
      accountId: accountId ?? undefined,
      cfg,
      token,
    });
    return jsonResult({ deleted: true, ok: true });
  }

  if (action === "editMessage") {
    if (!isActionEnabled("editMessage")) {
      throw new Error("Telegram editMessage is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageId = readNumberParam(params, "messageId", {
      integer: true,
      required: true,
    });
    const content =
      readStringParam(params, "content", { allowEmpty: false }) ??
      readStringParam(params, "message", { allowEmpty: false, required: true });
    const buttons = resolveTelegramButtonsFromParams(params);
    if (buttons) {
      const inlineButtonsScope = resolveTelegramInlineButtonsScope({
        accountId: accountId ?? undefined,
        cfg,
      });
      if (inlineButtonsScope === "off") {
        throw new Error(
          'Telegram inline buttons are disabled. Set channels.telegram.capabilities.inlineButtons to "dm", "group", "all", or "allowlist".',
        );
      }
    }
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.editMessageTelegram(
      chatId ?? "",
      messageId ?? 0,
      content,
      {
        accountId: accountId ?? undefined,
        buttons,
        cfg,
        token,
      },
    );
    return jsonResult({
      chatId: result.chatId,
      messageId: result.messageId,
      ok: true,
    });
  }

  if (action === "sendSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const to =
      readStringParam(params, "to") ?? readStringParam(params, "target", { required: true });
    const fileId =
      readStringParam(params, "fileId") ?? readStringArrayParam(params, "stickerId")?.[0];
    if (!fileId) {
      throw new Error("fileId is required.");
    }
    const replyToMessageId = readTelegramReplyToMessageId(params);
    const messageThreadId = readTelegramThreadId(params);
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.sendStickerTelegram(to, fileId, {
      accountId: accountId ?? undefined,
      cfg,
      messageThreadId: messageThreadId ?? undefined,
      replyToMessageId: replyToMessageId ?? undefined,
      token,
    });
    return jsonResult({
      chatId: result.chatId,
      messageId: result.messageId,
      ok: true,
    });
  }

  if (action === "searchSticker") {
    if (!isActionEnabled("sticker", false)) {
      throw new Error(
        "Telegram sticker actions are disabled. Set channels.telegram.actions.sticker to true.",
      );
    }
    const query = readStringParam(params, "query", { required: true });
    const limit = readNumberParam(params, "limit", { integer: true }) ?? 5;
    const results = telegramActionRuntime.searchStickers(query, limit);
    return jsonResult({
      count: results.length,
      ok: true,
      stickers: results.map((s) => ({
        description: s.description,
        emoji: s.emoji,
        fileId: s.fileId,
        setName: s.setName,
      })),
    });
  }

  if (action === "stickerCacheStats") {
    const stats = telegramActionRuntime.getCacheStats();
    return jsonResult({ ok: true, ...stats });
  }

  if (action === "createForumTopic") {
    if (!isActionEnabled("createForumTopic")) {
      throw new Error("Telegram createForumTopic is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const name = readStringParam(params, "name", { required: true });
    const iconColor = readTelegramForumTopicIconColor(params);
    const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.createForumTopicTelegram(chatId ?? "", name, {
      accountId: accountId ?? undefined,
      cfg,
      iconColor,
      iconCustomEmojiId: iconCustomEmojiId ?? undefined,
      token,
    });
    return jsonResult({
      chatId: result.chatId,
      name: result.name,
      ok: true,
      topicId: result.topicId,
    });
  }

  if (action === "editForumTopic") {
    if (!isActionEnabled("editForumTopic")) {
      throw new Error("Telegram editForumTopic is disabled.");
    }
    const chatId = readTelegramChatId(params);
    const messageThreadId = readTelegramThreadId(params);
    if (typeof messageThreadId !== "number") {
      throw new Error("messageThreadId or threadId is required.");
    }
    const name = readStringParam(params, "name");
    const iconCustomEmojiId = readStringParam(params, "iconCustomEmojiId");
    const {token} = resolveTelegramToken(cfg, { accountId });
    if (!token) {
      throw new Error(
        "Telegram bot token missing. Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.",
      );
    }
    const result = await telegramActionRuntime.editForumTopicTelegram(
      chatId ?? "",
      messageThreadId,
      {
        accountId: accountId ?? undefined,
        cfg,
        iconCustomEmojiId: iconCustomEmojiId ?? undefined,
        name: name ?? undefined,
        token,
      },
    );
    return jsonResult(result);
  }

  throw new Error(`Unsupported Telegram action: ${String(action)}`);
}
