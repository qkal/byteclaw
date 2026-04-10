import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { DmPolicy } from "openclaw/plugin-sdk/config-runtime";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { type NormalizedAllowFrom, resolveSenderAllowMatch } from "./bot-access.js";
import { renderTelegramHtmlText } from "./format.js";

interface TelegramDmAccessLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

interface TelegramSenderIdentity {
  username: string;
  userId: string | null;
  candidateId: string;
  firstName?: string;
  lastName?: string;
}

function resolveTelegramSenderIdentity(msg: Message, chatId: number): TelegramSenderIdentity {
  const { from } = msg;
  const userId = from?.id != null ? String(from.id) : null;
  return {
    candidateId: userId ?? String(chatId),
    firstName: from?.first_name,
    lastName: from?.last_name,
    userId,
    username: from?.username ?? "",
  };
}

export async function enforceTelegramDmAccess(params: {
  isGroup: boolean;
  dmPolicy: DmPolicy;
  msg: Message;
  chatId: number;
  effectiveDmAllow: NormalizedAllowFrom;
  accountId: string;
  bot: Bot;
  logger: TelegramDmAccessLogger;
  upsertPairingRequest?: typeof upsertChannelPairingRequest;
}): Promise<boolean> {
  const {
    isGroup,
    dmPolicy,
    msg,
    chatId,
    effectiveDmAllow,
    accountId,
    bot,
    logger,
    upsertPairingRequest,
  } = params;
  if (isGroup) {
    return true;
  }
  if (dmPolicy === "disabled") {
    return false;
  }
  if (dmPolicy === "open") {
    return true;
  }

  const sender = resolveTelegramSenderIdentity(msg, chatId);
  const allowMatch = resolveSenderAllowMatch({
    allow: effectiveDmAllow,
    senderId: sender.candidateId,
    senderUsername: sender.username,
  });
  const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${
    allowMatch.matchSource ?? "none"
  }`;
  const allowed =
    effectiveDmAllow.hasWildcard || (effectiveDmAllow.hasEntries && allowMatch.allowed);
  if (allowed) {
    return true;
  }

  if (dmPolicy === "pairing") {
    try {
      const telegramUserId = sender.userId ?? sender.candidateId;
      await createChannelPairingChallengeIssuer({
        channel: "telegram",
        upsertPairingRequest: async ({ id, meta }) =>
          await (upsertPairingRequest ?? upsertChannelPairingRequest)({
            accountId,
            channel: "telegram",
            id,
            meta,
          }),
      })({
        meta: {
          firstName: sender.firstName,
          lastName: sender.lastName,
          username: sender.username || undefined,
        },
        onCreated: () => {
          logger.info(
            {
              chatId: String(chatId),
              firstName: sender.firstName,
              lastName: sender.lastName,
              matchKey: allowMatch.matchKey ?? "none",
              matchSource: allowMatch.matchSource ?? "none",
              senderUserId: sender.userId ?? undefined,
              username: sender.username || undefined,
            },
            "telegram pairing request",
          );
        },
        onReplyError: (err) => {
          logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
        },
        sendPairingReply: async (text) => {
          const html = renderTelegramHtmlText(text);
          await withTelegramApiErrorLogging({
            fn: () => bot.api.sendMessage(chatId, html, { parse_mode: "HTML" }),
            operation: "sendMessage",
          });
        },
        senderId: telegramUserId,
        senderIdLine: `Your Telegram user id: ${telegramUserId}`,
      });
    } catch (error) {
      logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(error)}`);
    }
    return false;
  }

  logVerbose(
    `Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
  );
  return false;
}
