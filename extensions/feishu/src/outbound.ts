import fs from "node:fs";
import path from "node:path";
import { createAttachedChannelResultAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { replyComment } from "./drive.js";
import { sendMediaFeishu } from "./media.js";
import { type ChannelOutboundAdapter, chunkTextForOutbound } from "./outbound-runtime-api.js";
import { sendMarkdownCardFeishu, sendMessageFeishu, sendStructuredCardFeishu } from "./send.js";

function normalizePossibleLocalImagePath(text: string | undefined): string | null {
  const raw = text?.trim();
  if (!raw) {
    return null;
  }

  // Only auto-convert when the message is a pure path-like payload.
  // Avoid converting regular sentences that merely contain a path.
  const hasWhitespace = /\s/.test(raw);
  if (hasWhitespace) {
    return null;
  }

  // Ignore links/data URLs; those should stay in normal mediaUrl/text paths.
  if (/^(https?:\/\/|data:|file:\/\/)/i.test(raw)) {
    return null;
  }

  const ext = normalizeLowercaseStringOrEmpty(path.extname(raw));
  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (!isImageExt) {
    return null;
  }

  if (!path.isAbsolute(raw)) {
    return null;
  }
  if (!fs.existsSync(raw)) {
    return null;
  }

  // Fix race condition: wrap statSync in try-catch to handle file deletion
  // Between existsSync and statSync
  try {
    if (!fs.statSync(raw).isFile()) {
      return null;
    }
  } catch {
    // File may have been deleted or became inaccessible between checks
    return null;
  }

  return raw;
}

function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

function resolveReplyToMessageId(params: {
  replyToId?: string | null;
  threadId?: string | number | null;
}): string | undefined {
  const replyToId = params.replyToId?.trim();
  if (replyToId) {
    return replyToId;
  }
  if (params.threadId == null) {
    return undefined;
  }
  const trimmed = String(params.threadId).trim();
  return trimmed || undefined;
}

async function sendCommentThreadReply(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string;
}) {
  const target = parseFeishuCommentTarget(params.to);
  if (!target) {
    return null;
  }
  const account = resolveFeishuAccount({ accountId: params.accountId, cfg: params.cfg });
  const client = createFeishuClient(account);
  const result = await replyComment(client, {
    comment_id: target.commentId,
    content: params.text,
    file_token: target.fileToken,
    file_type: target.fileType,
  });
  return {
    chatId: target.commentId,
    messageId: typeof result.reply_id === "string" ? result.reply_id : "",
    result,
  };
}

async function sendOutboundText(params: {
  cfg: Parameters<typeof sendMessageFeishu>[0]["cfg"];
  to: string;
  text: string;
  replyToMessageId?: string;
  accountId?: string;
}) {
  const { cfg, to, text, accountId, replyToMessageId } = params;
  const commentResult = await sendCommentThreadReply({
    accountId,
    cfg,
    text,
    to,
  });
  if (commentResult) {
    return commentResult;
  }

  const account = resolveFeishuAccount({ accountId, cfg });
  const renderMode = account.config?.renderMode ?? "auto";

  if (renderMode === "card" || (renderMode === "auto" && shouldUseCard(text))) {
    return sendMarkdownCardFeishu({ accountId, cfg, replyToMessageId, text, to });
  }

  return sendMessageFeishu({ accountId, cfg, replyToMessageId, text, to });
}

export const feishuOutbound: ChannelOutboundAdapter = {
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  deliveryMode: "direct",
  textChunkLimit: 4000,
  ...createAttachedChannelResultAdapter({
    channel: "feishu",
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      accountId,
      mediaLocalRoots,
      replyToId,
      threadId,
    }) => {
      const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
      const commentTarget = parseFeishuCommentTarget(to);
      if (commentTarget) {
        const commentText = [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n\n");
        return await sendOutboundText({
          accountId: accountId ?? undefined,
          cfg,
          replyToMessageId,
          text: commentText || mediaUrl || text || "",
          to,
        });
      }

      // Send text first if provided
      if (text?.trim()) {
        await sendOutboundText({
          accountId: accountId ?? undefined,
          cfg,
          replyToMessageId,
          text,
          to,
        });
      }

      // Upload and send media if URL or local path provided
      if (mediaUrl) {
        try {
          return await sendMediaFeishu({
            accountId: accountId ?? undefined,
            cfg,
            mediaLocalRoots,
            mediaUrl,
            replyToMessageId,
            to,
          });
        } catch (error) {
          // Log the error for debugging
          console.error(`[feishu] sendMediaFeishu failed:`, error);
          // Fallback to URL link if upload fails
          return await sendOutboundText({
            accountId: accountId ?? undefined,
            cfg,
            replyToMessageId,
            text: `📎 ${mediaUrl}`,
            to,
          });
        }
      }

      // No media URL, just return text result
      return await sendOutboundText({
        accountId: accountId ?? undefined,
        cfg,
        replyToMessageId,
        text: text ?? "",
        to,
      });
    },
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      replyToId,
      threadId,
      mediaLocalRoots,
      identity,
    }) => {
      const replyToMessageId = resolveReplyToMessageId({ replyToId, threadId });
      // Scheme A compatibility shim:
      // When upstream accidentally returns a local image path as plain text,
      // Auto-upload and send as Feishu image message instead of leaking path text.
      const localImagePath = normalizePossibleLocalImagePath(text);
      if (localImagePath) {
        try {
          return await sendMediaFeishu({
            accountId: accountId ?? undefined,
            cfg,
            mediaLocalRoots,
            mediaUrl: localImagePath,
            replyToMessageId,
            to,
          });
        } catch (error) {
          console.error(`[feishu] local image path auto-send failed:`, error);
          // Fall through to plain text as last resort
        }
      }

      if (parseFeishuCommentTarget(to)) {
        return await sendOutboundText({
          accountId: accountId ?? undefined,
          cfg,
          replyToMessageId,
          text,
          to,
        });
      }

      const account = resolveFeishuAccount({ accountId: accountId ?? undefined, cfg });
      const renderMode = account.config?.renderMode ?? "auto";
      const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));
      if (useCard) {
        const header = identity
          ? {
              template: "blue" as const,
              title: identity.emoji
                ? `${identity.emoji} ${identity.name ?? ""}`.trim()
                : (identity.name ?? ""),
            }
          : undefined;
        return await sendStructuredCardFeishu({
          accountId: accountId ?? undefined,
          cfg,
          header: header?.title ? header : undefined,
          replyInThread: threadId != null && !replyToId,
          replyToMessageId,
          text,
          to,
        });
      }
      return await sendOutboundText({
        accountId: accountId ?? undefined,
        cfg,
        replyToMessageId,
        text,
        to,
      });
    },
  }),
};
