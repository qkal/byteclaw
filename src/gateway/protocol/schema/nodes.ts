import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const NodePendingWorkTypeSchema = Type.String({
  enum: ["status.request", "location.request"],
});

const NodePendingWorkPrioritySchema = Type.String({
  enum: ["normal", "high"],
});

export const NodePairRequestParamsSchema = Type.Object(
  {
    caps: Type.Optional(Type.Array(NonEmptyString)),
    commands: Type.Optional(Type.Array(NonEmptyString)),
    coreVersion: Type.Optional(NonEmptyString),
    deviceFamily: Type.Optional(NonEmptyString),
    displayName: Type.Optional(NonEmptyString),
    modelIdentifier: Type.Optional(NonEmptyString),
    nodeId: NonEmptyString,
    platform: Type.Optional(NonEmptyString),
    remoteIp: Type.Optional(NonEmptyString),
    silent: Type.Optional(Type.Boolean()),
    uiVersion: Type.Optional(NonEmptyString),
    version: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const NodePairListParamsSchema = Type.Object({}, { additionalProperties: false });

export const NodePairApproveParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

export const NodePairRejectParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

export const NodePairVerifyParamsSchema = Type.Object(
  { nodeId: NonEmptyString, token: NonEmptyString },
  { additionalProperties: false },
);

export const NodeRenameParamsSchema = Type.Object(
  { displayName: NonEmptyString, nodeId: NonEmptyString },
  { additionalProperties: false },
);

export const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });

export const NodePendingAckParamsSchema = Type.Object(
  {
    ids: Type.Array(NonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const NodeDescribeParamsSchema = Type.Object(
  { nodeId: NonEmptyString },
  { additionalProperties: false },
);

export const NodeInvokeParamsSchema = Type.Object(
  {
    command: NonEmptyString,
    idempotencyKey: NonEmptyString,
    nodeId: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const NodeInvokeResultParamsSchema = Type.Object(
  {
    error: Type.Optional(
      Type.Object(
        {
          code: Type.Optional(NonEmptyString),
          message: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    id: NonEmptyString,
    nodeId: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    payloadJSON: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const NodeEventParamsSchema = Type.Object(
  {
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    payloadJSON: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const NodePendingDrainParamsSchema = Type.Object(
  {
    maxItems: Type.Optional(Type.Integer({ maximum: 10, minimum: 1 })),
  },
  { additionalProperties: false },
);

export const NodePendingDrainItemSchema = Type.Object(
  {
    createdAtMs: Type.Integer({ minimum: 0 }),
    expiresAtMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    id: NonEmptyString,
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    priority: Type.String({ enum: ["default", "normal", "high"] }),
    type: NodePendingWorkTypeSchema,
  },
  { additionalProperties: false },
);

export const NodePendingDrainResultSchema = Type.Object(
  {
    hasMore: Type.Boolean(),
    items: Type.Array(NodePendingDrainItemSchema),
    nodeId: NonEmptyString,
    revision: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const NodePendingEnqueueParamsSchema = Type.Object(
  {
    expiresInMs: Type.Optional(Type.Integer({ maximum: 86_400_000, minimum: 1_000 })),
    nodeId: NonEmptyString,
    priority: Type.Optional(NodePendingWorkPrioritySchema),
    type: NodePendingWorkTypeSchema,
    wake: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const NodePendingEnqueueResultSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    queued: NodePendingDrainItemSchema,
    revision: Type.Integer({ minimum: 0 }),
    wakeTriggered: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const NodeInvokeRequestEventSchema = Type.Object(
  {
    command: NonEmptyString,
    id: NonEmptyString,
    idempotencyKey: Type.Optional(NonEmptyString),
    nodeId: NonEmptyString,
    paramsJSON: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
