import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { applyProviderNativeStreamingUsageCompat } from "../plugin-sdk/provider-catalog-shared.js";
import { resetProviderRuntimeHookCacheForTest } from "../plugins/provider-runtime.js";

async function loadSecretsModule() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  vi.resetModules();
  return import("./models-config.providers.secrets.js");
}

beforeEach(() => {
  resetProviderRuntimeHookCacheForTest();
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
});

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

function buildMoonshotProvider(): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl: MOONSHOT_BASE_URL,
    models: [
      {
        contextWindow: 262144,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "kimi-k2.5",
        input: ["text", "image"],
        maxTokens: 262144,
        name: "Kimi K2.5",
        reasoning: false,
      },
    ],
  };
}

describe("moonshot implicit provider (#33637)", () => {
  it("uses explicit CN baseUrl when provided", () => {
    const provider = {
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    };

    expect(provider.baseUrl).toBe(MOONSHOT_CN_BASE_URL);
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    expect(
      applyProviderNativeStreamingUsageCompat({
        providerConfig: provider,
        providerId: "moonshot",
      }).models?.[0]?.compat?.supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage opt-in unset before the final compat pass", () => {
    const provider = {
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    };

    expect(provider.baseUrl).toBe("https://proxy.example.com/v1");
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    expect(
      applyProviderNativeStreamingUsageCompat({
        providerConfig: provider,
        providerId: "moonshot",
      }).models?.[0]?.compat?.supportsUsageInStreaming,
    ).toBeUndefined();
  });

  it("includes moonshot when MOONSHOT_API_KEY is configured", async () => {
    const { resolveMissingProviderApiKey } = await loadSecretsModule();
    const provider = resolveMissingProviderApiKey({
      env: { MOONSHOT_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
      provider: buildMoonshotProvider(),
      providerKey: "moonshot",
    });

    expect(provider.apiKey).toBe("MOONSHOT_API_KEY");
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
  });
});
