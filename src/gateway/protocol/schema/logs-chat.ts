import { Type } from "@sinclair/typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ maximum: 5000, minimum: 1 })),
    maxBytes: Type.Optional(Type.Integer({ maximum: 1_000_000, minimum: 1 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    cursor: Type.Integer({ minimum: 0 }),
    file: NonEmptyString,
    lines: Type.Array(Type.String()),
    reset: Type.Optional(Type.Boolean()),
    size: Type.Integer({ minimum: 0 }),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ maximum: 1000, minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ maximum: 500_000, minimum: 1 })),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatSendParamsSchema = Type.Object(
  {
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    deliver: Type.Optional(Type.Boolean()),
    idempotencyKey: NonEmptyString,
    message: Type.String(),
    originatingAccountId: Type.Optional(Type.String()),
    originatingChannel: Type.Optional(Type.String()),
    originatingThreadId: Type.Optional(Type.String()),
    originatingTo: Type.Optional(Type.String()),
    sessionKey: ChatSendSessionKeyString,
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    runId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ maxLength: 100 })),
    message: NonEmptyString,
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Object(
  {
    errorKind: Type.Optional(
      Type.Union([
        Type.Literal("refusal"),
        Type.Literal("timeout"),
        Type.Literal("rate_limit"),
        Type.Literal("context_length"),
        Type.Literal("unknown"),
      ]),
    ),
    errorMessage: Type.Optional(Type.String()),
    message: Type.Optional(Type.Unknown()),
    runId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    sessionKey: NonEmptyString,
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
    stopReason: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
