import { describe, expect, it } from "vitest";
import {
  applyXaiModelCompat,
  buildProviderToolCompatFamilyHooks,
  inspectGeminiToolSchemas,
  normalizeGeminiToolSchemas,
  resolveXaiModelCompatPatch,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
  it("covers the tool compat family matrix", () => {
    const cases = [
      {
        family: "gemini" as const,
        inspectToolSchemas: inspectGeminiToolSchemas,
        normalizeToolSchemas: normalizeGeminiToolSchemas,
      },
    ];

    for (const testCase of cases) {
      const hooks = buildProviderToolCompatFamilyHooks(testCase.family);

      expect(hooks.normalizeToolSchemas).toBe(testCase.normalizeToolSchemas);
      expect(hooks.inspectToolSchemas).toBe(testCase.inspectToolSchemas);
    }
  });

  it("covers the shared xAI tool compat patch", () => {
    const patch = resolveXaiModelCompatPatch();

    expect(patch).toMatchObject({
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
      toolSchemaProfile: "xai",
    });
    expect(patch.unsupportedToolSchemaKeywords).toEqual(
      expect.arrayContaining(["minLength", "maxLength", "minItems", "maxItems"]),
    );

    expect(
      applyXaiModelCompat({
        compat: {
          supportsUsageInStreaming: true,
        },
        id: "grok-4",
      }),
    ).toMatchObject({
      compat: {
        nativeWebSearchTool: true,
        supportsUsageInStreaming: true,
        toolCallArgumentsEncoding: "html-entities",
        toolSchemaProfile: "xai",
      },
    });
  });
});
