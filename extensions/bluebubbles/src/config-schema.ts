import {
  AllowFromListSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  buildCatchallMultiAccountChannelSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
import { bluebubblesChannelConfigUiHints } from "./config-ui-hints.js";
import { buildSecretInputSchema, hasConfiguredSecretInput } from "./secret-input.js";

const bluebubblesActionSchema = z
  .object({
    addParticipant: z.boolean().default(true),
    edit: z.boolean().default(true),
    leaveGroup: z.boolean().default(true),
    reactions: z.boolean().default(true),
    removeParticipant: z.boolean().default(true),
    renameGroup: z.boolean().default(true),
    reply: z.boolean().default(true),
    sendAttachment: z.boolean().default(true),
    sendWithEffect: z.boolean().default(true),
    setGroupIcon: z.boolean().default(true),
    unsend: z.boolean().default(true),
  })
  .optional();

const bluebubblesGroupConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
});

const bluebubblesNetworkSchema = z
  .object({
    /** Dangerous opt-in for same-host or trusted private/internal BlueBubbles deployments. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const bluebubblesAccountSchema = z
  .object({
    actions: bluebubblesActionSchema,
    allowFrom: AllowFromListSchema,
    blockStreaming: z.boolean().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dmPolicy: DmPolicySchema.optional(),
    enabled: z.boolean().optional(),
    enrichGroupParticipantsFromContacts: z.boolean().optional().default(true),
    groupAllowFrom: AllowFromListSchema,
    groupPolicy: GroupPolicySchema.optional(),
    groups: z.object({}).catchall(bluebubblesGroupConfigSchema).optional(),
    historyLimit: z.number().int().min(0).optional(),
    markdown: MarkdownConfigSchema,
    mediaLocalRoots: z.array(z.string()).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    name: z.string().optional(),
    network: bluebubblesNetworkSchema,
    password: buildSecretInputSchema().optional(),
    sendReadReceipts: z.boolean().optional(),
    serverUrl: z.string().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    webhookPath: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const serverUrl = value.serverUrl?.trim() ?? "";
    const passwordConfigured = hasConfiguredSecretInput(value.password);
    if (serverUrl && !passwordConfigured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "password is required when serverUrl is configured",
        path: ["password"],
      });
    }
  });

export const BlueBubblesConfigSchema = buildCatchallMultiAccountChannelSchema(
  bluebubblesAccountSchema,
).safeExtend({
  actions: bluebubblesActionSchema,
});

export const BlueBubblesChannelConfigSchema = buildChannelConfigSchema(BlueBubblesConfigSchema, {
  uiHints: bluebubblesChannelConfigUiHints,
});
