import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import { chunkTextForOutbound } from "./channel-api.js";

export const ircOutboundBaseAdapter = {
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  deliveryMode: "direct" as const,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
  textChunkLimit: 350,
};
