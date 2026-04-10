import {
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveOutboundSendDep, sanitizeForPlainText } from "openclaw/plugin-sdk/infra-runtime";
import { WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./outbound-send-deps.js";

type WhatsAppChunker = NonNullable<ChannelOutboundAdapter["chunker"]>;
interface WhatsAppSendTextOptions {
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
}
type WhatsAppSendMessage = (
  to: string,
  body: string,
  options: WhatsAppSendTextOptions,
) => Promise<{ messageId: string; toJid: string }>;
type WhatsAppSendPoll = (
  to: string,
  poll: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]["poll"],
  options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
) => Promise<{ messageId: string; toJid: string }>;

interface CreateWhatsAppOutboundBaseParams {
  chunker: WhatsAppChunker;
  sendMessageWhatsApp: WhatsAppSendMessage;
  sendPollWhatsApp: WhatsAppSendPoll;
  shouldLogVerbose: () => boolean;
  resolveTarget: ChannelOutboundAdapter["resolveTarget"];
  normalizeText?: (text: string | undefined) => string;
  skipEmptyText?: boolean;
}

export function createWhatsAppOutboundBase({
  chunker,
  sendMessageWhatsApp,
  sendPollWhatsApp,
  shouldLogVerbose,
  resolveTarget,
  normalizeText = (text) => text ?? "",
  skipEmptyText = false,
}: CreateWhatsAppOutboundBaseParams): Pick<
  ChannelOutboundAdapter,
  | "deliveryMode"
  | "chunker"
  | "chunkerMode"
  | "textChunkLimit"
  | "sanitizeText"
  | "pollMaxOptions"
  | "resolveTarget"
  | "sendText"
  | "sendMedia"
  | "sendPoll"
> {
  return {
    chunker,
    chunkerMode: "text",
    deliveryMode: "gateway",
    pollMaxOptions: 12,
    resolveTarget,
    sanitizeText: ({ text }) => sanitizeForPlainText(text),
    textChunkLimit: 4000,
    ...createAttachedChannelResultAdapter({
      channel: "whatsapp",
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
        gifPlayback,
      }) => {
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
            legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
          }) ?? sendMessageWhatsApp;
        return await send(to, normalizeText(text), {
          accountId: accountId ?? undefined,
          cfg,
          gifPlayback,
          mediaAccess,
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
        const normalizedText = normalizeText(text);
        if (skipEmptyText && !normalizedText) {
          return { messageId: "" };
        }
        const send =
          resolveOutboundSendDep<WhatsAppSendMessage>(deps, "whatsapp", {
            legacyKeys: WHATSAPP_LEGACY_OUTBOUND_SEND_DEP_KEYS,
          }) ?? sendMessageWhatsApp;
        return await send(to, normalizedText, {
          accountId: accountId ?? undefined,
          cfg,
          gifPlayback,
          verbose: false,
        });
      },
    }),
  };
}
