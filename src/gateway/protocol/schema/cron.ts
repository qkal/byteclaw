import { type TSchema, Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

function cronAgentTurnPayloadSchema(params: { message: TSchema; toolsAllow: TSchema }) {
  return Type.Object(
    {
      allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
      fallbacks: Type.Optional(Type.Array(Type.String())),
      kind: Type.Literal("agentTurn"),
      lightContext: Type.Optional(Type.Boolean()),
      message: params.message,
      model: Type.Optional(Type.String()),
      thinking: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
      toolsAllow: Type.Optional(params.toolsAllow),
    },
    { additionalProperties: false },
  );
}

const CronSessionTargetSchema = Type.Union([
  Type.Literal("main"),
  Type.Literal("isolated"),
  Type.Literal("current"),
  Type.String({ pattern: "^session:.+" }),
]);
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
const CronRunStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("enabled"),
  Type.Literal("disabled"),
]);
const CronJobsSortBySchema = Type.Union([
  Type.Literal("nextRunAtMs"),
  Type.Literal("updatedAtMs"),
  Type.Literal("name"),
]);
const CronRunsStatusFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
const CronRunsStatusValueSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("error"),
  Type.Literal("skipped"),
]);
const CronDeliveryStatusSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("not-delivered"),
  Type.Literal("unknown"),
  Type.Literal("not-requested"),
]);
const CronFailoverReasonSchema = Type.Union([
  Type.Literal("auth"),
  Type.Literal("format"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("model_not_found"),
  Type.Literal("unknown"),
]);
const CronCommonOptionalFields = {
  agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  deleteAfterRun: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
  sessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
};

function cronIdOrJobIdParams(extraFields: Record<string, TSchema>) {
  return Type.Union([
    Type.Object(
      {
        id: NonEmptyString,
        ...extraFields,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        jobId: NonEmptyString,
        ...extraFields,
      },
      { additionalProperties: false },
    ),
  ]);
}

const CronRunLogJobIdSchema = Type.String({
  minLength: 1,
  // Prevent path traversal via separators in cron.runs id/jobId.
  pattern: "^[^/\\\\]+$",
});

export const CronScheduleSchema = Type.Union([
  Type.Object(
    {
      at: NonEmptyString,
      kind: Type.Literal("at"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      anchorMs: Type.Optional(Type.Integer({ minimum: 0 })),
      everyMs: Type.Integer({ minimum: 1 }),
      kind: Type.Literal("every"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      expr: NonEmptyString,
      kind: Type.Literal("cron"),
      staggerMs: Type.Optional(Type.Integer({ minimum: 0 })),
      tz: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export const CronPayloadSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("systemEvent"),
      text: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  cronAgentTurnPayloadSchema({
    message: NonEmptyString,
    toolsAllow: Type.Array(Type.String()),
  }),
]);

export const CronPayloadPatchSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("systemEvent"),
      text: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
  cronAgentTurnPayloadSchema({
    message: Type.Optional(NonEmptyString),
    toolsAllow: Type.Union([Type.Array(Type.String()), Type.Null()]),
  }),
]);

export const CronFailureAlertSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
    after: Type.Optional(Type.Integer({ minimum: 1 })),
    channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
    cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CronFailureDestinationSchema = Type.Object(
  {
    accountId: Type.Optional(NonEmptyString),
    channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
    mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliverySharedProperties = {
  accountId: Type.Optional(NonEmptyString),
  bestEffort: Type.Optional(Type.Boolean()),
  channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
  failureDestination: Type.Optional(CronFailureDestinationSchema),
};

const CronDeliveryNoopSchema = Type.Object(
  {
    mode: Type.Literal("none"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliveryAnnounceSchema = Type.Object(
  {
    mode: Type.Literal("announce"),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronDeliveryWebhookSchema = Type.Object(
  {
    mode: Type.Literal("webhook"),
    ...CronDeliverySharedProperties,
    to: NonEmptyString,
  },
  { additionalProperties: false },
);

export const CronDeliverySchema = Type.Union([
  CronDeliveryNoopSchema,
  CronDeliveryAnnounceSchema,
  CronDeliveryWebhookSchema,
]);

export const CronDeliveryPatchSchema = Type.Object(
  {
    mode: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("announce"), Type.Literal("webhook")]),
    ),
    ...CronDeliverySharedProperties,
    to: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CronJobStateSchema = Type.Object(
  {
    consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDelivered: Type.Optional(Type.Boolean()),
    lastDeliveryError: Type.Optional(Type.String()),
    lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastError: Type.Optional(Type.String()),
    lastErrorReason: Type.Optional(CronFailoverReasonSchema),
    lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunStatus: Type.Optional(CronRunStatusSchema),
    lastStatus: Type.Optional(CronRunStatusSchema),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const CronJobSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    createdAtMs: Type.Integer({ minimum: 0 }),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    delivery: Type.Optional(CronDeliverySchema),
    description: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
    id: NonEmptyString,
    name: NonEmptyString,
    payload: CronPayloadSchema,
    schedule: CronScheduleSchema,
    sessionKey: Type.Optional(NonEmptyString),
    sessionTarget: CronSessionTargetSchema,
    state: CronJobStateSchema,
    updatedAtMs: Type.Integer({ minimum: 0 }),
    wakeMode: CronWakeModeSchema,
  },
  { additionalProperties: false },
);

export const CronListParamsSchema = Type.Object(
  {
    enabled: Type.Optional(CronJobsEnabledFilterSchema),
    includeDisabled: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ maximum: 200, minimum: 1 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    query: Type.Optional(Type.String()),
    sortBy: Type.Optional(CronJobsSortBySchema),
    sortDir: Type.Optional(CronSortDirSchema),
  },
  { additionalProperties: false },
);

export const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const CronAddParamsSchema = Type.Object(
  {
    name: NonEmptyString,
    ...CronCommonOptionalFields,
    schedule: CronScheduleSchema,
    sessionTarget: CronSessionTargetSchema,
    wakeMode: CronWakeModeSchema,
    payload: CronPayloadSchema,
    delivery: Type.Optional(CronDeliverySchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
  },
  { additionalProperties: false },
);

export const CronJobPatchSchema = Type.Object(
  {
    name: Type.Optional(NonEmptyString),
    ...CronCommonOptionalFields,
    schedule: Type.Optional(CronScheduleSchema),
    sessionTarget: Type.Optional(CronSessionTargetSchema),
    wakeMode: Type.Optional(CronWakeModeSchema),
    payload: Type.Optional(CronPayloadPatchSchema),
    delivery: Type.Optional(CronDeliveryPatchSchema),
    failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
    state: Type.Optional(Type.Partial(CronJobStateSchema)),
  },
  { additionalProperties: false },
);

export const CronUpdateParamsSchema = cronIdOrJobIdParams({
  patch: CronJobPatchSchema,
});

export const CronRemoveParamsSchema = cronIdOrJobIdParams({});

export const CronRunParamsSchema = cronIdOrJobIdParams({
  mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])),
});

export const CronRunsParamsSchema = Type.Object(
  {
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    deliveryStatuses: Type.Optional(
      Type.Array(CronDeliveryStatusSchema, { maxItems: 4, minItems: 1 }),
    ),
    id: Type.Optional(CronRunLogJobIdSchema),
    jobId: Type.Optional(CronRunLogJobIdSchema),
    limit: Type.Optional(Type.Integer({ maximum: 200, minimum: 1 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    query: Type.Optional(Type.String()),
    scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
    sortDir: Type.Optional(CronSortDirSchema),
    status: Type.Optional(CronRunsStatusFilterSchema),
    statuses: Type.Optional(Type.Array(CronRunsStatusValueSchema, { maxItems: 3, minItems: 1 })),
  },
  { additionalProperties: false },
);

export const CronRunLogEntrySchema = Type.Object(
  {
    action: Type.Literal("finished"),
    delivered: Type.Optional(Type.Boolean()),
    deliveryError: Type.Optional(Type.String()),
    deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    error: Type.Optional(Type.String()),
    jobId: NonEmptyString,
    jobName: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    provider: Type.Optional(Type.String()),
    runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    status: Type.Optional(CronRunStatusSchema),
    summary: Type.Optional(Type.String()),
    ts: Type.Integer({ minimum: 0 }),
    usage: Type.Optional(
      Type.Object(
        {
          cache_read_tokens: Type.Optional(Type.Number()),
          cache_write_tokens: Type.Optional(Type.Number()),
          input_tokens: Type.Optional(Type.Number()),
          output_tokens: Type.Optional(Type.Number()),
          total_tokens: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
