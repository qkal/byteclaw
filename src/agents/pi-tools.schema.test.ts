import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { normalizeToolParameterSchema, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("normalizeToolParameterSchema", () => {
  it("normalizes truly empty schemas to type:object with properties:{}", () => {
    expect(normalizeToolParameterSchema({})).toEqual({
      properties: {},
      type: "object",
    });
  });

  it("leaves top-level allOf schemas unchanged", () => {
    const schema = {
      allOf: [{ properties: { id: { type: "string" } }, type: "object" }],
    };

    expect(normalizeToolParameterSchema(schema)).toEqual(schema);
  });

  it("adds missing top-level type for raw object-ish schemas", () => {
    expect(
      normalizeToolParameterSchema({
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    ).toEqual({
      properties: { q: { type: "string" } },
      required: ["q"],
      type: "object",
    });
  });
});

describe("normalizeToolParameters", () => {
  it("normalizes truly empty schemas to type:object with properties:{} (MCP parameter-free tools)", () => {
    const tool: AnyAgentTool = {
      description: "Get current Flux instance status",
      execute: vi.fn(),
      label: "get_flux_instance",
      name: "get_flux_instance",
      parameters: {},
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toEqual({});
  });

  it("does not rewrite non-empty schemas that still lack type/properties", () => {
    const tool: AnyAgentTool = {
      description: "Conditional schema stays untouched",
      execute: vi.fn(),
      label: "conditional",
      name: "conditional",
      parameters: { allOf: [] },
    };

    const normalized = normalizeToolParameters(tool);

    expect(normalized.parameters).toEqual({ allOf: [] });
  });

  it("injects properties:{} for type:object schemas missing properties (MCP no-param tools)", () => {
    const tool: AnyAgentTool = {
      description: "List all AWS regions",
      execute: vi.fn(),
      label: "list_regions",
      name: "list_regions",
      parameters: { type: "object" },
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toEqual({});
  });

  it("preserves existing properties on type:object schemas", () => {
    const tool: AnyAgentTool = {
      description: "Run a query",
      execute: vi.fn(),
      label: "query",
      name: "query",
      parameters: { properties: { q: { type: "string" } }, type: "object" },
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toEqual({ q: { type: "string" } });
  });

  it("injects properties:{} for type:object with only additionalProperties", () => {
    const tool: AnyAgentTool = {
      description: "Accept any input",
      execute: vi.fn(),
      label: "passthrough",
      name: "passthrough",
      parameters: { additionalProperties: true, type: "object" },
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toEqual({});
    expect(parameters.additionalProperties).toBe(true);
  });

  it("strips compat-declared unsupported schema keywords without provider-specific branching", () => {
    const tool: AnyAgentTool = {
      description: "demo",
      execute: vi.fn(),
      label: "demo",
      name: "demo",
      parameters: Type.Object({
        count: Type.Integer({ maximum: 5, minimum: 1 }),
        query: Type.Optional(Type.String({ minLength: 2 })),
      }),
    };

    const normalized = normalizeToolParameters(tool, {
      modelCompat: {
        unsupportedToolSchemaKeywords: ["minimum", "maximum", "minLength"],
      },
    });

    const parameters = normalized.parameters as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(parameters.required).toEqual(["count"]);
    expect(parameters.properties?.count.minimum).toBeUndefined();
    expect(parameters.properties?.count.maximum).toBeUndefined();
    expect(parameters.properties?.count.type).toBe("integer");
    expect(parameters.properties?.query.minLength).toBeUndefined();
    expect(parameters.properties?.query.type).toBe("string");
  });
});
