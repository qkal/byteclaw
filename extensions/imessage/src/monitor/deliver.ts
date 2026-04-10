import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { createIMessageRpcClient } from "../client.js";
import { sendMessageIMessage } from "../send.js";
import {
  chunkTextWithMode,
  convertMarkdownTables,
  loadConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
} from "./deliver.runtime.js";
import type { SentMessageCache } from "./echo-cache.js";
import { sanitizeOutboundText } from "./sanitize-outbound.js";

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  client: Awaited<ReturnType<typeof createIMessageRpcClient>>;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  sentMessageCache?: Pick<SentMessageCache, "remember">;
}) {
  const { replies, target, client, runtime, maxBytes, textLimit, accountId, sentMessageCache } =
    params;
  const scope = `${accountId ?? ""}:${target}`;
  const cfg = loadConfig();
  const tableMode = resolveMarkdownTableMode({
    accountId,
    cfg,
    channel: "imessage",
  });
  const chunkMode = resolveChunkMode(cfg, "imessage", accountId);
  for (const payload of replies) {
    const rawText = sanitizeOutboundText(payload.text ?? "");
    const reply = resolveSendableOutboundReplyParts(payload, {
      text: convertMarkdownTables(rawText, tableMode),
    });
    const delivered = await deliverTextOrMediaReply({
      chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
      payload,
      sendMedia: async ({ mediaUrl, caption }) => {
        const sent = await sendMessageIMessage(target, caption ?? "", {
          accountId,
          client,
          maxBytes,
          mediaUrl,
          replyToId: payload.replyToId,
        });
        sentMessageCache?.remember(scope, {
          messageId: sent.messageId,
          text: sent.sentText || undefined,
        });
      },
      sendText: async (chunk) => {
        const sent = await sendMessageIMessage(target, chunk, {
          accountId,
          client,
          maxBytes,
          replyToId: payload.replyToId,
        });
        // Post-send cache population (#47830): caching happens after each chunk is sent,
        // Not before. The window between send completion and cache write is sub-millisecond;
        // The next SQLite inbound poll is 1-2s away, so no echo can arrive before the
        // Cache entry exists.
        sentMessageCache?.remember(scope, { messageId: sent.messageId, text: sent.sentText });
      },
      text: reply.text,
    });
    if (delivered !== "empty") {
      runtime.log?.(`imessage: delivered reply to ${target}`);
    }
  }
}
