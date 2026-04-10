import { Type } from "@sinclair/typebox";
import {
  AGENT_INTERNAL_EVENT_SOURCES,
  AGENT_INTERNAL_EVENT_STATUSES,
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
} from "../../../agents/internal-event-contract.js";
import { InputProvenanceSchema, NonEmptyString, SessionLabelString } from "./primitives.js";

export const AgentInternalEventSchema = Type.Object(
  {
    announceType: Type.String(),
    childSessionId: Type.Optional(Type.String()),
    childSessionKey: Type.String(),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    replyInstruction: Type.String(),
    result: Type.String(),
    source: Type.String({ enum: [...AGENT_INTERNAL_EVENT_SOURCES] }),
    statsLine: Type.Optional(Type.String()),
    status: Type.String({ enum: [...AGENT_INTERNAL_EVENT_STATUSES] }),
    statusLabel: Type.String(),
    taskLabel: Type.String(),
    type: Type.Literal(AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    data: Type.Record(Type.String(), Type.Unknown()),
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    stream: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SendParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    message: Type.Optional(Type.String()),
    mediaUrl: Type.Optional(Type.String()),
    mediaUrls: Type.Optional(Type.Array(Type.String())),
    gifPlayback: Type.Optional(Type.Boolean()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    /** Optional agent id for per-agent media root resolution on gateway sends. */
    agentId: Type.Optional(Type.String()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    /** Optional session key for mirroring delivered output back into the transcript. */
    sessionKey: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const PollParamsSchema = Type.Object(
  {
    to: NonEmptyString,
    question: NonEmptyString,
    options: Type.Array(NonEmptyString, { maxItems: 12, minItems: 2 }),
    maxSelections: Type.Optional(Type.Integer({ maximum: 12, minimum: 1 })),
    /** Poll duration in seconds (channel-specific limits may apply). */
    durationSeconds: Type.Optional(Type.Integer({ maximum: 604_800, minimum: 1 })),
    durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
    /** Send silently (no notification) where supported. */
    silent: Type.Optional(Type.Boolean()),
    /** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
    isAnonymous: Type.Optional(Type.Boolean()),
    /** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
    threadId: Type.Optional(Type.String()),
    channel: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentParamsSchema = Type.Object(
  {
    accountId: Type.Optional(Type.String()),
    agentId: Type.Optional(NonEmptyString),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    bestEffortDeliver: Type.Optional(Type.Boolean()),
    bootstrapContextMode: Type.Optional(
      Type.Union([Type.Literal("full"), Type.Literal("lightweight")]),
    ),
    bootstrapContextRunKind: Type.Optional(
      Type.Union([Type.Literal("default"), Type.Literal("heartbeat"), Type.Literal("cron")]),
    ),
    channel: Type.Optional(Type.String()),
    deliver: Type.Optional(Type.Boolean()),
    extraSystemPrompt: Type.Optional(Type.String()),
    groupChannel: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
    groupSpace: Type.Optional(Type.String()),
    idempotencyKey: NonEmptyString,
    inputProvenance: Type.Optional(InputProvenanceSchema),
    internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
    label: Type.Optional(SessionLabelString),
    lane: Type.Optional(Type.String()),
    message: NonEmptyString,
    model: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    replyAccountId: Type.Optional(Type.String()),
    replyChannel: Type.Optional(Type.String()),
    replyTo: Type.Optional(Type.String()),
    sessionId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Integer({ minimum: 0 })),
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentIdentityParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AgentIdentityResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    avatar: Type.Optional(NonEmptyString),
    emoji: Type.Optional(NonEmptyString),
    name: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentWaitParamsSchema = Type.Object(
  {
    runId: NonEmptyString,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const WakeParamsSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
    text: NonEmptyString,
  },
  { additionalProperties: false },
);
