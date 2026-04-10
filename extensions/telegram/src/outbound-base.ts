import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";

export const telegramOutboundBaseAdapter = {
  chunker: chunkMarkdownText,
  chunkerMode: "markdown" as const,
  deliveryMode: "direct" as const,
  pollMaxOptions: 10,
  textChunkLimit: 4000,
};
