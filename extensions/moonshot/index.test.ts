import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("moonshot provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Moonshot transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "kimi-k2.5",
        provider: "moonshot",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: true,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
      validateGeminiTurns: true,
    });
  });

  it("wires moonshot-thinking stream hooks", async () => {
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

    const wrapped = provider.wrapStreamFn?.({
      modelId: "kimi-k2.5",
      provider: "moonshot",
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never);

    void wrapped?.(
      {
        api: "openai-completions",
        id: "kimi-k2.5",
        provider: "moonshot",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });
  });
});
