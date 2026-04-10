import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { REQUIRED_PARAM_GROUPS, wrapToolParamValidation } from "./pi-tools.params.js";
import { cleanToolSchemaForGemini } from "./pi-tools.schema.js";

describe("createOpenClawCodingTools", () => {
  describe("Gemini cleanup and strict param validation", () => {
    it("enforces canonical path/content at runtime", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool: AgentTool = {
        description: "test",
        execute,
        label: "write",
        name: "write",
        parameters: Type.Object({
          content: Type.String(),
          path: Type.String(),
        }),
      };

      const wrapped = wrapToolParamValidation(tool, REQUIRED_PARAM_GROUPS.write);

      await wrapped.execute("tool-1", { content: "x", path: "foo.txt" });
      expect(execute).toHaveBeenCalledWith(
        "tool-1",
        { content: "x", path: "foo.txt" },
        undefined,
        undefined,
      );

      await expect(wrapped.execute("tool-2", { content: "x" })).rejects.toThrow(
        /Missing required parameter/,
      );
      await expect(wrapped.execute("tool-2", { content: "x" })).rejects.toThrow(
        /Supply correct parameters before retrying\./,
      );
      await expect(wrapped.execute("tool-3", { content: "x", path: "   " })).rejects.toThrow(
        /Missing required parameter/,
      );
      await expect(wrapped.execute("tool-3", { content: "x", path: "   " })).rejects.toThrow(
        /Supply correct parameters before retrying\./,
      );
      await expect(wrapped.execute("tool-4", {})).rejects.toThrow(
        /Missing required parameters: path, content/,
      );
      await expect(wrapped.execute("tool-4", {})).rejects.toThrow(
        /Supply correct parameters before retrying\./,
      );
    });
  });

  it("inlines local $ref before removing unsupported keywords", () => {
    const cleaned = cleanToolSchemaForGemini({
      $defs: {
        Foo: { enum: ["a", "b"], type: "string" },
      },
      properties: {
        foo: { $ref: "#/$defs/Foo" },
      },
      type: "object",
    }) as {
      $defs?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties).toBeDefined();
    expect(cleaned.properties?.foo).toMatchObject({
      enum: ["a", "b"],
      type: "string",
    });
  });

  it("cleans tuple items schemas", () => {
    const cleaned = cleanToolSchemaForGemini({
      properties: {
        tuples: {
          items: [
            { format: "uuid", type: "string" },
            { minimum: 1, type: "number" },
          ],
          type: "array",
        },
      },
      type: "object",
    }) as {
      properties?: Record<string, unknown>;
    };

    const tuples = cleaned.properties?.tuples as { items?: unknown } | undefined;
    const items = Array.isArray(tuples?.items) ? tuples?.items : [];
    const first = items[0] as { format?: unknown } | undefined;
    const second = items[1] as { minimum?: unknown } | undefined;

    expect(first?.format).toBeUndefined();
    expect(second?.minimum).toBeUndefined();
  });

  it("drops null-only union variants without flattening other unions", () => {
    const cleaned = cleanToolSchemaForGemini({
      properties: {
        count: { oneOf: [{ type: "string" }, { type: "number" }] },
        parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      type: "object",
    }) as {
      properties?: Record<string, unknown>;
    };

    const parentId = cleaned.properties?.parentId as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;
    const count = cleaned.properties?.count as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;

    expect(parentId?.type).toBe("string");
    expect(parentId?.anyOf).toBeUndefined();
    expect(count?.oneOf).toBeUndefined();
  });
});
