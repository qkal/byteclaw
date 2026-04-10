import { z } from "zod";
import { parseByteSize } from "../cli/parse-bytes.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { normalizeStringifiedOptionalString } from "../shared/string-coerce.js";
import { ElevatedAllowFromSchema } from "./zod-schema.agent-runtime.js";
import { createAllowDenyChannelRulesSchema } from "./zod-schema.allowdeny.js";
import {
  GroupChatSchema,
  InboundDebounceSchema,
  NativeCommandsSettingSchema,
  QueueSchema,
  TtsConfigSchema,
  TypingModeSchema,
} from "./zod-schema.core.js";
import { sensitive } from "./zod-schema.sensitive.js";

const SessionResetConfigSchema = z
  .object({
    atHour: z.number().int().min(0).max(23).optional(),
    idleMinutes: z.number().int().positive().optional(),
    mode: z.union([z.literal("daily"), z.literal("idle")]).optional(),
  })
  .strict();

export const SessionSendPolicySchema = createAllowDenyChannelRulesSchema();

export const SessionSchema = z
  .object({
    agentToAgent: z
      .object({
        maxPingPongTurns: z.number().int().min(0).max(5).optional(),
      })
      .strict()
      .optional(),
    dmScope: z
      .union([
        z.literal("main"),
        z.literal("per-peer"),
        z.literal("per-channel-peer"),
        z.literal("per-account-channel-peer"),
      ])
      .optional(),
    identityLinks: z.record(z.string(), z.array(z.string())).optional(),
    idleMinutes: z.number().int().positive().optional(),
    mainKey: z.string().optional(),
    maintenance: z
      .object({
        mode: z.enum(["enforce", "warn"]).optional(),
        pruneAfter: z.union([z.string(), z.number()]).optional(),
        /** @deprecated Use pruneAfter instead. */
        pruneDays: z.number().int().positive().optional(),
        maxEntries: z.number().int().positive().optional(),
        rotateBytes: z.union([z.string(), z.number()]).optional(),
        resetArchiveRetention: z.union([z.string(), z.number(), z.literal(false)]).optional(),
        maxDiskBytes: z.union([z.string(), z.number()]).optional(),
        highWaterBytes: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .superRefine((val, ctx) => {
        if (val.pruneAfter !== undefined) {
          try {
            parseDurationMs(normalizeStringifiedOptionalString(val.pruneAfter) ?? "", {
              defaultUnit: "d",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid duration (use ms, s, m, h, d)",
              path: ["pruneAfter"],
            });
          }
        }
        if (val.rotateBytes !== undefined) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.rotateBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid size (use b, kb, mb, gb, tb)",
              path: ["rotateBytes"],
            });
          }
        }
        if (val.resetArchiveRetention !== undefined && val.resetArchiveRetention !== false) {
          try {
            parseDurationMs(normalizeStringifiedOptionalString(val.resetArchiveRetention) ?? "", {
              defaultUnit: "d",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid duration (use ms, s, m, h, d)",
              path: ["resetArchiveRetention"],
            });
          }
        }
        if (val.maxDiskBytes !== undefined) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.maxDiskBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid size (use b, kb, mb, gb, tb)",
              path: ["maxDiskBytes"],
            });
          }
        }
        if (val.highWaterBytes !== undefined) {
          try {
            parseByteSize(normalizeStringifiedOptionalString(val.highWaterBytes) ?? "", {
              defaultUnit: "b",
            });
          } catch {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "invalid size (use b, kb, mb, gb, tb)",
              path: ["highWaterBytes"],
            });
          }
        }
      })
      .optional(),
    parentForkMaxTokens: z.number().int().nonnegative().optional(),
    reset: SessionResetConfigSchema.optional(),
    resetByChannel: z.record(z.string(), SessionResetConfigSchema).optional(),
    resetByType: z
      .object({
        direct: SessionResetConfigSchema.optional(),
        /** @deprecated Use `direct` instead. Kept for backward compatibility. */
        dm: SessionResetConfigSchema.optional(),
        group: SessionResetConfigSchema.optional(),
        thread: SessionResetConfigSchema.optional(),
      })
      .strict()
      .optional(),
    resetTriggers: z.array(z.string()).optional(),
    scope: z.union([z.literal("per-sender"), z.literal("global")]).optional(),
    sendPolicy: SessionSendPolicySchema.optional(),
    store: z.string().optional(),
    threadBindings: z
      .object({
        enabled: z.boolean().optional(),
        idleHours: z.number().nonnegative().optional(),
        maxAgeHours: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: TypingModeSchema.optional(),
  })
  .strict()
  .optional();

export const MessagesSchema = z
  .object({
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    groupChat: GroupChatSchema,
    inbound: InboundDebounceSchema,
    messagePrefix: z.string().optional(),
    queue: QueueSchema,
    removeAckAfterReply: z.boolean().optional(),
    responsePrefix: z.string().optional(),
    statusReactions: z
      .object({
        emojis: z
          .object({
            thinking: z.string().optional(),
            tool: z.string().optional(),
            coding: z.string().optional(),
            web: z.string().optional(),
            done: z.string().optional(),
            error: z.string().optional(),
            stallSoft: z.string().optional(),
            stallHard: z.string().optional(),
            compacting: z.string().optional(),
          })
          .strict()
          .optional(),
        enabled: z.boolean().optional(),
        timing: z
          .object({
            debounceMs: z.number().int().min(0).optional(),
            stallSoftMs: z.number().int().min(0).optional(),
            stallHardMs: z.number().int().min(0).optional(),
            doneHoldMs: z.number().int().min(0).optional(),
            errorHoldMs: z.number().int().min(0).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    suppressToolErrors: z.boolean().optional(),
    tts: TtsConfigSchema,
  })
  .strict()
  .optional();

export const CommandsSchema = z
  .object({
    allowFrom: ElevatedAllowFromSchema.optional(),
    bash: z.boolean().optional(),
    bashForegroundMs: z.number().int().min(0).max(30_000).optional(),
    config: z.boolean().optional(),
    debug: z.boolean().optional(),
    mcp: z.boolean().optional(),
    native: NativeCommandsSettingSchema.optional().default("auto"),
    nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
    ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    ownerDisplay: z.enum(["raw", "hash"]).optional().default("raw"),
    ownerDisplaySecret: z.string().optional().register(sensitive),
    plugins: z.boolean().optional(),
    restart: z.boolean().optional().default(true),
    text: z.boolean().optional(),
    useAccessGroups: z.boolean().optional(),
  })
  .strict()
  .optional()
  .default(
    () => ({ native: "auto", nativeSkills: "auto", ownerDisplay: "raw", restart: true }) as const,
  );
