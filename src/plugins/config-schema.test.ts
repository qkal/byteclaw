import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildPluginConfigSchema, emptyPluginConfigSchema } from "./config-schema.js";

function expectSafeParseCases(
  safeParse: ((value: unknown) => unknown) | undefined,
  cases: readonly (readonly [unknown, unknown])[],
) {
  expect(safeParse).toBeDefined();
  expect(cases.map(([value]) => safeParse?.(value))).toEqual(cases.map(([, expected]) => expected));
}

function expectJsonSchema(
  result: ReturnType<typeof buildPluginConfigSchema>,
  expected: Record<string, unknown>,
) {
  expect(result.jsonSchema).toMatchObject(expected);
}

describe("buildPluginConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.strictObject({ enabled: z.boolean().default(true) });
    const result = buildPluginConfigSchema(schema);
    expectJsonSchema(result, {
      additionalProperties: false,
      properties: { enabled: { default: true, type: "boolean" } },
      type: "object",
    });
  });

  it("uses input mode and strips helper-only draft metadata", () => {
    const toJSONSchema = vi.fn(() => ({
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        enabled: { default: true, type: "boolean" },
      },
      propertyNames: { type: "string" },
      required: [],
      type: "object",
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildPluginConfigSchema>[0];

    const result = buildPluginConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      io: "input",
      target: "draft-07",
      unrepresentable: "any",
    });
    expect(result.jsonSchema).toEqual({
      properties: {
        enabled: { default: true, type: "boolean" },
      },
      type: "object",
    });
  });

  it("falls back when toJSONSchema is missing", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildPluginConfigSchema>[0];
    const result = buildPluginConfigSchema(legacySchema);
    expectJsonSchema(result, { additionalProperties: true, type: "object" });
  });

  it("uses zod runtime parsing by default", () => {
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().default(true) }));
    expect(result.safeParse?.({})).toEqual({
      data: { enabled: true },
      success: true,
    });
  });

  it("allows custom safeParse overrides", () => {
    const safeParse = vi.fn(() => ({ data: { normalized: true }, success: true as const }));
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().optional() }), {
      safeParse,
    });

    expect(result.safeParse?.({ enabled: false })).toEqual({
      data: { normalized: true },
      success: true,
    });
    expect(safeParse).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("emptyPluginConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const schema = emptyPluginConfigSchema();
    expectSafeParseCases(schema.safeParse, [
      [undefined, { data: undefined, success: true }],
      [{}, { data: {}, success: true }],
      [
        { nope: true },
        { error: { issues: [{ message: "config must be empty", path: [] }] }, success: false },
      ],
    ] as const);
  });
});
