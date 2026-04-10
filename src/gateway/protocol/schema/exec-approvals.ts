import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ExecApprovalsAllowlistEntrySchema = Type.Object(
  {
    argPattern: Type.Optional(Type.String()),
    id: Type.Optional(NonEmptyString),
    lastResolvedPath: Type.Optional(Type.String()),
    lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastUsedCommand: Type.Optional(Type.String()),
    pattern: Type.String(),
  },
  { additionalProperties: false },
);

const ExecApprovalsPolicyFields = {
  ask: Type.Optional(Type.String()),
  askFallback: Type.Optional(Type.String()),
  autoAllowSkills: Type.Optional(Type.Boolean()),
  security: Type.Optional(Type.String()),
};

export const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, {
  additionalProperties: false,
});

export const ExecApprovalsAgentSchema = Type.Object(
  {
    ...ExecApprovalsPolicyFields,
    allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema)),
  },
  { additionalProperties: false },
);

export const ExecApprovalsFileSchema = Type.Object(
  {
    agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema)),
    defaults: Type.Optional(ExecApprovalsDefaultsSchema),
    socket: Type.Optional(
      Type.Object(
        {
          path: Type.Optional(Type.String()),
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    version: Type.Literal(1),
  },
  { additionalProperties: false },
);

export const ExecApprovalsSnapshotSchema = Type.Object(
  {
    exists: Type.Boolean(),
    file: ExecApprovalsFileSchema,
    hash: NonEmptyString,
    path: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const ExecApprovalsSetParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(NonEmptyString),
    file: ExecApprovalsFileSchema,
  },
  { additionalProperties: false },
);

export const ExecApprovalsNodeGetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalsNodeSetParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(NonEmptyString),
    file: ExecApprovalsFileSchema,
    nodeId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ExecApprovalRequestParamsSchema = Type.Object(
  {
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    command: Type.Optional(NonEmptyString),
    commandArgv: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
    host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    id: Type.Optional(NonEmptyString),
    nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
    resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    systemRunPlan: Type.Optional(
      Type.Object(
        {
          agentId: Type.Union([Type.String(), Type.Null()]),
          argv: Type.Array(Type.String()),
          commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          commandText: Type.String(),
          cwd: Type.Union([Type.String(), Type.Null()]),
          mutableFileOperand: Type.Optional(
            Type.Union([
              Type.Object(
                {
                  argvIndex: Type.Integer({ minimum: 0 }),
                  path: Type.String(),
                  sha256: Type.String(),
                },
                { additionalProperties: false },
              ),
              Type.Null(),
            ]),
          ),
          sessionKey: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: false },
      ),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
    turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ExecApprovalResolveParamsSchema = Type.Object(
  {
    decision: NonEmptyString,
    id: NonEmptyString,
  },
  { additionalProperties: false },
);
