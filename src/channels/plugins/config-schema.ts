import { type ZodRawShape, type ZodTypeAny, z } from "zod";
import { DmPolicySchema } from "../../config/zod-schema.core.js";
import type {
  ChannelConfigRuntimeIssue,
  ChannelConfigRuntimeParseResult,
  ChannelConfigSchema,
  ChannelConfigUiHint,
} from "./types.plugin.js";

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

type ExtendableZodObject = ZodTypeAny & {
  extend: (shape: Record<string, ZodTypeAny>) => ZodTypeAny;
};

export const AllowFromEntrySchema = z.union([z.string(), z.number()]);
export const AllowFromListSchema = z.array(AllowFromEntrySchema).optional();

export function buildNestedDmConfigSchema<TExtraShape extends ZodRawShape = {}>(
  extraShape?: TExtraShape,
) {
  const baseShape = {
    allowFrom: AllowFromListSchema,
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional(),
  };
  return z.object(extraShape ? { ...baseShape, ...extraShape } : baseShape).optional();
}

export function buildCatchallMultiAccountChannelSchema<T extends ExtendableZodObject>(
  accountSchema: T,
): T {
  return accountSchema.extend({
    accounts: z.object({}).catchall(accountSchema).optional(),
    defaultAccount: z.string().optional(),
  }) as T;
}

interface BuildChannelConfigSchemaOptions {
  uiHints?: Record<string, ChannelConfigUiHint>;
}

function cloneRuntimeIssue(issue: unknown): ChannelConfigRuntimeIssue {
  const record = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
  const path = Array.isArray(record.path)
    ? record.path.filter((segment): segment is string | number => {
        const kind = typeof segment;
        return kind === "string" || kind === "number";
      })
    : undefined;
  return {
    ...record,
    ...(path ? { path } : {}),
  };
}

function safeParseRuntimeSchema(
  schema: ZodTypeAny,
  value: unknown,
): ChannelConfigRuntimeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      data: result.data,
      success: true,
    };
  }
  return {
    issues: result.error.issues.map((issue) => cloneRuntimeIssue(issue)),
    success: false,
  };
}

export function buildChannelConfigSchema(
  schema: ZodTypeAny,
  options?: BuildChannelConfigSchemaOptions,
): ChannelConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      schema: schemaWithJson.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>,
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      runtime: {
        safeParse: (value) => safeParseRuntimeSchema(schema, value),
      },
    };
  }

  // Compatibility fallback for plugins built against Zod v3 schemas,
  // Where `.toJSONSchema()` is unavailable.
  return {
    schema: {
      additionalProperties: true,
      type: "object",
    },
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    runtime: {
      safeParse: (value) => safeParseRuntimeSchema(schema, value),
    },
  };
}

export function emptyChannelConfigSchema(): ChannelConfigSchema {
  return {
    runtime: {
      safeParse(value) {
        if (value === undefined) {
          return { data: undefined, success: true };
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return {
            issues: [{ path: [], message: "expected config object" }],
            success: false,
          };
        }
        if (Object.keys(value as Record<string, unknown>).length > 0) {
          return {
            issues: [{ path: [], message: "config must be empty" }],
            success: false,
          };
        }
        return { data: value, success: true };
      },
    },
    schema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
  };
}
