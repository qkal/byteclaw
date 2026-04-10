import { describe, expect, it } from "vitest";
import { resolveExtraParams } from "./pi-embedded-runner/extra-params.js";

describe("resolveExtraParams", () => {
  it("returns undefined with no model config", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      modelId: "glm-4.7",
      provider: "zai",
    });

    expect(result).toBeUndefined();
  });

  it("applies default runtime params for OpenAI GPT-5 models", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      modelId: "gpt-5.4",
      provider: "openai",
    });

    expect(result).toEqual({
      openaiWsWarmup: true,
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
  });

  it("returns params for exact provider/model key", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  maxTokens: 2048,
                  temperature: 0.7,
                },
              },
            },
          },
        },
      },
      modelId: "gpt-4",
      provider: "openai",
    });

    expect(result).toEqual({
      maxTokens: 2048,
      temperature: 0.7,
    });
  });

  it("ignores unrelated model entries", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                },
              },
            },
          },
        },
      },
      modelId: "gpt-4.1-mini",
      provider: "openai",
    });

    expect(result).toBeUndefined();
  });

  it("returns per-agent params when agentId matches", () => {
    const result = resolveExtraParams({
      agentId: "risk-reviewer",
      cfg: {
        agents: {
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toEqual({ cacheRetention: "none" });
  });

  it("merges per-agent params over global model defaults", () => {
    const result = resolveExtraParams({
      agentId: "risk-reviewer",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  cacheRetention: "long",
                  temperature: 0.5,
                },
              },
            },
          },
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toEqual({
      cacheRetention: "none",
      temperature: 0.5,
    });
  });

  it("preserves higher-precedence agent parallelToolCalls override across alias styles", () => {
    const result = resolveExtraParams({
      agentId: "main",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4.1": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                parallelToolCalls: false,
              },
            },
          ],
        },
      },
      modelId: "gpt-4.1",
      provider: "openai",
    });

    expect(result).toEqual({
      parallel_tool_calls: false,
    });
  });

  it("canonicalizes text verbosity alias styles with agent override precedence", () => {
    const result = resolveExtraParams({
      agentId: "main",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  text_verbosity: "high",
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                textVerbosity: "low",
              },
            },
          ],
        },
      },
      modelId: "gpt-5.4",
      provider: "openai",
    });

    expect(result).toEqual({
      openaiWsWarmup: true,
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
  });

  it("ignores per-agent params when agentId does not match", () => {
    const result = resolveExtraParams({
      agentId: "main",
      cfg: {
        agents: {
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      modelId: "claude-opus-4-6",
      provider: "anthropic",
    });

    expect(result).toBeUndefined();
  });
});
