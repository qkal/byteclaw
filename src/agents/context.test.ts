import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_CONTEXT_1M_TOKENS,
  applyConfiguredContextWindows,
  applyDiscoveredContextWindows,
  resolveContextTokensForModel,
} from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-hooks/session-manager-runtime-registry.js";

describe("applyDiscoveredContextWindows", () => {
  it("keeps the smallest context window when the same bare model id appears under multiple providers", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { contextWindow: 128_000, id: "gemini-3.1-pro-preview" },
        { contextWindow: 1_048_576, id: "gemini-3.1-pro-preview" },
      ],
    });

    // Keep the conservative (minimum) value: this cache feeds runtime paths such
    // As flush thresholds and session persistence, not just /status display.
    // Callers with a known provider should use resolveContextTokensForModel which
    // Tries the provider-qualified key first.
    expect(cache.get("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("stores provider-qualified entries independently", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [
        { contextWindow: 128_000, id: "github-copilot/gemini-3.1-pro-preview" },
        { contextWindow: 1_048_576, id: "google-gemini-cli/gemini-3.1-pro-preview" },
      ],
    });

    expect(cache.get("github-copilot/gemini-3.1-pro-preview")).toBe(128_000);
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("prefers discovered contextTokens over contextWindow", () => {
    const cache = new Map<string, number>();
    applyDiscoveredContextWindows({
      cache,
      models: [{ contextTokens: 272_000, contextWindow: 1_050_000, id: "gpt-5.4" }],
    });

    expect(cache.get("gpt-5.4")).toBe(272_000);
  });
});

describe("applyConfiguredContextWindows", () => {
  it("writes bare model id to cache; does not touch raw provider-qualified discovery entries", () => {
    // Discovery stored a provider-qualified entry; config override goes into the
    // Bare key only. resolveContextTokensForModel now scans config directly, so
    // There is no need (and no benefit) to also write a synthetic qualified key.
    const cache = new Map<string, number>([["openrouter/anthropic/claude-opus-4-6", 1_000_000]]);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ contextWindow: 200_000, id: "anthropic/claude-opus-4-6" }],
          },
        },
      },
    });

    expect(cache.get("anthropic/claude-opus-4-6")).toBe(200_000);
    // Discovery entry is untouched — no synthetic write that could corrupt
    // An unrelated provider's raw slash-containing model ID.
    expect(cache.get("openrouter/anthropic/claude-opus-4-6")).toBe(1_000_000);
  });

  it("does not write synthetic provider-qualified keys; only bare model ids go into cache", () => {
    // ApplyConfiguredContextWindows must NOT write "google-gemini-cli/gemini-3.1-pro-preview"
    // Into the cache — that keyspace is reserved for raw discovery model IDs and
    // A synthetic write would overwrite unrelated entries (e.g. OpenRouter's
    // "google/gemini-2.5-pro" being clobbered by a Google provider config).
    const cache = new Map<string, number>();
    cache.set("google-gemini-cli/gemini-3.1-pro-preview", 1_048_576); // Discovery entry
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          "google-gemini-cli": {
            models: [{ contextWindow: 200_000, id: "gemini-3.1-pro-preview" }],
          },
        },
      },
    });

    // Bare key is written.
    expect(cache.get("gemini-3.1-pro-preview")).toBe(200_000);
    // Discovery entry is NOT overwritten.
    expect(cache.get("google-gemini-cli/gemini-3.1-pro-preview")).toBe(1_048_576);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [
              { contextWindow: 150_000, id: "custom/model" },
              { contextWindow: 0, id: "bad/model" },
              { contextWindow: 300_000, id: "" },
            ],
          },
        },
      },
    });

    expect(cache.get("custom/model")).toBe(150_000);
    expect(cache.has("bad/model")).toBe(false);
  });

  it("prefers configured contextTokens over contextWindow", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ contextTokens: 200_000, contextWindow: 1_050_000, id: "custom/model" }],
          },
        },
      },
    });

    expect(cache.get("custom/model")).toBe(200_000);
  });
});

describe("createSessionManagerRuntimeRegistry", () => {
  it("stores, reads, and clears values by object identity", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    const key = {};
    expect(registry.get(key)).toBeNull();
    registry.set(key, { value: 1 });
    expect(registry.get(key)).toEqual({ value: 1 });
    registry.set(key, null);
    expect(registry.get(key)).toBeNull();
  });

  it("ignores non-object keys", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    registry.set(null, { value: 1 });
    registry.set(123, { value: 1 });
    expect(registry.get(null)).toBeNull();
    expect(registry.get(123)).toBeNull();
  });
});

describe("resolveContextTokensForModel", () => {
  it("returns 1M context when anthropic context1m is enabled for opus/sonnet", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      fallbackContextTokens: 200_000,
      model: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it("does not force 1M context when context1m is not enabled", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {},
              },
            },
          },
        },
      },
      fallbackContextTokens: 200_000,
      model: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toBe(200_000);
  });

  it("does not force 1M context for non-opus/sonnet Anthropic models", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-haiku-3-5": {
                params: { context1m: true },
              },
            },
          },
        },
      },
      fallbackContextTokens: 200_000,
      model: "claude-haiku-3-5",
      provider: "anthropic",
    });

    expect(result).toBe(200_000);
  });

  it("prefers per-model contextTokens config over contextWindow", () => {
    const result = resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://chatgpt.com/backend-api",
              models: [
                {
                  contextTokens: 160_000,
                  contextWindow: 1_050_000,
                  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                  id: "gpt-5.4",
                  input: ["text", "image"],
                  maxTokens: 128_000,
                  name: "gpt-5.4",
                  reasoning: true,
                },
              ],
            },
          },
        },
      },
      fallbackContextTokens: 272_000,
      model: "gpt-5.4",
      provider: "openai-codex",
    });

    expect(result).toBe(160_000);
  });
});
