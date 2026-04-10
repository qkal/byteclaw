import { Type } from "@sinclair/typebox";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { textToSpeech } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format (e.g. telegram)." }),
  ),
  text: Type.String({ description: "Text to convert to speech." }),
});

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
}): AnyAgentTool {
  return {
    description: `Convert text to speech. Audio is delivered automatically from the tool result — reply with ${SILENT_REPLY_TOKEN} after a successful call to avoid duplicate messages.`,
    displaySummary: "Convert text to speech and return audio.",
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const cfg = opts?.config ?? loadConfig();
      const result = await textToSpeech({
        cfg,
        channel: channel ?? opts?.agentChannel,
        text,
      });

      if (result.success && result.audioPath) {
        return {
          content: [{ text: "Generated audio reply.", type: "text" }],
          details: {
            audioPath: result.audioPath,
            media: {
              mediaUrl: result.audioPath,
              ...(result.voiceCompatible ? { audioAsVoice: true } : {}),
            },
            provider: result.provider,
          },
        };
      }

      return {
        content: [
          {
            text: result.error ?? "TTS conversion failed",
            type: "text",
          },
        ],
        details: { error: result.error },
      };
    },
    label: "TTS",
    name: "tts",
    parameters: TtsToolSchema,
  };
}
