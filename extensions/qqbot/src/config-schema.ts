import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const AudioFormatPolicySchema = z
  .object({
    sttDirectFormats: z.array(z.string()).optional(),
    transcodeEnabled: z.boolean().optional(),
    uploadDirectFormats: z.array(z.string()).optional(),
  })
  .optional();

const QQBotSpeechQueryParamsSchema = z.record(z.string(), z.string()).optional();

const QQBotTtsSchema = z
  .object({
    apiKey: z.string().optional(),
    authStyle: z.enum(["bearer", "api-key"]).optional(),
    baseUrl: z.string().optional(),
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    queryParams: QQBotSpeechQueryParamsSchema,
    speed: z.number().optional(),
    voice: z.string().optional(),
  })
  .strict()
  .optional();

const QQBotSttSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    enabled: z.boolean().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
  })
  .strict()
  .optional();

const QQBotStreamingSchema = z
  .union([
    z.boolean(),
    z
      .object({
        /** "partial" (default) enables block streaming; "off" disables it. */
        mode: z.enum(["off", "partial"]).default("partial"),
      })
      .passthrough(),
  ])
  .optional();

const QQBotAccountSchema = z
  .object({
    allowFrom: AllowFromListSchema,
    appId: z.string().optional(),
    audioFormatPolicy: AudioFormatPolicySchema,
    clientSecret: buildSecretInputSchema().optional(),
    clientSecretFile: z.string().optional(),
    enabled: z.boolean().optional(),
    markdownSupport: z.boolean().optional(),
    name: z.string().optional(),
    streaming: QQBotStreamingSchema,
    systemPrompt: z.string().optional(),
    upgradeMode: z.enum(["doc", "hot-reload"]).optional(),
    upgradeUrl: z.string().optional(),
    urlDirectUpload: z.boolean().optional(),
    voiceDirectUploadFormats: z.array(z.string()).optional(),
  })
  .passthrough();

export const QQBotConfigSchema = QQBotAccountSchema.extend({
  accounts: z.object({}).catchall(QQBotAccountSchema.passthrough()).optional(),
  defaultAccount: z.string().optional(),
  stt: QQBotSttSchema,
  tts: QQBotTtsSchema,
}).passthrough();
export const qqbotChannelConfigSchema = buildChannelConfigSchema(QQBotConfigSchema);
