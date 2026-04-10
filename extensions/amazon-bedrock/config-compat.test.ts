import { describe, expect, it } from "vitest";
import { migrateAmazonBedrockLegacyConfig } from "./config-compat.js";

describe("amazon-bedrock config migration", () => {
  it("moves legacy models.bedrockDiscovery into plugin-owned discovery config", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: {
        bedrockDiscovery: {
          enabled: true,
          refreshInterval: 3600,
          region: "us-east-1",
        },
        mode: "merge",
      },
    });

    expect(result.config).toEqual({
      models: {
        mode: "merge",
      },
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                refreshInterval: 3600,
                region: "us-east-1",
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Moved models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery.",
    ]);
  });

  it("merges missing fields into existing plugin discovery config", () => {
    const result = migrateAmazonBedrockLegacyConfig({
      models: {
        bedrockDiscovery: {
          enabled: true,
          providerFilter: ["anthropic"],
          region: "us-east-1",
        },
      },
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                region: "us-west-2",
              },
            },
          },
        },
      },
    });

    expect(result.config).toEqual({
      plugins: {
        entries: {
          "amazon-bedrock": {
            config: {
              discovery: {
                enabled: true,
                providerFilter: ["anthropic"],
                region: "us-west-2",
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Merged models.bedrockDiscovery → plugins.entries.amazon-bedrock.config.discovery (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });
});
