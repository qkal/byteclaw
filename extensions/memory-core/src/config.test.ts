import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../../src/plugins/schema-validator.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

describe("memory-core manifest config schema", () => {
  it("accepts dreaming phase thresholds used by QA and runtime", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "memory-core.manifest.dreaming-phase-thresholds",
      schema: manifest.configSchema,
      value: {
        dreaming: {
          enabled: true,
          phases: {
            deep: {
              enabled: true,
              limit: 10,
              maxAgeDays: 30,
              minRecallCount: 3,
              minScore: 0,
              minUniqueQueries: 3,
              recencyHalfLifeDays: 14,
            },
            light: {
              dedupeSimilarity: 0.9,
              enabled: true,
              limit: 20,
              lookbackDays: 2,
            },
            rem: {
              enabled: true,
              limit: 10,
              lookbackDays: 7,
              minPatternStrength: 0.75,
            },
          },
          storage: {
            mode: "inline",
            separateReports: false,
          },
          timezone: "Europe/London",
          verboseLogging: true,
        },
      },
    });

    expect(result.ok).toBe(true);
  });
});
