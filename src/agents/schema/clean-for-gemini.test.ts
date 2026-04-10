import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it("coerces null properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      properties: null,
      type: "object",
    }) as { type?: unknown; properties?: unknown };

    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({});
  });

  it("coerces non-object properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      properties: "invalid",
      type: "object",
    }) as { properties?: unknown };

    expect(cleaned.properties).toEqual({});
  });

  it("coerces array properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      properties: [],
      type: "object",
    }) as { properties?: unknown };

    expect(cleaned.properties).toEqual({});
  });

  it("coerces nested null properties while preserving valid siblings", () => {
    const cleaned = cleanSchemaForGemini({
      properties: {
        bad: {
          properties: null,
          type: "object",
        },
        good: {
          type: "string",
        },
      },
      type: "object",
    }) as {
      properties?: {
        bad?: { properties?: unknown };
        good?: { type?: unknown };
      };
    };

    expect(cleaned.properties?.bad?.properties).toEqual({});
    expect(cleaned.properties?.good?.type).toBe("string");
  });

  it("strips empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      properties: {
        name: { type: "string" },
      },
      required: [],
      type: "object",
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("required");
    expect(cleaned.type).toBe("object");
  });

  it("preserves non-empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      type: "object",
    }) as Record<string, unknown>;

    expect(cleaned.required).toEqual(["name"]);
  });

  it("strips empty required arrays in nested schemas", () => {
    const cleaned = cleanSchemaForGemini({
      properties: {
        nested: {
          properties: {
            optional: { type: "string" },
          },
          required: [],
          type: "object",
        },
      },
      required: ["nested"],
      type: "object",
    }) as { properties?: { nested?: Record<string, unknown> }; required?: string[] };

    expect(cleaned.required).toEqual(["nested"]);
    expect(cleaned.properties?.nested).not.toHaveProperty("required");
  });

  // Regression: #61206 — `not` keyword is not part of the OpenAPI 3.0 subset
  // And must be stripped to avoid HTTP 400 from Gemini-backed providers.
  it("strips the not keyword from schemas", () => {
    const cleaned = cleanSchemaForGemini({
      not: { const: true },
      properties: {
        name: { type: "string" },
      },
      type: "object",
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("not");
    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({ name: { type: "string" } });
  });

  // Regression: #61206 — type arrays like ["string", "null"] must be
  // Collapsed to a single scalar type for OpenAPI 3.0 compatibility.
  it("collapses type arrays by stripping null entries", () => {
    const cleaned = cleanSchemaForGemini({
      description: "nullable field",
      type: ["string", "null"],
    }) as Record<string, unknown>;

    expect(cleaned.type).toBe("string");
    expect(cleaned.description).toBe("nullable field");
  });

  it("collapses type arrays in nested property schemas", () => {
    const cleaned = cleanSchemaForGemini({
      properties: {
        agentId: {
          description: "Agent id",
          type: ["string", "null"],
        },
      },
      type: "object",
    }) as { properties?: { agentId?: Record<string, unknown> } };

    expect(cleaned.properties?.agentId?.type).toBe("string");
  });
});
