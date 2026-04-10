import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const ConfigSchemaLookupPathString = Type.String({
  maxLength: 1024,
  minLength: 1,
  pattern: "^[A-Za-z0-9_./\\[\\]\\-*]+$",
});

export const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });

export const ConfigSetParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(NonEmptyString),
    raw: NonEmptyString,
  },
  { additionalProperties: false },
);

const ConfigApplyLikeParamsSchema = Type.Object(
  {
    baseHash: Type.Optional(NonEmptyString),
    note: Type.Optional(Type.String()),
    raw: NonEmptyString,
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ConfigApplyParamsSchema = ConfigApplyLikeParamsSchema;
export const ConfigPatchParamsSchema = ConfigApplyLikeParamsSchema;

export const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });

export const ConfigSchemaLookupParamsSchema = Type.Object(
  {
    path: ConfigSchemaLookupPathString,
  },
  { additionalProperties: false },
);

export const UpdateRunParamsSchema = Type.Object(
  {
    note: Type.Optional(Type.String()),
    restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
    sessionKey: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const ConfigUiHintSchema = Type.Object(
  {
    advanced: Type.Optional(Type.Boolean()),
    group: Type.Optional(Type.String()),
    help: Type.Optional(Type.String()),
    itemTemplate: Type.Optional(Type.Unknown()),
    label: Type.Optional(Type.String()),
    order: Type.Optional(Type.Integer()),
    placeholder: Type.Optional(Type.String()),
    sensitive: Type.Optional(Type.Boolean()),
    tags: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export const ConfigSchemaResponseSchema = Type.Object(
  {
    generatedAt: NonEmptyString,
    schema: Type.Unknown(),
    uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
    version: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ConfigSchemaLookupChildSchema = Type.Object(
  {
    hasChildren: Type.Boolean(),
    hint: Type.Optional(ConfigUiHintSchema),
    hintPath: Type.Optional(Type.String()),
    key: NonEmptyString,
    path: NonEmptyString,
    required: Type.Boolean(),
    type: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  },
  { additionalProperties: false },
);

export const ConfigSchemaLookupResultSchema = Type.Object(
  {
    children: Type.Array(ConfigSchemaLookupChildSchema),
    hint: Type.Optional(ConfigUiHintSchema),
    hintPath: Type.Optional(Type.String()),
    path: NonEmptyString,
    schema: Type.Unknown(),
  },
  { additionalProperties: false },
);
