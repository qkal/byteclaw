import { shouldAckReactionForWhatsApp } from "openclaw/plugin-sdk/channel-feedback";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getSenderIdentity } from "../../identity.js";
import { resolveWhatsAppReactionLevel } from "../../reaction-level.js";
import { sendReactionWhatsApp } from "../../send.js";
import { formatError } from "../../session.js";
import type { WebInboundMsg } from "../types.js";
import { resolveGroupActivationFor } from "./group-activation.js";

export function maybeSendAckReaction(params: {
  cfg: ReturnType<typeof loadConfig>;
  msg: WebInboundMsg;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  verbose: boolean;
  accountId?: string;
  info: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}) {
  if (!params.msg.id) {
    return;
  }

  // Keep ackReaction as the emoji/scope control, while letting reactionLevel
  // Suppress all automatic reactions when it is explicitly set to "off".
  const reactionLevel = resolveWhatsAppReactionLevel({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  if (reactionLevel.level === "off") {
    return;
  }

  const ackConfig = params.cfg.channels?.whatsapp?.ackReaction;
  const emoji = (ackConfig?.emoji ?? "").trim();
  const directEnabled = ackConfig?.direct ?? true;
  const groupMode = ackConfig?.group ?? "mentions";
  const conversationIdForCheck = params.msg.conversationId ?? params.msg.from;

  const activation =
    params.msg.chatType === "group"
      ? resolveGroupActivationFor({
          agentId: params.agentId,
          cfg: params.cfg,
          conversationId: conversationIdForCheck,
          sessionKey: params.sessionKey,
        })
      : null;
  const shouldSendReaction = () =>
    shouldAckReactionForWhatsApp({
      directEnabled,
      emoji,
      groupActivated: activation === "always",
      groupMode,
      isDirect: params.msg.chatType === "direct",
      isGroup: params.msg.chatType === "group",
      wasMentioned: params.msg.wasMentioned === true,
    });

  if (!shouldSendReaction()) {
    return;
  }

  params.info(
    { chatId: params.msg.chatId, emoji, messageId: params.msg.id },
    "sending ack reaction",
  );
  const sender = getSenderIdentity(params.msg);
  sendReactionWhatsApp(params.msg.chatId, params.msg.id, emoji, {
    accountId: params.accountId,
    fromMe: false,
    participant: sender.jid ?? undefined,
    verbose: params.verbose,
  }).catch((error) => {
    params.warn(
      {
        chatId: params.msg.chatId,
        error: formatError(error),
        messageId: params.msg.id,
      },
      "failed to send ack reaction",
    );
    logVerbose(`WhatsApp ack reaction failed for chat ${params.msg.chatId}: ${formatError(error)}`);
  });
}
