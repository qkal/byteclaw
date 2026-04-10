import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";

describe("resolveSimpleCompletionSelectionForAgent", () => {
  it("preserves multi-segment model ids (openrouter provider models)", () => {
    const cfg = {
      agents: {
        defaults: { model: "openrouter/anthropic/claude-sonnet-4-6" },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ agentId: "main", cfg });
    expect(selection).toEqual(
      expect.objectContaining({
        modelId: "anthropic/claude-sonnet-4-6",
        provider: "openrouter",
      }),
    );
  });

  it("uses the routed agent model override when present", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
        list: [{ id: "ops", model: "openrouter/aurora-alpha" }],
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ agentId: "ops", cfg });
    expect(selection).toEqual(
      expect.objectContaining({
        modelId: "openrouter/aurora-alpha",
        provider: "openrouter",
      }),
    );
  });

  it("keeps trailing auth profile for credential lookup", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6@work" },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ agentId: "main", cfg });
    expect(selection).toEqual(
      expect.objectContaining({
        modelId: "claude-opus-4-6",
        profileId: "work",
        provider: "anthropic",
      }),
    );
  });

  it("resolves alias refs before parsing provider/model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "fast@work",
          models: {
            "openrouter/anthropic/claude-sonnet-4-6": { alias: "fast" },
          },
        },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ agentId: "main", cfg });
    expect(selection).toEqual(
      expect.objectContaining({
        modelId: "anthropic/claude-sonnet-4-6",
        profileId: "work",
        provider: "openrouter",
      }),
    );
  });

  it("falls back to runtime default model when no explicit model is configured", () => {
    const cfg = {} as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ agentId: "main", cfg });
    expect(selection).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.4",
        provider: "openai",
      }),
    );
  });

  it("uses configured provider fallback when default provider is unavailable", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                contextWindow: 200_000,
                cost: {
                  cacheRead: 0,
                  cacheWrite: 0,
                  input: 0,
                  output: 0,
                },
                id: "gpt-5",
                input: ["text"],
                maxTokens: 8192,
                name: "GPT-5",
                reasoning: false,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ agentId: "main", cfg });
    expect(selection).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.4",
        provider: "openai",
      }),
    );
  });
});
