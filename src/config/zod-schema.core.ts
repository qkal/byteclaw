import path from "node:path";
import { z } from "zod";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
} from "../secrets/ref-contract.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import type { ModelCompatConfig } from "./types.models.js";
import { MODEL_APIS } from "./types.models.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import { sensitive } from "./zod-schema.sensitive.js";

const ENV_SECRET_REF_ID_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

const EnvSecretRefSchema = z
  .object({
    id: z
      .string()
      .regex(
        ENV_SECRET_REF_ID_PATTERN,
        'Env secret reference id must match /^[A-Z][A-Z0-9_]{0,127}$/ (example: "OPENAI_API_KEY").',
      ),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    source: z.literal("env"),
  })
  .strict();

const FileSecretRefSchema = z
  .object({
    id: z
      .string()
      .refine(
        isValidFileSecretRefId,
        'File secret reference id must be an absolute JSON pointer (example: "/providers/openai/apiKey"), or "value" for singleValue mode.',
      ),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    source: z.literal("file"),
  })
  .strict();

const ExecSecretRefSchema = z
  .object({
    id: z.string().refine(isValidExecSecretRefId, formatExecSecretRefIdValidationMessage()),
    provider: z
      .string()
      .regex(
        SECRET_PROVIDER_ALIAS_PATTERN,
        'Secret reference provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").',
      ),
    source: z.literal("exec"),
  })
  .strict();

export const SecretRefSchema = z.discriminatedUnion("source", [
  EnvSecretRefSchema,
  FileSecretRefSchema,
  ExecSecretRefSchema,
]);

export const SecretInputSchema = z.union([z.string(), SecretRefSchema]);

const SecretsEnvProviderSchema = z
  .object({
    allowlist: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(256).optional(),
    source: z.literal("env"),
  })
  .strict();

const SecretsFileProviderSchema = z
  .object({
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
    mode: z.union([z.literal("singleValue"), z.literal("json")]).optional(),
    path: z.string().min(1),
    source: z.literal("file"),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

const SecretsExecProviderSchema = z
  .object({
    allowInsecurePath: z.boolean().optional(),
    allowSymlinkCommand: z.boolean().optional(),
    args: z.array(z.string().max(1024)).max(128).optional(),
    command: z
      .string()
      .min(1)
      .refine((value) => isSafeExecutableValue(value), "secrets.providers.*.command is unsafe.")
      .refine(
        (value) => isAbsolutePath(value),
        "secrets.providers.*.command must be an absolute path.",
      ),
    env: z.record(z.string(), z.string()).optional(),
    jsonOnly: z.boolean().optional(),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(20 * 1024 * 1024)
      .optional(),
    noOutputTimeoutMs: z.number().int().positive().max(120_000).optional(),
    passEnv: z.array(z.string().regex(ENV_SECRET_REF_ID_PATTERN)).max(128).optional(),
    source: z.literal("exec"),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    trustedDirs: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => isAbsolutePath(value), "trustedDirs entries must be absolute paths."),
      )
      .max(64)
      .optional(),
  })
  .strict();

export const SecretProviderSchema = z.discriminatedUnion("source", [
  SecretsEnvProviderSchema,
  SecretsFileProviderSchema,
  SecretsExecProviderSchema,
]);

export const SecretsConfigSchema = z
  .object({
    defaults: z
      .object({
        env: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        exec: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
        file: z.string().regex(SECRET_PROVIDER_ALIAS_PATTERN).optional(),
      })
      .strict()
      .optional(),
    providers: z
      .object({
        // Keep this as a record so users can define multiple providers per source.
      })
      .catchall(SecretProviderSchema)
      .optional(),
    resolution: z
      .object({
        maxBatchBytes: z
          .number()
          .int()
          .positive()
          .max(5 * 1024 * 1024)
          .optional(),
        maxProviderConcurrency: z.number().int().positive().max(16).optional(),
        maxRefsPerProvider: z.number().int().positive().max(4096).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const ModelApiSchema = z.enum(MODEL_APIS);

export const ModelCompatSchema = z
  .object({
    maxTokensField: z
      .union([z.literal("max_completion_tokens"), z.literal("max_tokens")])
      .optional(),
    nativeWebSearchTool: z.boolean().optional(),
    requiresAssistantAfterToolResult: z.boolean().optional(),
    requiresMistralToolIds: z.boolean().optional(),
    requiresOpenAiAnthropicToolPayload: z.boolean().optional(),
    requiresStringContent: z.boolean().optional(),
    requiresThinkingAsText: z.boolean().optional(),
    requiresToolResultName: z.boolean().optional(),
    supportsDeveloperRole: z.boolean().optional(),
    supportsReasoningEffort: z.boolean().optional(),
    supportsStore: z.boolean().optional(),
    supportsStrictMode: z.boolean().optional(),
    supportsTools: z.boolean().optional(),
    supportsUsageInStreaming: z.boolean().optional(),
    thinkingFormat: z
      .union([
        z.literal("openai"),
        z.literal("openrouter"),
        z.literal("zai"),
        z.literal("qwen"),
        z.literal("qwen-chat-template"),
      ])
      .optional(),
    toolCallArgumentsEncoding: z.string().optional(),
    toolSchemaProfile: z.string().optional(),
    unsupportedToolSchemaKeywords: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .optional();

type AssertAssignable<_T extends U, U> = true;
type _ModelCompatSchemaAssignableToType = AssertAssignable<
  z.infer<typeof ModelCompatSchema>,
  ModelCompatConfig | undefined
>;
type _ModelCompatTypeAssignableToSchema = AssertAssignable<
  ModelCompatConfig | undefined,
  z.infer<typeof ModelCompatSchema>
>;

const ConfiguredProviderRequestTlsSchema = z
  .object({
    ca: SecretInputSchema.optional().register(sensitive),
    cert: SecretInputSchema.optional().register(sensitive),
    insecureSkipVerify: z.boolean().optional(),
    key: SecretInputSchema.optional().register(sensitive),
    passphrase: SecretInputSchema.optional().register(sensitive),
    serverName: z.string().optional(),
  })
  .strict()
  .optional();

const ConfiguredProviderRequestAuthSchema = z
  .union([
    z
      .object({
        mode: z.literal("provider-default"),
      })
      .strict(),
    z
      .object({
        mode: z.literal("authorization-bearer"),
        token: SecretInputSchema.register(sensitive),
      })
      .strict(),
    z
      .object({
        headerName: z.string().min(1),
        mode: z.literal("header"),
        prefix: z.string().optional(),
        value: SecretInputSchema.register(sensitive),
      })
      .strict(),
  ])
  .optional();

const ConfiguredProviderRequestProxySchema = z
  .union([
    z
      .object({
        mode: z.literal("env-proxy"),
        tls: ConfiguredProviderRequestTlsSchema,
      })
      .strict(),
    z
      .object({
        mode: z.literal("explicit-proxy"),
        tls: ConfiguredProviderRequestTlsSchema,
        url: z.string().min(1),
      })
      .strict(),
  ])
  .optional();

const ConfiguredProviderRequestFields = {
  auth: ConfiguredProviderRequestAuthSchema,
  headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
  proxy: ConfiguredProviderRequestProxySchema,
  tls: ConfiguredProviderRequestTlsSchema,
};

const ConfiguredProviderRequestSchema = z
  .object(ConfiguredProviderRequestFields)
  .strict()
  .optional();

const ConfiguredModelProviderRequestSchema = z
  .object({
    ...ConfiguredProviderRequestFields,
    allowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

export const ModelDefinitionSchema = z
  .object({
    api: ModelApiSchema.optional(),
    compat: ModelCompatSchema,
    contextTokens: z.number().int().positive().optional(),
    contextWindow: z.number().positive().optional(),
    cost: z
      .object({
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
        input: z.number().optional(),
        output: z.number().optional(),
      })
      .strict()
      .optional(),
    headers: z.record(z.string(), z.string()).optional(),
    id: z.string().min(1),
    input: z.array(z.union([z.literal("text"), z.literal("image")])).optional(),
    maxTokens: z.number().positive().optional(),
    name: z.string().min(1),
    reasoning: z.boolean().optional(),
  })
  .strict();

export const ModelProviderSchema = z
  .object({
    api: ModelApiSchema.optional(),
    apiKey: SecretInputSchema.optional().register(sensitive),
    auth: z
      .union([z.literal("api-key"), z.literal("aws-sdk"), z.literal("oauth"), z.literal("token")])
      .optional(),
    authHeader: z.boolean().optional(),
    baseUrl: z.string().min(1),
    headers: z.record(z.string(), SecretInputSchema.register(sensitive)).optional(),
    injectNumCtxForOpenAICompat: z.boolean().optional(),
    models: z.array(ModelDefinitionSchema),
    request: ConfiguredModelProviderRequestSchema,
  })
  .strict();

export const BedrockDiscoverySchema = z
  .object({
    defaultContextWindow: z.number().int().positive().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    providerFilter: z.array(z.string()).optional(),
    refreshInterval: z.number().int().nonnegative().optional(),
    region: z.string().optional(),
  })
  .strict()
  .optional();

export const ModelsConfigSchema = z
  .object({
    mode: z.union([z.literal("merge"), z.literal("replace")]).optional(),
    providers: z.record(z.string(), ModelProviderSchema).optional(),
  })
  .strict()
  .optional();

export const GroupChatSchema = z
  .object({
    historyLimit: z.number().int().positive().optional(),
    mentionPatterns: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const DmConfigSchema = z
  .object({
    historyLimit: z.number().int().min(0).optional(),
  })
  .strict();

export const IdentitySchema = z
  .object({
    avatar: z.string().optional(),
    emoji: z.string().optional(),
    name: z.string().optional(),
    theme: z.string().optional(),
  })
  .strict()
  .optional();

export const QueueModeSchema = z.union([
  z.literal("steer"),
  z.literal("followup"),
  z.literal("collect"),
  z.literal("steer-backlog"),
  z.literal("steer+backlog"),
  z.literal("queue"),
  z.literal("interrupt"),
]);
export const QueueDropSchema = z.union([
  z.literal("old"),
  z.literal("new"),
  z.literal("summarize"),
]);
export const ReplyToModeSchema = z.union([
  z.literal("off"),
  z.literal("first"),
  z.literal("all"),
  z.literal("batched"),
]);
export const TypingModeSchema = z.union([
  z.literal("never"),
  z.literal("instant"),
  z.literal("thinking"),
  z.literal("message"),
]);

// GroupPolicySchema: controls how group messages are handled
// Used with .default("allowlist").optional() pattern:
//   - .optional() allows field omission in input config
//   - .default("allowlist") ensures runtime always resolves to "allowlist" if not provided
export const GroupPolicySchema = z.enum(["open", "disabled", "allowlist"]);

export const DmPolicySchema = z.enum(["pairing", "allowlist", "open", "disabled"]);
export const ContextVisibilityModeSchema = z.enum(["all", "allowlist", "allowlist_quote"]);

export const BlockStreamingCoalesceSchema = z
  .object({
    idleMs: z.number().int().nonnegative().optional(),
    maxChars: z.number().int().positive().optional(),
    minChars: z.number().int().positive().optional(),
  })
  .strict();

export const ReplyRuntimeConfigSchemaShape = {
  blockStreaming: z.boolean().optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  contextVisibility: ContextVisibilityModeSchema.optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
  historyLimit: z.number().int().min(0).optional(),
  mediaMaxMb: z.number().positive().optional(),
  responsePrefix: z.string().optional(),
  textChunkLimit: z.number().int().positive().optional(),
};

export const BlockStreamingChunkSchema = z
  .object({
    breakPreference: z
      .union([z.literal("paragraph"), z.literal("newline"), z.literal("sentence")])
      .optional(),
    maxChars: z.number().int().positive().optional(),
    minChars: z.number().int().positive().optional(),
  })
  .strict();

export const MarkdownTableModeSchema = z.enum(["off", "bullets", "code", "block"]);

export const MarkdownConfigSchema = z
  .object({
    tables: MarkdownTableModeSchema.optional(),
  })
  .strict()
  .optional();

export const TtsProviderSchema = z.string().min(1);
export const TtsModeSchema = z.enum(["final", "all"]);
export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
const TtsProviderConfigSchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ]),
  );
export const TtsConfigSchema = z
  .object({
    auto: TtsAutoSchema.optional(),
    enabled: z.boolean().optional(),
    maxTextLength: z.number().int().min(1).optional(),
    mode: TtsModeSchema.optional(),
    modelOverrides: z
      .object({
        allowModelId: z.boolean().optional(),
        allowNormalization: z.boolean().optional(),
        allowProvider: z.boolean().optional(),
        allowSeed: z.boolean().optional(),
        allowText: z.boolean().optional(),
        allowVoice: z.boolean().optional(),
        allowVoiceSettings: z.boolean().optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    prefsPath: z.string().optional(),
    provider: TtsProviderSchema.optional(),
    providers: z.record(z.string(), TtsProviderConfigSchema).optional(),
    summaryModel: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  })
  .strict()
  .optional();

export const HumanDelaySchema = z
  .object({
    maxMs: z.number().int().nonnegative().optional(),
    minMs: z.number().int().nonnegative().optional(),
    mode: z.union([z.literal("off"), z.literal("natural"), z.literal("custom")]).optional(),
  })
  .strict();

const CliBackendWatchdogModeSchema = z
  .object({
    maxMs: z.number().int().min(1000).optional(),
    minMs: z.number().int().min(1000).optional(),
    noOutputTimeoutMs: z.number().int().min(1000).optional(),
    noOutputTimeoutRatio: z.number().min(0.05).max(0.95).optional(),
  })
  .strict()
  .optional();

export const CliBackendSchema = z
  .object({
    args: z.array(z.string()).optional(),
    clearEnv: z.array(z.string()).optional(),
    command: z.string(),
    env: z.record(z.string(), z.string()).optional(),
    imageArg: z.string().optional(),
    imageMode: z.union([z.literal("repeat"), z.literal("list")]).optional(),
    imagePathScope: z.union([z.literal("temp"), z.literal("workspace")]).optional(),
    input: z.union([z.literal("arg"), z.literal("stdin")]).optional(),
    maxPromptArgChars: z.number().int().positive().optional(),
    modelAliases: z.record(z.string(), z.string()).optional(),
    modelArg: z.string().optional(),
    output: z.union([z.literal("json"), z.literal("text"), z.literal("jsonl")]).optional(),
    reliability: z
      .object({
        watchdog: z
          .object({
            fresh: CliBackendWatchdogModeSchema,
            resume: CliBackendWatchdogModeSchema,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    resumeArgs: z.array(z.string()).optional(),
    resumeOutput: z.union([z.literal("json"), z.literal("text"), z.literal("jsonl")]).optional(),
    serialize: z.boolean().optional(),
    sessionArg: z.string().optional(),
    sessionArgs: z.array(z.string()).optional(),
    sessionIdFields: z.array(z.string()).optional(),
    sessionMode: z
      .union([z.literal("always"), z.literal("existing"), z.literal("none")])
      .optional(),
    systemPromptArg: z.string().optional(),
    systemPromptFileConfigArg: z.string().optional(),
    systemPromptFileConfigKey: z.string().optional(),
    systemPromptMode: z.union([z.literal("append"), z.literal("replace")]).optional(),
    systemPromptWhen: z
      .union([z.literal("first"), z.literal("always"), z.literal("never")])
      .optional(),
  })
  .strict();

export const normalizeAllowFrom = (values?: (string | number)[]): string[] =>
  normalizeStringEntries(values);

export const requireOpenAllowFrom = (params: {
  policy?: string;
  allowFrom?: (string | number)[];
  ctx: z.RefinementCtx;
  path: (string | number)[];
  message: string;
}) => {
  if (params.policy !== "open") {
    return;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: params.message,
    path: params.path,
  });
};

/**
 * Validate that dmPolicy="allowlist" has a non-empty allowFrom array.
 * Without this, all DMs are silently dropped because the allowlist is empty
 * and no senders can match.
 */
export const requireAllowlistAllowFrom = (params: {
  policy?: string;
  allowFrom?: (string | number)[];
  ctx: z.RefinementCtx;
  path: (string | number)[];
  message: string;
}) => {
  if (params.policy !== "allowlist") {
    return;
  }
  const allow = normalizeAllowFrom(params.allowFrom);
  if (allow.length > 0) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: params.message,
    path: params.path,
  });
};

export const MSTeamsReplyStyleSchema = z.enum(["thread", "top-level"]);

export const RetryConfigSchema = z
  .object({
    attempts: z.number().int().min(1).optional(),
    jitter: z.number().min(0).max(1).optional(),
    maxDelayMs: z.number().int().min(0).optional(),
    minDelayMs: z.number().int().min(0).optional(),
  })
  .strict()
  .optional();

export const QueueModeBySurfaceSchema = z
  .object({
    discord: QueueModeSchema.optional(),
    imessage: QueueModeSchema.optional(),
    irc: QueueModeSchema.optional(),
    mattermost: QueueModeSchema.optional(),
    msteams: QueueModeSchema.optional(),
    signal: QueueModeSchema.optional(),
    slack: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
    whatsapp: QueueModeSchema.optional(),
  })
  .strict()
  .optional();

export const DebounceMsBySurfaceSchema = z
  .record(z.string(), z.number().int().nonnegative())
  .optional();

export const QueueSchema = z
  .object({
    byChannel: QueueModeBySurfaceSchema,
    cap: z.number().int().positive().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    debounceMsByChannel: DebounceMsBySurfaceSchema,
    drop: QueueDropSchema.optional(),
    mode: QueueModeSchema.optional(),
  })
  .strict()
  .optional();

export const InboundDebounceSchema = z
  .object({
    byChannel: DebounceMsBySurfaceSchema,
    debounceMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

export const TranscribeAudioSchema = z
  .object({
    command: z.array(z.string()).superRefine((value, ctx) => {
      const executable = value[0];
      if (!isSafeExecutableValue(executable)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "expected safe executable name or path",
          path: [0],
        });
      }
    }),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const HexColorSchema = z.string().regex(/^#?[0-9a-fA-F]{6}$/, "expected hex color (RRGGBB)");

export const ExecutableTokenSchema = z
  .string()
  .refine(isSafeExecutableValue, "expected safe executable name or path");

export const MediaUnderstandingScopeSchema = createAllowDenyChannelRulesSchema();

export const MediaUnderstandingCapabilitiesSchema = z
  .array(z.union([z.literal("image"), z.literal("audio"), z.literal("video")]))
  .optional();

export const MediaUnderstandingAttachmentsSchema = z
  .object({
    maxAttachments: z.number().int().positive().optional(),
    mode: z.union([z.literal("first"), z.literal("all")]).optional(),
    prefer: z
      .union([z.literal("first"), z.literal("last"), z.literal("path"), z.literal("url")])
      .optional(),
  })
  .strict()
  .optional();

const DeepgramAudioSchema = z
  .object({
    detectLanguage: z.boolean().optional(),
    punctuate: z.boolean().optional(),
    smartFormat: z.boolean().optional(),
  })
  .strict()
  .optional();

const ProviderOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const ProviderOptionsSchema = z
  .record(z.string(), z.record(z.string(), ProviderOptionValueSchema))
  .optional();

const MediaUnderstandingRuntimeFields = {
  baseUrl: z.string().optional(),
  deepgram: DeepgramAudioSchema,
  headers: z.record(z.string(), z.string()).optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
  providerOptions: ProviderOptionsSchema,
  request: ConfiguredProviderRequestSchema,
  timeoutSeconds: z.number().int().positive().optional(),
};

export const MediaUnderstandingModelSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    capabilities: MediaUnderstandingCapabilitiesSchema,
    type: z.union([z.literal("provider"), z.literal("cli")]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    maxChars: z.number().int().positive().optional(),
    maxBytes: z.number().int().positive().optional(),
    ...MediaUnderstandingRuntimeFields,
    profile: z.string().optional(),
    preferredProfile: z.string().optional(),
  })
  .strict()
  .optional();

export const ToolsMediaUnderstandingSchema = z
  .object({
    enabled: z.boolean().optional(),
    scope: MediaUnderstandingScopeSchema,
    maxBytes: z.number().int().positive().optional(),
    maxChars: z.number().int().positive().optional(),
    ...MediaUnderstandingRuntimeFields,
    attachments: MediaUnderstandingAttachmentsSchema,
    models: z.array(MediaUnderstandingModelSchema).optional(),
    echoTranscript: z.boolean().optional(),
    echoFormat: z.string().optional(),
  })
  .strict()
  .optional();

export const ToolsMediaSchema = z
  .object({
    audio: ToolsMediaUnderstandingSchema.optional(),
    concurrency: z.number().int().positive().optional(),
    image: ToolsMediaUnderstandingSchema.optional(),
    models: z.array(MediaUnderstandingModelSchema).optional(),
    video: ToolsMediaUnderstandingSchema.optional(),
  })
  .strict()
  .optional();

export const LinkModelSchema = z
  .object({
    args: z.array(z.string()).optional(),
    command: z.string().min(1),
    timeoutSeconds: z.number().int().positive().optional(),
    type: z.literal("cli").optional(),
  })
  .strict();

export const ToolsLinksSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxLinks: z.number().int().positive().optional(),
    models: z.array(LinkModelSchema).optional(),
    scope: MediaUnderstandingScopeSchema,
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);

export const ProviderCommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional(),
    nativeSkills: NativeCommandsSettingSchema.optional(),
  })
  .strict()
  .optional();
