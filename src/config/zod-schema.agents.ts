import { z } from "zod";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .strict()
  .optional();

const BindingMatchSchema = z
  .object({
    accountId: z.string().optional(),
    channel: z.string(),
    guildId: z.string().optional(),
    peer: z
      .object({
        id: z.string(),
        kind: z.union([
          z.literal("direct"),
          z.literal("group"),
          z.literal("channel"),
          /** @deprecated Use `direct` instead. Kept for backward compatibility. */
          z.literal("dm"),
        ]),
      })
      .strict()
      .optional(),
    roles: z.array(z.string()).optional(),
    teamId: z.string().optional(),
  })
  .strict();

const RouteBindingSchema = z
  .object({
    agentId: z.string(),
    comment: z.string().optional(),
    match: BindingMatchSchema,
    type: z.literal("route").optional(),
  })
  .strict();

const AcpBindingSchema = z
  .object({
    acp: z
      .object({
        backend: z.string().optional(),
        cwd: z.string().optional(),
        label: z.string().optional(),
        mode: z.enum(["persistent", "oneshot"]).optional(),
      })
      .strict()
      .optional(),
    agentId: z.string(),
    comment: z.string().optional(),
    match: BindingMatchSchema,
    type: z.literal("acp"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const peerId = normalizeOptionalString(value.match.peer?.id) ?? "";
    if (!peerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ACP bindings require match.peer.id to target a concrete conversation.",
        path: ["match", "peer"],
      });
      return;
    }
  });

export const BindingsSchema = z.array(z.union([RouteBindingSchema, AcpBindingSchema])).optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .strict()
  .optional();
