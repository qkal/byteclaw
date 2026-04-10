import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

function expectValidationFailure(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }> {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

function expectValidationIssue(
  result: Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }>,
  path: string,
) {
  const issue = result.errors.find((entry) => entry.path === path);
  expect(issue).toBeDefined();
  return issue;
}

function expectIssueMessageIncludes(
  issue: ReturnType<typeof expectValidationIssue>,
  fragments: readonly string[],
) {
  expect(issue?.message).toEqual(expect.stringContaining(fragments[0] ?? ""));
  fragments.slice(1).forEach((fragment) => {
    expect(issue?.message).toContain(fragment);
  });
}

function expectSuccessfulValidationValue(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  expectedValue: unknown;
}) {
  const result = validateJsonSchemaValue(params.input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(params.expectedValue);
  }
}

function expectValidationSuccess(params: Parameters<typeof validateJsonSchemaValue>[0]) {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(true);
}

function expectUriValidationCase(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  ok: boolean;
  expectedPath?: string;
  expectedMessage?: string;
}) {
  if (params.ok) {
    expectValidationSuccess(params.input);
    return;
  }

  const result = expectValidationFailure(params.input);
  const issue = expectValidationIssue(result, params.expectedPath ?? "");
  expect(issue?.message).toContain(params.expectedMessage ?? "");
}

describe("schema validator", () => {
  it("can apply JSON Schema defaults while validating", () => {
    expectSuccessfulValidationValue({
      expectedValue: { mode: "auto" },
      input: {
        applyDefaults: true,
        cacheKey: "schema-validator.test.defaults",
        schema: {
          additionalProperties: false,
          properties: {
            mode: {
              default: "auto",
              type: "string",
            },
          },
          type: "object",
        },
        value: {},
      },
    });
  });

  it.each([
    {
      allowedValues: ["markdown", "html", "json"],
      hiddenCount: 0,
      messageIncludes: ["(allowed:"],
      params: {
        cacheKey: "schema-validator.test.enum",
        schema: {
          properties: {
            fileFormat: {
              enum: ["markdown", "html", "json"],
              type: "string",
            },
          },
          required: ["fileFormat"],
          type: "object",
        },
        value: { fileFormat: "txt" },
      },
      path: "fileFormat",
      title: "includes allowed values in enum validation errors",
    },
    {
      allowedValues: ["strict"],
      hiddenCount: 0,
      messageIncludes: ["(allowed:"],
      params: {
        cacheKey: "schema-validator.test.const",
        schema: {
          properties: {
            mode: {
              const: "strict",
            },
          },
          required: ["mode"],
          type: "object",
        },
        value: { mode: "relaxed" },
      },
      path: "mode",
      title: "includes allowed value in const validation errors",
    },
    {
      allowedValues: ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"],
      hiddenCount: 1,
      messageIncludes: ["(allowed:", "... (+1 more)"],
      params: {
        cacheKey: "schema-validator.test.enum.truncate",
        schema: {
          properties: {
            mode: {
              enum: [
                "v1",
                "v2",
                "v3",
                "v4",
                "v5",
                "v6",
                "v7",
                "v8",
                "v9",
                "v10",
                "v11",
                "v12",
                "v13",
              ],
              type: "string",
            },
          },
          required: ["mode"],
          type: "object",
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      title: "truncates long allowed-value hints",
    },
    {
      messageIncludes: ["(allowed:", "... (+"],
      params: {
        cacheKey: "schema-validator.test.enum.long-value",
        schema: {
          properties: {
            mode: {
              enum: ["a".repeat(300)],
              type: "string",
            },
          },
          required: ["mode"],
          type: "object",
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      title: "truncates oversized allowed value entries",
    },
  ])("$title", ({ params, path, messageIncludes, allowedValues, hiddenCount }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, path);

    expectIssueMessageIncludes(issue, messageIncludes);
    if (allowedValues) {
      expect(issue?.allowedValues).toEqual(allowedValues);
      expect(issue?.allowedValuesHiddenCount).toBe(hiddenCount);
    }
  });

  it.each([
    {
      expectedPath: "settings.mode",
      params: {
        cacheKey: "schema-validator.test.required.path",
        schema: {
          properties: {
            settings: {
              properties: {
                mode: { type: "string" },
              },
              required: ["mode"],
              type: "object",
            },
          },
          required: ["settings"],
          type: "object",
        },
        value: { settings: {} },
      },
      title: "appends missing required property to the structured path",
    },
    {
      expectedPath: "settings.format",
      params: {
        cacheKey: "schema-validator.test.dependencies.path",
        schema: {
          properties: {
            settings: {
              dependencies: {
                mode: ["format"],
              },
              type: "object",
            },
          },
          type: "object",
        },
        value: { settings: { mode: "strict" } },
      },
      title: "appends missing dependency property to the structured path",
    },
  ])("$title", ({ params, expectedPath }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, expectedPath);

    expect(issue?.allowedValues).toBeUndefined();
  });

  it("sanitizes terminal text while preserving structured fields", () => {
    const maliciousProperty = "evil\nkey\t\x1b[31mred\x1b[0m";
    const result = expectValidationFailure({
      cacheKey: "schema-validator.test.terminal-sanitize",
      schema: {
        properties: {},
        required: [maliciousProperty],
        type: "object",
      },
      value: {},
    });

    const issue = result.errors[0];
    expect(issue).toBeDefined();
    expect(issue?.path).toContain("\n");
    expect(issue?.message).toContain("\n");
    expect(issue?.text).toContain(String.raw`\n`);
    expect(issue?.text).toContain(String.raw`\t`);
    expect(issue?.text).not.toContain("\n");
    expect(issue?.text).not.toContain("\t");
    expect(issue?.text).not.toContain("\x1b");
  });

  it.each([
    {
      ok: true,
      params: {
        cacheKey: "schema-validator.test.uri.valid",
        schema: {
          properties: {
            apiRoot: {
              format: "uri",
              type: "string",
            },
          },
          required: ["apiRoot"],
          type: "object",
        },
        value: { apiRoot: "https://api.telegram.org" },
      },
      title: "accepts uri-formatted string schemas for valid urls",
    },
    {
      expectedMessage: "must match format",
      expectedPath: "apiRoot",
      ok: false,
      params: {
        cacheKey: "schema-validator.test.uri.invalid",
        schema: {
          properties: {
            apiRoot: {
              format: "uri",
              type: "string",
            },
          },
          required: ["apiRoot"],
          type: "object",
        },
        value: { apiRoot: "not a uri" },
      },
      title: "rejects uri-formatted string schemas for invalid urls",
    },
  ])(
    "supports uri-formatted string schemas: $title",
    ({ params, ok, expectedPath, expectedMessage }) => {
      expectUriValidationCase({
        expectedMessage,
        expectedPath,
        input: params,
        ok,
      });
    },
  );
});
