import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildChannelConfigSchema, emptyChannelConfigSchema } from "./config-schema.js";

describe("buildChannelConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.object({ enabled: z.boolean().default(true) });
    const result = buildChannelConfigSchema(schema);
    expect(result.schema).toMatchObject({ type: "object" });
  });

  it("falls back when toJSONSchema is missing (zod v3 plugin compatibility)", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildChannelConfigSchema>[0];
    const result = buildChannelConfigSchema(legacySchema);
    expect(result.schema).toEqual({ additionalProperties: true, type: "object" });
  });

  it("passes draft-07 compatibility options to toJSONSchema", () => {
    const toJSONSchema = vi.fn(() => ({
      properties: { enabled: { type: "boolean" } },
      type: "object",
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildChannelConfigSchema>[0];

    const result = buildChannelConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      unrepresentable: "any",
    });
    expect(result.schema).toEqual({
      properties: { enabled: { type: "boolean" } },
      type: "object",
    });
  });

  it("passes through ui hints and exposes a runtime parser", () => {
    const result = buildChannelConfigSchema(z.object({ enabled: z.boolean().default(true) }), {
      uiHints: { enabled: { label: "Enabled" } },
    });

    expect(result.uiHints).toEqual({ enabled: { label: "Enabled" } });
    expect(result.runtime?.safeParse({})).toEqual({
      data: { enabled: true },
      success: true,
    });
  });
});

describe("emptyChannelConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const result = emptyChannelConfigSchema();

    expect(result.runtime?.safeParse(undefined)).toEqual({
      data: undefined,
      success: true,
    });
    expect(result.runtime?.safeParse({})).toEqual({
      data: {},
      success: true,
    });
    expect(result.runtime?.safeParse({ enabled: true })).toEqual({
      issues: [{ message: "config must be empty", path: [] }],
      success: false,
    });
  });
});
