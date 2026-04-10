import { z } from "zod";
import { isSafeScpRemoteHost } from "../infra/scp-host.js";
import { isValidInboundPathRootPattern } from "../media/inbound-path-policy.js";
import {
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "../plugin-sdk/telegram-command-config.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  ExecutableTokenSchema,
  GroupPolicySchema,
  HexColorSchema,
  MSTeamsReplyStyleSchema,
  MarkdownConfigSchema,
  ProviderCommandsSchema,
  ReplyToModeSchema,
  RetryConfigSchema,
  SecretInputSchema,
  SecretRefSchema,
  TtsConfigSchema,
  requireAllowlistAllowFrom,
  requireOpenAllowFrom,
} from "./zod-schema.core.js";
import {
  validateSlackSigningSecretRequirements,
  validateTelegramWebhookSecretRequirements,
} from "./zod-schema.secret-input-validation.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const DiscordIdSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `Discord ID "${String(value)}" is not a valid non-negative safe integer. ` +
            `Wrap it in quotes in your config file.`,
        });
        return z.NEVER;
      }
      return String(value);
    }
    return value;
  })
  .pipe(z.string());
const DiscordIdListSchema = z.array(DiscordIdSchema);

const TelegramInlineButtonsScopeSchema = z.enum(["off", "dm", "group", "all", "allowlist"]);
const TelegramIdListSchema = z.array(z.union([z.string(), z.number()]));

const TelegramCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      inlineButtons: TelegramInlineButtonsScopeSchema.optional(),
    })
    .strict(),
]);
const TextChunkModeSchema = z.enum(["length", "newline"]);
const UnifiedStreamingModeSchema = z.enum(["off", "partial", "block", "progress"]);
const ChannelStreamingBlockSchema = z
  .object({
    coalesce: BlockStreamingCoalesceSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const ChannelStreamingPreviewSchema = z
  .object({
    chunk: BlockStreamingChunkSchema.optional(),
  })
  .strict();
const ChannelPreviewStreamingConfigSchema = z
  .object({
    block: ChannelStreamingBlockSchema.optional(),
    chunkMode: TextChunkModeSchema.optional(),
    mode: UnifiedStreamingModeSchema.optional(),
    preview: ChannelStreamingPreviewSchema.optional(),
  })
  .strict();
const SlackStreamingConfigSchema = ChannelPreviewStreamingConfigSchema.extend({
  nativeTransport: z.boolean().optional(),
}).strict();
const SlackCapabilitiesSchema = z.union([
  z.array(z.string()),
  z
    .object({
      interactiveReplies: z.boolean().optional(),
    })
    .strict(),
]);

const TelegramErrorPolicySchema = z.enum(["always", "once", "silent"]).optional();
export const TelegramTopicSchema = z
  .object({
    agentId: z.string().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    disableAudioPreflight: z.boolean().optional(),
    enabled: z.boolean().optional(),
    errorCooldownMs: z.number().int().nonnegative().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    groupPolicy: GroupPolicySchema.optional(),
    ingest: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const TelegramGroupSchema = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    disableAudioPreflight: z.boolean().optional(),
    enabled: z.boolean().optional(),
    errorCooldownMs: z.number().int().nonnegative().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    groupPolicy: GroupPolicySchema.optional(),
    ingest: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
  })
  .strict();

const AutoTopicLabelSchema = z
  .union([
    z.boolean(),
    z
      .object({
        enabled: z.boolean().optional(),
        prompt: z.string().optional(),
      })
      .strict(),
  ])
  .optional();

export const TelegramDirectSchema = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    autoTopicLabel: AutoTopicLabelSchema,
    dmPolicy: DmPolicySchema.optional(),
    enabled: z.boolean().optional(),
    errorCooldownMs: z.number().int().nonnegative().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    requireTopic: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    topics: z.record(z.string(), TelegramTopicSchema.optional()).optional(),
  })
  .strict();

const TelegramCustomCommandSchema = z
  .object({
    command: z.string().overwrite(normalizeTelegramCommandName),
    description: z.string().overwrite(normalizeTelegramCommandDescription),
  })
  .strict();

const validateTelegramCustomCommands = (
  value: { customCommands?: { command?: string; description?: string }[] },
  ctx: z.RefinementCtx,
) => {
  if (!value.customCommands || value.customCommands.length === 0) {
    return;
  }
  const { issues } = resolveTelegramCustomCommands({
    checkDuplicates: false,
    checkReserved: false,
    commands: value.customCommands,
  });
  for (const issue of issues) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: issue.message,
      path: ["customCommands", issue.index, issue.field],
    });
  }
};

export const TelegramAccountSchemaBase = z
  .object({
    ackReaction: z.string().optional(),
    actions: z
      .object({
        createForumTopic: z.boolean().optional(),
        deleteMessage: z.boolean().optional(),
        editForumTopic: z.boolean().optional(),
        editMessage: z.boolean().optional(),
        poll: z.boolean().optional(),
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        sticker: z.boolean().optional(),
      })
      .strict()
      .optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    apiRoot: z.string().url().optional(),
    autoTopicLabel: AutoTopicLabelSchema,
    botToken: SecretInputSchema.optional().register(sensitive),
    capabilities: TelegramCapabilitiesSchema.optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    customCommands: z.array(TelegramCustomCommandSchema).optional(),
    defaultTo: z.union([z.string(), z.number()]).optional(),
    direct: z.record(z.string(), TelegramDirectSchema.optional()).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    errorCooldownMs: z.number().int().nonnegative().optional(),
    errorPolicy: TelegramErrorPolicySchema,
    execApprovals: z
      .object({
        agentFilter: z.array(z.string()).optional(),
        approvers: TelegramIdListSchema.optional(),
        enabled: z.boolean().optional(),
        sessionFilter: z.array(z.string()).optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), TelegramGroupSchema.optional()).optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    historyLimit: z.number().int().min(0).optional(),
    linkPreview: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    mediaMaxMb: z.number().positive().optional(),
    name: z.string().optional(),
    network: z
      .object({
        autoSelectFamily: z.boolean().optional(),
        dangerouslyAllowPrivateNetwork: z
          .boolean()
          .optional()
          .describe(
            "Dangerous opt-in for trusted Telegram fake-IP or transparent-proxy environments where api.telegram.org resolves to private/internal/special-use addresses during media downloads.",
          ),
        dnsResultOrder: z.enum(["ipv4first", "verbatim"]).optional(),
      })
      .strict()
      .optional(),
    proxy: z.string().optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    reactionNotifications: z.enum(["off", "own", "all"]).optional(),
    replyToMode: ReplyToModeSchema.optional(),
    responsePrefix: z.string().optional(),
    retry: RetryConfigSchema,
    silentErrorReplies: z.boolean().optional(),
    streaming: ChannelPreviewStreamingConfigSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
        spawnAcpSessions: z.boolean().optional(),
        spawnSubagentSessions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    tokenFile: z.string().optional(),
    trustedLocalFileRoots: z
      .array(z.string())
      .optional()
      .describe(
        "Trusted local filesystem roots for self-hosted Telegram Bot API absolute file_path values. Only absolute paths under these roots are read directly; all other absolute paths are rejected.",
      ),
    webhookCertPath: z
      .string()
      .optional()
      .describe(
        "Path to the self-signed certificate (PEM) to upload to Telegram during webhook registration. Required for self-signed certs (direct IP or no domain).",
      ),
    webhookHost: z
      .string()
      .optional()
      .describe(
        "Local bind host for the webhook listener. Defaults to 127.0.0.1; keep loopback unless you intentionally expose direct ingress.",
      ),
    webhookPath: z
      .string()
      .optional()
      .describe(
        "Local webhook route path served by the gateway listener. Defaults to /telegram-webhook.",
      ),
    webhookPort: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Local bind port for the webhook listener. Defaults to 8787; set to 0 to let the OS assign an ephemeral port.",
      ),
    webhookSecret: SecretInputSchema.optional()
      .describe(
        "Secret token sent to Telegram during webhook registration and verified on inbound webhook requests. Telegram returns this value for verification; this is not the gateway auth token and not the bot token.",
      )
      .register(sensitive),
    webhookUrl: z
      .string()
      .optional()
      .describe(
        "Public HTTPS webhook URL registered with Telegram for inbound updates. This must be internet-reachable and requires channels.telegram.webhookSecret.",
      ),
  })
  .strict();

export const TelegramAccountSchema = TelegramAccountSchemaBase.superRefine((value, ctx) => {
  // Account-level schemas skip allowFrom validation because accounts inherit
  // AllowFrom from the parent channel config at runtime (resolveTelegramAccount
  // Shallow-merges top-level and account values in src/telegram/accounts.ts).
  // Validation is enforced at the top-level TelegramConfigSchema instead.
  validateTelegramCustomCommands(value, ctx);
});

export const TelegramConfigSchema = TelegramAccountSchemaBase.extend({
  accounts: z.record(z.string(), TelegramAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.telegram.dmPolicy="allowlist" requires channels.telegram.allowFrom to contain at least one sender ID',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  validateTelegramCustomCommands(value, ctx);

  if (value.accounts) {
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
      const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
      requireOpenAllowFrom({
        allowFrom: effectiveAllowFrom,
        ctx,
        message:
          'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to include "*"',
        path: ["accounts", accountId, "allowFrom"],
        policy: effectivePolicy,
      });
      requireAllowlistAllowFrom({
        allowFrom: effectiveAllowFrom,
        ctx,
        message:
          'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.accounts.*.allowFrom (or channels.telegram.allowFrom) to contain at least one sender ID',
        path: ["accounts", accountId, "allowFrom"],
        policy: effectivePolicy,
      });
    }
  }

  if (!value.accounts) {
    validateTelegramWebhookSecretRequirements(value, ctx);
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const effectiveDmPolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = Array.isArray(account.allowFrom)
      ? account.allowFrom
      : value.allowFrom;
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.telegram.accounts.*.dmPolicy="open" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectiveDmPolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.telegram.accounts.*.dmPolicy="allowlist" requires channels.telegram.allowFrom or channels.telegram.accounts.*.allowFrom to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectiveDmPolicy,
    });
  }
  validateTelegramWebhookSecretRequirements(value, ctx);
});

export const DiscordDmSchema = z
  .object({
    allowFrom: DiscordIdListSchema.optional(),
    enabled: z.boolean().optional(),
    groupChannels: DiscordIdListSchema.optional(),
    groupEnabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
  })
  .strict();

export const DiscordGuildChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    ignoreOtherMentions: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    users: DiscordIdListSchema.optional(),
    roles: DiscordIdListSchema.optional(),
    systemPrompt: z.string().optional(),
    includeThreadStarter: z.boolean().optional(),
    autoThread: z.boolean().optional(),
    /** Naming strategy for auto-created threads. "message" uses message text; "generated" creates an LLM title after thread creation. */
    autoThreadName: z.enum(["message", "generated"]).optional(),
    /** Archive duration for auto-created threads in minutes. Discord supports 60, 1440 (1 day), 4320 (3 days), 10080 (1 week). Default: 60. */
    autoArchiveDuration: z
      .union([
        z.enum(["60", "1440", "4320", "10080"]),
        z.literal(60),
        z.literal(1440),
        z.literal(4320),
        z.literal(10_080),
      ])
      .optional(),
  })
  .strict();

export const DiscordGuildSchema = z
  .object({
    channels: z.record(z.string(), DiscordGuildChannelSchema.optional()).optional(),
    ignoreOtherMentions: z.boolean().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    requireMention: z.boolean().optional(),
    roles: DiscordIdListSchema.optional(),
    slug: z.string().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    users: DiscordIdListSchema.optional(),
  })
  .strict();

const DiscordUiSchema = z
  .object({
    components: z
      .object({
        accentColor: HexColorSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const DiscordVoiceAutoJoinSchema = z
  .object({
    channelId: z.string().min(1),
    guildId: z.string().min(1),
  })
  .strict();

const DiscordVoiceSchema = z
  .object({
    autoJoin: z.array(DiscordVoiceAutoJoinSchema).optional(),
    daveEncryption: z.boolean().optional(),
    decryptionFailureTolerance: z.number().int().min(0).optional(),
    enabled: z.boolean().optional(),
    tts: TtsConfigSchema.optional(),
  })
  .strict()
  .optional();

export const DiscordAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    token: SecretInputSchema.optional().register(sensitive),
    proxy: z.string().optional(),
    allowBots: z.union([z.boolean(), z.literal("mentions")]).optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: ChannelPreviewStreamingConfigSchema.optional(),
    maxLinesPerMessage: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    retry: RetryConfigSchema,
    actions: z
      .object({
        channelInfo: z.boolean().optional(),
        channels: z.boolean().optional(),
        emojiUploads: z.boolean().optional(),
        events: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        messages: z.boolean().optional(),
        moderation: z.boolean().optional(),
        permissions: z.boolean().optional(),
        pins: z.boolean().optional(),
        polls: z.boolean().optional(),
        presence: z.boolean().optional(),
        reactions: z.boolean().optional(),
        roleInfo: z.boolean().optional(),
        roles: z.boolean().optional(),
        search: z.boolean().optional(),
        stickerUploads: z.boolean().optional(),
        stickers: z.boolean().optional(),
        threads: z.boolean().optional(),
        voiceStatus: z.boolean().optional(),
      })
      .strict()
      .optional(),
    replyToMode: ReplyToModeSchema.optional(),
    // Aliases for channels.discord.dm.policy / channels.discord.dm.allowFrom. Prefer these for
    // Inheritance in multi-account setups (shallow merge works; nested dm object doesn't).
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: DiscordIdListSchema.optional(),
    defaultTo: z.string().optional(),
    dm: DiscordDmSchema.optional(),
    guilds: z.record(z.string(), DiscordGuildSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    execApprovals: z
      .object({
        agentFilter: z.array(z.string()).optional(),
        approvers: DiscordIdListSchema.optional(),
        cleanupAfterResolve: z.boolean().optional(),
        enabled: z.boolean().optional(),
        sessionFilter: z.array(z.string()).optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    agentComponents: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    ui: DiscordUiSchema,
    slashCommand: z
      .object({
        ephemeral: z.boolean().optional(),
      })
      .strict()
      .optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
        spawnAcpSessions: z.boolean().optional(),
        spawnSubagentSessions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    intents: z
      .object({
        guildMembers: z.boolean().optional(),
        presence: z.boolean().optional(),
      })
      .strict()
      .optional(),
    voice: DiscordVoiceSchema,
    pluralkit: z
      .object({
        enabled: z.boolean().optional(),
        token: SecretInputSchema.optional().register(sensitive),
      })
      .strict()
      .optional(),
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    activity: z.string().optional(),
    status: z.enum(["online", "dnd", "idle", "invisible"]).optional(),
    autoPresence: z
      .object({
        degradedText: z.string().optional(),
        enabled: z.boolean().optional(),
        exhaustedText: z.string().optional(),
        healthyText: z.string().optional(),
        intervalMs: z.number().int().positive().optional(),
        minUpdateIntervalMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    activityType: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    activityUrl: z.string().url().optional(),
    inboundWorker: z
      .object({
        runTimeoutMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    eventQueue: z
      .object({
        listenerTimeout: z.number().int().positive().optional(),
        maxConcurrency: z.number().int().positive().optional(),
        maxQueueSize: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const activityText = normalizeOptionalString(value.activity) ?? "";
    const hasActivity = Boolean(activityText);
    const hasActivityType = value.activityType !== undefined;
    const activityUrl = normalizeOptionalString(value.activityUrl) ?? "";
    const hasActivityUrl = Boolean(activityUrl);

    if ((hasActivityType || hasActivityUrl) && !hasActivity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activity is required when activityType or activityUrl is set",
        path: ["activity"],
      });
    }

    if (value.activityType === 1 && !hasActivityUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activityUrl is required when activityType is 1 (Streaming)",
        path: ["activityUrl"],
      });
    }

    if (hasActivityUrl && value.activityType !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "channels.discord.activityType must be 1 (Streaming) when activityUrl is set",
        path: ["activityType"],
      });
    }

    const autoPresenceInterval = value.autoPresence?.intervalMs;
    const autoPresenceMinUpdate = value.autoPresence?.minUpdateIntervalMs;
    if (
      typeof autoPresenceInterval === "number" &&
      typeof autoPresenceMinUpdate === "number" &&
      autoPresenceMinUpdate > autoPresenceInterval
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.discord.autoPresence.minUpdateIntervalMs must be less than or equal to channels.discord.autoPresence.intervalMs",
        path: ["autoPresence", "minUpdateIntervalMs"],
      });
    }

    // DM allowlist validation is enforced at DiscordConfigSchema so account entries
    // Can inherit top-level allowFrom via runtime shallow merge.
  });

export const DiscordConfigSchema = DiscordAccountSchema.extend({
  accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
  const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
  const allowFromPath =
    value.allowFrom !== undefined ? (["allowFrom"] as const) : (["dm", "allowFrom"] as const);
  requireOpenAllowFrom({
    allowFrom,
    ctx,
    message:
      'channels.discord.dmPolicy="open" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to include "*"',
    path: [...allowFromPath],
    policy: dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom,
    ctx,
    message:
      'channels.discord.dmPolicy="allowlist" requires channels.discord.allowFrom (or channels.discord.dm.allowFrom) to contain at least one sender ID',
    path: [...allowFromPath],
    policy: dmPolicy,
  });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy =
      account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
    const effectiveAllowFrom =
      account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.discord.accounts.*.dmPolicy="open" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.discord.accounts.*.dmPolicy="allowlist" requires channels.discord.accounts.*.allowFrom (or channels.discord.allowFrom) to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
  }
});

export const GoogleChatDmSchema = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("pairing"),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.googlechat.dm.policy="open" requires channels.googlechat.dm.allowFrom to include "*"',
      path: ["allowFrom"],
      policy: value.policy,
    });
    requireAllowlistAllowFrom({
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.googlechat.dm.policy="allowlist" requires channels.googlechat.dm.allowFrom to contain at least one sender ID',
      path: ["allowFrom"],
      policy: value.policy,
    });
  });

export const GoogleChatGroupSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    systemPrompt: z.string().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const GoogleChatAccountSchema = z
  .object({
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    allowBots: z.boolean().optional(),
    appPrincipal: z.string().optional(),
    audience: z.string().optional(),
    audienceType: z.enum(["app-url", "project-number"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    botUser: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    configWrites: z.boolean().optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    defaultTo: z.string().optional(),
    dm: GoogleChatDmSchema.optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), GoogleChatGroupSchema.optional()).optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    historyLimit: z.number().int().min(0).optional(),
    mediaMaxMb: z.number().positive().optional(),
    name: z.string().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    requireMention: z.boolean().optional(),
    responsePrefix: z.string().optional(),
    serviceAccount: z
      .union([z.string(), z.record(z.string(), z.unknown()), SecretRefSchema])
      .optional()
      .register(sensitive),
    serviceAccountFile: z.string().optional(),
    serviceAccountRef: SecretRefSchema.optional().register(sensitive),
    textChunkLimit: z.number().int().positive().optional(),
    typingIndicator: z.enum(["none", "message", "reaction"]).optional(),
    webhookPath: z.string().optional(),
    webhookUrl: z.string().optional(),
  })
  .strict();

export const GoogleChatConfigSchema = GoogleChatAccountSchema.extend({
  accounts: z.record(z.string(), GoogleChatAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});

export const SlackDmSchema = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    enabled: z.boolean().optional(),
    groupChannels: z.array(z.union([z.string(), z.number()])).optional(),
    groupEnabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
    replyToMode: ReplyToModeSchema.optional(),
  })
  .strict();

export const SlackChannelSchema = z
  .object({
    allowBots: z.boolean().optional(),
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    users: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

export const SlackThreadSchema = z
  .object({
    historyScope: z.enum(["thread", "channel"]).optional(),
    inheritParent: z.boolean().optional(),
    initialHistoryLimit: z.number().int().min(0).optional(),
    requireExplicitMention: z.boolean().optional(),
  })
  .strict();

const SlackReplyToModeByChatTypeSchema = z
  .object({
    channel: ReplyToModeSchema.optional(),
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
  })
  .strict();

export const SlackAccountSchema = z
  .object({
    name: z.string().optional(),
    mode: z.enum(["socket", "http"]).optional(),
    signingSecret: SecretInputSchema.optional().register(sensitive),
    webhookPath: z.string().optional(),
    capabilities: SlackCapabilitiesSchema.optional(),
    execApprovals: z
      .object({
        agentFilter: z.array(z.string()).optional(),
        approvers: z.array(z.union([z.string(), z.number()])).optional(),
        enabled: z.boolean().optional(),
        sessionFilter: z.array(z.string()).optional(),
        target: z.enum(["dm", "channel", "both"]).optional(),
      })
      .strict()
      .optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    configWrites: z.boolean().optional(),
    botToken: SecretInputSchema.optional().register(sensitive),
    appToken: SecretInputSchema.optional().register(sensitive),
    userToken: SecretInputSchema.optional().register(sensitive),
    userTokenReadOnly: z.boolean().optional().default(true),
    allowBots: z.boolean().optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    groupPolicy: GroupPolicySchema.optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    streaming: SlackStreamingConfigSchema.optional(),
    mediaMaxMb: z.number().positive().optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    replyToMode: ReplyToModeSchema.optional(),
    replyToModeByChatType: SlackReplyToModeByChatTypeSchema.optional(),
    thread: SlackThreadSchema.optional(),
    actions: z
      .object({
        channelInfo: z.boolean().optional(),
        emojiList: z.boolean().optional(),
        memberInfo: z.boolean().optional(),
        messages: z.boolean().optional(),
        permissions: z.boolean().optional(),
        pins: z.boolean().optional(),
        reactions: z.boolean().optional(),
        search: z.boolean().optional(),
      })
      .strict()
      .optional(),
    slashCommand: z
      .object({
        enabled: z.boolean().optional(),
        ephemeral: z.boolean().optional(),
        name: z.string().optional(),
        sessionPrefix: z.string().optional(),
      })
      .strict()
      .optional(),
    // Aliases for channels.slack.dm.policy / channels.slack.dm.allowFrom. Prefer these for
    // Inheritance in multi-account setups (shallow merge works; nested dm object doesn't).
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    dm: SlackDmSchema.optional(),
    channels: z.record(z.string(), SlackChannelSchema.optional()).optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
    ackReaction: z.string().optional(),
    typingReaction: z.string().optional(),
  })
  .strict()
  .superRefine(() => {
    // DM allowlist validation is enforced at SlackConfigSchema so account entries
    // Can inherit top-level allowFrom via runtime shallow merge.
  });

export const SlackConfigSchema = SlackAccountSchema.safeExtend({
  accounts: z.record(z.string(), SlackAccountSchema.optional()).optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  defaultAccount: z.string().optional(),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  mode: z.enum(["socket", "http"]).optional().default("socket"),
  signingSecret: SecretInputSchema.optional().register(sensitive),
  webhookPath: z.string().optional().default("/slack/events"),
}).superRefine((value, ctx) => {
  const dmPolicy = value.dmPolicy ?? value.dm?.policy ?? "pairing";
  const allowFrom = value.allowFrom ?? value.dm?.allowFrom;
  const allowFromPath =
    value.allowFrom !== undefined ? (["allowFrom"] as const) : (["dm", "allowFrom"] as const);
  requireOpenAllowFrom({
    allowFrom,
    ctx,
    message:
      'channels.slack.dmPolicy="open" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to include "*"',
    path: [...allowFromPath],
    policy: dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom,
    ctx,
    message:
      'channels.slack.dmPolicy="allowlist" requires channels.slack.allowFrom (or channels.slack.dm.allowFrom) to contain at least one sender ID',
    path: [...allowFromPath],
    policy: dmPolicy,
  });

  const baseMode = value.mode ?? "socket";
  if (!value.accounts) {
    validateSlackSigningSecretRequirements(value, ctx);
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    if (account.enabled === false) {
      continue;
    }
    const accountMode = account.mode ?? baseMode;
    const effectivePolicy =
      account.dmPolicy ?? account.dm?.policy ?? value.dmPolicy ?? value.dm?.policy ?? "pairing";
    const effectiveAllowFrom =
      account.allowFrom ?? account.dm?.allowFrom ?? value.allowFrom ?? value.dm?.allowFrom;
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.slack.accounts.*.dmPolicy="open" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.slack.accounts.*.dmPolicy="allowlist" requires channels.slack.accounts.*.allowFrom (or channels.slack.allowFrom) to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    if (accountMode !== "http") {
      continue;
    }
  }
  validateSlackSigningSecretRequirements(value, ctx);
});

const SignalGroupEntrySchema = z
  .object({
    ingest: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

export const SignalAccountSchemaBase = z
  .object({
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    autoStart: z.boolean().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    capabilities: z.array(z.string()).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    cliPath: ExecutableTokenSchema.optional(),
    configWrites: z.boolean().optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    defaultTo: z.string().optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: SignalGroupsSchema,
    healthMonitor: ChannelHealthMonitorSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    historyLimit: z.number().int().min(0).optional(),
    httpHost: z.string().optional(),
    httpPort: z.number().int().positive().optional(),
    httpUrl: z.string().optional(),
    ignoreAttachments: z.boolean().optional(),
    ignoreStories: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    mediaMaxMb: z.number().int().positive().optional(),
    name: z.string().optional(),
    reactionAllowlist: z.array(z.union([z.string(), z.number()])).optional(),
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    reactionNotifications: z.enum(["off", "own", "all", "allowlist"]).optional(),
    receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
    responsePrefix: z.string().optional(),
    sendReadReceipts: z.boolean().optional(),
    startupTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    textChunkLimit: z.number().int().positive().optional(),
  })
  .strict();

// Account-level schemas skip allowFrom validation because accounts inherit
// AllowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level SignalConfigSchema instead.
export const SignalAccountSchema = SignalAccountSchemaBase;

export const SignalConfigSchema = SignalAccountSchemaBase.extend({
  accounts: z.record(z.string(), SignalAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message: 'channels.signal.dmPolicy="open" requires channels.signal.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.signal.dmPolicy="allowlist" requires channels.signal.allowFrom to contain at least one sender ID',
    path: ["allowFrom"],
    policy: value.dmPolicy,
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
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.signal.accounts.*.dmPolicy="open" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.signal.accounts.*.dmPolicy="allowlist" requires channels.signal.accounts.*.allowFrom (or channels.signal.allowFrom) to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
  }
});

export const IrcGroupSchema = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    skills: z.array(z.string()).optional(),
    systemPrompt: z.string().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

export const IrcNickServSchema = z
  .object({
    enabled: z.boolean().optional(),
    password: SecretInputSchema.optional().register(sensitive),
    passwordFile: z.string().optional(),
    register: z.boolean().optional(),
    registerEmail: z.string().optional(),
    service: z.string().optional(),
  })
  .strict();

export const IrcAccountSchemaBase = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    capabilities: z.array(z.string()).optional(),
    channels: z.array(z.string()).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    configWrites: z.boolean().optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    defaultTo: z.string().optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    historyLimit: z.number().int().min(0).optional(),
    host: z.string().optional(),
    markdown: MarkdownConfigSchema,
    mediaMaxMb: z.number().positive().optional(),
    mentionPatterns: z.array(z.string()).optional(),
    name: z.string().optional(),
    nick: z.string().optional(),
    nickserv: IrcNickServSchema.optional(),
    password: SecretInputSchema.optional().register(sensitive),
    passwordFile: z.string().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    realname: z.string().optional(),
    responsePrefix: z.string().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    tls: z.boolean().optional(),
    username: z.string().optional(),
  })
  .strict();

type IrcBaseConfig = z.infer<typeof IrcAccountSchemaBase>;

function refineIrcAllowFromAndNickserv(value: IrcBaseConfig, ctx: z.RefinementCtx): void {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message: 'channels.irc.dmPolicy="open" requires channels.irc.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.irc.dmPolicy="allowlist" requires channels.irc.allowFrom to contain at least one sender ID',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
      path: ["nickserv", "registerEmail"],
    });
  }
}

// Account-level schemas skip allowFrom validation because accounts inherit
// AllowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level IrcConfigSchema instead.
export const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
  // Only validate nickserv at account level, not allowFrom (inherited from parent).
  if (value.nickserv?.register && !value.nickserv.registerEmail?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail",
      path: ["nickserv", "registerEmail"],
    });
  }
});

export const IrcConfigSchema = IrcAccountSchemaBase.extend({
  accounts: z.record(z.string(), IrcAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  refineIrcAllowFromAndNickserv(value, ctx);
  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    const effectivePolicy = account.dmPolicy ?? value.dmPolicy;
    const effectiveAllowFrom = account.allowFrom ?? value.allowFrom;
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.irc.accounts.*.dmPolicy="open" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.irc.accounts.*.dmPolicy="allowlist" requires channels.irc.accounts.*.allowFrom (or channels.irc.allowFrom) to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
  }
});

export const IMessageAccountSchemaBase = z
  .object({
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    attachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    capabilities: z.array(z.string()).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    cliPath: ExecutableTokenSchema.optional(),
    configWrites: z.boolean().optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    dbPath: z.string().optional(),
    defaultTo: z.string().optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            tools: ToolPolicySchema,
            toolsBySender: ToolPolicyBySenderSchema,
          })
          .strict()
          .optional(),
      )
      .optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    historyLimit: z.number().int().min(0).optional(),
    includeAttachments: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    mediaMaxMb: z.number().int().positive().optional(),
    name: z.string().optional(),
    region: z.string().optional(),
    remoteAttachmentRoots: z
      .array(z.string().refine(isValidInboundPathRootPattern, "expected absolute path root"))
      .optional(),
    remoteHost: z
      .string()
      .refine(isSafeScpRemoteHost, "expected SSH host or user@host (no spaces/options)")
      .optional(),
    responsePrefix: z.string().optional(),
    service: z.union([z.literal("imessage"), z.literal("sms"), z.literal("auto")]).optional(),
    textChunkLimit: z.number().int().positive().optional(),
  })
  .strict();

// Account-level schemas skip allowFrom validation because accounts inherit
// AllowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level IMessageConfigSchema instead.
export const IMessageAccountSchema = IMessageAccountSchemaBase;

export const IMessageConfigSchema = IMessageAccountSchemaBase.extend({
  accounts: z.record(z.string(), IMessageAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.imessage.dmPolicy="open" requires channels.imessage.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.imessage.dmPolicy="allowlist" requires channels.imessage.allowFrom to contain at least one sender ID',
    path: ["allowFrom"],
    policy: value.dmPolicy,
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
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.imessage.accounts.*.dmPolicy="open" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.imessage.accounts.*.dmPolicy="allowlist" requires channels.imessage.accounts.*.allowFrom (or channels.imessage.allowFrom) to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
  }
});

const BlueBubblesAllowFromEntry = z.union([z.string(), z.number()]);

const BlueBubblesActionSchema = z
  .object({
    addParticipant: z.boolean().optional(),
    edit: z.boolean().optional(),
    leaveGroup: z.boolean().optional(),
    reactions: z.boolean().optional(),
    removeParticipant: z.boolean().optional(),
    renameGroup: z.boolean().optional(),
    reply: z.boolean().optional(),
    sendAttachment: z.boolean().optional(),
    sendWithEffect: z.boolean().optional(),
    setGroupIcon: z.boolean().optional(),
    unsend: z.boolean().optional(),
  })
  .strict()
  .optional();

const BlueBubblesGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

export const BlueBubblesAccountSchemaBase = z
  .object({
    allowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    capabilities: z.array(z.string()).optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    configWrites: z.boolean().optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    enabled: z.boolean().optional(),
    enrichGroupParticipantsFromContacts: z.boolean().optional(),
    groupAllowFrom: z.array(BlueBubblesAllowFromEntry).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groups: z.record(z.string(), BlueBubblesGroupConfigSchema.optional()).optional(),
    healthMonitor: ChannelHealthMonitorSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    historyLimit: z.number().int().min(0).optional(),
    markdown: MarkdownConfigSchema,
    mediaLocalRoots: z.array(z.string()).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    name: z.string().optional(),
    network: z
      .object({
        dangerouslyAllowPrivateNetwork: z.boolean().optional(),
      })
      .strict()
      .optional(),
    password: SecretInputSchema.optional().register(sensitive),
    responsePrefix: z.string().optional(),
    sendReadReceipts: z.boolean().optional(),
    serverUrl: z.string().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    webhookPath: z.string().optional(),
  })
  .strict();

// Account-level schemas skip allowFrom validation because accounts inherit
// AllowFrom from the parent channel config at runtime.
// Validation is enforced at the top-level BlueBubblesConfigSchema instead.
export const BlueBubblesAccountSchema = BlueBubblesAccountSchemaBase;

export const BlueBubblesConfigSchema = BlueBubblesAccountSchemaBase.extend({
  accounts: z.record(z.string(), BlueBubblesAccountSchema.optional()).optional(),
  actions: BlueBubblesActionSchema,
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.bluebubbles.dmPolicy="open" requires channels.bluebubbles.allowFrom to include "*"',
    path: ["allowFrom"],
    policy: value.dmPolicy,
  });
  requireAllowlistAllowFrom({
    allowFrom: value.allowFrom,
    ctx,
    message:
      'channels.bluebubbles.dmPolicy="allowlist" requires channels.bluebubbles.allowFrom to contain at least one sender ID',
    path: ["allowFrom"],
    policy: value.dmPolicy,
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
    requireOpenAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.bluebubbles.accounts.*.dmPolicy="open" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to include "*"',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: effectiveAllowFrom,
      ctx,
      message:
        'channels.bluebubbles.accounts.*.dmPolicy="allowlist" requires channels.bluebubbles.accounts.*.allowFrom (or channels.bluebubbles.allowFrom) to contain at least one sender ID',
      path: ["accounts", accountId, "allowFrom"],
      policy: effectivePolicy,
    });
  }
});

export const MSTeamsChannelSchema = z
  .object({
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

export const MSTeamsTeamSchema = z
  .object({
    channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
  })
  .strict();

export const MSTeamsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    appId: z.string().optional(),
    appPassword: SecretInputSchema.optional().register(sensitive),
    tenantId: z.string().optional(),
    webhook: z
      .object({
        path: z.string().optional(),
        port: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    typingIndicator: z.boolean().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    mediaAuthAllowHosts: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
    /** Max media size in MB (default: 100MB for OneDrive upload support). */
    mediaMaxMb: z.number().positive().optional(),
    /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
    sharePointSiteId: z.string().optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
    responsePrefix: z.string().optional(),
    welcomeCard: z.boolean().optional(),
    promptStarters: z.array(z.string()).optional(),
    groupWelcomeCard: z.boolean().optional(),
    feedbackEnabled: z.boolean().optional(),
    feedbackReflection: z.boolean().optional(),
    feedbackReflectionCooldownMs: z.number().int().min(0).optional(),
    sso: z
      .object({
        connectionName: z.string().optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.msteams.dmPolicy="open" requires channels.msteams.allowFrom to include "*"',
      path: ["allowFrom"],
      policy: value.dmPolicy,
    });
    requireAllowlistAllowFrom({
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.msteams.dmPolicy="allowlist" requires channels.msteams.allowFrom to contain at least one sender ID',
      path: ["allowFrom"],
      policy: value.dmPolicy,
    });
    if (value.sso?.enabled === true && !value.sso.connectionName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.msteams.sso.enabled=true requires channels.msteams.sso.connectionName to identify the Bot Framework OAuth connection",
        path: ["sso", "connectionName"],
      });
    }
  });
