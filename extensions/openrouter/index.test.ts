import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import openrouterPlugin from "./index.js";

describe("openrouter provider hooks", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
        provider: "openrouter",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
        provider: "openrouter",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
        provider: "openrouter",
      } as never),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });

  it("owns native reasoning output mode", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        modelApi: "openai-completions",
        modelId: "openai/gpt-5.4",
        provider: "openrouter",
      } as never),
    ).toBe("native");
  });

  it("injects provider routing into compat before applying stream wrappers", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const baseStreamFn = vi.fn(
      (..._args: Parameters<import("@mariozechner/pi-agent-core").StreamFn>) =>
        ({ async *[Symbol.asyncIterator]() {} }) as never,
    );

    const wrapped = provider.wrapStreamFn?.({
      extraParams: {
        provider: {
          order: ["moonshot"],
        },
      },
      modelId: "openai/gpt-5.4",
      provider: "openrouter",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    wrapped?.(
      {
        api: "openai-completions",
        compat: {},
        id: "openai/gpt-5.4",
        provider: "openrouter",
      } as never,
      { messages: [] } as never,
      {},
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    const firstCall = baseStreamFn.mock.calls[0];
    const firstModel = firstCall?.[0];
    expect(firstModel).toMatchObject({
      compat: {
        openRouterRouting: {
          order: ["moonshot"],
        },
      },
    });
  });
});
