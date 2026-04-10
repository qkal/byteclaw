import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("xai provider plugin", () => {
  it("owns replay policy for xAI OpenAI-compatible transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "grok-3",
        provider: "xai",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
      validateGeminiTurns: true,
    });

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-responses",
        modelId: "grok-4-fast",
        provider: "xai",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });
  });

  it("wires provider stream shaping for fast mode and tool-stream defaults", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedModelId = "";
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = String(model.id);
      const payload: Record<string, unknown> = {
        reasoning: { effort: "high" },
        tools: [
          {
            function: {
              name: "write",
              parameters: { properties: {}, type: "object" },
              strict: true,
            },
            type: "function",
          },
        ],
      };
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {
        result: async () => ({}) as never,
        async *[Symbol.asyncIterator]() {},
      } as unknown as ReturnType<StreamFn>;
    };

    const wrapped = provider.wrapStreamFn?.({
      extraParams: { fastMode: true },
      modelId: "grok-4",
      provider: "xai",
      streamFn: baseStreamFn,
    } as never);

    void wrapped?.(
      {
        api: "openai-responses",
        id: "grok-4",
        provider: "xai",
      } as Model<"openai-responses">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedModelId).toBe("grok-4-fast");
    expect(capturedPayload).toMatchObject({ tool_stream: true });
    expect(capturedPayload).not.toHaveProperty("reasoning");
    expect(
      (capturedPayload?.tools as { function?: Record<string, unknown> }[])[0]?.function,
    ).not.toHaveProperty("strict");
  });
});
