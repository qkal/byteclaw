import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { applyProviderAuthConfigPatch } from "./provider-auth-choice-helpers.js";

describe("applyProviderAuthConfigPatch", () => {
  it("replaces patched default model maps instead of recursively merging them", () => {
    const base = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-opus-4-6", "openai/gpt-5.2"],
            primary: "anthropic/claude-sonnet-4-6",
          },
          models: {
            "anthropic/claude-opus-4-6": { alias: "Opus" },
            "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };
    const patch = {
      agents: {
        defaults: {
          models: {
            "claude-cli/claude-opus-4-6": { alias: "Opus" },
            "claude-cli/claude-sonnet-4-6": { alias: "Sonnet" },
            "openai/gpt-5.2": {},
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch);

    expect(next.agents?.defaults?.models).toEqual(patch.agents.defaults.models);
    expect(next.agents?.defaults?.model).toEqual(base.agents?.defaults?.model);
  });

  it("keeps normal recursive merges for unrelated provider auth patch fields", () => {
    const base = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
            ttl: "30m",
          },
        },
      },
    } satisfies OpenClawConfig;
    const patch = {
      agents: {
        defaults: {
          contextPruning: {
            ttl: "1h",
          },
        },
      },
    };

    const next = applyProviderAuthConfigPatch(base, patch);

    expect(next).toEqual({
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
            ttl: "1h",
          },
        },
      },
    });
  });
});
