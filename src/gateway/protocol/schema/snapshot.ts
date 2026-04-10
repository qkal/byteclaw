import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const PresenceEntrySchema = Type.Object(
  {
    deviceFamily: Type.Optional(NonEmptyString),
    deviceId: Type.Optional(NonEmptyString),
    host: Type.Optional(NonEmptyString),
    instanceId: Type.Optional(NonEmptyString),
    ip: Type.Optional(NonEmptyString),
    lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    mode: Type.Optional(NonEmptyString),
    modelIdentifier: Type.Optional(NonEmptyString),
    platform: Type.Optional(NonEmptyString),
    reason: Type.Optional(NonEmptyString),
    roles: Type.Optional(Type.Array(NonEmptyString)),
    scopes: Type.Optional(Type.Array(NonEmptyString)),
    tags: Type.Optional(Type.Array(NonEmptyString)),
    text: Type.Optional(Type.String()),
    ts: Type.Integer({ minimum: 0 }),
    version: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const HealthSnapshotSchema = Type.Any();

export const SessionDefaultsSchema = Type.Object(
  {
    defaultAgentId: NonEmptyString,
    mainKey: NonEmptyString,
    mainSessionKey: NonEmptyString,
    scope: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const StateVersionSchema = Type.Object(
  {
    health: Type.Integer({ minimum: 0 }),
    presence: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const SnapshotSchema = Type.Object(
  {
    authMode: Type.Optional(
      Type.Union([
        Type.Literal("none"),
        Type.Literal("token"),
        Type.Literal("password"),
        Type.Literal("trusted-proxy"),
      ]),
    ),
    configPath: Type.Optional(NonEmptyString),
    health: HealthSnapshotSchema,
    presence: Type.Array(PresenceEntrySchema),
    sessionDefaults: Type.Optional(SessionDefaultsSchema),
    stateDir: Type.Optional(NonEmptyString),
    stateVersion: StateVersionSchema,
    updateAvailable: Type.Optional(
      Type.Object({
        channel: NonEmptyString,
        currentVersion: NonEmptyString,
        latestVersion: NonEmptyString,
      }),
    ),
    uptimeMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
