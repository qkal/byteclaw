import { z } from "zod";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";
import {
  BlockStreamingCoalesceSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "./zod-schema.core.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const WhatsAppGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict()
  .optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppAckReactionSchema = z
  .object({
    direct: z.boolean().optional().default(true),
    emoji: z.string().optional(),
    group: z.enum(["always", "mentions", "never"]).optional().default("mentions"),
  })
  .strict()
  .optional();

const WhatsAppSharedSchema = z.object({
  ackReaction: WhatsAppAckReactionSchema,
  allowFrom: z.array(z.string()).optional(),
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  capabilities: z.array(z.string()).optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  configWrites: z.boolean().optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  debounceMs: z.number().int().nonnegative().optional().default(0),
  defaultTo: z.string().optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  enabled: z.boolean().optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  groups: WhatsAppGroupsSchema,
  healthMonitor: ChannelHealthMonitorSchema,
  heartbeat: ChannelHeartbeatVisibilitySchema,
  historyLimit: z.number().int().min(0).optional(),
  markdown: MarkdownConfigSchema,
  messagePrefix: z.string().optional(),
  reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
  responsePrefix: z.string().optional(),
  selfChatMode: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
  textChunkLimit: z.number().int().positive().optional(),
});

function enforceOpenDmPolicyAllowFromStar(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
  path?: (string | number)[];
}) {
  if (params.dmPolicy !== "open") {
    return;
  }
  const allow = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: params.message,
    path: params.path ?? ["allowFrom"],
  });
}

function enforceAllowlistDmPolicyAllowFrom(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
  path?: (string | number)[];
}) {
  if (params.dmPolicy !== "allowlist") {
    return;
  }
  const allow = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []);
  if (allow.length > 0) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: params.message,
    path: params.path ?? ["allowFrom"],
  });
}

export const WhatsAppAccountSchema = WhatsAppSharedSchema.extend({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
  authDir: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
}).strict();

export const WhatsAppConfigSchema = WhatsAppSharedSchema.extend({
  accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
  actions: z
    .object({
      polls: z.boolean().optional(),
      reactions: z.boolean().optional(),
      sendMessage: z.boolean().optional(),
    })
    .strict()
    .optional(),
  defaultAccount: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional().default(50),
})
  .strict()
  .superRefine((value, ctx) => {
    enforceOpenDmPolicyAllowFromStar({
      allowFrom: value.allowFrom,
      ctx,
      dmPolicy: value.dmPolicy,
      message:
        'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    });
    enforceAllowlistDmPolicyAllowFrom({
      allowFrom: value.allowFrom,
      ctx,
      dmPolicy: value.dmPolicy,
      message:
        'channels.whatsapp.dmPolicy="allowlist" requires channels.whatsapp.allowFrom to contain at least one sender ID',
    });
    if (!value.accounts) {
      return;
    }
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
      const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
      enforceOpenDmPolicyAllowFromStar({
        allowFrom: effectiveAllowFrom,
        ctx,
        dmPolicy: effectivePolicy,
        message:
          'channels.whatsapp.accounts.*.dmPolicy="open" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to include "*"',
        path: ["accounts", accountId, "allowFrom"],
      });
      enforceAllowlistDmPolicyAllowFrom({
        allowFrom: effectiveAllowFrom,
        ctx,
        dmPolicy: effectivePolicy,
        message:
          'channels.whatsapp.accounts.*.dmPolicy="allowlist" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to contain at least one sender ID',
        path: ["accounts", accountId, "allowFrom"],
      });
    }
  });
