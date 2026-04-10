import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("kilocode provider plugin", () => {
  it("owns passthrough-gemini replay policy for Gemini-backed models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "gemini-2.5-pro",
        provider: "kilocode",
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

  it("wires kilocode-thinking stream hooks", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const wrappedReasoning = provider.wrapStreamFn?.({
      modelId: "openai/gpt-5.4",
      provider: "kilocode",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrappedReasoning?.(
      {
        api: "openai-completions",
        id: "openai/gpt-5.4",
        provider: "kilocode",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toMatchObject({
      reasoning: { effort: "high" },
    });

    const wrappedAuto = provider.wrapStreamFn?.({
      modelId: "kilo/auto",
      provider: "kilocode",
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never);

    void wrappedAuto?.(
      {
        api: "openai-completions",
        id: "kilo/auto",
        provider: "kilocode",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).not.toHaveProperty("reasoning");
  });

  it("publishes configured Kilo models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              kilocode: {
                models: [
                  {
                    contextWindow: 1_048_576,
                    id: "google/gemini-3-pro-preview",
                    input: ["text", "image"],
                    name: "Gemini 3 Pro Preview",
                    reasoning: true,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        contextWindow: 1_048_576,
        id: "google/gemini-3-pro-preview",
        input: ["text", "image"],
        name: "Gemini 3 Pro Preview",
        provider: "kilocode",
        reasoning: true,
      },
    ]);
  });
});
