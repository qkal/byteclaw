import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import { makeIsolatedEnv } from "./plugin-auto-enable.test-helpers.js";

function makeRegistry(
  plugins: {
    id: string;
    modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
  }[],
): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: plugins.map((plugin) => ({
      channels: [],
      cliBackends: [],
      hooks: [],
      id: plugin.id,
      manifestPath: `/fake/${plugin.id}/openclaw.plugin.json`,
      modelSupport: plugin.modelSupport,
      origin: "config" as const,
      providers: [],
      rootDir: `/fake/${plugin.id}`,
      skills: [],
      source: `/fake/${plugin.id}/index.js`,
    })),
  };
}

describe("applyPluginAutoEnable modelSupport", () => {
  it("auto-enables provider plugins from shorthand modelSupport ownership", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "gpt-5.4",
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "openai",
          modelSupport: {
            modelPrefixes: ["gpt-", "o1", "o3", "o4"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai?.enabled).toBe(true);
    expect(result.changes).toContain("gpt-5.4 model configured, enabled automatically.");
  });

  it("skips ambiguous shorthand model ownership during auto-enable", () => {
    const result = applyPluginAutoEnable({
      config: {
        agents: {
          defaults: {
            model: "gpt-5.4",
          },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: makeRegistry([
        {
          id: "openai",
          modelSupport: {
            modelPrefixes: ["gpt-"],
          },
        },
        {
          id: "proxy-openai",
          modelSupport: {
            modelPrefixes: ["gpt-"],
          },
        },
      ]),
    });

    expect(result.config.plugins?.entries?.openai).toBeUndefined();
    expect(result.config.plugins?.entries?.["proxy-openai"]).toBeUndefined();
    expect(result.changes).toEqual([]);
  });
});
