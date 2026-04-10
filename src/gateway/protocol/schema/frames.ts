import { Type } from "@sinclair/typebox";
import { GatewayClientIdSchema, GatewayClientModeSchema, NonEmptyString } from "./primitives.js";
import { SnapshotSchema, StateVersionSchema } from "./snapshot.js";

export const TickEventSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ShutdownEventSchema = Type.Object(
  {
    reason: NonEmptyString,
    restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const ConnectParamsSchema = Type.Object(
  {
    auth: Type.Optional(
      Type.Object(
        {
          bootstrapToken: Type.Optional(Type.String()),
          deviceToken: Type.Optional(Type.String()),
          password: Type.Optional(Type.String()),
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
    client: Type.Object(
      {
        deviceFamily: Type.Optional(NonEmptyString),
        displayName: Type.Optional(NonEmptyString),
        id: GatewayClientIdSchema,
        instanceId: Type.Optional(NonEmptyString),
        mode: GatewayClientModeSchema,
        modelIdentifier: Type.Optional(NonEmptyString),
        platform: NonEmptyString,
        version: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    commands: Type.Optional(Type.Array(NonEmptyString)),
    device: Type.Optional(
      Type.Object(
        {
          id: NonEmptyString,
          nonce: NonEmptyString,
          publicKey: NonEmptyString,
          signature: NonEmptyString,
          signedAt: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
      ),
    ),
    locale: Type.Optional(Type.String()),
    maxProtocol: Type.Integer({ minimum: 1 }),
    minProtocol: Type.Integer({ minimum: 1 }),
    pathEnv: Type.Optional(Type.String()),
    permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
    role: Type.Optional(NonEmptyString),
    scopes: Type.Optional(Type.Array(NonEmptyString)),
    userAgent: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const HelloOkSchema = Type.Object(
  {
    auth: Type.Optional(
      Type.Object(
        {
          deviceToken: NonEmptyString,
          deviceTokens: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  deviceToken: NonEmptyString,
                  role: NonEmptyString,
                  scopes: Type.Array(NonEmptyString),
                  issuedAtMs: Type.Integer({ minimum: 0 }),
                },
                { additionalProperties: false },
              ),
            ),
          ),
          issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
          role: NonEmptyString,
          scopes: Type.Array(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    canvasHostUrl: Type.Optional(NonEmptyString),
    features: Type.Object(
      {
        events: Type.Array(NonEmptyString),
        methods: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
    policy: Type.Object(
      {
        maxBufferedBytes: Type.Integer({ minimum: 1 }),
        maxPayload: Type.Integer({ minimum: 1 }),
        tickIntervalMs: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    protocol: Type.Integer({ minimum: 1 }),
    server: Type.Object(
      {
        connId: NonEmptyString,
        version: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    snapshot: SnapshotSchema,
    type: Type.Literal("hello-ok"),
  },
  { additionalProperties: false },
);

export const ErrorShapeSchema = Type.Object(
  {
    code: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
    message: NonEmptyString,
    retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const RequestFrameSchema = Type.Object(
  {
    id: NonEmptyString,
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
    type: Type.Literal("req"),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Object(
  {
    error: Type.Optional(ErrorShapeSchema),
    id: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    type: Type.Literal("res"),
  },
  { additionalProperties: false },
);

export const EventFrameSchema = Type.Object(
  {
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(Type.Integer({ minimum: 0 })),
    stateVersion: Type.Optional(StateVersionSchema),
    type: Type.Literal("event"),
  },
  { additionalProperties: false },
);

// Discriminated union of all top-level frames. Using a discriminator makes
// Downstream codegen (quicktype) produce tighter types instead of all-optional
// Blobs.
export const GatewayFrameSchema = Type.Union(
  [RequestFrameSchema, ResponseFrameSchema, EventFrameSchema],
  { discriminator: "type" },
);
