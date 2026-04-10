import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

describe("memory-lancedb config", () => {
  it("accepts dreaming in the manifest schema and preserves it in runtime parsing", () => {
    const manifestResult = validateJsonSchemaValue({
      cacheKey: "memory-lancedb.manifest.dreaming",
      schema: manifest.configSchema,
      value: {
        dreaming: {
          enabled: true,
        },
        embedding: {
          apiKey: "sk-test",
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      dreaming: {
        enabled: true,
      },
      embedding: {
        apiKey: "sk-test",
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.dreaming).toEqual({
      enabled: true,
    });
  });

  it("still rejects unrelated unknown top-level config keys", () => {
    expect(() => {
      memoryConfigSchema.parse({
        dreaming: {
          enabled: true,
        },
        embedding: {
          apiKey: "sk-test",
        },
        unexpected: true,
      });
    }).toThrow("memory config has unknown keys: unexpected");
  });

  it("rejects non-object dreaming values in runtime parsing", () => {
    expect(() => {
      memoryConfigSchema.parse({
        dreaming: true,
        embedding: {
          apiKey: "sk-test",
        },
      });
    }).toThrow("dreaming config must be an object");
  });
});
