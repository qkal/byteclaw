import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });

export const PushTestParamsSchema = Type.Object(
  {
    body: Type.Optional(Type.String()),
    environment: Type.Optional(ApnsEnvironmentSchema),
    nodeId: NonEmptyString,
    title: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PushTestResultSchema = Type.Object(
  {
    apnsId: Type.Optional(Type.String()),
    environment: ApnsEnvironmentSchema,
    ok: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    status: Type.Integer(),
    tokenSuffix: Type.String(),
    topic: Type.String(),
    transport: Type.String({ enum: ["direct", "relay"] }),
  },
  { additionalProperties: false },
);
