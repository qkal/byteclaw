import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const DevicePairListParamsSchema = Type.Object({}, { additionalProperties: false });

export const DevicePairApproveParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

export const DevicePairRejectParamsSchema = Type.Object(
  { requestId: NonEmptyString },
  { additionalProperties: false },
);

export const DevicePairRemoveParamsSchema = Type.Object(
  { deviceId: NonEmptyString },
  { additionalProperties: false },
);

export const DeviceTokenRotateParamsSchema = Type.Object(
  {
    deviceId: NonEmptyString,
    role: NonEmptyString,
    scopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const DeviceTokenRevokeParamsSchema = Type.Object(
  {
    deviceId: NonEmptyString,
    role: NonEmptyString,
  },
  { additionalProperties: false },
);

export const DevicePairRequestedEventSchema = Type.Object(
  {
    clientId: Type.Optional(NonEmptyString),
    clientMode: Type.Optional(NonEmptyString),
    deviceFamily: Type.Optional(NonEmptyString),
    deviceId: NonEmptyString,
    displayName: Type.Optional(NonEmptyString),
    isRepair: Type.Optional(Type.Boolean()),
    platform: Type.Optional(NonEmptyString),
    publicKey: NonEmptyString,
    remoteIp: Type.Optional(NonEmptyString),
    requestId: NonEmptyString,
    role: Type.Optional(NonEmptyString),
    roles: Type.Optional(Type.Array(NonEmptyString)),
    scopes: Type.Optional(Type.Array(NonEmptyString)),
    silent: Type.Optional(Type.Boolean()),
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const DevicePairResolvedEventSchema = Type.Object(
  {
    decision: NonEmptyString,
    deviceId: NonEmptyString,
    requestId: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
