import {
  AllowFromListSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  buildCatchallMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
import { buildSecretInputSchema } from "./secret-input.js";

const zaloAccountSchema = z.object({
  allowFrom: AllowFromListSchema,
  botToken: buildSecretInputSchema().optional(),
  dmPolicy: DmPolicySchema.optional(),
  enabled: z.boolean().optional(),
  groupAllowFrom: AllowFromListSchema,
  groupPolicy: GroupPolicySchema.optional(),
  markdown: MarkdownConfigSchema,
  mediaMaxMb: z.number().optional(),
  name: z.string().optional(),
  proxy: z.string().optional(),
  responsePrefix: z.string().optional(),
  tokenFile: z.string().optional(),
  webhookPath: z.string().optional(),
  webhookSecret: buildSecretInputSchema().optional(),
  webhookUrl: z.string().optional(),
});

export const ZaloConfigSchema = buildCatchallMultiAccountChannelSchema(zaloAccountSchema);
