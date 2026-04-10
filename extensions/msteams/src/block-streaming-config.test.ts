import { describe, expect, it } from "vitest";

// Import the schema directly to avoid cross-extension import chains
const { MSTeamsConfigSchema } = await import("../../../src/config/zod-schema.providers-core.js");

describe("MSTeamsConfigSchema blockStreaming", () => {
  const baseConfig = {
    allowFrom: ["*"],
    dmPolicy: "open" as const,
    enabled: true,
  };

  it("accepts blockStreaming: true", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBe(true);
    }
  });

  it("accepts blockStreaming: false", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBe(false);
    }
  });

  it("accepts config without blockStreaming (optional)", () => {
    const result = MSTeamsConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBeUndefined();
    }
  });

  it("accepts blockStreaming alongside blockStreamingCoalesce", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: true,
      blockStreamingCoalesce: { idleMs: 500, minChars: 100 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockStreaming).toBe(true);
      expect(result.data.blockStreamingCoalesce).toEqual({ idleMs: 500, minChars: 100 });
    }
  });

  it("rejects non-boolean blockStreaming", () => {
    const result = MSTeamsConfigSchema.safeParse({
      ...baseConfig,
      blockStreaming: "yes",
    });
    expect(result.success).toBe(false);
  });
});
