import type { z} from "zod";
import type { ZodTypeAny } from "zod";
import type { OpenClawPluginConfigSchema, PluginConfigUiHint } from "./types.js";

interface Issue { path: (string | number)[]; message: string }

type SafeParseResult =
  | { success: true; data?: unknown }
  | { success: false; error: { issues: Issue[] } };

type ZodSchemaWithToJsonSchema = ZodTypeAny & {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
};

interface BuildPluginConfigSchemaOptions {
  uiHints?: Record<string, PluginConfigUiHint>;
  safeParse?: OpenClawPluginConfigSchema["safeParse"];
}

function error(message: string): SafeParseResult {
  return { error: { issues: [{ message, path: [] }] }, success: false };
}

function cloneIssue(issue: z.ZodIssue): Issue {
  return {
    message: issue.message,
    path: issue.path.filter((segment): segment is string | number => {
      const kind = typeof segment;
      return kind === "string" || kind === "number";
    }),
  };
}

function safeParseRuntimeSchema(schema: ZodTypeAny, value: unknown): SafeParseResult {
  const result = schema.safeParse(value);
  if (result.success) {
    return {
      data: result.data,
      success: true,
    };
  }
  return {
    error: { issues: result.error.issues.map((issue) => cloneIssue(issue)) },
    success: false,
  };
}

function normalizeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeJsonSchema(item));
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const record = { ...(schema as Record<string, unknown>) };
  delete record.$schema;

  for (const [key, value] of Object.entries(record)) {
    record[key] = normalizeJsonSchema(value);
  }

  const {propertyNames} = record;
  if (
    propertyNames &&
    typeof propertyNames === "object" &&
    !Array.isArray(propertyNames) &&
    (propertyNames as Record<string, unknown>).type === "string"
  ) {
    delete record.propertyNames;
  }

  if (Array.isArray(record.required) && record.required.length === 0) {
    delete record.required;
  }

  return record;
}

export function buildPluginConfigSchema(
  schema: ZodTypeAny,
  options?: BuildPluginConfigSchemaOptions,
): OpenClawPluginConfigSchema {
  const schemaWithJson = schema as ZodSchemaWithToJsonSchema;
  const safeParse = options?.safeParse ?? ((value) => safeParseRuntimeSchema(schema, value));
  if (typeof schemaWithJson.toJSONSchema === "function") {
    return {
      safeParse,
      ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
      jsonSchema: normalizeJsonSchema(
        schemaWithJson.toJSONSchema({
          io: "input",
          target: "draft-07",
          unrepresentable: "any",
        }),
      ) as Record<string, unknown>,
    };
  }

  return {
    safeParse,
    ...(options?.uiHints ? { uiHints: options.uiHints } : {}),
    jsonSchema: {
      additionalProperties: true,
      type: "object",
    },
  };
}

export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    jsonSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    safeParse(value: unknown): SafeParseResult {
      if (value === undefined) {
        return { data: undefined, success: true };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value as Record<string, unknown>).length > 0) {
        return error("config must be empty");
      }
      return { data: value, success: true };
    },
  };
}
