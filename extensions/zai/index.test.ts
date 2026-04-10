import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("zai provider plugin", () => {
  it("owns replay policy for OpenAI-compatible Z.ai transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.buildReplayPolicy?.({
        modelApi: "openai-completions",
        modelId: "glm-5.1",
        provider: "zai",
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
        modelId: "glm-5.1",
        provider: "zai",
      } as never),
    ).toMatchObject({
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: false,
      validateGeminiTurns: false,
    });
  });

  it("resolves persisted GLM-5 family models with provider-owned metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = {
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      contextWindow: 204_800,
      cost: { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
      id: "glm-4.7",
      input: ["text"],
      maxTokens: 131_072,
      name: "GLM-4.7",
      provider: "zai",
      reasoning: true,
    };

    const cases = [
      {
        expected: {
          contextWindow: 202_800,
          input: ["text"],
          maxTokens: 131_100,
          reasoning: true,
        },
        modelId: "glm-5.1",
      },
      {
        expected: {
          contextWindow: 202_800,
          input: ["text", "image"],
          maxTokens: 131_100,
          reasoning: true,
        },
        modelId: "glm-5v-turbo",
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        provider.resolveDynamicModel?.({
          modelId: testCase.modelId,
          modelRegistry: {
            find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
          },
          provider: "zai",
        } as never),
      ).toMatchObject({
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        id: testCase.modelId,
        provider: "zai",
        ...testCase.expected,
      });
    }
  });

  it("returns an already-registered GLM-5 variant as-is", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const registered = {
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      contextWindow: 123_456,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0.1, output: 0.2 },
      id: "glm-5-turbo",
      input: ["text"],
      maxTokens: 54_321,
      name: "GLM-5-Turbo",
      provider: "zai",
      reasoning: false,
    };
    const template = {
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      contextWindow: 204_800,
      cost: { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
      id: "glm-4.7",
      input: ["text"],
      maxTokens: 131_072,
      name: "GLM-4.7",
      provider: "zai",
      reasoning: true,
    };

    expect(
      provider.resolveDynamicModel?.({
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) =>
            modelId === "glm-5-turbo" ? registered : (modelId === "glm-4.7" ? template : null),
        },
        provider: "zai",
      } as never),
    ).toEqual(registered);
  });

  it("still synthesizes unknown GLM-5 variants from the GLM-4.7 template", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const template = {
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      contextWindow: 204_800,
      cost: { cacheRead: 0.11, cacheWrite: 0, input: 0.6, output: 2.2 },
      id: "glm-4.7",
      input: ["text"],
      maxTokens: 131_072,
      name: "GLM-4.7",
      provider: "zai",
      reasoning: true,
    };

    expect(
      provider.resolveDynamicModel?.({
        modelId: "glm-5-turbo",
        modelRegistry: {
          find: (_provider: string, modelId: string) => (modelId === "glm-4.7" ? template : null),
        },
        provider: "zai",
      } as never),
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      id: "glm-5-turbo",
      input: ["text"],
      name: "GLM-5 Turbo",
      provider: "zai",
      reasoning: true,
    });
  });

  it("wires tool-stream defaults through the shared stream family hook", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const defaultWrapped = provider.wrapStreamFn?.({
      extraParams: {},
      modelId: "glm-5.1",
      provider: "zai",
      streamFn: baseStreamFn,
    } as never);

    void defaultWrapped?.(
      {
        api: "openai-completions",
        id: "glm-5.1",
        provider: "zai",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).toMatchObject({
      tool_stream: true,
    });

    const disabledWrapped = provider.wrapStreamFn?.({
      extraParams: { tool_stream: false },
      modelId: "glm-5.1",
      provider: "zai",
      streamFn: baseStreamFn,
    } as never);

    void disabledWrapped?.(
      {
        api: "openai-completions",
        id: "glm-5.1",
        provider: "zai",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedPayload).not.toHaveProperty("tool_stream");
  });
});
