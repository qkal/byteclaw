import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "./context-window-guard.js";

describe("context-window-guard", () => {
  it("blocks below 16k (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      defaultTokens: 200_000,
      modelContextWindow: 8000,
      modelId: "tiny",
      provider: "openrouter",
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.source).toBe("model");
    expect(guard.tokens).toBe(8000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(true);
  });

  it("warns below 32k but does not block at 16k+", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      defaultTokens: 200_000,
      modelContextWindow: 24_000,
      modelId: "small",
      provider: "openai",
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.tokens).toBe(24_000);
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not warn at 32k+ (model metadata)", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      defaultTokens: 200_000,
      modelContextWindow: 64_000,
      modelId: "ok",
      provider: "openai",
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("uses models.providers.*.models[].contextWindow when present", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            apiKey: "x",
            baseUrl: "http://localhost",
            models: [
              {
                contextWindow: 12_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "tiny",
                input: ["text"],
                maxTokens: 256,
                name: "tiny",
                reasoning: false,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      defaultTokens: 200_000,
      modelContextWindow: 64_000,
      modelId: "tiny",
      provider: "openrouter",
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("modelsConfig");
    expect(guard.shouldBlock).toBe(true);
  });

  it("prefers models.providers.*.models[].contextTokens over contextWindow", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            apiKey: "x",
            baseUrl: "http://localhost",
            models: [
              {
                contextTokens: 12_000,
                contextWindow: 1_050_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "tiny",
                input: ["text"],
                maxTokens: 256,
                name: "tiny",
                reasoning: false,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      defaultTokens: 200_000,
      modelContextTokens: 48_000,
      modelContextWindow: 64_000,
      modelId: "tiny",
      provider: "openrouter",
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 12_000,
    });
  });

  it("normalizes provider aliases when reading models config context windows", () => {
    const cfg = {
      models: {
        providers: {
          "z.ai": {
            apiKey: "x",
            baseUrl: "http://localhost",
            models: [
              {
                contextWindow: 12_000,
                cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                id: "glm-5",
                input: ["text"],
                maxTokens: 256,
                name: "glm-5",
                reasoning: false,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;

    const info = resolveContextWindowInfo({
      cfg,
      defaultTokens: 200_000,
      modelContextWindow: 64_000,
      modelId: "glm-5",
      provider: "z-ai",
    });

    expect(info).toEqual({
      source: "modelsConfig",
      tokens: 12_000,
    });
  });

  it("caps with agents.defaults.contextTokens", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 20_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      defaultTokens: 200_000,
      modelContextWindow: 200_000,
      modelId: "whatever",
      provider: "anthropic",
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("agentContextTokens");
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("does not override when cap exceeds base window", () => {
    const cfg = {
      agents: { defaults: { contextTokens: 128_000 } },
    } satisfies OpenClawConfig;
    const info = resolveContextWindowInfo({
      cfg,
      defaultTokens: 200_000,
      modelContextWindow: 64_000,
      modelId: "whatever",
      provider: "anthropic",
    });
    expect(info.source).toBe("model");
    expect(info.tokens).toBe(64_000);
  });

  it("uses default when nothing else is available", () => {
    const info = resolveContextWindowInfo({
      cfg: undefined,
      defaultTokens: 200_000,
      modelContextWindow: undefined,
      modelId: "unknown",
      provider: "anthropic",
    });
    const guard = evaluateContextWindowGuard({ info });
    expect(info.source).toBe("default");
    expect(guard.shouldWarn).toBe(false);
    expect(guard.shouldBlock).toBe(false);
  });

  it("allows overriding thresholds", () => {
    const info = { source: "model" as const, tokens: 10_000 };
    const guard = evaluateContextWindowGuard({
      hardMinTokens: 9000,
      info,
      warnBelowTokens: 12_000,
    });
    expect(guard.shouldWarn).toBe(true);
    expect(guard.shouldBlock).toBe(false);
  });

  it("exports thresholds as expected", () => {
    expect(CONTEXT_WINDOW_HARD_MIN_TOKENS).toBe(16_000);
    expect(CONTEXT_WINDOW_WARN_BELOW_TOKENS).toBe(32_000);
  });
});
