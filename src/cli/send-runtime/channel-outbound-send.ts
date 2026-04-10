import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { loadConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

interface RuntimeSendOpts {
  cfg?: ReturnType<typeof loadConfig>;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  messageThreadId?: string | number;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  gatewayClientScopes?: readonly string[];
}

export function createChannelOutboundRuntimeSend(params: {
  channelId: ChannelId;
  unavailableMessage: string;
}) {
  return {
    sendMessage: async (to: string, text: string, opts: RuntimeSendOpts = {}) => {
      const outbound = await loadChannelOutboundAdapter(params.channelId);
      if (!outbound?.sendText) {
        throw new Error(params.unavailableMessage);
      }
      return await outbound.sendText({
        accountId: opts.accountId,
        cfg: opts.cfg ?? loadConfig(),
        forceDocument: opts.forceDocument,
        gatewayClientScopes: opts.gatewayClientScopes,
        gifPlayback: opts.gifPlayback,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaUrl: opts.mediaUrl,
        replyToId:
          opts.replyToMessageId == null
            ? undefined
            : normalizeOptionalString(String(opts.replyToMessageId)),
        silent: opts.silent,
        text,
        threadId: opts.messageThreadId,
        to,
      });
    },
  };
}
