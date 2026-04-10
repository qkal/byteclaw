import { type OpenClawConfig, loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { generateSecureUuid } from "openclaw/plugin-sdk/core";
import { type PollInput, normalizePollInput } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/text-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/text-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import {
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppMediaMaxBytes,
} from "./accounts.js";
import { type ActiveWebSendOptions, requireActiveWebListener } from "./active-listener.js";
import { loadOutboundMediaFromUrl } from "./outbound-media.runtime.js";
import { markdownToWhatsApp, toWhatsappJid } from "./text-runtime.js";

const outboundLog = createSubsystemLogger("gateway/channels/whatsapp").child("outbound");

function resolveOutboundWhatsAppAccountId(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): string | undefined {
  const explicitAccountId = params.accountId?.trim();
  if (explicitAccountId) {
    return explicitAccountId;
  }
  return resolveDefaultWhatsAppAccountId(params.cfg);
}

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    verbose: boolean;
    cfg?: OpenClawConfig;
    mediaUrl?: string;
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    gifPlayback?: boolean;
    accountId?: string;
  },
): Promise<{ messageId: string; toJid: string }> {
  let text = body.trimStart();
  const jid = toWhatsappJid(to);
  if (!text && !options.mediaUrl) {
    return { messageId: "", toJid: jid };
  }
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const cfg = options.cfg ?? loadConfig();
  const effectiveAccountId = resolveOutboundWhatsAppAccountId({
    accountId: options.accountId,
    cfg,
  });
  const { listener: active, accountId: resolvedAccountId } =
    requireActiveWebListener(effectiveAccountId);
  const account = resolveWhatsAppAccount({
    accountId: resolvedAccountId ?? options.accountId,
    cfg,
  });
  const tableMode = resolveMarkdownTableMode({
    accountId: resolvedAccountId ?? options.accountId,
    cfg,
    channel: "whatsapp",
  });
  text = convertMarkdownTables(text ?? "", tableMode);
  text = markdownToWhatsApp(text);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    correlationId,
    module: "web-outbound",
    to: redactedTo,
  });
  try {
    const redactedJid = redactIdentifier(jid);
    let mediaBuffer: Buffer | undefined;
    let mediaType: string | undefined;
    let documentFileName: string | undefined;
    if (options.mediaUrl) {
      const media = await loadOutboundMediaFromUrl(options.mediaUrl, {
        maxBytes: resolveWhatsAppMediaMaxBytes(account),
        mediaAccess: options.mediaAccess,
        mediaLocalRoots: options.mediaLocalRoots,
        mediaReadFile: options.mediaReadFile,
      });
      const caption = text || undefined;
      mediaBuffer = media.buffer;
      mediaType = media.contentType ?? "application/octet-stream";
      if (media.kind === "audio") {
        // WhatsApp expects explicit opus codec for PTT voice notes.
        mediaType =
          media.contentType === "audio/ogg"
            ? "audio/ogg; codecs=opus"
            : (media.contentType ?? "application/octet-stream");
      } else if (media.kind === "video") {
        text = caption ?? "";
      } else if (media.kind === "image") {
        text = caption ?? "";
      } else {
        text = caption ?? "";
        documentFileName = media.fileName;
      }
    }
    outboundLog.info(`Sending message -> ${redactedJid}${options.mediaUrl ? " (media)" : ""}`);
    logger.info({ hasMedia: Boolean(options.mediaUrl), jid: redactedJid }, "sending message");
    await active.sendComposingTo(to);
    const hasExplicitAccountId = Boolean(options.accountId?.trim());
    const accountId = hasExplicitAccountId ? resolvedAccountId : undefined;
    const sendOptions: ActiveWebSendOptions | undefined =
      options.gifPlayback || accountId || documentFileName
        ? {
            ...(options.gifPlayback ? { gifPlayback: true } : {}),
            ...(documentFileName ? { fileName: documentFileName } : {}),
            accountId,
          }
        : undefined;
    const result = sendOptions
      ? await active.sendMessage(to, text, mediaBuffer, mediaType, sendOptions)
      : await active.sendMessage(to, text, mediaBuffer, mediaType);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(
      `Sent message ${messageId} -> ${redactedJid}${options.mediaUrl ? " (media)" : ""} (${durationMs}ms)`,
    );
    logger.info({ jid: redactedJid, messageId }, "sent message");
    return { messageId, toJid: jid };
  } catch (error) {
    logger.error(
      { err: String(error), hasMedia: Boolean(options.mediaUrl), to: redactedTo },
      "failed to send via web session",
    );
    throw error;
  }
}

export async function sendReactionWhatsApp(
  chatJid: string,
  messageId: string,
  emoji: string,
  options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  },
): Promise<void> {
  const correlationId = generateSecureUuid();
  const cfg = loadConfig();
  const effectiveAccountId = resolveOutboundWhatsAppAccountId({
    accountId: options.accountId,
    cfg,
  });
  const { listener: active } = requireActiveWebListener(effectiveAccountId);
  const redactedChatJid = redactIdentifier(chatJid);
  const logger = getChildLogger({
    chatJid: redactedChatJid,
    correlationId,
    messageId,
    module: "web-outbound",
  });
  try {
    const jid = toWhatsappJid(chatJid);
    const redactedJid = redactIdentifier(jid);
    outboundLog.info(`Sending reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, emoji, messageId }, "sending reaction");
    await active.sendReaction(
      chatJid,
      messageId,
      emoji,
      options.fromMe ?? false,
      options.participant,
    );
    outboundLog.info(`Sent reaction "${emoji}" -> message ${messageId}`);
    logger.info({ chatJid: redactedJid, emoji, messageId }, "sent reaction");
  } catch (error) {
    logger.error(
      { chatJid: redactedChatJid, emoji, err: String(error), messageId },
      "failed to send reaction via web session",
    );
    throw error;
  }
}

export async function sendPollWhatsApp(
  to: string,
  poll: PollInput,
  options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
): Promise<{ messageId: string; toJid: string }> {
  const correlationId = generateSecureUuid();
  const startedAt = Date.now();
  const cfg = options.cfg ?? loadConfig();
  const effectiveAccountId = resolveOutboundWhatsAppAccountId({
    accountId: options.accountId,
    cfg,
  });
  const { listener: active } = requireActiveWebListener(effectiveAccountId);
  const redactedTo = redactIdentifier(to);
  const logger = getChildLogger({
    correlationId,
    module: "web-outbound",
    to: redactedTo,
  });
  try {
    const jid = toWhatsappJid(to);
    const redactedJid = redactIdentifier(jid);
    const normalized = normalizePollInput(poll, { maxOptions: 12 });
    outboundLog.info(`Sending poll -> ${redactedJid}`);
    logger.info(
      {
        jid: redactedJid,
        maxSelections: normalized.maxSelections,
        optionCount: normalized.options.length,
      },
      "sending poll",
    );
    const result = await active.sendPoll(to, normalized);
    const messageId = (result as { messageId?: string })?.messageId ?? "unknown";
    const durationMs = Date.now() - startedAt;
    outboundLog.info(`Sent poll ${messageId} -> ${redactedJid} (${durationMs}ms)`);
    logger.info({ jid: redactedJid, messageId }, "sent poll");
    return { messageId, toJid: jid };
  } catch (error) {
    logger.error({ err: String(error), to: redactedTo }, "failed to send poll via web session");
    throw error;
  }
}
