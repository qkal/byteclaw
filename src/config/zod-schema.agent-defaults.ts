import { z } from "zod";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";
import {
  AgentModelSchema,
  AgentSandboxSchema,
  HeartbeatSchema,
  MemorySearchSchema,
} from "./zod-schema.agent-runtime.js";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  HumanDelaySchema,
  TypingModeSchema,
} from "./zod-schema.core.js";

export const AgentDefaultsSchema = z
  .object({
    /** Global default provider params applied to all models before per-model and per-agent overrides. */
    blockStreamingBreak: z.union([z.literal("text_end"), z.literal("message_end")]).optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    blockStreamingDefault: z.union([z.literal("off"), z.literal("on")]).optional(),
    bootstrapMaxChars: z.number().int().positive().optional(),
    bootstrapPromptTruncationWarning: z
      .union([z.literal("off"), z.literal("once"), z.literal("always")])
      .optional(),
    bootstrapTotalMaxChars: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    compaction: z
      .object({
        customInstructions: z.string().optional(),
        identifierInstructions: z.string().optional(),
        identifierPolicy: z
          .union([z.literal("strict"), z.literal("off"), z.literal("custom")])
          .optional(),
        keepRecentTokens: z.number().int().positive().optional(),
        maxHistoryShare: z.number().min(0.1).max(0.9).optional(),
        memoryFlush: z
          .object({
            enabled: z.boolean().optional(),
            softThresholdTokens: z.number().int().nonnegative().optional(),
            forceFlushTranscriptBytes: z
              .union([
                z.number().int().nonnegative(),
                z
                  .string()
                  .refine(isValidNonNegativeByteSizeString, "Expected byte size string like 2mb"),
              ])
              .optional(),
            prompt: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .strict()
          .optional(),
        mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        model: z.string().optional(),
        notifyUser: z.boolean().optional(),
        postCompactionSections: z.array(z.string()).optional(),
        postIndexSync: z.enum(["off", "async", "await"]).optional(),
        provider: z.string().optional(),
        qualityGuard: z
          .object({
            enabled: z.boolean().optional(),
            maxRetries: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        recentTurnsPreserve: z.number().int().min(0).max(12).optional(),
        reserveTokens: z.number().int().nonnegative().optional(),
        reserveTokensFloor: z.number().int().nonnegative().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    contextInjection: z.union([z.literal("always"), z.literal("continuation-skip")]).optional(),
    contextPruning: z
      .object({
        hardClear: z
          .object({
            enabled: z.boolean().optional(),
            placeholder: z.string().optional(),
          })
          .strict()
          .optional(),
        hardClearRatio: z.number().min(0).max(1).optional(),
        keepLastAssistants: z.number().int().nonnegative().optional(),
        minPrunableToolChars: z.number().int().nonnegative().optional(),
        mode: z.union([z.literal("off"), z.literal("cache-ttl")]).optional(),
        softTrim: z
          .object({
            maxChars: z.number().int().nonnegative().optional(),
            headChars: z.number().int().nonnegative().optional(),
            tailChars: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
        softTrimRatio: z.number().min(0).max(1).optional(),
        tools: z
          .object({
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        ttl: z.string().optional(),
      })
      .strict()
      .optional(),
    contextTokens: z.number().int().positive().optional(),
    elevatedDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("ask"), z.literal("full")])
      .optional(),
    embeddedPi: z
      .object({
        projectSettingsPolicy: z
          .union([z.literal("trusted"), z.literal("sanitize"), z.literal("ignore")])
          .optional(),
      })
      .strict()
      .optional(),
    envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeTimezone: z.string().optional(),
    heartbeat: HeartbeatSchema,
    humanDelay: HumanDelaySchema.optional(),
    imageGenerationModel: AgentModelSchema.optional(),
    imageMaxDimensionPx: z.number().int().positive().optional(),
    imageModel: AgentModelSchema.optional(),
    llm: z
      .object({
        idleTimeoutSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            "Idle timeout for LLM streaming responses in seconds. If no token is received within this time, the request is aborted. Set to 0 to disable. Default: 60 seconds.",
          ),
      })
      .strict()
      .optional(),
    maxConcurrent: z.number().int().positive().optional(),
    mediaGenerationAutoProviderFallback: z.boolean().optional(),
    mediaMaxMb: z.number().positive().optional(),
    memorySearch: MemorySearchSchema,
    model: AgentModelSchema.optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            alias: z.string().optional(),
            /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
            params: z.record(z.string(), z.unknown()).optional(),
            /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
            streaming: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    musicGenerationModel: AgentModelSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    pdfMaxBytesMb: z.number().positive().optional(),
    pdfMaxPages: z.number().int().positive().optional(),
    pdfModel: AgentModelSchema.optional(),
    repoRoot: z.string().optional(),
    sandbox: AgentSandboxSchema,
    skills: z.array(z.string()).optional(),
    skipBootstrap: z.boolean().optional(),
    subagents: z
      .object({
        allowAgents: z.array(z.string()).optional(),
        announceTimeoutMs: z.number().int().positive().optional(),
        archiveAfterMinutes: z.number().int().min(0).optional(),
        maxChildrenPerAgent: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Maximum number of active children a single agent session can spawn (default: 5).",
          ),
        maxConcurrent: z.number().int().positive().optional(),
        maxSpawnDepth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe(
            "Maximum nesting depth for sub-agent spawning. 1 = no nesting (default), 2 = sub-agents can spawn sub-sub-agents.",
          ),
        model: AgentModelSchema.optional(),
        requireAgentId: z.boolean().optional(),
        runTimeoutSeconds: z.number().int().min(0).optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    systemPromptOverride: z.string().optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
        z.literal("adaptive"),
      ])
      .optional(),
    timeFormat: z.union([z.literal("auto"), z.literal("12"), z.literal("24")]).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: TypingModeSchema.optional(),
    userTimezone: z.string().optional(),
    verboseDefault: z.union([z.literal("off"), z.literal("on"), z.literal("full")]).optional(),
    videoGenerationModel: AgentModelSchema.optional(),
    workspace: z.string().optional(),
  })
  .strict()
  .optional();
