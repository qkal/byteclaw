import { Type } from "@sinclair/typebox";
import {
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
} from "../../../infra/plugin-approvals.js";
import { NonEmptyString } from "./primitives.js";

export const PluginApprovalRequestParamsSchema = Type.Object(
  {
    agentId: Type.Optional(Type.String()),
    description: Type.String({ maxLength: PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH, minLength: 1 }),
    pluginId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(Type.String()),
    severity: Type.Optional(Type.String({ enum: ["info", "warning", "critical"] })),
    timeoutMs: Type.Optional(Type.Integer({ maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS, minimum: 1 })),
    title: Type.String({ maxLength: PLUGIN_APPROVAL_TITLE_MAX_LENGTH, minLength: 1 }),
    toolCallId: Type.Optional(Type.String()),
    toolName: Type.Optional(Type.String()),
    turnSourceAccountId: Type.Optional(Type.String()),
    turnSourceChannel: Type.Optional(Type.String()),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    turnSourceTo: Type.Optional(Type.String()),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const PluginApprovalResolveParamsSchema = Type.Object(
  {
    decision: NonEmptyString,
    id: NonEmptyString,
  },
  { additionalProperties: false },
);
