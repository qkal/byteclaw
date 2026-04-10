import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import {
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
  createReplyPrefixContext,
} from "./comment-dispatcher-runtime-api.js";
import type { CommentFileType } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { getFeishuRuntime } from "./runtime.js";

export interface CreateFeishuCommentReplyDispatcherParams {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  accountId?: string;
  fileToken: string;
  fileType: CommentFileType;
  commentId: string;
  isWholeComment?: boolean;
}

export function createFeishuCommentReplyDispatcher(
  params: CreateFeishuCommentReplyDispatcherParams,
) {
  const core = getFeishuRuntime();
  const prefixContext = createReplyPrefixContext({
    accountId: params.accountId,
    agentId: params.agentId,
    cfg: params.cfg,
    channel: "feishu",
  });
  const account = resolveFeishuRuntimeAccount({ accountId: params.accountId, cfg: params.cfg });
  const client = createFeishuClient(account);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(
    params.cfg,
    "feishu",
    params.accountId,
    {
      fallbackLimit: 4000,
    },
  );
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "feishu");

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info) => {
        if (info.kind !== "final") {
          return;
        }
        const reply = resolveSendableOutboundReplyParts(payload);
        if (!reply.hasText) {
          if (reply.hasMedia) {
            params.runtime.log?.(
              `feishu[${params.accountId ?? "default"}]: comment reply ignored media-only payload for comment=${params.commentId}`,
            );
          }
          return;
        }
        const chunks = core.channel.text.chunkTextWithMode(reply.text, textChunkLimit, chunkMode);
        for (const chunk of chunks) {
          await deliverCommentThreadText(client, {
            comment_id: params.commentId,
            content: chunk,
            file_token: params.fileToken,
            file_type: params.fileType,
            is_whole_comment: params.isWholeComment,
          });
        }
      },
      humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, params.agentId),
      onError: (err, info) => {
        params.runtime.error?.(
          `feishu[${params.accountId ?? "default"}]: comment dispatcher failed kind=${info.kind} comment=${params.commentId}: ${String(err)}`,
        );
      },
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    });

  return { dispatcher, markDispatchIdle, replyOptions };
}
