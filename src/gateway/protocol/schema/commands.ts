import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const CommandSourceSchema = Type.Union([
  Type.Literal("native"),
  Type.Literal("skill"),
  Type.Literal("plugin"),
]);

export const CommandScopeSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("native"),
  Type.Literal("both"),
]);

export const CommandCategorySchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("options"),
  Type.Literal("status"),
  Type.Literal("management"),
  Type.Literal("media"),
  Type.Literal("tools"),
  Type.Literal("docks"),
]);

export const CommandArgChoiceSchema = Type.Object(
  {
    label: Type.String(),
    value: Type.String(),
  },
  { additionalProperties: false },
);

export const CommandArgSchema = Type.Object(
  {
    choices: Type.Optional(Type.Array(CommandArgChoiceSchema)),
    description: Type.String(),
    dynamic: Type.Optional(Type.Boolean()),
    name: NonEmptyString,
    required: Type.Optional(Type.Boolean()),
    type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
  },
  { additionalProperties: false },
);

export const CommandEntrySchema = Type.Object(
  {
    acceptsArgs: Type.Boolean(),
    args: Type.Optional(Type.Array(CommandArgSchema)),
    category: Type.Optional(CommandCategorySchema),
    description: Type.String(),
    name: NonEmptyString,
    nativeName: Type.Optional(NonEmptyString),
    scope: CommandScopeSchema,
    source: CommandSourceSchema,
    textAliases: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const CommandsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    includeArgs: Type.Optional(Type.Boolean()),
    provider: Type.Optional(NonEmptyString),
    scope: Type.Optional(CommandScopeSchema),
  },
  { additionalProperties: false },
);

export const CommandsListResultSchema = Type.Object(
  {
    commands: Type.Array(CommandEntrySchema),
  },
  { additionalProperties: false },
);
