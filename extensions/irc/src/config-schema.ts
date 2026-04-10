import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  ToolPolicySchema,
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
import { ircChannelConfigUiHints } from "./config-ui-hints.js";

const IrcGroupSchema = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
  })
  .strict();

const IrcNickServSchema = z
  .object({
    enabled: z.boolean().optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    register: z.boolean().optional(),
    registerEmail: z.string().optional(),
    service: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.register && !value.registerEmail?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
        path: ["registerEmail"],
      });
    }
  });

export const IrcAccountSchemaBase = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    channels: z.array(z.string()).optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    enabled: z.boolean().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
    host: z.string().optional(),
    markdown: MarkdownConfigSchema,
    mentionPatterns: z.array(z.string()).optional(),
    name: z.string().optional(),
    nick: z.string().optional(),
    nickserv: IrcNickServSchema.optional(),
    password: z.string().optional(),
    passwordFile: z.string().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    realname: z.string().optional(),
    tls: z.boolean().optional(),
    username: z.string().optional(),
    ...ReplyRuntimeConfigSchemaShape,
  })
  .strict();

export const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
});

export const IrcConfigSchema = IrcAccountSchemaBase.extend({
  accounts: z.record(z.string(), IrcAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
});

export const IrcChannelConfigSchema = buildChannelConfigSchema(IrcConfigSchema, {
  uiHints: ircChannelConfigUiHints,
});
