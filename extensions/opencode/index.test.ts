import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("opencode provider plugin", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
        provider: "opencode",
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
  });

  it("keeps non-Gemini replay policy minimal on passthrough routes", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "claude-opus-4.6",
        provider: "opencode",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });
    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "claude-opus-4.6",
        provider: "opencode",
      } as never),
    ).not.toHaveProperty("sanitizeThoughtSignatures");
  });
});
