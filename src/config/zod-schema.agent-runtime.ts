import { z } from "zod";
import { getBlockedNetworkModeReason } from "../agents/sandbox/network-mode.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { AgentModelSchema } from "./zod-schema.agent-model.js";
import {
  GroupChatSchema,
  HumanDelaySchema,
  IdentitySchema,
  SecretInputSchema,
  ToolsLinksSchema,
  ToolsMediaSchema,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const HeartbeatSchema = z
  .object({
    accountId: z.string().optional(),
    ackMaxChars: z.number().int().nonnegative().optional(),
    activeHours: z
      .object({
        end: z.string().optional(),
        start: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
    directPolicy: z.union([z.literal("allow"), z.literal("block")]).optional(),
    every: z.string().optional(),
    includeReasoning: z.boolean().optional(),
    includeSystemPromptSection: z.boolean().optional(),
    isolatedSession: z.boolean().optional(),
    lightContext: z.boolean().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    session: z.string().optional(),
    suppressToolErrorWarnings: z.boolean().optional(),
    target: z.string().optional(),
    to: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.every) {
      return;
    }
    try {
      parseDurationMs(val.every, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid duration (use ms, s, m, h)",
        path: ["every"],
      });
    }

    const active = val.activeHours;
    if (!active) {
      return;
    }
    const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
    const validateTime = (raw: string | undefined, opts: { allow24: boolean }, path: string) => {
      if (!raw) {
        return;
      }
      if (!timePattern.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'invalid time (use "HH:MM" 24h format)',
          path: ["activeHours", path],
        });
        return;
      }
      const [hourStr, minuteStr] = raw.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      if (hour === 24 && minute !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid time (24:00 is the only allowed 24:xx value)",
          path: ["activeHours", path],
        });
        return;
      }
      if (hour === 24 && !opts.allow24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "invalid time (start cannot be 24:00)",
          path: ["activeHours", path],
        });
      }
    };

    validateTime(active.start, { allow24: false }, "start");
    validateTime(active.end, { allow24: true }, "end");
  })
  .optional();

export const SandboxDockerSchema = z
  .object({
    apparmorProfile: z.string().optional(),
    binds: z.array(z.string()).optional(),
    capDrop: z.array(z.string()).optional(),
    containerPrefix: z.string().optional(),
    cpus: z.number().positive().optional(),
    dangerouslyAllowContainerNamespaceJoin: z.boolean().optional(),
    dangerouslyAllowExternalBindSources: z.boolean().optional(),
    dangerouslyAllowReservedContainerTargets: z.boolean().optional(),
    dns: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
    image: z.string().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    network: z.string().optional(),
    pidsLimit: z.number().int().positive().optional(),
    readOnlyRoot: z.boolean().optional(),
    seccompProfile: z.string().optional(),
    setupCommand: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value.join("\n") : value))
      .optional(),
    tmpfs: z.array(z.string()).optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z
            .object({
              hard: z.number().int().nonnegative().optional(),
              soft: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    user: z.string().optional(),
    workdir: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.binds) {
      for (let i = 0; i < data.binds.length; i += 1) {
        const bind = normalizeOptionalString(data.binds[i]) ?? "";
        if (!bind) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Sandbox security: bind mount entry must be a non-empty string.",
            path: ["binds", i],
          });
          continue;
        }
        const firstColon = bind.indexOf(":");
        const source = (firstColon <= 0 ? bind : bind.slice(0, firstColon)).trim();
        if (!source.startsWith("/")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Sandbox security: bind mount "${bind}" uses a non-absolute source path "${source}". ` +
              "Only absolute POSIX paths are supported for sandbox binds.",
            path: ["binds", i],
          });
        }
      }
    }
    const blockedNetworkReason = getBlockedNetworkModeReason({
      allowContainerNamespaceJoin: data.dangerouslyAllowContainerNamespaceJoin === true,
      network: data.network,
    });
    if (blockedNetworkReason === "host") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sandbox security: network mode "host" is blocked. Use "bridge" or "none" instead.',
        path: ["network"],
      });
    }
    if (blockedNetworkReason === "container_namespace_join") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sandbox security: network mode "container:*" is blocked by default. ' +
          "Use a custom bridge network, or set dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
        path: ["network"],
      });
    }
    if (normalizeLowercaseStringOrEmpty(data.seccompProfile ?? "") === "unconfined") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sandbox security: seccomp profile "unconfined" is blocked. ' +
          "Use a custom seccomp profile file or omit this setting.",
        path: ["seccompProfile"],
      });
    }
    if (normalizeLowercaseStringOrEmpty(data.apparmorProfile ?? "") === "unconfined") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sandbox security: apparmor profile "unconfined" is blocked. ' +
          "Use a named AppArmor profile or omit this setting.",
        path: ["apparmorProfile"],
      });
    }
  })
  .optional();

export const SandboxBrowserSchema = z
  .object({
    allowHostControl: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    autoStartTimeoutMs: z.number().int().positive().optional(),
    binds: z.array(z.string()).optional(),
    cdpPort: z.number().int().positive().optional(),
    cdpSourceRange: z.string().optional(),
    containerPrefix: z.string().optional(),
    enableNoVnc: z.boolean().optional(),
    enabled: z.boolean().optional(),
    headless: z.boolean().optional(),
    image: z.string().optional(),
    network: z.string().optional(),
    noVncPort: z.number().int().positive().optional(),
    vncPort: z.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    if (normalizeLowercaseStringOrEmpty(data.network ?? "") === "host") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sandbox security: browser network mode "host" is blocked. Use "bridge" or a custom bridge network instead.',
        path: ["network"],
      });
    }
  })
  .strict()
  .optional();

export const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const ToolPolicyBaseSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const ToolPolicySchema = ToolPolicyBaseSchema.superRefine((value, ctx) => {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "tools policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    });
  }
}).optional();

const TrimmedOptionalConfigStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().optional());

const CodexAllowedDomainsSchema = z
  .array(z.string())
  .transform((values) => {
    const deduped = [
      ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    ];
    return deduped.length > 0 ? deduped : undefined;
  })
  .optional();

const CodexUserLocationSchema = z
  .object({
    city: TrimmedOptionalConfigStringSchema,
    country: TrimmedOptionalConfigStringSchema,
    region: TrimmedOptionalConfigStringSchema,
    timezone: TrimmedOptionalConfigStringSchema,
  })
  .strict()
  .transform((value) => value.country || value.region || value.city || value.timezone ? value : undefined)
  .optional();

export const ToolsWebSearchSchema = z
  .object({
    apiKey: SecretInputSchema.optional().register(sensitive),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    enabled: z.boolean().optional(),
    maxResults: z.number().int().positive().optional(),
    openaiCodex: z
      .object({
        allowedDomains: CodexAllowedDomainsSchema,
        contextSize: z.union([z.literal("low"), z.literal("medium"), z.literal("high")]).optional(),
        enabled: z.boolean().optional(),
        mode: z.union([z.literal("cached"), z.literal("live")]).optional(),
        userLocation: CodexUserLocationSchema,
      })
      .strict()
      .optional(),
    provider: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ToolsWebFetchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    maxChars: z.number().int().positive().optional(),
    maxCharsCap: z.number().int().positive().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
    userAgent: z.string().optional(),
    readability: z.boolean().optional(),
    ssrfPolicy: z
      .object({
        allowRfc2544BenchmarkRange: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Keep the legacy Firecrawl fetch shape loadable so existing installs can
    // Start and then migrate cleanly through doctor.
    firecrawl: z
      .object({
        apiKey: SecretInputSchema.optional().register(sensitive),
        baseUrl: z.string().optional(),
        enabled: z.boolean().optional(),
        maxAgeMs: z.number().int().nonnegative().optional(),
        onlyMainContent: z.boolean().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const ToolsWebXSearchSchema = z
  .object({
    cacheTtlMinutes: z.number().nonnegative().optional(),
    enabled: z.boolean().optional(),
    inlineCitations: z.boolean().optional(),
    maxTurns: z.number().int().optional(),
    model: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ToolsWebSchema = z
  .object({
    fetch: ToolsWebFetchSchema,
    search: ToolsWebSearchSchema,
    x_search: ToolsWebXSearchSchema,
  })
  .strict()
  .optional();

export const ToolProfileSchema = z
  .union([z.literal("minimal"), z.literal("coding"), z.literal("messaging"), z.literal("full")])
  .optional();

interface AllowlistPolicy {
  allow?: string[];
  alsoAllow?: string[];
}

function addAllowAlsoAllowConflictIssue(
  value: AllowlistPolicy,
  ctx: z.RefinementCtx,
  message: string,
): void {
  if (value.allow && value.allow.length > 0 && value.alsoAllow && value.alsoAllow.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
    });
  }
}

export const ToolPolicyWithProfileSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    profile: ToolProfileSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "tools.byProvider policy cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  });

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
export const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

const ToolExecApplyPatchSchema = z
  .object({
    allowModels: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    workspaceOnly: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolExecSafeBinProfileSchema = z
  .object({
    allowedValueFlags: z.array(z.string()).optional(),
    deniedFlags: z.array(z.string()).optional(),
    maxPositional: z.number().int().nonnegative().optional(),
    minPositional: z.number().int().nonnegative().optional(),
  })
  .strict();

const ToolExecBaseShape = {
  applyPatch: ToolExecApplyPatchSchema,
  ask: z.enum(["off", "on-miss", "always"]).optional(),
  backgroundMs: z.number().int().positive().optional(),
  cleanupMs: z.number().int().positive().optional(),
  host: z.enum(["auto", "sandbox", "gateway", "node"]).optional(),
  node: z.string().optional(),
  notifyOnExit: z.boolean().optional(),
  notifyOnExitEmptySuccess: z.boolean().optional(),
  pathPrepend: z.array(z.string()).optional(),
  safeBinProfiles: z.record(z.string(), ToolExecSafeBinProfileSchema).optional(),
  safeBinTrustedDirs: z.array(z.string()).optional(),
  safeBins: z.array(z.string()).optional(),
  security: z.enum(["deny", "allowlist", "full"]).optional(),
  strictInlineEval: z.boolean().optional(),
  timeoutSec: z.number().int().positive().optional(),
} as const;

const AgentToolExecSchema = z
  .object({
    ...ToolExecBaseShape,
    approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const ToolExecSchema = z.object(ToolExecBaseShape).strict().optional();

const ToolFsSchema = z
  .object({
    workspaceOnly: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolLoopDetectionDetectorSchema = z
  .object({
    genericRepeat: z.boolean().optional(),
    knownPollNoProgress: z.boolean().optional(),
    pingPong: z.boolean().optional(),
  })
  .strict()
  .optional();

const ToolLoopDetectionSchema = z
  .object({
    criticalThreshold: z.number().int().positive().optional(),
    detectors: ToolLoopDetectionDetectorSchema,
    enabled: z.boolean().optional(),
    globalCircuitBreakerThreshold: z.number().int().positive().optional(),
    historySize: z.number().int().positive().optional(),
    warningThreshold: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.warningThreshold !== undefined &&
      value.criticalThreshold !== undefined &&
      value.warningThreshold >= value.criticalThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tools.loopDetection.warningThreshold must be lower than criticalThreshold.",
        path: ["criticalThreshold"],
      });
    }
    if (
      value.criticalThreshold !== undefined &&
      value.globalCircuitBreakerThreshold !== undefined &&
      value.criticalThreshold >= value.globalCircuitBreakerThreshold
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "tools.loopDetection.criticalThreshold must be lower than globalCircuitBreakerThreshold.",
        path: ["globalCircuitBreakerThreshold"],
      });
    }
  })
  .optional();

export const SandboxSshSchema = z
  .object({
    certificateData: SecretInputSchema.optional().register(sensitive),
    certificateFile: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    identityData: SecretInputSchema.optional().register(sensitive),
    identityFile: z.string().min(1).optional(),
    knownHostsData: SecretInputSchema.optional().register(sensitive),
    knownHostsFile: z.string().min(1).optional(),
    strictHostKeyChecking: z.boolean().optional(),
    target: z.string().min(1).optional(),
    updateHostKeys: z.boolean().optional(),
    workspaceRoot: z.string().min(1).optional(),
  })
  .strict()
  .optional();

export const AgentSandboxSchema = z
  .object({
    backend: z.string().min(1).optional(),
    browser: SandboxBrowserSchema,
    docker: SandboxDockerSchema,
    mode: z.union([z.literal("off"), z.literal("non-main"), z.literal("all")]).optional(),
    prune: SandboxPruneSchema,
    scope: z.union([z.literal("session"), z.literal("agent"), z.literal("shared")]).optional(),
    sessionToolsVisibility: z.union([z.literal("spawned"), z.literal("all")]).optional(),
    ssh: SandboxSshSchema,
    workspaceAccess: z.union([z.literal("none"), z.literal("ro"), z.literal("rw")]).optional(),
    workspaceRoot: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const blockedBrowserNetworkReason = getBlockedNetworkModeReason({
      allowContainerNamespaceJoin: data.docker?.dangerouslyAllowContainerNamespaceJoin === true,
      network: data.browser?.network,
    });
    if (blockedBrowserNetworkReason === "container_namespace_join") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sandbox security: browser network mode "container:*" is blocked by default. ' +
          "Set sandbox.docker.dangerouslyAllowContainerNamespaceJoin=true only when you fully trust this runtime.",
        path: ["browser", "network"],
      });
    }
  })
  .optional();

const CommonToolPolicyFields = {
  allow: z.array(z.string()).optional(),
  alsoAllow: z.array(z.string()).optional(),
  byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
  deny: z.array(z.string()).optional(),
  profile: ToolProfileSchema,
};

export const AgentToolsSchema = z
  .object({
    ...CommonToolPolicyFields,
    elevated: z
      .object({
        allowFrom: ElevatedAllowFromSchema,
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    exec: AgentToolExecSchema,
    fs: ToolFsSchema,
    loopDetection: ToolLoopDetectionSchema,
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "agent tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  })
  .optional();

export const MemorySearchSchema = z
  .object({
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        overlap: z.number().int().nonnegative().optional(),
        tokens: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
    experimental: z
      .object({
        sessionMemory: z.boolean().optional(),
      })
      .strict()
      .optional(),
    extraPaths: z.array(z.string()).optional(),
    fallback: z.string().optional(),
    local: z
      .object({
        modelCacheDir: z.string().optional(),
        modelPath: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    multimodal: z
      .object({
        enabled: z.boolean().optional(),
        maxFileBytes: z.number().int().positive().optional(),
        modalities: z
          .array(z.union([z.literal("image"), z.literal("audio"), z.literal("all")]))
          .optional(),
      })
      .strict()
      .optional(),
    outputDimensionality: z.number().int().positive().optional(),
    provider: z.string().optional(),
    qmd: z
      .object({
        extraCollections: z
          .array(
            z
              .object({
                name: z.string().optional(),
                path: z.string(),
                pattern: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        hybrid: z
          .object({
            enabled: z.boolean().optional(),
            vectorWeight: z.number().min(0).max(1).optional(),
            textWeight: z.number().min(0).max(1).optional(),
            candidateMultiplier: z.number().int().positive().optional(),
            mmr: z
              .object({
                enabled: z.boolean().optional(),
                lambda: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            temporalDecay: z
              .object({
                enabled: z.boolean().optional(),
                halfLifeDays: z.number().int().positive().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    remote: z
      .object({
        apiKey: SecretInputSchema.optional().register(sensitive),
        baseUrl: z.string().optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
            wait: z.boolean().optional(),
            concurrency: z.number().int().positive().optional(),
            pollIntervalMs: z.number().int().nonnegative().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        headers: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    store: z
      .object({
        driver: z.literal("sqlite").optional(),
        fts: z
          .object({
            tokenizer: z.union([z.literal("unicode61"), z.literal("trigram")]).optional(),
          })
          .strict()
          .optional(),
        path: z.string().optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    sync: z
      .object({
        intervalMinutes: z.number().int().nonnegative().optional(),
        onSearch: z.boolean().optional(),
        onSessionStart: z.boolean().optional(),
        sessions: z
          .object({
            deltaBytes: z.number().int().nonnegative().optional(),
            deltaMessages: z.number().int().nonnegative().optional(),
            postCompactionForce: z.boolean().optional(),
          })
          .strict()
          .optional(),
        watch: z.boolean().optional(),
        watchDebounceMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
export { AgentModelSchema };

const AgentRuntimeAcpSchema = z
  .object({
    agent: z.string().optional(),
    backend: z.string().optional(),
    cwd: z.string().optional(),
    mode: z.enum(["persistent", "oneshot"]).optional(),
  })
  .strict()
  .optional();

const AgentRuntimeSchema = z
  .union([
    z
      .object({
        type: z.literal("embedded"),
      })
      .strict(),
    z
      .object({
        acp: AgentRuntimeAcpSchema,
        type: z.literal("acp"),
      })
      .strict(),
  ])
  .optional();

export const AgentEntrySchema = z
  .object({
    agentDir: z.string().optional(),
    default: z.boolean().optional(),
    fastModeDefault: z.boolean().optional(),
    groupChat: GroupChatSchema,
    heartbeat: HeartbeatSchema,
    humanDelay: HumanDelaySchema.optional(),
    id: z.string(),
    identity: IdentitySchema,
    memorySearch: MemorySearchSchema,
    model: AgentModelSchema.optional(),
    name: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    reasoningDefault: z.enum(["on", "off", "stream"]).optional(),
    runtime: AgentRuntimeSchema,
    sandbox: AgentSandboxSchema,
    skills: z.array(z.string()).optional(),
    subagents: z
      .object({
        allowAgents: z.array(z.string()).optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        requireAgentId: z.boolean().optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    systemPromptOverride: z.string().optional(),
    thinkingDefault: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"])
      .optional(),
    tools: AgentToolsSchema,
    workspace: z.string().optional(),
  })
  .strict();

export const ToolsSchema = z
  .object({
    ...CommonToolPolicyFields,
    agentToAgent: z
      .object({
        allow: z.array(z.string()).optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    elevated: z
      .object({
        allowFrom: ElevatedAllowFromSchema,
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    exec: ToolExecSchema,
    experimental: z
      .object({
        planTool: z.boolean().optional(),
      })
      .strict()
      .optional(),
    fs: ToolFsSchema,
    links: ToolsLinksSchema,
    loopDetection: ToolLoopDetectionSchema,
    media: ToolsMediaSchema,
    message: z
      .object({
        allowCrossContextSend: z.boolean().optional(),
        broadcast: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
        crossContext: z
          .object({
            allowWithinProvider: z.boolean().optional(),
            allowAcrossProviders: z.boolean().optional(),
            marker: z
              .object({
                enabled: z.boolean().optional(),
                prefix: z.string().optional(),
                suffix: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    sessions: z
      .object({
        visibility: z.enum(["self", "tree", "agent", "all"]).optional(),
      })
      .strict()
      .optional(),
    sessions_spawn: z
      .object({
        attachments: z
          .object({
            enabled: z.boolean().optional(),
            maxFileBytes: z.number().optional(),
            maxFiles: z.number().optional(),
            maxTotalBytes: z.number().optional(),
            retainOnSessionKeep: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    web: ToolsWebSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    addAllowAlsoAllowConflictIssue(
      value,
      ctx,
      "tools cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)",
    );
  })
  .optional();
