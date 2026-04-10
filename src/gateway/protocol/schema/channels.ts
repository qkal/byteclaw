import { Type } from "@sinclair/typebox";
import { NonEmptyString, SecretInputSchema } from "./primitives.js";

export const TalkModeParamsSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    phase: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const TalkConfigParamsSchema = Type.Object(
  {
    includeSecrets: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const TalkSpeakParamsSchema = Type.Object(
  {
    language: Type.Optional(Type.String()),
    latencyTier: Type.Optional(Type.Integer({ minimum: 0 })),
    modelId: Type.Optional(Type.String()),
    normalize: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    rateWpm: Type.Optional(Type.Integer({ minimum: 1 })),
    seed: Type.Optional(Type.Integer({ minimum: 0 })),
    similarity: Type.Optional(Type.Number()),
    speakerBoost: Type.Optional(Type.Boolean()),
    speed: Type.Optional(Type.Number()),
    stability: Type.Optional(Type.Number()),
    style: Type.Optional(Type.Number()),
    text: NonEmptyString,
    voiceId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const talkProviderFieldSchemas = {
  apiKey: Type.Optional(SecretInputSchema),
};

const TalkProviderConfigSchema = Type.Object(talkProviderFieldSchemas, {
  additionalProperties: true,
});

const ResolvedTalkConfigSchema = Type.Object(
  {
    config: TalkProviderConfigSchema,
    provider: Type.String(),
  },
  { additionalProperties: false },
);

const TalkConfigSchema = Type.Object(
  {
    interruptOnSpeech: Type.Optional(Type.Boolean()),
    provider: Type.Optional(Type.String()),
    providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
    resolved: ResolvedTalkConfigSchema,
    silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const TalkConfigResultSchema = Type.Object(
  {
    config: Type.Object(
      {
        session: Type.Optional(
          Type.Object(
            {
              mainKey: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
        talk: Type.Optional(TalkConfigSchema),
        ui: Type.Optional(
          Type.Object(
            {
              seamColor: Type.Optional(Type.String()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TalkSpeakResultSchema = Type.Object(
  {
    audioBase64: NonEmptyString,
    fileExtension: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    outputFormat: Type.Optional(Type.String()),
    provider: NonEmptyString,
    voiceCompatible: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ChannelsStatusParamsSchema = Type.Object(
  {
    probe: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

// Channel docking: channels.status is intentionally schema-light so new
// Channels can ship without protocol updates.
export const ChannelAccountSnapshotSchema = Type.Object(
  {
    accountId: NonEmptyString,
    activeRuns: Type.Optional(Type.Integer({ minimum: 0 })),
    allowFrom: Type.Optional(Type.Array(Type.String())),
    allowUnmentionedGroups: Type.Optional(Type.Boolean()),
    appTokenSource: Type.Optional(Type.String()),
    application: Type.Optional(Type.Unknown()),
    audit: Type.Optional(Type.Unknown()),
    baseUrl: Type.Optional(Type.String()),
    botTokenSource: Type.Optional(Type.String()),
    busy: Type.Optional(Type.Boolean()),
    cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    configured: Type.Optional(Type.Boolean()),
    connected: Type.Optional(Type.Boolean()),
    dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    dmPolicy: Type.Optional(Type.String()),
    enabled: Type.Optional(Type.Boolean()),
    healthState: Type.Optional(Type.String()),
    lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastError: Type.Optional(Type.String()),
    lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastRunActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
    linked: Type.Optional(Type.Boolean()),
    mode: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    probe: Type.Optional(Type.Unknown()),
    reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    running: Type.Optional(Type.Boolean()),
    tokenSource: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

export const ChannelUiMetaSchema = Type.Object(
  {
    detailLabel: NonEmptyString,
    id: NonEmptyString,
    label: NonEmptyString,
    systemImage: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChannelsStatusResultSchema = Type.Object(
  {
    channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
    channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString),
    channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channelLabels: Type.Record(NonEmptyString, NonEmptyString),
    channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
    channelOrder: Type.Array(NonEmptyString),
    channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
    channels: Type.Record(NonEmptyString, Type.Unknown()),
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const ChannelsLogoutParamsSchema = Type.Object(
  {
    accountId: Type.Optional(Type.String()),
    channel: NonEmptyString,
  },
  { additionalProperties: false },
);

export const WebLoginStartParamsSchema = Type.Object(
  {
    accountId: Type.Optional(Type.String()),
    force: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    verbose: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const WebLoginWaitParamsSchema = Type.Object(
  {
    accountId: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
