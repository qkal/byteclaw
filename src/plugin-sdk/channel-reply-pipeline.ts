import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import {
  type ReplyPrefixContextBundle,
  type ReplyPrefixOptions,
  createReplyPrefixContext,
  createReplyPrefixOptions,
} from "../channels/reply-prefix.js";
import {
  type CreateTypingCallbacksParams,
  type TypingCallbacks,
  createTypingCallbacks,
} from "../channels/typing.js";

export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };

export type ChannelReplyPipeline = ReplyPrefixOptions & {
  typingCallbacks?: TypingCallbacks;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};

export function createChannelReplyPipeline(params: {
  cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
  agentId: string;
  channel?: string;
  accountId?: string;
  typing?: CreateTypingCallbacksParams;
  typingCallbacks?: TypingCallbacks;
}): ChannelReplyPipeline {
  const channelId = params.channel
    ? (normalizeChannelId(params.channel) ?? params.channel)
    : undefined;
  const plugin = channelId ? getChannelPlugin(channelId) : undefined;
  const transformReplyPayload = plugin?.messaging?.transformReplyPayload
    ? (payload: ReplyPayload) =>
        plugin.messaging?.transformReplyPayload?.({
          accountId: params.accountId,
          cfg: params.cfg,
          payload,
        }) ?? payload
    : undefined;
  return {
    ...createReplyPrefixOptions({
      accountId: params.accountId,
      agentId: params.agentId,
      cfg: params.cfg,
      channel: params.channel,
    }),
    ...(transformReplyPayload ? { transformReplyPayload } : {}),
    ...(params.typingCallbacks
      ? { typingCallbacks: params.typingCallbacks }
      : (params.typing
        ? { typingCallbacks: createTypingCallbacks(params.typing) }
        : {})),
  };
}
