import {
  AllowFromListSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  buildCatchallMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";

const groupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
});

const zalouserAccountSchema = z.object({
  allowFrom: AllowFromListSchema,
  dangerouslyAllowNameMatching: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional(),
  enabled: z.boolean().optional(),
  groupAllowFrom: AllowFromListSchema,
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  groups: z.object({}).catchall(groupConfigSchema).optional(),
  historyLimit: z.number().int().min(0).optional(),
  markdown: MarkdownConfigSchema,
  messagePrefix: z.string().optional(),
  name: z.string().optional(),
  profile: z.string().optional(),
  responsePrefix: z.string().optional(),
});

export const ZalouserConfigSchema = buildCatchallMultiAccountChannelSchema(zalouserAccountSchema);
