import { describe, expect, it } from "vitest";
import { stripXaiUnsupportedKeywords } from "../../plugin-sdk/provider-tools.js";

describe("stripXaiUnsupportedKeywords", () => {
  it("strips minLength and maxLength from string properties", () => {
    const schema = {
      properties: {
        name: { description: "A name", maxLength: 64, minLength: 1, type: "string" },
      },
      type: "object",
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { name: Record<string, unknown> };
    };
    expect(result.properties.name.minLength).toBeUndefined();
    expect(result.properties.name.maxLength).toBeUndefined();
    expect(result.properties.name.type).toBe("string");
    expect(result.properties.name.description).toBe("A name");
  });

  it("strips minItems and maxItems from array properties", () => {
    const schema = {
      properties: {
        items: { items: { type: "string" }, maxItems: 50, minItems: 1, type: "array" },
      },
      type: "object",
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { items: Record<string, unknown> };
    };
    expect(result.properties.items.minItems).toBeUndefined();
    expect(result.properties.items.maxItems).toBeUndefined();
    expect(result.properties.items.type).toBe("array");
  });

  it("strips minContains and maxContains", () => {
    const schema = {
      contains: { type: "string" },
      maxContains: 5,
      minContains: 1,
      type: "array",
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.minContains).toBeUndefined();
    expect(result.maxContains).toBeUndefined();
    expect(result.contains).toBeDefined();
  });

  it("strips keywords recursively inside nested objects", () => {
    const schema = {
      properties: {
        attachment: {
          properties: {
            content: { maxLength: 6_700_000, type: "string" },
          },
          type: "object",
        },
      },
      type: "object",
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { attachment: { properties: { content: Record<string, unknown> } } };
    };
    expect(result.properties.attachment.properties.content.maxLength).toBeUndefined();
    expect(result.properties.attachment.properties.content.type).toBe("string");
  });

  it("strips keywords inside anyOf/oneOf/allOf variants", () => {
    const schema = {
      anyOf: [{ minLength: 1, type: "string" }, { type: "null" }],
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      anyOf: Record<string, unknown>[];
    };
    expect(result.anyOf[0].minLength).toBeUndefined();
    expect(result.anyOf[0].type).toBe("string");
  });

  it("strips keywords inside array item schemas", () => {
    const schema = {
      items: { maxLength: 100, type: "string" },
      type: "array",
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      items: Record<string, unknown>;
    };
    expect(result.items.maxLength).toBeUndefined();
    expect(result.items.type).toBe("string");
  });

  it("preserves all other schema keywords", () => {
    const schema = {
      additionalProperties: false,
      description: "A tool schema",
      properties: {
        name: { description: "The name", enum: ["foo", "bar"], type: "string" },
      },
      required: ["name"],
      type: "object",
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.type).toBe("object");
    expect(result.description).toBe("A tool schema");
    expect(result.required).toEqual(["name"]);
    expect(result.additionalProperties).toBe(false);
  });

  it("passes through primitives and null unchanged", () => {
    expect(stripXaiUnsupportedKeywords(null)).toBeNull();
    expect(stripXaiUnsupportedKeywords("string")).toBe("string");
    expect(stripXaiUnsupportedKeywords(42)).toBe(42);
  });
});
