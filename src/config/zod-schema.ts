import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";
import { AgentsSchema, AudioSchema, BindingsSchema, BroadcastSchema } from "./zod-schema.agents.js";
import { ApprovalsSchema } from "./zod-schema.approvals.js";
import {
  HexColorSchema,
  ModelsConfigSchema,
  SecretInputSchema,
  SecretsConfigSchema,
} from "./zod-schema.core.js";
import { HookMappingSchema, HooksGmailSchema, InternalHooksSchema } from "./zod-schema.hooks.js";
import { PluginInstallRecordShape } from "./zod-schema.installs.js";
import { ChannelsSchema } from "./zod-schema.providers.js";
import { sensitive } from "./zod-schema.sensitive.js";
import {
  CommandsSchema,
  MessagesSchema,
  SessionSchema,
  SessionSendPolicySchema,
} from "./zod-schema.session.js";

const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

const NodeHostSchema = z
  .object({
    browserProxy: z
      .object({
        allowProfiles: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const MemoryQmdPathSchema = z
  .object({
    name: z.string().optional(),
    path: z.string(),
    pattern: z.string().optional(),
  })
  .strict();

const MemoryQmdSessionSchema = z
  .object({
    enabled: z.boolean().optional(),
    exportDir: z.string().optional(),
    retentionDays: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdUpdateSchema = z
  .object({
    commandTimeoutMs: z.number().int().nonnegative().optional(),
    debounceMs: z.number().int().nonnegative().optional(),
    embedInterval: z.string().optional(),
    embedTimeoutMs: z.number().int().nonnegative().optional(),
    interval: z.string().optional(),
    onBoot: z.boolean().optional(),
    updateTimeoutMs: z.number().int().nonnegative().optional(),
    waitForBootSync: z.boolean().optional(),
  })
  .strict();

const MemoryQmdLimitsSchema = z
  .object({
    maxInjectedChars: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().optional(),
    maxSnippetChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const MemoryQmdMcporterSchema = z
  .object({
    enabled: z.boolean().optional(),
    serverName: z.string().optional(),
    startDaemon: z.boolean().optional(),
  })
  .strict();

const LoggingLevelSchema = z.union([
  z.literal("silent"),
  z.literal("fatal"),
  z.literal("error"),
  z.literal("warn"),
  z.literal("info"),
  z.literal("debug"),
  z.literal("trace"),
]);

const MemoryQmdSchema = z
  .object({
    command: z.string().optional(),
    includeDefaultMemory: z.boolean().optional(),
    limits: MemoryQmdLimitsSchema.optional(),
    mcporter: MemoryQmdMcporterSchema.optional(),
    paths: z.array(MemoryQmdPathSchema).optional(),
    scope: SessionSendPolicySchema.optional(),
    searchMode: z.union([z.literal("query"), z.literal("search"), z.literal("vsearch")]).optional(),
    searchTool: z.string().trim().min(1).optional(),
    sessions: MemoryQmdSessionSchema.optional(),
    update: MemoryQmdUpdateSchema.optional(),
  })
  .strict();

const MemorySchema = z
  .object({
    backend: z.union([z.literal("builtin"), z.literal("qmd")]).optional(),
    citations: z.union([z.literal("auto"), z.literal("on"), z.literal("off")]).optional(),
    qmd: MemoryQmdSchema.optional(),
  })
  .strict()
  .optional();

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  }, "Expected http:// or https:// URL");

const ResponsesEndpointUrlFetchShape = {
  allowUrl: z.boolean().optional(),
  allowedMimes: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  urlAllowlist: z.array(z.string()).optional(),
};

const SkillEntrySchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const PluginEntrySchema = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
    hooks: z
      .object({
        allowPromptInjection: z.boolean().optional(),
      })
      .strict()
      .optional(),
    subagent: z
      .object({
        allowModelOverride: z.boolean().optional(),
        allowedModels: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const TalkProviderEntrySchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
  })
  .catchall(z.unknown());

const TalkSchema = z
  .object({
    interruptOnSpeech: z.boolean().optional(),
    provider: z.string().optional(),
    providers: z.record(z.string(), TalkProviderEntrySchema).optional(),
    silenceTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((talk, ctx) => {
    const provider = normalizeLowercaseStringOrEmpty(talk.provider ?? "");
    const providers = talk.providers ? Object.keys(talk.providers) : [];

    if (provider && providers.length > 0 && !(provider in talk.providers!)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `talk.provider must match a key in talk.providers (missing "${provider}")`,
        path: ["provider"],
      });
    }

    if (!provider && providers.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "talk.provider is required when talk.providers defines multiple providers",
        path: ["provider"],
      });
    }
  });

const McpServerSchema = z
  .object({
    args: z.array(z.string()).optional(),
    command: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    url: HttpUrlSchema.optional(),
    workingDirectory: z.string().optional(),
  })
  .catchall(z.unknown());

const McpConfigSchema = z
  .object({
    servers: z.record(z.string(), McpServerSchema).optional(),
  })
  .strict()
  .optional();

export const OpenClawSchema = z
  .object({
    $schema: z.string().optional(),
    acp: z
      .object({
        allowedAgents: z.array(z.string()).optional(),
        backend: z.string().optional(),
        defaultAgent: z.string().optional(),
        dispatch: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        enabled: z.boolean().optional(),
        maxConcurrentSessions: z.number().int().positive().optional(),
        runtime: z
          .object({
            ttlMinutes: z.number().int().positive().optional(),
            installCommand: z.string().optional(),
          })
          .strict()
          .optional(),
        stream: z
          .object({
            coalesceIdleMs: z.number().int().nonnegative().optional(),
            maxChunkChars: z.number().int().positive().optional(),
            repeatSuppression: z.boolean().optional(),
            deliveryMode: z.union([z.literal("live"), z.literal("final_only")]).optional(),
            hiddenBoundarySeparator: z
              .union([
                z.literal("none"),
                z.literal("space"),
                z.literal("newline"),
                z.literal("paragraph"),
              ])
              .optional(),
            maxOutputChars: z.number().int().positive().optional(),
            maxSessionUpdateChars: z.number().int().positive().optional(),
            tagVisibility: z.record(z.string(), z.boolean()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    agents: AgentsSchema,
    approvals: ApprovalsSchema,
    audio: AudioSchema,
    auth: z
      .object({
        cooldowns: z
          .object({
            billingBackoffHours: z.number().positive().optional(),
            billingBackoffHoursByProvider: z.record(z.string(), z.number().positive()).optional(),
            billingMaxHours: z.number().positive().optional(),
            authPermanentBackoffMinutes: z.number().positive().optional(),
            authPermanentMaxMinutes: z.number().positive().optional(),
            failureWindowHours: z.number().positive().optional(),
            overloadedProfileRotations: z.number().int().nonnegative().optional(),
            overloadedBackoffMs: z.number().int().nonnegative().optional(),
            rateLimitedProfileRotations: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        order: z.record(z.string(), z.array(z.string())).optional(),
        profiles: z
          .record(
            z.string(),
            z
              .object({
                provider: z.string(),
                mode: z.union([z.literal("api_key"), z.literal("oauth"), z.literal("token")]),
                email: z.string().optional(),
                displayName: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    bindings: BindingsSchema,
    broadcast: BroadcastSchema,
    browser: z
      .object({
        attachOnly: z.boolean().optional(),
        cdpPortRangeStart: z.number().int().min(1).max(65535).optional(),
        cdpUrl: z.string().optional(),
        color: z.string().optional(),
        defaultProfile: z.string().optional(),
        enabled: z.boolean().optional(),
        evaluateEnabled: z.boolean().optional(),
        executablePath: z.string().optional(),
        extraArgs: z.array(z.string()).optional(),
        headless: z.boolean().optional(),
        noSandbox: z.boolean().optional(),
        profiles: z
          .record(
            z
              .string()
              .regex(/^[a-z0-9-]+$/, "Profile names must be alphanumeric with hyphens only"),
            z
              .object({
                cdpPort: z.number().int().min(1).max(65535).optional(),
                cdpUrl: z.string().optional(),
                userDataDir: z.string().optional(),
                driver: z
                  .union([z.literal("openclaw"), z.literal("clawd"), z.literal("existing-session")])
                  .optional(),
                attachOnly: z.boolean().optional(),
                color: HexColorSchema,
              })
              .strict()
              .refine(
                (value) => value.driver === "existing-session" || value.cdpPort || value.cdpUrl,
                {
                  message: "Profile must set cdpPort or cdpUrl",
                },
              )
              .refine((value) => value.driver === "existing-session" || !value.userDataDir, {
                message: 'Profile userDataDir is only supported with driver="existing-session"',
              }),
          )
          .optional(),
        remoteCdpHandshakeTimeoutMs: z.number().int().nonnegative().optional(),
        remoteCdpTimeoutMs: z.number().int().nonnegative().optional(),
        snapshotDefaults: BrowserSnapshotDefaultsSchema,
        ssrfPolicy: z
          .object({
            dangerouslyAllowPrivateNetwork: z.boolean().optional(),
            allowedHostnames: z.array(z.string()).optional(),
            hostnameAllowlist: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    canvasHost: z
      .object({
        enabled: z.boolean().optional(),
        liveReload: z.boolean().optional(),
        port: z.number().int().positive().optional(),
        root: z.string().optional(),
      })
      .strict()
      .optional(),
    channels: ChannelsSchema,
    cli: z
      .object({
        banner: z
          .object({
            taglineMode: z
              .union([z.literal("random"), z.literal("default"), z.literal("off")])
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    commands: CommandsSchema,
    cron: z
      .object({
        enabled: z.boolean().optional(),
        failureAlert: z
          .object({
            enabled: z.boolean().optional(),
            after: z.number().int().min(1).optional(),
            cooldownMs: z.number().int().min(0).optional(),
            mode: z.enum(["announce", "webhook"]).optional(),
            accountId: z.string().optional(),
          })
          .strict()
          .optional(),
        failureDestination: z
          .object({
            channel: z.string().optional(),
            to: z.string().optional(),
            accountId: z.string().optional(),
            mode: z.enum(["announce", "webhook"]).optional(),
          })
          .strict()
          .optional(),
        maxConcurrentRuns: z.number().int().positive().optional(),
        retry: z
          .object({
            maxAttempts: z.number().int().min(0).max(10).optional(),
            backoffMs: z.array(z.number().int().nonnegative()).min(1).max(10).optional(),
            retryOn: z
              .array(z.enum(["rate_limit", "overloaded", "network", "timeout", "server_error"]))
              .min(1)
              .optional(),
          })
          .strict()
          .optional(),
        runLog: z
          .object({
            maxBytes: z.union([z.string(), z.number()]).optional(),
            keepLines: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        sessionRetention: z.union([z.string(), z.literal(false)]).optional(),
        store: z.string().optional(),
        webhook: HttpUrlSchema.optional(),
        webhookToken: SecretInputSchema.optional().register(sensitive),
      })
      .strict()
      .superRefine((val, ctx) => {
        if (val.sessionRetention !== undefined && val.sessionRetention !== false) {
          try {
            parseDurationMs(normalizeStringifiedOptionalString(val.sessionRetention) ?? "", {
              defaultUnit: "h",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid duration (use ms, s, m, h, d)",
              path: ["sessionRetention"],
            });
          }
        }
        if (val.runLog?.maxBytes !== undefined) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.runLog.maxBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid size (use b, kb, mb, gb, tb)",
              path: ["runLog", "maxBytes"],
            });
          }
        }
      })
      .optional(),
    diagnostics: z
      .object({
        cacheTrace: z
          .object({
            enabled: z.boolean().optional(),
            filePath: z.string().optional(),
            includeMessages: z.boolean().optional(),
            includePrompt: z.boolean().optional(),
            includeSystem: z.boolean().optional(),
          })
          .strict()
          .optional(),
        enabled: z.boolean().optional(),
        flags: z.array(z.string()).optional(),
        otel: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            protocol: z.union([z.literal("http/protobuf"), z.literal("grpc")]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            serviceName: z.string().optional(),
            traces: z.boolean().optional(),
            metrics: z.boolean().optional(),
            logs: z.boolean().optional(),
            sampleRate: z.number().min(0).max(1).optional(),
            flushIntervalMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        stuckSessionWarnMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    discovery: z
      .object({
        mdns: z
          .object({
            mode: z.enum(["off", "minimal", "full"]).optional(),
          })
          .strict()
          .optional(),
        wideArea: z
          .object({
            enabled: z.boolean().optional(),
            domain: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    env: z
      .object({
        shellEnv: z
          .object({
            enabled: z.boolean().optional(),
            timeoutMs: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        vars: z.record(z.string(), z.string()).optional(),
      })
      .catchall(z.string())
      .optional(),
    gateway: z
      .object({
        allowRealIpFallback: z.boolean().optional(),
        auth: z
          .object({
            mode: z
              .union([
                z.literal("none"),
                z.literal("token"),
                z.literal("password"),
                z.literal("trusted-proxy"),
              ])
              .optional(),
            token: SecretInputSchema.optional().register(sensitive),
            password: SecretInputSchema.optional().register(sensitive),
            allowTailscale: z.boolean().optional(),
            rateLimit: z
              .object({
                maxAttempts: z.number().optional(),
                windowMs: z.number().optional(),
                lockoutMs: z.number().optional(),
                exemptLoopback: z.boolean().optional(),
              })
              .strict()
              .optional(),
            trustedProxy: z
              .object({
                userHeader: z.string().min(1, "userHeader is required for trusted-proxy mode"),
                requiredHeaders: z.array(z.string()).optional(),
                allowUsers: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        bind: z
          .union([
            z.literal("auto"),
            z.literal("lan"),
            z.literal("loopback"),
            z.literal("custom"),
            z.literal("tailnet"),
          ])
          .optional(),
        channelHealthCheckMinutes: z.number().int().min(0).optional(),
        channelMaxRestartsPerHour: z.number().int().min(1).optional(),
        channelStaleEventThresholdMinutes: z.number().int().min(1).optional(),
        controlUi: z
          .object({
            enabled: z.boolean().optional(),
            basePath: z.string().optional(),
            root: z.string().optional(),
            allowedOrigins: z.array(z.string()).optional(),
            dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
            allowInsecureAuth: z.boolean().optional(),
            dangerouslyDisableDeviceAuth: z.boolean().optional(),
          })
          .strict()
          .optional(),
        customBindHost: z.string().optional(),
        http: z
          .object({
            endpoints: z
              .object({
                chatCompletions: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    maxImageParts: z.number().int().nonnegative().optional(),
                    maxTotalImageBytes: z.number().int().positive().optional(),
                    images: z
                      .object({
                        ...ResponsesEndpointUrlFetchShape,
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
                responses: z
                  .object({
                    enabled: z.boolean().optional(),
                    maxBodyBytes: z.number().int().positive().optional(),
                    maxUrlParts: z.number().int().nonnegative().optional(),
                    files: z
                      .object({
                        ...ResponsesEndpointUrlFetchShape,
                        maxChars: z.number().int().positive().optional(),
                        pdf: z
                          .object({
                            maxPages: z.number().int().positive().optional(),
                            maxPixels: z.number().int().positive().optional(),
                            minTextChars: z.number().int().nonnegative().optional(),
                          })
                          .strict()
                          .optional(),
                      })
                      .strict()
                      .optional(),
                    images: z
                      .object({
                        ...ResponsesEndpointUrlFetchShape,
                      })
                      .strict()
                      .optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
            securityHeaders: z
              .object({
                strictTransportSecurity: z.union([z.string(), z.literal(false)]).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        mode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        nodes: z
          .object({
            browser: z
              .object({
                mode: z
                  .union([z.literal("auto"), z.literal("manual"), z.literal("off")])
                  .optional(),
                node: z.string().optional(),
              })
              .strict()
              .optional(),
            allowCommands: z.array(z.string()).optional(),
            denyCommands: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        port: z.number().int().positive().optional(),
        push: z
          .object({
            apns: z
              .object({
                relay: z
                  .object({
                    baseUrl: z.string().optional(),
                    timeoutMs: z.number().int().positive().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        reload: z
          .object({
            mode: z
              .union([
                z.literal("off"),
                z.literal("restart"),
                z.literal("hot"),
                z.literal("hybrid"),
              ])
              .optional(),
            debounceMs: z.number().int().min(0).optional(),
            deferralTimeoutMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        remote: z
          .object({
            url: z.string().optional(),
            transport: z.union([z.literal("ssh"), z.literal("direct")]).optional(),
            token: SecretInputSchema.optional().register(sensitive),
            password: SecretInputSchema.optional().register(sensitive),
            tlsFingerprint: z.string().optional(),
            sshTarget: z.string().optional(),
            sshIdentity: z.string().optional(),
          })
          .strict()
          .optional(),
        tailscale: z
          .object({
            mode: z.union([z.literal("off"), z.literal("serve"), z.literal("funnel")]).optional(),
            resetOnExit: z.boolean().optional(),
          })
          .strict()
          .optional(),
        tls: z
          .object({
            enabled: z.boolean().optional(),
            autoGenerate: z.boolean().optional(),
            certPath: z.string().optional(),
            keyPath: z.string().optional(),
            caPath: z.string().optional(),
          })
          .optional(),
        tools: z
          .object({
            deny: z.array(z.string()).optional(),
            allow: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        trustedProxies: z.array(z.string()).optional(),
        webchat: z
          .object({
            chatHistoryMaxChars: z.number().int().positive().max(500_000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((gateway, ctx) => {
        const effectiveHealthCheckMinutes = gateway.channelHealthCheckMinutes ?? 5;
        if (
          gateway.channelStaleEventThresholdMinutes != null &&
          effectiveHealthCheckMinutes !== 0 &&
          gateway.channelStaleEventThresholdMinutes < effectiveHealthCheckMinutes
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              "channelStaleEventThresholdMinutes should be >= channelHealthCheckMinutes to avoid delayed stale detection",
            path: ["channelStaleEventThresholdMinutes"],
          });
        }
      })
      .optional(),
    hooks: z
      .object({
        allowRequestSessionKey: z.boolean().optional(),
        allowedAgentIds: z.array(z.string()).optional(),
        allowedSessionKeyPrefixes: z.array(z.string()).optional(),
        defaultSessionKey: z.string().optional(),
        enabled: z.boolean().optional(),
        gmail: HooksGmailSchema,
        internal: InternalHooksSchema,
        mappings: z.array(HookMappingSchema).optional(),
        maxBodyBytes: z.number().int().positive().optional(),
        path: z.string().optional(),
        presets: z.array(z.string()).optional(),
        token: z.string().optional().register(sensitive),
        transformsDir: z.string().optional(),
      })
      .strict()
      .optional(),
    logging: z
      .object({
        consoleLevel: LoggingLevelSchema.optional(),
        consoleStyle: z
          .union([z.literal("pretty"), z.literal("compact"), z.literal("json")])
          .optional(),
        file: z.string().optional(),
        level: LoggingLevelSchema.optional(),
        maxFileBytes: z.number().int().positive().optional(),
        redactPatterns: z.array(z.string()).optional(),
        redactSensitive: z.union([z.literal("off"), z.literal("tools")]).optional(),
      })
      .strict()
      .optional(),
    mcp: McpConfigSchema,
    media: z
      .object({
        preserveFilenames: z.boolean().optional(),
        ttlHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 7)
          .optional(),
      })
      .strict()
      .optional(),
    memory: MemorySchema,
    messages: MessagesSchema,
    meta: z
      .object({
        lastTouchedVersion: z.string().optional(),
        // Accept any string unchanged (backwards-compatible) and coerce numeric Unix
        // Timestamps to ISO strings (agent file edits may write Date.now()).
        lastTouchedAt: z
          .union([
            z.string(),
            z.number().transform((n, ctx) => {
              const d = new Date(n);
              if (Number.isNaN(d.getTime())) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid timestamp" });
                return z.NEVER;
              }
              return d.toISOString();
            }),
          ])
          .optional(),
      })
      .strict()
      .optional(),
    models: ModelsConfigSchema,
    nodeHost: NodeHostSchema,
    plugins: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
        entries: z.record(z.string(), PluginEntrySchema).optional(),
        installs: z
          .record(
            z.string(),
            z
              .object({
                ...PluginInstallRecordShape,
              })
              .strict(),
          )
          .optional(),
        load: z
          .object({
            paths: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        slots: z
          .object({
            memory: z.string().optional(),
            contextEngine: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    secrets: SecretsConfigSchema,
    session: SessionSchema,
    skills: z
      .object({
        allowBundled: z.array(z.string()).optional(),
        entries: z.record(z.string(), SkillEntrySchema).optional(),
        install: z
          .object({
            preferBrew: z.boolean().optional(),
            nodeManager: z
              .union([z.literal("npm"), z.literal("pnpm"), z.literal("yarn"), z.literal("bun")])
              .optional(),
          })
          .strict()
          .optional(),
        limits: z
          .object({
            maxCandidatesPerRoot: z.number().int().min(1).optional(),
            maxSkillsLoadedPerSource: z.number().int().min(1).optional(),
            maxSkillsInPrompt: z.number().int().min(0).optional(),
            maxSkillsPromptChars: z.number().int().min(0).optional(),
            maxSkillFileBytes: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
        load: z
          .object({
            extraDirs: z.array(z.string()).optional(),
            watch: z.boolean().optional(),
            watchDebounceMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    talk: TalkSchema.optional(),
    tools: ToolsSchema,
    ui: z
      .object({
        assistant: z
          .object({
            name: z.string().max(50).optional(),
            avatar: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
        seamColor: HexColorSchema.optional(),
      })
      .strict()
      .optional(),
    update: z
      .object({
        auto: z
          .object({
            enabled: z.boolean().optional(),
            stableDelayHours: z.number().nonnegative().max(168).optional(),
            stableJitterHours: z.number().nonnegative().max(168).optional(),
            betaCheckIntervalHours: z.number().positive().max(24).optional(),
          })
          .strict()
          .optional(),
        channel: z.union([z.literal("stable"), z.literal("beta"), z.literal("dev")]).optional(),
        checkOnStart: z.boolean().optional(),
      })
      .strict()
      .optional(),
    web: z
      .object({
        enabled: z.boolean().optional(),
        heartbeatSeconds: z.number().int().positive().optional(),
        reconnect: z
          .object({
            factor: z.number().positive().optional(),
            initialMs: z.number().positive().optional(),
            jitter: z.number().min(0).max(1).optional(),
            maxAttempts: z.number().int().min(0).optional(),
            maxMs: z.number().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    wizard: z
      .object({
        lastRunAt: z.string().optional(),
        lastRunCommand: z.string().optional(),
        lastRunCommit: z.string().optional(),
        lastRunMode: z.union([z.literal("local"), z.literal("remote")]).optional(),
        lastRunVersion: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agents = cfg.agents?.list ?? [];
    if (agents.length === 0) {
      return;
    }
    const agentIds = new Set(agents.map((agent) => agent.id));

    const { broadcast } = cfg;
    if (!broadcast) {
      return;
    }

    for (const [peerId, ids] of Object.entries(broadcast)) {
      if (peerId === "strategy") {
        continue;
      }
      if (!Array.isArray(ids)) {
        continue;
      }
      for (let idx = 0; idx < ids.length; idx += 1) {
        const agentId = ids[idx];
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown agent id "${agentId}" (not in agents.list).`,
            path: ["broadcast", peerId, idx],
          });
        }
      }
    }
  });
