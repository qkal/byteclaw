import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const WizardRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("cancelled"),
  Type.Literal("error"),
]);

export const WizardStartParamsSchema = Type.Object(
  {
    mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
    workspace: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const WizardAnswerSchema = Type.Object(
  {
    stepId: NonEmptyString,
    value: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const WizardNextParamsSchema = Type.Object(
  {
    answer: Type.Optional(WizardAnswerSchema),
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

const WizardSessionIdParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WizardCancelParamsSchema = WizardSessionIdParamsSchema;

export const WizardStatusParamsSchema = WizardSessionIdParamsSchema;

export const WizardStepOptionSchema = Type.Object(
  {
    hint: Type.Optional(Type.String()),
    label: NonEmptyString,
    value: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const WizardStepSchema = Type.Object(
  {
    executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")])),
    id: NonEmptyString,
    initialValue: Type.Optional(Type.Unknown()),
    message: Type.Optional(Type.String()),
    options: Type.Optional(Type.Array(WizardStepOptionSchema)),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    title: Type.Optional(Type.String()),
    type: Type.Union([
      Type.Literal("note"),
      Type.Literal("select"),
      Type.Literal("text"),
      Type.Literal("confirm"),
      Type.Literal("multiselect"),
      Type.Literal("progress"),
      Type.Literal("action"),
    ]),
  },
  { additionalProperties: false },
);

const WizardResultFields = {
  done: Type.Boolean(),
  error: Type.Optional(Type.String()),
  status: Type.Optional(WizardRunStatusSchema),
  step: Type.Optional(WizardStepSchema),
};

export const WizardNextResultSchema = Type.Object(WizardResultFields, {
  additionalProperties: false,
});

export const WizardStartResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    ...WizardResultFields,
  },
  { additionalProperties: false },
);

export const WizardStatusResultSchema = Type.Object(
  {
    error: Type.Optional(Type.String()),
    status: WizardRunStatusSchema,
  },
  { additionalProperties: false },
);
