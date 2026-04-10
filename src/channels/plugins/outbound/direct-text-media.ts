import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence,
  sendPayloadMediaSequenceAndFinalize,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkText } from "../../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import type { OutboundMediaAccess } from "../../../media/load-options.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.js";

interface DirectSendOptions {
  cfg: OpenClawConfig;
  accountId?: string | null;
  replyToId?: string | null;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
}

interface DirectSendResult {
  messageId: string;
  [key: string]: unknown;
}

type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (
  to: string,
  text: string,
  opts: TOpts,
) => Promise<TResult>;
export {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequence,
  sendPayloadMediaSequenceAndFinalize,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";

export function resolveScopedChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
}): number | undefined {
  return resolveChannelMediaMaxBytes({
    accountId: params.accountId,
    cfg: params.cfg,
    resolveChannelLimitMb: params.resolveChannelLimitMb,
  });
}

export function createScopedChannelMediaMaxBytesResolver(channel: string) {
  return (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveScopedChannelMediaMaxBytes({
      accountId: params.accountId,
      cfg: params.cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        (cfg.channels?.[channel]?.accounts?.[accountId] as { mediaMaxMb?: number } | undefined)
          ?.mediaMaxMb ?? cfg.channels?.[channel]?.mediaMaxMb,
    });
}

export function createDirectTextMediaOutbound<
  TOpts extends Record<string, unknown>,
  TResult extends DirectSendResult,
>(params: {
  channel: string;
  resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
  resolveMaxBytes: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => number | undefined;
  buildTextOptions: (params: DirectSendOptions) => TOpts;
  buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter {
  const sendDirect = async (sendParams: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    deps?: OutboundSendDeps;
    replyToId?: string | null;
    mediaUrl?: string;
    mediaAccess?: OutboundMediaAccess;
    buildOptions: (params: DirectSendOptions) => TOpts;
  }) => {
    const send = params.resolveSender(sendParams.deps);
    const maxBytes = params.resolveMaxBytes({
      accountId: sendParams.accountId,
      cfg: sendParams.cfg,
    });
    const result = await send(
      sendParams.to,
      sendParams.text,
      sendParams.buildOptions({
        accountId: sendParams.accountId,
        cfg: sendParams.cfg,
        maxBytes,
        mediaAccess: sendParams.mediaAccess,
        mediaLocalRoots: sendParams.mediaAccess?.localRoots,
        mediaReadFile: sendParams.mediaAccess?.readFile,
        mediaUrl: sendParams.mediaUrl,
        replyToId: sendParams.replyToId,
      }),
    );
    return { channel: params.channel, ...result };
  };

  const outbound: ChannelOutboundAdapter = {
    chunker: chunkText,
    chunkerMode: "text",
    deliveryMode: "direct",
    sanitizeText: ({ text }) => sanitizeForPlainText(text),
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
    }) =>
      await sendDirect({
        cfg,
        to,
        text,
        mediaUrl,
        mediaAccess:
          mediaAccess ??
          (mediaLocalRoots || mediaReadFile
            ? {
                ...(mediaLocalRoots?.length ? { localRoots: mediaLocalRoots } : {}),
                ...(mediaReadFile ? { readFile: mediaReadFile } : {}),
              }
            : undefined),
        accountId,
        deps,
        replyToId,
        buildOptions: params.buildMediaOptions,
      }),
    sendPayload: async (ctx) =>
      await sendTextMediaPayload({ adapter: outbound, channel: params.channel, ctx }),
    sendText: async ({ cfg, to, text, accountId, deps, replyToId }) =>
      await sendDirect({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        buildOptions: params.buildTextOptions,
      }),
    textChunkLimit: 4000,
  };
  return outbound;
}
