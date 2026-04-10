import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { applyModelDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

describe("applyModelDefaults", () => {
  function buildProxyProviderConfig(overrides?: { contextWindow?: number; maxTokens?: number }) {
    return {
      models: {
        providers: {
          myproxy: {
            api: "openai-completions",
            apiKey: "sk-test",
            baseUrl: "https://proxy.example/v1",
            models: [
              {
                contextWindow: overrides?.contextWindow ?? 200_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "gpt-5.4",
                input: ["text"],
                maxTokens: overrides?.maxTokens ?? 8192,
                name: "GPT-5.2",
                reasoning: false,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  function buildMistralProviderConfig(overrides?: {
    modelId?: string;
    contextWindow?: number;
    maxTokens?: number;
  }) {
    return {
      models: {
        providers: {
          mistral: {
            baseUrl: "https://api.mistral.ai/v1",
            apiKey: "sk-mistral", // Pragma: allowlist secret
            api: "openai-completions",
            models: [
              {
                contextWindow: overrides?.contextWindow ?? 262_144,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: overrides?.modelId ?? "mistral-large-latest",
                input: ["text", "image"],
                maxTokens: overrides?.maxTokens ?? 262_144,
                name: "Mistral",
                reasoning: false,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
  }

  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
      },
    } satisfies OpenClawConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.4"]?.alias).toBe("gpt");
  });

  it("does not override existing aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { alias: "Opus" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.alias).toBe("Opus");
  });

  it("respects explicit empty alias disables", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-flash-preview": {},
            "google/gemini-3.1-flash-lite-preview": {},
            "google/gemini-3.1-pro-preview": { alias: "" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["google/gemini-3.1-pro-preview"]?.alias).toBe("");
    expect(next.agents?.defaults?.models?.["google/gemini-3-flash-preview"]?.alias).toBe(
      "gemini-flash",
    );
    expect(next.agents?.defaults?.models?.["google/gemini-3.1-flash-lite-preview"]?.alias).toBe(
      "gemini-flash-lite",
    );
  });

  it("fills missing model provider defaults", () => {
    const cfg = buildProxyProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost).toEqual({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(model?.maxTokens).toBe(8192);
  });

  it("clamps maxTokens to contextWindow", () => {
    const cfg = buildProxyProviderConfig({ contextWindow: 32_768, maxTokens: 40_960 });

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.contextWindow).toBe(32_768);
    expect(model?.maxTokens).toBe(32_768);
  });

  it("normalizes stale mistral maxTokens that matched the full context window", () => {
    const cfg = buildMistralProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.mistral?.models?.[0];

    expect(model?.contextWindow).toBe(262_144);
    expect(model?.maxTokens).toBe(16_384);
  });

  it("defaults anthropic provider and model api to anthropic-messages", () => {
    const cfg = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://relay.example.com/api",
            apiKey: "cr_xxxx", // Pragma: allowlist secret
            models: [
              {
                contextWindow: 200_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "claude-opus-4-6",
                input: ["text"],
                maxTokens: 8192,
                name: "Claude Opus 4.6",
                reasoning: false,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const next = applyModelDefaults(cfg);
    const provider = next.models?.providers?.anthropic;
    const model = provider?.models?.[0];

    expect(provider?.api).toBe("anthropic-messages");
    expect(model?.api).toBe("anthropic-messages");
  });

  it("propagates provider api to models when model api is missing", () => {
    const cfg = buildProxyProviderConfig();

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];
    expect(model?.api).toBe("openai-completions");
  });
});
