import { describe, expect, it } from "vitest";
import {
  applyProviderNativeStreamingUsageCompat,
  supportsNativeStreamingUsageCompat,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig } from "./provider-model-shared.js";

function buildModel(id: string, supportsUsageInStreaming?: boolean): ModelDefinitionConfig {
  return {
    contextWindow: 1024,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 1024,
    name: id,
    reasoning: false,
    ...(supportsUsageInStreaming === undefined ? {} : { compat: { supportsUsageInStreaming } }),
  };
}

describe("provider-catalog-shared native streaming usage compat", () => {
  it("detects native streaming usage compat from the endpoint capabilities", () => {
    expect(
      supportsNativeStreamingUsageCompat({
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        providerId: "custom-qwen",
      }),
    ).toBe(true);
    expect(
      supportsNativeStreamingUsageCompat({
        baseUrl: "https://api.moonshot.ai/v1",
        providerId: "custom-kimi",
      }),
    ).toBe(true);
    expect(
      supportsNativeStreamingUsageCompat({
        baseUrl: "https://proxy.example.com/v1",
        providerId: "custom-proxy",
      }),
    ).toBe(false);
  });

  it("opts models into streaming usage for native endpoints while preserving explicit overrides", () => {
    const provider = applyProviderNativeStreamingUsageCompat({
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [buildModel("qwen-plus"), buildModel("qwen-max", false)],
      },
      providerId: "custom-qwen",
    });

    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBe(true);
    expect(provider.models?.[1]?.compat?.supportsUsageInStreaming).toBe(false);
  });
});
