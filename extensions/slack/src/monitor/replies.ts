import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackReplyBlocks } from "../reply-blocks.js";
import {
  SILENT_REPLY_TOKEN,
  chunkMarkdownTextWithMode,
  createReplyReferencePlanner,
  isSilentReplyText,
} from "./reply.runtime.js";
import { type SlackSendIdentity, sendMessageSlack } from "./send.runtime.js";

export function readSlackReplyBlocks(payload: ReplyPayload) {
  return resolveSlackReplyBlocks(payload);
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all" | "batched";
  identity?: SlackSendIdentity;
}) {
  for (const payload of params.replies) {
    // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
    // Must not force threading.
    const inlineReplyToId = params.replyToMode === "off" ? undefined : payload.replyToId;
    const threadTs = inlineReplyToId ?? params.replyThreadTs;
    const reply = resolveSendableOutboundReplyParts(payload);
    const slackBlocks = readSlackReplyBlocks(payload);
    if (!reply.hasContent && !slackBlocks?.length) {
      continue;
    }

    if (!reply.hasMedia && slackBlocks?.length) {
      const trimmed = reply.trimmedText;
      if (!trimmed && !slackBlocks?.length) {
        continue;
      }
      if (trimmed && isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      await sendMessageSlack(params.target, trimmed, {
        accountId: params.accountId,
        threadTs,
        token: params.token,
        ...(slackBlocks?.length ? { blocks: slackBlocks } : {}),
        ...(params.identity ? { identity: params.identity } : {}),
      });
      params.runtime.log?.(`delivered reply to ${params.target}`);
      continue;
    }

    const delivered = await deliverTextOrMediaReply({
      chunkText: !reply.hasMedia
        ? (value) => {
            const trimmed = value.trim();
            if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
              return [];
            }
            return [trimmed];
          }
        : undefined,
      payload,
      sendMedia: async ({ mediaUrl, caption }) => {
        await sendMessageSlack(params.target, caption ?? "", {
          accountId: params.accountId,
          mediaUrl,
          threadTs,
          token: params.token,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      },
      sendText: async (trimmed) => {
        await sendMessageSlack(params.target, trimmed, {
          accountId: params.accountId,
          threadTs,
          token: params.token,
          ...(params.identity ? { identity: params.identity } : {}),
        });
      },
      text: reply.text,
    });
    if (delivered !== "empty") {
      params.runtime.log?.(`delivered reply to ${params.target}`);
    }
  }
}

export type SlackRespondFn = (payload: {
  text: string;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied: boolean;
  isThreadReply?: boolean;
}): string | undefined {
  const planner = createSlackReplyReferencePlanner({
    hasReplied: params.hasReplied,
    incomingThreadTs: params.incomingThreadTs,
    isThreadReply: params.isThreadReply,
    messageTs: params.messageTs,
    replyToMode: params.replyToMode,
  });
  return planner.use();
}

interface SlackReplyDeliveryPlan {
  nextThreadTs: () => string | undefined;
  markSent: () => void;
}

function createSlackReplyReferencePlanner(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied?: boolean;
  isThreadReply?: boolean;
}) {
  // Older/internal callers may not pass explicit thread classification. Keep
  // Genuine thread replies sticky, but do not let Slack's auto-populated
  // Top-level thread_ts override the configured replyToMode.
  const effectiveIsThreadReply =
    params.isThreadReply ??
    Boolean(params.incomingThreadTs && params.incomingThreadTs !== params.messageTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    existingId: params.incomingThreadTs,
    hasReplied: params.hasReplied,
    replyToMode: effectiveMode,
    startId: params.messageTs,
  });
}

export function createSlackReplyDeliveryPlan(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasRepliedRef: { value: boolean };
  isThreadReply?: boolean;
}): SlackReplyDeliveryPlan {
  const replyReference = createSlackReplyReferencePlanner({
    hasReplied: params.hasRepliedRef.value,
    incomingThreadTs: params.incomingThreadTs,
    isThreadReply: params.isThreadReply,
    messageTs: params.messageTs,
    replyToMode: params.replyToMode,
  });
  return {
    markSent: () => {
      replyReference.markSent();
      params.hasRepliedRef.value = replyReference.hasReplied();
    },
    nextThreadTs: () => replyReference.use(),
  };
}

export async function deliverSlackSlashReplies(params: {
  replies: ReplyPayload[];
  respond: SlackRespondFn;
  ephemeral: boolean;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const messages: string[] = [];
  const chunkLimit = Math.min(params.textLimit, SLACK_TEXT_LIMIT);
  for (const payload of params.replies) {
    const reply = resolveSendableOutboundReplyParts(payload);
    const text =
      reply.hasText && !isSilentReplyText(reply.trimmedText, SILENT_REPLY_TOKEN)
        ? reply.trimmedText
        : undefined;
    const combined = [text ?? "", ...reply.mediaUrls].filter(Boolean).join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined];
    const chunks = markdownChunks.flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    for (const chunk of chunks) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const text of messages) {
    await params.respond({ response_type: responseType, text });
  }
}
