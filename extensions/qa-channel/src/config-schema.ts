import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const QaChannelActionConfigSchema = z
  .object({
    messages: z.boolean().optional(),
    reactions: z.boolean().optional(),
    search: z.boolean().optional(),
    threads: z.boolean().optional(),
  })
  .strict();

export const QaChannelAccountConfigSchema = z
  .object({
    actions: QaChannelActionConfigSchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    baseUrl: z.string().url().optional(),
    botDisplayName: z.string().optional(),
    botUserId: z.string().optional(),
    defaultTo: z.string().optional(),
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    pollTimeoutMs: z.number().int().min(100).max(30_000).optional(),
  })
  .strict();

export const QaChannelConfigSchema = QaChannelAccountConfigSchema.extend({
  accounts: z.record(z.string(), QaChannelAccountConfigSchema.partial()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

export const qaChannelPluginConfigSchema = buildChannelConfigSchema(QaChannelConfigSchema);
