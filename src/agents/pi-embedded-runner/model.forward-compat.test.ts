import { describe, it, vi } from "vitest";
import {
  buildForwardCompatTemplate,
  expectResolvedForwardCompatFallbackWithRegistryResult,
} from "./model.forward-compat.test-support.js";
import { resolveModelWithRegistry } from "./model.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedModelCompatWithPlugins: () => undefined,
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  clearProviderRuntimeHookCache: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => undefined,
  resolveProviderBuiltInModelSuppression: () => undefined,
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

const ANTHROPIC_OPUS_TEMPLATE = buildForwardCompatTemplate({
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  provider: "anthropic",
});

const ANTHROPIC_OPUS_EXPECTED = {
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  id: "claude-opus-4-6",
  provider: "anthropic",
  reasoning: true,
};

const ANTHROPIC_SONNET_TEMPLATE = buildForwardCompatTemplate({
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
});

const ANTHROPIC_SONNET_EXPECTED = {
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  id: "claude-sonnet-4-6",
  provider: "anthropic",
  reasoning: true,
};

const ZAI_GLM5_CASE = {
  expectedModel: {
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    id: "glm-5",
    provider: "zai",
    reasoning: true,
  },
  id: "glm-5",
  provider: "zai",
  registryEntries: [
    {
      model: buildForwardCompatTemplate({
        id: "glm-4.7",
        name: "GLM-4.7",
        provider: "zai",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 131072,
      }),
      modelId: "glm-4.7",
      provider: "zai",
    },
  ],
} as const;

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["anthropic", "claude-cli", "zai", "openai-codex"],
  });
}

function createRegistry(
  entries: { provider: string; modelId: string; model: Record<string, unknown> }[],
) {
  return {
    find(provider: string, modelId: string) {
      const match = entries.find(
        (entry) => entry.provider === provider && entry.modelId === modelId,
      );
      return match?.model ?? null;
    },
  } as never;
}

function runAnthropicOpusForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    expectedModel: ANTHROPIC_OPUS_EXPECTED,
    result: resolveModelWithRegistry({
      agentDir: "/tmp/agent",
      modelId: "claude-opus-4-6",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-opus-4-5",
          model: ANTHROPIC_OPUS_TEMPLATE,
        },
      ]),
      provider: "anthropic",
      runtimeHooks: createRuntimeHooks(),
    }),
  });
}

function runAnthropicSonnetForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    expectedModel: ANTHROPIC_SONNET_EXPECTED,
    result: resolveModelWithRegistry({
      agentDir: "/tmp/agent",
      modelId: "claude-sonnet-4-6",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          model: ANTHROPIC_SONNET_TEMPLATE,
        },
      ]),
      provider: "anthropic",
      runtimeHooks: createRuntimeHooks(),
    }),
  });
}

function runClaudeCliSonnetForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    expectedModel: {
      ...ANTHROPIC_SONNET_EXPECTED,
      provider: "claude-cli",
    },
    result: resolveModelWithRegistry({
      agentDir: "/tmp/agent",
      modelId: "claude-sonnet-4-6",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          model: ANTHROPIC_SONNET_TEMPLATE,
        },
      ]),
      provider: "claude-cli",
      runtimeHooks: createRuntimeHooks(),
    }),
  });
}

function runZaiForwardCompatFallback() {
  const result = resolveModelWithRegistry({
    agentDir: "/tmp/agent",
    modelId: ZAI_GLM5_CASE.id,
    modelRegistry: createRegistry(
      ZAI_GLM5_CASE.registryEntries.map((entry) => ({
        model: entry.model,
        modelId: entry.modelId,
        provider: entry.provider,
      })),
    ),
    provider: ZAI_GLM5_CASE.provider,
    runtimeHooks: createRuntimeHooks(),
  });
  expectResolvedForwardCompatFallbackWithRegistryResult({
    expectedModel: ZAI_GLM5_CASE.expectedModel,
    result,
  });
}

describe("resolveModel forward-compat tail", () => {
  it(
    "builds an anthropic forward-compat fallback for claude-opus-4-6",
    runAnthropicOpusForwardCompatFallback,
  );

  it(
    "builds an anthropic forward-compat fallback for claude-sonnet-4-6",
    runAnthropicSonnetForwardCompatFallback,
  );

  it(
    "preserves the claude-cli provider for anthropic forward-compat fallback models",
    runClaudeCliSonnetForwardCompatFallback,
  );

  it("builds a zai forward-compat fallback for glm-5", runZaiForwardCompatFallback);
});
