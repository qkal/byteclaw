import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const ModelChoiceSchema = Type.Object(
  {
    alias: Type.Optional(NonEmptyString),
    contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
    id: NonEmptyString,
    name: NonEmptyString,
    provider: NonEmptyString,
    reasoning: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentSummarySchema = Type.Object(
  {
    id: NonEmptyString,
    identity: Type.Optional(
      Type.Object(
        {
          avatar: Type.Optional(NonEmptyString),
          avatarUrl: Type.Optional(NonEmptyString),
          emoji: Type.Optional(NonEmptyString),
          name: Type.Optional(NonEmptyString),
          theme: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    model: Type.Optional(
      Type.Object(
        {
          fallbacks: Type.Optional(Type.Array(NonEmptyString)),
          primary: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const AgentsListResultSchema = Type.Object(
  {
    agents: Type.Array(AgentSummarySchema),
    defaultId: NonEmptyString,
    mainKey: NonEmptyString,
    scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
  },
  { additionalProperties: false },
);

export const AgentsCreateParamsSchema = Type.Object(
  {
    avatar: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    model: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsCreateResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    model: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    ok: Type.Literal(true),
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsUpdateParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    avatar: Type.Optional(Type.String()),
    emoji: Type.Optional(Type.String()),
    model: Type.Optional(NonEmptyString),
    name: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const AgentsUpdateResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    ok: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const AgentsDeleteParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    deleteFiles: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentsDeleteResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    ok: Type.Literal(true),
    removedBindings: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const AgentsFileEntrySchema = Type.Object(
  {
    content: Type.Optional(Type.String()),
    missing: Type.Boolean(),
    name: NonEmptyString,
    path: NonEmptyString,
    size: Type.Optional(Type.Integer({ minimum: 0 })),
    updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const AgentsFilesListParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesListResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    files: Type.Array(AgentsFileEntrySchema),
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesGetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    file: AgentsFileEntrySchema,
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    content: Type.String(),
    name: NonEmptyString,
  },
  { additionalProperties: false },
);

export const AgentsFilesSetResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    file: AgentsFileEntrySchema,
    ok: Type.Literal(true),
    workspace: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ModelsListParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsListResultSchema = Type.Object(
  {
    models: Type.Array(ModelChoiceSchema),
  },
  { additionalProperties: false },
);

export const SkillsStatusParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });

export const SkillsBinsResultSchema = Type.Object(
  {
    bins: Type.Array(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsInstallParamsSchema = Type.Union([
  Type.Object(
    {
      dangerouslyForceUnsafeInstall: Type.Optional(Type.Boolean()),
      installId: NonEmptyString,
      name: NonEmptyString,
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      force: Type.Optional(Type.Boolean()),
      slug: NonEmptyString,
      source: Type.Literal("clawhub"),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
      version: Type.Optional(NonEmptyString),
    },
    { additionalProperties: false },
  ),
]);

export const SkillsUpdateParamsSchema = Type.Union([
  Type.Object(
    {
      apiKey: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
      skillKey: NonEmptyString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      all: Type.Optional(Type.Boolean()),
      slug: Type.Optional(NonEmptyString),
      source: Type.Literal("clawhub"),
    },
    { additionalProperties: false },
  ),
]);

export const SkillsSearchParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    query: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SkillsSearchResultSchema = Type.Object(
  {
    results: Type.Array(
      Type.Object(
        {
          displayName: NonEmptyString,
          score: Type.Number(),
          slug: NonEmptyString,
          summary: Type.Optional(Type.String()),
          updatedAt: Type.Optional(Type.Integer()),
          version: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const SkillsDetailParamsSchema = Type.Object(
  {
    slug: NonEmptyString,
  },
  { additionalProperties: false },
);

export const SkillsDetailResultSchema = Type.Object(
  {
    latestVersion: Type.Optional(
      Type.Union([
        Type.Object(
          {
            changelog: Type.Optional(Type.String()),
            createdAt: Type.Integer(),
            version: NonEmptyString,
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    metadata: Type.Optional(
      Type.Union([
        Type.Object(
          {
            os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
            systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    owner: Type.Optional(
      Type.Union([
        Type.Object(
          {
            displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
            image: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    ),
    skill: Type.Union([
      Type.Object(
        {
          createdAt: Type.Integer(),
          displayName: NonEmptyString,
          slug: NonEmptyString,
          summary: Type.Optional(Type.String()),
          tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
          updatedAt: Type.Integer(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const ToolsCatalogParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includePlugins: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ToolCatalogProfileSchema = Type.Object(
  {
    id: Type.Union([
      Type.Literal("minimal"),
      Type.Literal("coding"),
      Type.Literal("messaging"),
      Type.Literal("full"),
    ]),
    label: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ToolCatalogEntrySchema = Type.Object(
  {
    defaultProfiles: Type.Array(
      Type.Union([
        Type.Literal("minimal"),
        Type.Literal("coding"),
        Type.Literal("messaging"),
        Type.Literal("full"),
      ]),
    ),
    description: Type.String(),
    id: NonEmptyString,
    label: NonEmptyString,
    optional: Type.Optional(Type.Boolean()),
    pluginId: Type.Optional(NonEmptyString),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
  },
  { additionalProperties: false },
);

export const ToolCatalogGroupSchema = Type.Object(
  {
    id: NonEmptyString,
    label: NonEmptyString,
    pluginId: Type.Optional(NonEmptyString),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
    tools: Type.Array(ToolCatalogEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsCatalogResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    groups: Type.Array(ToolCatalogGroupSchema),
    profiles: Type.Array(ToolCatalogProfileSchema),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveEntrySchema = Type.Object(
  {
    channelId: Type.Optional(NonEmptyString),
    description: Type.String(),
    id: NonEmptyString,
    label: NonEmptyString,
    pluginId: Type.Optional(NonEmptyString),
    rawDescription: Type.String(),
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin"), Type.Literal("channel")]),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveGroupSchema = Type.Object(
  {
    id: Type.Union([Type.Literal("core"), Type.Literal("plugin"), Type.Literal("channel")]),
    label: NonEmptyString,
    source: Type.Union([Type.Literal("core"), Type.Literal("plugin"), Type.Literal("channel")]),
    tools: Type.Array(ToolsEffectiveEntrySchema),
  },
  { additionalProperties: false },
);

export const ToolsEffectiveResultSchema = Type.Object(
  {
    agentId: NonEmptyString,
    groups: Type.Array(ToolsEffectiveGroupSchema),
    profile: NonEmptyString,
  },
  { additionalProperties: false },
);
