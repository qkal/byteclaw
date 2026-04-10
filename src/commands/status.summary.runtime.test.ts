import { describe, expect, it } from "vitest";
import { statusSummaryRuntime } from "./status.summary.runtime.js";

describe("statusSummaryRuntime.resolveContextTokensForModel", () => {
  it("matches provider context window overrides across canonical provider aliases", () => {
    const contextTokens = statusSummaryRuntime.resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "z.ai": {
              models: [{ contextWindow: 123_456, id: "glm-4.7" }],
            },
          },
        },
      } as never,
      fallbackContextTokens: 999,
      model: "glm-4.7",
      provider: "z-ai",
    });

    expect(contextTokens).toBe(123_456);
  });

  it("prefers per-model contextTokens over contextWindow", () => {
    const contextTokens = statusSummaryRuntime.resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              models: [{ contextTokens: 272_000, contextWindow: 1_050_000, id: "gpt-5.4" }],
            },
          },
        },
      } as never,
      fallbackContextTokens: 999,
      model: "gpt-5.4",
      provider: "openai-codex",
    });

    expect(contextTokens).toBe(272_000);
  });
});

describe("statusSummaryRuntime.resolveSessionModelRef", () => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
      },
    },
  } as never;

  it("preserves explicit runtime providers for vendor-prefixed model ids", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        model: "anthropic/claude-haiku-4.5",
        modelProvider: "openrouter",
      }),
    ).toEqual({
      model: "anthropic/claude-haiku-4.5",
      provider: "openrouter",
    });
  });

  it("splits legacy combined overrides when provider is missing", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      }),
    ).toEqual({
      model: "qwen2.5-coder:7b",
      provider: "ollama-beelink2",
    });
  });

  it("uses the configured default provider for providerless runtime models", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
            },
          },
        } as never,
        {
          model: "gpt-5.4",
        },
      ),
    ).toEqual({
      model: "gpt-5.4",
      provider: "openai",
    });
  });

  it("prefers explicit overrides ahead of fallback runtime fields", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        model: "minimax.minimax-m2.5",
        modelOverride: "gpt-5.4",
        modelProvider: "amazon-bedrock",
        providerOverride: "openai-codex",
      }),
    ).toEqual({
      model: "gpt-5.4",
      provider: "openai-codex",
    });
  });
});
