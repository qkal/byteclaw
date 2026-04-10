import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "../pi-model-discovery.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../model-suppression.js", () => ({
  buildSuppressedBuiltInModelError: ({ provider, id }: { provider?: string; id?: string }) => {
    if (
      (provider !== "openai" && provider !== "azure-openai-responses") ||
      id?.trim().toLowerCase() !== "gpt-5.3-codex-spark"
    ) {
      return undefined;
    }
    return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.`;
  },
  shouldSuppressBuiltInModel: ({ provider, id }: { provider?: string; id?: string }) =>
    (provider === "openai" || provider === "azure-openai-responses") &&
    id?.trim().toLowerCase() === "gpt-5.3-codex-spark",
}));

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import type { OpenRouterModelCapabilities } from "./openrouter-model-capabilities.js";

const mockGetOpenRouterModelCapabilities = vi.fn<
  (modelId: string) => OpenRouterModelCapabilities | undefined
>(() => undefined);
const mockLoadOpenRouterModelCapabilities = vi.fn<(modelId: string) => Promise<void>>(
  async () => {},
);
vi.mock("./openrouter-model-capabilities.js", () => ({
  getOpenRouterModelCapabilities: (modelId: string) => mockGetOpenRouterModelCapabilities(modelId),
  loadOpenRouterModelCapabilities: (modelId: string) =>
    mockLoadOpenRouterModelCapabilities(modelId),
}));

import type { OpenClawConfig } from "../../config/config.js";
import { buildForwardCompatTemplate } from "./model.forward-compat.test-support.js";
import { buildInlineProviderModels, resolveModel, resolveModelAsync } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels(discoverModels);
  mockGetOpenRouterModelCapabilities.mockReset();
  mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);
  mockLoadOpenRouterModelCapabilities.mockReset();
  mockLoadOpenRouterModelCapabilities.mockResolvedValue();
});

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    getOpenRouterModelCapabilities: (modelId: string) =>
      mockGetOpenRouterModelCapabilities(modelId),
    handledDynamicProviders: [
      "openrouter",
      "github-copilot",
      "openai-codex",
      "openai",
      "anthropic",
      "zai",
    ],
    loadOpenRouterModelCapabilities: async (modelId: string) => {
      await mockLoadOpenRouterModelCapabilities(modelId);
    },
  });
}

function resolveModelForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
) {
  const resolvedAgentDir = agentDir ?? "/tmp/agent";
  return resolveModel(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    runtimeHooks: createRuntimeHooks(),
  });
}

function resolveModelAsyncForTest(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
  options?: { retryTransientProviderRuntimeMiss?: boolean },
) {
  const resolvedAgentDir = agentDir ?? "/tmp/agent";
  return resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, resolvedAgentDir),
    ...options,
    runtimeHooks: createRuntimeHooks(),
  });
}

describe("resolveModel", () => {
  it("defaults model input to text when discovery omits input", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "missing-input",
      provider: "custom",
      templateModel: {
        id: "missing-input",
        name: "missing-input",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://localhost:9999",
        reasoning: false,
        // NOTE: deliberately omit input to simulate buggy/custom catalogs.
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    });

    const result = resolveModelForTest("custom", "missing-input", "/tmp/agent", {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9999",
            api: "openai-completions",
            // Intentionally keep this minimal — the discovered model provides the rest.
            models: [{ id: "missing-input", name: "missing-input" }],
          },
        },
      },
    } as unknown as OpenClawConfig);

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.model?.input)).toBe(true);
    expect(result.model?.input).toEqual(["text"]);
  });

  it("includes provider baseUrl in fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("http://localhost:9000");
    expect(result.model?.provider).toBe("custom");
    expect(result.model?.id).toBe("missing-model");
  });

  it("normalizes Google fallback baseUrls for custom providers", () => {
    const cfg = {
      models: {
        providers: {
          "google-paid": {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google-paid", "missing-model", "/tmp/agent", cfg);

    expect(result.model?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("normalizes configured Google override baseUrls when provider api is omitted", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gemini-2.5-pro",
      provider: "google",
      templateModel: {
        ...makeModel("gemini-2.5-pro"),
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        provider: "google",
      },
    });

    const cfg = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [{ id: "gemini-2.5-pro", name: "gemini-2.5-pro" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("google", "gemini-2.5-pro", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.api).toBe("google-generative-ai");
    expect(result.model?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("normalizes custom api.openai.com providers to responses transport", () => {
    const cfg = {
      models: {
        providers: {
          "custom-openai": {
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                ...makeModel("gpt-5.4"),
                provider: "custom-openai",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom-openai", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: "gpt-5.4",
      provider: "custom-openai",
    });
  });

  it("normalizes custom api.x.ai providers to responses transport", () => {
    const cfg = {
      models: {
        providers: {
          "custom-xai": {
            api: "openai-completions",
            baseUrl: "https://api.x.ai/v1",
            models: [
              {
                ...makeModel("grok-4.1-fast"),
                provider: "custom-xai",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom-xai", "grok-4.1-fast", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      id: "grok-4.1-fast",
      provider: "custom-xai",
    });
  });

  it("includes provider headers in provider fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: { "X-Custom-Auth": "token-123" },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    // Requesting a non-listed model forces the providerCfg fallback branch.
    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops SecretRef marker provider headers in fallback models", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            headers: {
              Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
              "X-Custom-Auth": "token-123",
              "X-Managed": "secretref-managed",
            },
            models: [makeModel("listed-model")],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "missing-model", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops marker headers from discovered models.json entries", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "listed-model",
      provider: "custom",
      templateModel: {
        ...makeModel("listed-model"),
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Managed": "secretref-managed",
          "X-Static": "tenant-a",
        },
        provider: "custom",
      },
    });

    const result = resolveModelForTest("custom", "listed-model", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toEqual({
      "X-Static": "tenant-a",
    });
  });

  it("prefers matching configured model metadata for fallback token limits", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                contextWindow: 4096,
                maxTokens: 1024,
              },
              {
                ...makeModel("model-b"),
                contextWindow: 262_144,
                maxTokens: 32_768,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.contextWindow).toBe(262_144);
    expect(result.model?.maxTokens).toBe(32_768);
  });

  it("propagates reasoning from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                reasoning: false,
              },
              {
                ...makeModel("model-b"),
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.reasoning).toBe(true);
  });

  it("propagates image input capability from matching configured fallback model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text"],
              },
              {
                ...makeModel("model-b"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "model-b", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("keeps unknown fallback models text-only instead of borrowing image input from another configured model", () => {
    const cfg = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://localhost:9000",
            models: [
              {
                ...makeModel("model-a"),
                input: ["text", "image"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("custom", "typoed-model", "/tmp/agent", cfg);

    expect(result.model?.id).toBe("typoed-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("repairs stale text-only Foundry fallback rows for GPT-family models", () => {
    const cfg = {
      models: {
        providers: {
          "microsoft-foundry": {
            api: "azure-openai-responses",
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            models: [
              {
                ...makeModel("gpt-5.4"),
                api: "azure-openai-responses",
                input: ["text"],
                name: "gpt-5.4",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows for GPT-family models", () => {
    const cfg = {
      models: {
        providers: {
          "microsoft-foundry": {
            api: "azure-openai-responses",
            baseUrl: "https://example.services.ai.azure.com/openai/v1",
            models: [
              {
                ...makeModel("gpt-5.4"),
                api: "azure-openai-responses",
                input: ["text"],
                name: "gpt-5.4",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "microsoft-foundry",
      templateModel: {
        api: "azure-openai-responses",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 16_384,
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        reasoning: false,
      },
    });

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("repairs stale text-only Foundry discovered rows without config overrides", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "microsoft-foundry",
      templateModel: {
        api: "azure-openai-responses",
        baseUrl: "https://example.services.ai.azure.com/openai/v1",
        contextWindow: 128_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "gpt-5.4",
        input: ["text"],
        maxTokens: 16_384,
        name: "gpt-5.4",
        provider: "microsoft-foundry",
        reasoning: false,
      },
    });

    const result = resolveModelForTest("microsoft-foundry", "gpt-5.4", "/tmp/agent");

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it("matches prefixed OpenRouter native ids in configured fallback models", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            api: "openai-completions",
            baseUrl: "https://openrouter.ai/api/v1",
            models: [
              {
                ...makeModel("openrouter/healer-alpha"),
                contextWindow: 262144,
                input: ["text", "image"],
                maxTokens: 65536,
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const models = buildInlineProviderModels(cfg.models?.providers ?? {});
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contextWindow: 262_144,
          id: "openrouter/healer-alpha",
          input: ["text", "image"],
          maxTokens: 65_536,
          provider: "openrouter",
          reasoning: true,
        }),
      ]),
    );
    expect(models.find((model) => model.id === "openrouter/healer-alpha")).toMatchObject({
      contextWindow: 262_144,
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
      maxTokens: 65_536,
      provider: "openrouter",
      reasoning: true,
    });
  });

  it("uses OpenRouter API capabilities for unknown models when cache is populated", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue({
      contextWindow: 262_144,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      input: ["text", "image"],
      maxTokens: 65_536,
      name: "Healer Alpha",
      reasoning: true,
    });

    const result = resolveModelForTest("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      contextWindow: 262_144,
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
      maxTokens: 65_536,
      name: "Healer Alpha",
      provider: "openrouter",
      reasoning: true,
    });
  });

  it("falls back to text-only when OpenRouter API cache is empty", () => {
    mockGetOpenRouterModelCapabilities.mockReturnValue(undefined);

    const result = resolveModelForTest("openrouter", "openrouter/healer-alpha", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      id: "openrouter/healer-alpha",
      input: ["text"],
      provider: "openrouter",
      reasoning: false,
    });
  });

  it("matches prefixed Hugging Face ids against discovered registry models", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "deepseek-ai/DeepSeek-R1",
      provider: "huggingface",
      templateModel: {
        ...makeModel("deepseek-ai/DeepSeek-R1"),
        baseUrl: "https://router.huggingface.co/v1",
        input: ["text"],
        provider: "huggingface",
        reasoning: true,
      },
    });

    const result = resolveModelForTest(
      "huggingface",
      "huggingface/deepseek-ai/DeepSeek-R1",
      "/tmp/agent",
    );

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      id: "deepseek-ai/DeepSeek-R1",
      input: ["text"],
      provider: "huggingface",
      reasoning: true,
    });
  });

  it("preloads OpenRouter capabilities before first async resolve of an unknown model", async () => {
    mockLoadOpenRouterModelCapabilities.mockImplementation(async (modelId) => {
      if (modelId === "google/gemini-3.1-flash-image-preview") {
        mockGetOpenRouterModelCapabilities.mockReturnValue({
          contextWindow: 65_536,
          cost: { cacheRead: 0, cacheWrite: 0, input: 0.5, output: 3 },
          input: ["text", "image"],
          maxTokens: 65_536,
          name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
          reasoning: true,
        });
      }
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "google/gemini-3.1-flash-image-preview",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).toHaveBeenCalledWith(
      "google/gemini-3.1-flash-image-preview",
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      contextWindow: 65_536,
      id: "google/gemini-3.1-flash-image-preview",
      input: ["text", "image"],
      maxTokens: 65_536,
      provider: "openrouter",
      reasoning: true,
    });
  });

  it("skips OpenRouter preload for models already present in the registry", async () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "openrouter/healer-alpha",
      provider: "openrouter",
      templateModel: {
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        contextWindow: 262_144,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "openrouter/healer-alpha",
        input: ["text", "image"],
        maxTokens: 65_536,
        name: "Healer Alpha",
        provider: "openrouter",
        reasoning: true,
      },
    });

    const result = await resolveModelAsyncForTest(
      "openrouter",
      "openrouter/healer-alpha",
      "/tmp/agent",
    );

    expect(mockLoadOpenRouterModelCapabilities).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      id: "openrouter/healer-alpha",
      input: ["text", "image"],
      provider: "openrouter",
    });
  });

  it("prefers configured provider api metadata over discovered registry model", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "glm-5",
      provider: "onehub",
      templateModel: {
        api: "anthropic-messages",
        baseUrl: "https://old-provider.example.com/v1",
        contextWindow: 8192,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "glm-5",
        input: ["text"],
        maxTokens: 2048,
        name: "GLM-5 (cached)",
        provider: "onehub",
        reasoning: false,
      },
    });

    const cfg = {
      models: {
        providers: {
          onehub: {
            api: "openai-completions",
            baseUrl: "http://new-provider.example.com/v1",
            models: [
              {
                ...makeModel("glm-5"),
                api: "openai-completions",
                contextWindow: 198000,
                maxTokens: 16000,
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("onehub", "glm-5", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "http://new-provider.example.com/v1",
      contextWindow: 198_000,
      id: "glm-5",
      maxTokens: 16_000,
      provider: "onehub",
      reasoning: true,
    });
  });

  it("prefers exact provider config over normalized alias match when both keys exist", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "bedrock-alias-exact-test",
      provider: "bedrock",
      templateModel: {
        api: "openai-completions",
        baseUrl: "https://default-provider.example.com/v1",
        contextWindow: 8192,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "bedrock-alias-exact-test",
        input: ["text"],
        maxTokens: 2048,
        name: "Bedrock alias test",
        provider: "bedrock",
        reasoning: false,
      },
    });

    const cfg = {
      models: {
        providers: {
          "amazon-bedrock": {
            api: "openai-completions",
            baseUrl: "https://canonical-bedrock.example.com/v1",
            headers: { "X-Provider": "canonical" },
            models: [{ ...makeModel("bedrock-alias-exact-test"), reasoning: false }],
          },
          bedrock: {
            api: "anthropic-messages",
            baseUrl: "https://alias-bedrock.example.com/v1",
            headers: { "X-Provider": "alias" },
            models: [
              {
                ...makeModel("bedrock-alias-exact-test"),
                api: "anthropic-messages",
                contextWindow: 262144,
                maxTokens: 32768,
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("bedrock", "bedrock-alias-exact-test", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://alias-bedrock.example.com",
      contextWindow: 262_144,
      headers: { "X-Provider": "alias" },
      id: "bedrock-alias-exact-test",
      maxTokens: 32_768,
      provider: "bedrock",
      reasoning: true,
    });
  });

  it("builds an openai-codex fallback for gpt-5.4", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("builds an openai-codex fallback for gpt-5.4-mini", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"));
  });

  it("builds an openai-codex fallback for gpt-5.3-codex-spark", () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = resolveModelForTest("openai-codex", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(
      buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
    );
  });

  it("keeps openai-codex gpt-5.3-codex-spark when discovery provides it", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.3-codex-spark",
      provider: "openai-codex",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
        input: ["text"],
        name: "GPT-5.3 Codex Spark",
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      id: "gpt-5.3-codex-spark",
      provider: "openai-codex",
    });
  });

  it("prefers runtime-resolved openai-codex gpt-5.4 metadata when it has a larger context window", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "openai-codex",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        contextTokens: 32_000,
        contextWindow: 128_000,
        input: ["text"],
        name: "GPT-5.4",
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextTokens: 272_000,
      contextWindow: 1_050_000,
      id: "gpt-5.4",
      provider: "openai-codex",
    });
  });

  it("prefers runtime-resolved openai-codex gpt-5.4 metadata during async resolution too", async () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "openai-codex",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        contextTokens: 32_000,
        contextWindow: 128_000,
        name: "GPT-5.4",
      },
    });

    const result = await resolveModelAsyncForTest("openai-codex", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      contextTokens: 272_000,
      contextWindow: 1_050_000,
      id: "gpt-5.4",
      provider: "openai-codex",
    });
  });

  it("passes configured workspaceDir to runtime preference hooks", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "openai-codex",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
        contextTokens: 32_000,
        contextWindow: 128_000,
        name: "GPT-5.4",
      },
    });

    const shouldPreferRuntimeResolvedModel = vi.fn(
      (params: { workspaceDir?: string; context: { agentDir?: string } }) =>
        params.workspaceDir === "/tmp/workspace" && params.context.agentDir === "/tmp/agent-state",
    );
    const runProviderDynamicModel = vi.fn(
      (params: { workspaceDir?: string; context: { provider: string; modelId: string } }) =>
        params.workspaceDir === "/tmp/workspace" &&
        params.context.provider === "openai-codex" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel,
      shouldPreferProviderRuntimeResolvedModel: shouldPreferRuntimeResolvedModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
        },
      },
    } as OpenClawConfig;

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent-state", cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent-state"),
      runtimeHooks,
    });

    expect(shouldPreferRuntimeResolvedModel).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          agentDir: "/tmp/agent-state",
          workspaceDir: "/tmp/workspace",
        }),
        provider: "openai-codex",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(runProviderDynamicModel).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          agentDir: "/tmp/agent-state",
          modelId: "gpt-5.4",
          provider: "openai-codex",
        }),
        provider: "openai-codex",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      contextTokens: 272_000,
      contextWindow: 1_050_000,
      id: "gpt-5.4",
      provider: "openai-codex",
    });
  });

  it("keeps exact discovered metadata for other openai-codex models", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4-mini",
      provider: "openai-codex",
      templateModel: {
        ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
        contextWindow: 64_000,
        input: ["text"],
        name: "GPT-5.4 Mini",
      },
    });

    const result = resolveModelForTest("openai-codex", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 64_000,
      id: "gpt-5.4-mini",
      input: ["text"],
      provider: "openai-codex",
    });
  });

  it("rejects stale direct openai gpt-5.3-codex-spark discovery rows", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.3-codex-spark",
      provider: "openai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.3-codex-spark", "/tmp/agent");

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is only supported via openai-codex OAuth. Use openai-codex/gpt-5.3-codex-spark.",
    );
  });

  it("applies provider overrides to openai gpt-5.4 forward-compat models", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "openai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        name: "GPT-5.2",
        provider: "openai",
      }),
    });

    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.com/v1",
            headers: { "X-Proxy-Auth": "token-123" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      id: "gpt-5.4",
      provider: "openai",
    });
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toMatchObject(
      {
        "X-Proxy-Auth": "token-123",
      },
    );
  });

  it("applies configured overrides to github-copilot dynamic models", () => {
    const cfg = {
      models: {
        providers: {
          "github-copilot": {
            api: "openai-completions",
            baseUrl: "https://proxy.example.com/v1",
            headers: { "X-Proxy-Auth": "token-123" },
            models: [
              {
                ...makeModel("gpt-5.4-mini"),
                contextWindow: 256000,
                input: ["text"],
                maxTokens: 32000,
                reasoning: true,
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveModelForTest("github-copilot", "gpt-5.4-mini", "/tmp/agent", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      contextWindow: 256_000,
      id: "gpt-5.4-mini",
      input: ["text"],
      maxTokens: 32_000,
      provider: "github-copilot",
      reasoning: true,
    });
    expect((result.model as unknown as { headers?: Record<string, string> }).headers).toMatchObject(
      {
        "X-Proxy-Auth": "token-123",
      },
    );
  });

  it("resolves github-copilot Claude dynamic models to anthropic-messages by default", () => {
    const result = resolveModelForTest("github-copilot", "claude-sonnet-4.6", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "anthropic-messages",
      id: "claude-sonnet-4.6",
      provider: "github-copilot",
    });
  });

  it("builds an openai fallback for gpt-5.4 mini from the gpt-5.4-mini template", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4-mini",
      provider: "openai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400_000,
        id: "gpt-5.4-mini",
        input: ["text", "image"],
        maxTokens: 128_000,
        name: "GPT-5 mini",
        provider: "openai",
        reasoning: true,
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4-mini", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      id: "gpt-5.4-mini",
      input: ["text", "image"],
      maxTokens: 128_000,
      provider: "openai",
      reasoning: true,
    });
  });

  it("builds an openai fallback for gpt-5.4 nano from the gpt-5.4-nano template", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4-nano",
      provider: "openai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 400_000,
        id: "gpt-5.4-nano",
        input: ["text", "image"],
        maxTokens: 128_000,
        name: "GPT-5 nano",
        provider: "openai",
        reasoning: true,
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4-nano", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      id: "gpt-5.4-nano",
      input: ["text", "image"],
      maxTokens: 128_000,
      provider: "openai",
      reasoning: true,
    });
  });

  it("normalizes stale native openai gpt-5.4 completions transport to responses", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "openai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: "gpt-5.4",
      provider: "openai",
    });
  });

  it("keeps proxied openai completions transport untouched", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "gpt-5.4",
      provider: "openai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
      }),
    });

    const result = resolveModelForTest("openai", "gpt-5.4", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://proxy.example.com/v1",
      id: "gpt-5.4",
      provider: "openai",
    });
  });

  it("normalizes stale native xai completions transport to responses", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "grok-4.20-beta-latest-reasoning",
      provider: "xai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        id: "grok-4.20-beta-latest-reasoning",
        name: "Grok 4.20 Beta Latest (Reasoning)",
        provider: "xai",
      }),
    });

    const result = resolveModelForTest("xai", "grok-4.20-beta-latest-reasoning", "/tmp/agent");

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      id: "grok-4.20-beta-latest-reasoning",
      provider: "xai",
    });
  });

  it("normalizes stale native xai completions transport after plugin model normalization", () => {
    mockDiscoveredModel(discoverModels, {
      modelId: "grok-4.20-beta-latest-reasoning",
      provider: "xai",
      templateModel: buildForwardCompatTemplate({
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        id: "grok-4.20-beta-latest-reasoning",
        name: "Grok 4.20 Beta Latest (Reasoning)",
        provider: "xai",
      }),
    });

    const result = resolveModel("xai", "grok-4.20-beta-latest-reasoning", "/tmp/agent", undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, "/tmp/agent"),
      runtimeHooks: {
        applyProviderResolvedModelCompatWithPlugins: () => undefined,
        applyProviderResolvedTransportWithPlugin: ({ provider, context }) =>
          provider === "xai" &&
          context.model.api === "openai-completions" &&
          context.model.baseUrl === "https://api.x.ai/v1"
            ? {
                ...context.model,
                api: "openai-responses",
              }
            : undefined,
        buildProviderUnknownModelHintWithPlugin: () => undefined,
        clearProviderRuntimeHookCache: () => {},
        normalizeProviderResolvedModelWithPlugin: ({ provider, context }) =>
          provider === "xai" ? (context.model as never) : undefined,
        normalizeProviderTransportWithPlugin: () => undefined,
        prepareProviderDynamicModel: async () => {},
        runProviderDynamicModel: () => undefined,
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      id: "grok-4.20-beta-latest-reasoning",
      provider: "xai",
    });
  });
});
