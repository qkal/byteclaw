import {
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
  createEmptyChannelResult,
} from "openclaw/plugin-sdk/channel-send-result";
import { resolveOutboundSendDep, sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolveSendableOutboundReplyParts,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { chunkText } from "openclaw/plugin-sdk/reply-runtime";
import { shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";
import { resolveWhatsAppOutboundTarget } from "./runtime-api.js";
import { sendPollWhatsApp } from "./send.js";

function trimLeadingWhitespace(text: string | undefined): string {
  return text?.trimStart() ?? "";
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  chunker: chunkText,
  chunkerMode: "text",
  deliveryMode: "gateway",
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ allowFrom, mode, to }),
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  sendPayload: async (ctx) => {
    const text = trimLeadingWhitespace(ctx.payload.text);
    const {hasMedia} = resolveSendableOutboundReplyParts(ctx.payload);
    if (!text && !hasMedia) {
      return createEmptyChannelResult("whatsapp");
    }
    return await sendTextMediaPayload({
      adapter: whatsappOutbound,
      channel: "whatsapp",
      ctx: {
        ...ctx,
        payload: {
          ...ctx.payload,
          text,
        },
      },
    });
  },
  textChunkLimit: 4000,
  ...createAttachedChannelResultAdapter({
    channel: "whatsapp",
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      gifPlayback,
    }) => {
      const normalizedText = trimLeadingWhitespace(text);
      const send =
        resolveOutboundSendDep<typeof import("./send.js").sendMessageWhatsApp>(deps, "whatsapp", {
          legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
        }) ?? (await import("./send.js")).sendMessageWhatsApp;
      return await send(to, normalizedText, {
        accountId: accountId ?? undefined,
        cfg,
        gifPlayback,
        mediaLocalRoots,
        mediaReadFile,
        mediaUrl,
        verbose: false,
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId }) =>
      await sendPollWhatsApp(to, poll, {
        accountId: accountId ?? undefined,
        cfg,
        verbose: shouldLogVerbose(),
      }),
    sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
      const normalizedText = trimLeadingWhitespace(text);
      if (!normalizedText) {
        return createEmptyChannelResult("whatsapp");
      }
      const send =
        resolveOutboundSendDep<typeof import("./send.js").sendMessageWhatsApp>(deps, "whatsapp", {
          legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
        }) ?? (await import("./send.js")).sendMessageWhatsApp;
      return await send(to, normalizedText, {
        accountId: accountId ?? undefined,
        cfg,
        gifPlayback,
        verbose: false,
      });
    },
  }),
};
