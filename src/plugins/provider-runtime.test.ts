import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import {
  expectAugmentedCodexCatalog,
  expectCodexBuiltInSuppression,
  expectCodexMissingAuthHint,
  expectedAugmentedOpenaiCodexCatalogEntries,
} from "./provider-runtime.test-support.js";
import type {
  AnyAgentTool,
  ProviderExternalAuthProfile,
  ProviderNormalizeToolSchemasContext,
  ProviderPlugin,
  ProviderRuntimeModel,
  ProviderSanitizeReplayHistoryContext,
  ProviderValidateReplayTurnsContext,
} from "./types.js";

type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;
type IsPluginProvidersLoadInFlight =
  typeof import("./providers.runtime.js").isPluginProvidersLoadInFlight;
type ResolveCatalogHookProviderPluginIds =
  typeof import("./providers.js").resolveCatalogHookProviderPluginIds;

const resolvePluginProvidersMock = vi.fn<ResolvePluginProviders>((_) => [] as ProviderPlugin[]);
const isPluginProvidersLoadInFlightMock = vi.fn<IsPluginProvidersLoadInFlight>((_) => false);
const resolveCatalogHookProviderPluginIdsMock = vi.fn<ResolveCatalogHookProviderPluginIds>(
  (_) => [] as string[],
);

let augmentModelCatalogWithProviderPlugins: typeof import("./provider-runtime.js").augmentModelCatalogWithProviderPlugins;
let buildProviderAuthDoctorHintWithPlugin: typeof import("./provider-runtime.js").buildProviderAuthDoctorHintWithPlugin;
let buildProviderMissingAuthMessageWithPlugin: typeof import("./provider-runtime.js").buildProviderMissingAuthMessageWithPlugin;
let buildProviderUnknownModelHintWithPlugin: typeof import("./provider-runtime.js").buildProviderUnknownModelHintWithPlugin;
let applyProviderNativeStreamingUsageCompatWithPlugin: typeof import("./provider-runtime.js").applyProviderNativeStreamingUsageCompatWithPlugin;
let applyProviderConfigDefaultsWithPlugin: typeof import("./provider-runtime.js").applyProviderConfigDefaultsWithPlugin;
let formatProviderAuthProfileApiKeyWithPlugin: typeof import("./provider-runtime.js").formatProviderAuthProfileApiKeyWithPlugin;
let classifyProviderFailoverReasonWithPlugin: typeof import("./provider-runtime.js").classifyProviderFailoverReasonWithPlugin;
let matchesProviderContextOverflowWithPlugin: typeof import("./provider-runtime.js").matchesProviderContextOverflowWithPlugin;
let normalizeProviderConfigWithPlugin: typeof import("./provider-runtime.js").normalizeProviderConfigWithPlugin;
let normalizeProviderModelIdWithPlugin: typeof import("./provider-runtime.js").normalizeProviderModelIdWithPlugin;
let applyProviderResolvedModelCompatWithPlugins: typeof import("./provider-runtime.js").applyProviderResolvedModelCompatWithPlugins;
let applyProviderResolvedTransportWithPlugin: typeof import("./provider-runtime.js").applyProviderResolvedTransportWithPlugin;
let normalizeProviderTransportWithPlugin: typeof import("./provider-runtime.js").normalizeProviderTransportWithPlugin;
let prepareProviderExtraParams: typeof import("./provider-runtime.js").prepareProviderExtraParams;
let resolveProviderConfigApiKeyWithPlugin: typeof import("./provider-runtime.js").resolveProviderConfigApiKeyWithPlugin;
let resolveProviderStreamFn: typeof import("./provider-runtime.js").resolveProviderStreamFn;
let resolveProviderCacheTtlEligibility: typeof import("./provider-runtime.js").resolveProviderCacheTtlEligibility;
let resolveProviderBinaryThinking: typeof import("./provider-runtime.js").resolveProviderBinaryThinking;
let resolveProviderBuiltInModelSuppression: typeof import("./provider-runtime.js").resolveProviderBuiltInModelSuppression;
let createProviderEmbeddingProvider: typeof import("./provider-runtime.js").createProviderEmbeddingProvider;
let resolveProviderDefaultThinkingLevel: typeof import("./provider-runtime.js").resolveProviderDefaultThinkingLevel;
let resolveProviderModernModelRef: typeof import("./provider-runtime.js").resolveProviderModernModelRef;
let resolveProviderReasoningOutputModeWithPlugin: typeof import("./provider-runtime.js").resolveProviderReasoningOutputModeWithPlugin;
let resolveProviderReplayPolicyWithPlugin: typeof import("./provider-runtime.js").resolveProviderReplayPolicyWithPlugin;
let resolveExternalAuthProfilesWithPlugins: typeof import("./provider-runtime.js").resolveExternalAuthProfilesWithPlugins;
let resolveProviderSyntheticAuthWithPlugin: typeof import("./provider-runtime.js").resolveProviderSyntheticAuthWithPlugin;
let shouldDeferProviderSyntheticProfileAuthWithPlugin: typeof import("./provider-runtime.js").shouldDeferProviderSyntheticProfileAuthWithPlugin;
let sanitizeProviderReplayHistoryWithPlugin: typeof import("./provider-runtime.js").sanitizeProviderReplayHistoryWithPlugin;
let resolveProviderUsageSnapshotWithPlugin: typeof import("./provider-runtime.js").resolveProviderUsageSnapshotWithPlugin;
let resolveProviderUsageAuthWithPlugin: typeof import("./provider-runtime.js").resolveProviderUsageAuthWithPlugin;
let resolveProviderXHighThinking: typeof import("./provider-runtime.js").resolveProviderXHighThinking;
let normalizeProviderToolSchemasWithPlugin: typeof import("./provider-runtime.js").normalizeProviderToolSchemasWithPlugin;
let inspectProviderToolSchemasWithPlugin: typeof import("./provider-runtime.js").inspectProviderToolSchemasWithPlugin;
let normalizeProviderResolvedModelWithPlugin: typeof import("./provider-runtime.js").normalizeProviderResolvedModelWithPlugin;
let prepareProviderDynamicModel: typeof import("./provider-runtime.js").prepareProviderDynamicModel;
let prepareProviderRuntimeAuth: typeof import("./provider-runtime.js").prepareProviderRuntimeAuth;
let resetProviderRuntimeHookCacheForTest: typeof import("./provider-runtime.js").resetProviderRuntimeHookCacheForTest;
let refreshProviderOAuthCredentialWithPlugin: typeof import("./provider-runtime.js").refreshProviderOAuthCredentialWithPlugin;
let resolveProviderRuntimePlugin: typeof import("./provider-runtime.js").resolveProviderRuntimePlugin;
let runProviderDynamicModel: typeof import("./provider-runtime.js").runProviderDynamicModel;
let validateProviderReplayTurnsWithPlugin: typeof import("./provider-runtime.js").validateProviderReplayTurnsWithPlugin;
let wrapProviderStreamFn: typeof import("./provider-runtime.js").wrapProviderStreamFn;

const MODEL: ProviderRuntimeModel = {
  api: "openai-responses",
  baseUrl: "https://api.example.com/v1",
  contextWindow: 128_000,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "demo-model",
  input: ["text"],
  maxTokens: 8192,
  name: "Demo Model",
  provider: "demo",
  reasoning: true,
};
const DEMO_PROVIDER_ID = "demo";
const EMPTY_MODEL_REGISTRY = { find: () => null } as never;
const DEMO_REPLAY_MESSAGES: AgentMessage[] = [{ content: "hello", role: "user", timestamp: 1 }];
const DEMO_SANITIZED_MESSAGE: AgentMessage = {
  api: MODEL.api,
  content: [{ text: "sanitized", type: "text" }],
  model: MODEL.id,
  provider: MODEL.provider,
  role: "assistant",
  stopReason: "stop",
  timestamp: 2,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
};
const DEMO_TOOL = {
  description: "Demo tool",
  execute: vi.fn(async () => ({ content: [], details: undefined })),
  label: "Demo tool",
  name: "demo-tool",
  parameters: { properties: {}, type: "object" },
} as unknown as AnyAgentTool;

function createOpenAiCatalogProviderPlugin(
  overrides: Partial<ProviderPlugin> = {},
): ProviderPlugin {
  return {
    augmentModelCatalog: () => [
      { id: "gpt-5.4", name: "gpt-5.4", provider: "openai" },
      { id: "gpt-5.4-pro", name: "gpt-5.4-pro", provider: "openai" },
      { id: "gpt-5.4-mini", name: "gpt-5.4-mini", provider: "openai" },
      { id: "gpt-5.4-nano", name: "gpt-5.4-nano", provider: "openai" },
      { id: "gpt-5.4", name: "gpt-5.4", provider: "openai-codex" },
      { id: "gpt-5.4-mini", name: "gpt-5.4-mini", provider: "openai-codex" },
      {
        id: "gpt-5.3-codex-spark",
        name: "gpt-5.3-codex-spark",
        provider: "openai-codex",
      },
    ],
    auth: [],
    id: "openai",
    label: "OpenAI",
    suppressBuiltInModel: ({ provider, modelId }) =>
      (provider === "openai" || provider === "azure-openai-responses") &&
      modelId === "gpt-5.3-codex-spark"
        ? { errorMessage: "openai-codex/gpt-5.3-codex-spark", suppress: true }
        : undefined,
    ...overrides,
  };
}

function expectProviderRuntimePluginLoad(params: { provider: string; expectedPluginId?: string }) {
  const plugin = resolveProviderRuntimePlugin({ provider: params.provider });

  expect(plugin?.id).toBe(params.expectedPluginId);
  expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
    expect.objectContaining({
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
      providerRefs: [params.provider],
    }),
  );
}

function createDemoRuntimeContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string } {
  return {
    modelId: MODEL.id,
    provider: DEMO_PROVIDER_ID,
    ...overrides,
  };
}

function createDemoProviderContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string } {
  return {
    provider: DEMO_PROVIDER_ID,
    ...overrides,
  };
}

function createDemoResolvedModelContext<TContext extends Record<string, unknown>>(
  overrides: TContext,
): TContext & { provider: string; modelId: string; model: ProviderRuntimeModel } {
  return createDemoRuntimeContext({
    model: MODEL,
    ...overrides,
  });
}

function expectCalledOnce(...mocks: { mock: { calls: unknown[] } }[]) {
  for (const mockFn of mocks) {
    expect(mockFn).toHaveBeenCalledTimes(1);
  }
}

function expectResolvedValues(
  cases: readonly {
    actual: () => unknown;
    expected: unknown;
  }[],
) {
  cases.forEach(({ actual, expected }) => {
    expect(actual()).toEqual(expected);
  });
}

async function expectResolvedMatches(
  cases: readonly {
    actual: () => Promise<unknown>;
    expected: Record<string, unknown>;
  }[],
) {
  await Promise.all(
    cases.map(async ({ actual, expected }) => {
      await expect(actual()).resolves.toMatchObject(expected);
    }),
  );
}

async function expectResolvedAsyncValues(
  cases: readonly {
    actual: () => Promise<unknown>;
    expected: unknown;
  }[],
) {
  await Promise.all(
    cases.map(async ({ actual, expected }) => {
      await expect(actual()).resolves.toEqual(expected);
    }),
  );
}

describe("provider-runtime", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./provider-public-artifacts.js", () => ({
      resolveBundledProviderPolicySurface: () => null,
    }));
    vi.doMock("./providers.js", () => ({
      resolveCatalogHookProviderPluginIds: (params: unknown) =>
        resolveCatalogHookProviderPluginIdsMock(params as never),
    }));
    vi.doMock("./providers.runtime.js", () => ({
      isPluginProvidersLoadInFlight: (params: unknown) =>
        isPluginProvidersLoadInFlightMock(params as never),
      resolvePluginProviders: (params: unknown) => resolvePluginProvidersMock(params as never),
    }));
    ({
      augmentModelCatalogWithProviderPlugins,
      buildProviderAuthDoctorHintWithPlugin,
      buildProviderMissingAuthMessageWithPlugin,
      buildProviderUnknownModelHintWithPlugin,
      applyProviderNativeStreamingUsageCompatWithPlugin,
      applyProviderConfigDefaultsWithPlugin,
      applyProviderResolvedModelCompatWithPlugins,
      applyProviderResolvedTransportWithPlugin,
      classifyProviderFailoverReasonWithPlugin,
      formatProviderAuthProfileApiKeyWithPlugin,
      matchesProviderContextOverflowWithPlugin,
      normalizeProviderConfigWithPlugin,
      normalizeProviderModelIdWithPlugin,
      normalizeProviderTransportWithPlugin,
      prepareProviderExtraParams,
      resolveProviderConfigApiKeyWithPlugin,
      resolveProviderStreamFn,
      resolveProviderCacheTtlEligibility,
      resolveProviderBinaryThinking,
      resolveProviderBuiltInModelSuppression,
      createProviderEmbeddingProvider,
      resolveProviderDefaultThinkingLevel,
      resolveProviderModernModelRef,
      resolveProviderReasoningOutputModeWithPlugin,
      resolveProviderReplayPolicyWithPlugin,
      resolveExternalAuthProfilesWithPlugins,
      resolveProviderSyntheticAuthWithPlugin,
      shouldDeferProviderSyntheticProfileAuthWithPlugin,
      sanitizeProviderReplayHistoryWithPlugin,
      resolveProviderUsageSnapshotWithPlugin,
      resolveProviderUsageAuthWithPlugin,
      resolveProviderXHighThinking,
      normalizeProviderToolSchemasWithPlugin,
      inspectProviderToolSchemasWithPlugin,
      normalizeProviderResolvedModelWithPlugin,
      prepareProviderDynamicModel,
      prepareProviderRuntimeAuth,
      resetProviderRuntimeHookCacheForTest,
      refreshProviderOAuthCredentialWithPlugin,
      resolveProviderRuntimePlugin,
      runProviderDynamicModel,
      validateProviderReplayTurnsWithPlugin,
      wrapProviderStreamFn,
    } = await import("./provider-runtime.js"));
  });

  beforeEach(() => {
    resetProviderRuntimeHookCacheForTest();
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    isPluginProvidersLoadInFlightMock.mockReset();
    isPluginProvidersLoadInFlightMock.mockReturnValue(false);
    resolveCatalogHookProviderPluginIdsMock.mockReset();
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue([]);
  });

  it("matches providers by alias for runtime hook lookup", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        aliases: ["Open Router"],
        auth: [],
        id: "openrouter",
        label: "OpenRouter",
      },
    ]);

    expectProviderRuntimePluginLoad({
      expectedPluginId: "openrouter",
      provider: "Open Router",
    });
  });

  it("matches providers by hook alias for runtime hook lookup", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        hookAliases: ["claude-cli"],
        id: "anthropic",
        label: "Anthropic",
      },
    ]);

    expectProviderRuntimePluginLoad({
      expectedPluginId: "anthropic",
      provider: "claude-cli",
    });
  });

  it("returns provider-prepared runtime auth for the matched provider", async () => {
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        id: DEMO_PROVIDER_ID,
        label: "Demo",
        prepareRuntimeAuth,
      },
    ]);

    await expect(
      prepareProviderRuntimeAuth({
        context: {
          apiKey: "raw-token",
          authMode: "token",
          config: undefined,
          env: process.env,
          model: MODEL,
          modelId: MODEL.id,
          provider: DEMO_PROVIDER_ID,
          workspaceDir: "/tmp/demo-workspace",
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).resolves.toEqual({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    });
    expect(prepareRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "raw-token",
        modelId: MODEL.id,
        provider: DEMO_PROVIDER_ID,
      }),
    );
  });

  it("returns no runtime plugin when the provider has no owning plugin", () => {
    expectProviderRuntimePluginLoad({
      provider: "anthropic",
    });
  });

  it("can normalize model ids through provider aliases without changing ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        hookAliases: ["google-vertex"],
        id: "google",
        label: "Google",
        normalizeModelId: ({ modelId }) => modelId.replace("flash-lite", "flash-lite-preview"),
      },
    ]);

    expect(
      normalizeProviderModelIdWithPlugin({
        context: {
          modelId: "gemini-3.1-flash-lite",
          provider: "google-vertex",
        },
        provider: "google-vertex",
      }),
    ).toBe("gemini-3.1-flash-lite-preview");
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);
  });

  it("resolves config hooks through hook-only aliases without changing provider surfaces", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        hookAliases: ["google-antigravity"],
        id: "google",
        label: "Google",
        normalizeConfig: ({ providerConfig }) => ({
          ...providerConfig,
          baseUrl: "https://normalized.example.com/v1",
        }),
      },
    ]);

    expect(
      normalizeProviderConfigWithPlugin({
        context: {
          provider: "google-antigravity",
          providerConfig: {
            api: "openai-completions",
            baseUrl: "https://example.com",
            models: [],
          },
        },
        provider: "google-antigravity",
      }),
    ).toMatchObject({
      baseUrl: "https://normalized.example.com/v1",
    });
  });

  it("resolves provider config defaults through owner plugins", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        applyConfigDefaults: ({ config }) => ({
          ...config,
          agents: {
            defaults: {
              heartbeat: { every: "1h" },
            },
          },
        }),
        auth: [],
        id: "anthropic",
        label: "Anthropic",
      },
    ]);

    expect(
      applyProviderConfigDefaultsWithPlugin({
        context: {
          config: {},
          env: {},
          provider: "anthropic",
        },
        provider: "anthropic",
      }),
    ).toMatchObject({
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
          },
        },
      },
    });
  });

  it("resolves failover classification through hook-only aliases", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        classifyFailoverReason: ({ errorMessage }) =>
          /\bquota exceeded\b/i.test(errorMessage) ? "rate_limit" : undefined,
        hookAliases: ["azure-openai-responses"],
        id: "openai",
        label: "OpenAI",
        matchesContextOverflowError: ({ errorMessage }) =>
          /\bcontent_filter\b.*\btoo long\b/i.test(errorMessage),
      },
    ]);

    expect(
      matchesProviderContextOverflowWithPlugin({
        context: {
          errorMessage: "content_filter prompt too long",
          provider: "azure-openai-responses",
        },
        provider: "azure-openai-responses",
      }),
    ).toBe(true);
    expect(
      classifyProviderFailoverReasonWithPlugin({
        context: {
          errorMessage: "quota exceeded",
          provider: "azure-openai-responses",
        },
        provider: "azure-openai-responses",
      }),
    ).toBe("rate_limit");
  });

  it("resolves stream wrapper hooks through hook-only aliases without provider ownership", () => {
    const wrappedStreamFn = vi.fn();
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        hookAliases: ["azure-openai-responses"],
        id: "openai",
        label: "OpenAI",
        wrapStreamFn: ({ streamFn }) => streamFn ?? wrappedStreamFn,
      },
    ]);

    expect(
      wrapProviderStreamFn({
        context: createDemoResolvedModelContext({
          provider: "azure-openai-responses",
          streamFn: wrappedStreamFn,
        }),
        provider: "azure-openai-responses",
      }),
    ).toBe(wrappedStreamFn);
  });

  it("normalizes transport hooks without needing provider ownership", () => {
    resolvePluginProvidersMock.mockReturnValue([
      {
        auth: [],
        id: "google",
        label: "Google",
        normalizeTransport: ({ api, baseUrl }) =>
          api === "google-generative-ai" && baseUrl === "https://generativelanguage.googleapis.com"
            ? {
                api,
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              }
            : undefined,
      },
    ]);

    expect(
      normalizeProviderTransportWithPlugin({
        context: {
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
          provider: "google-paid",
        },
        provider: "google-paid",
      }),
    ).toEqual({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });

  it("invalidates cached runtime providers when config mutates in place", () => {
    const config = {
      plugins: {
        entries: {
          demo: { enabled: false },
        },
      },
    } as { plugins: { entries: { demo: { enabled: boolean } } } };
    resolvePluginProvidersMock.mockImplementation((params) => {
      const runtimeConfig = params?.config as typeof config | undefined;
      const enabled = runtimeConfig?.plugins?.entries?.demo?.enabled === true;
      return enabled
        ? [
            {
              auth: [],
              id: DEMO_PROVIDER_ID,
              label: "Demo",
            },
          ]
        : [];
    });

    expect(
      resolveProviderRuntimePlugin({
        config: config as never,
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBeUndefined();

    config.plugins.entries.demo.enabled = true;

    expect(
      resolveProviderRuntimePlugin({
        config: config as never,
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      id: DEMO_PROVIDER_ID,
    });
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches runtime hooks for the matched provider", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    const prepareDynamicModel = vi.fn(async () => undefined);
    const createStreamFn = vi.fn(() => vi.fn());
    const createEmbeddingProvider = vi.fn(async () => ({
      client: { token: "embed-token" },
      embedBatch: async () => [[1, 0, 0]],
      embedQuery: async () => [1, 0, 0],
      id: "demo",
      model: "demo-embed",
    }));
    const buildReplayPolicy = vi.fn(() => ({
      allowSyntheticToolResults: true,
      sanitizeMode: "full" as const,
      toolCallIdMode: "strict9" as const,
    }));
    const sanitizeReplayHistory = vi.fn(
      async ({
        messages,
      }: Pick<ProviderSanitizeReplayHistoryContext, "messages">): Promise<AgentMessage[]> => [
        ...messages,
        DEMO_SANITIZED_MESSAGE,
      ],
    );
    const validateReplayTurns = vi.fn(
      async ({
        messages,
      }: Pick<ProviderValidateReplayTurnsContext, "messages">): Promise<AgentMessage[]> => messages,
    );
    const normalizeToolSchemas = vi.fn(
      ({ tools }: Pick<ProviderNormalizeToolSchemasContext, "tools">): AnyAgentTool[] => tools,
    );
    const inspectToolSchemas = vi.fn(() => [] as { toolName: string; violations: string[] }[]);
    const resolveReasoningOutputMode = vi.fn(() => "tagged" as const);
    const resolveSyntheticAuth = vi.fn(() => ({
      apiKey: "demo-local",
      mode: "api-key" as const,
      source: "models.providers.demo (synthetic local key)",
    }));
    const shouldDeferSyntheticProfileAuth = vi.fn(
      ({ resolvedApiKey }: { resolvedApiKey?: string }) => resolvedApiKey === "demo-local",
    );
    const buildUnknownModelHint = vi.fn(
      ({ modelId }: { modelId: string }) => `Use demo setup for ${modelId}`,
    );
    const prepareRuntimeAuth = vi.fn(async () => ({
      apiKey: "runtime-token",
      baseUrl: "https://runtime.example.com/v1",
      expiresAt: 123,
    }));
    const refreshOAuth = vi.fn(async (cred) => ({
      ...cred,
      access: "refreshed-access-token",
    }));
    const resolveUsageAuth = vi.fn(async () => ({
      accountId: "usage-account",
      token: "usage-token",
    }));
    const fetchUsageSnapshot = vi.fn(async () => ({
      displayName: "Demo",
      provider: "zai" as const,
      windows: [{ label: "Day", usedPercent: 25 }],
    }));
    resolvePluginProvidersMock.mockImplementation((_params: unknown) => [
        {
          applyNativeStreamingUsageCompat: ({ providerConfig }) => ({
            ...providerConfig,
            compat: { supportsUsageInStreaming: true },
          }),
          auth: [],
          buildAuthDoctorHint: ({ provider, profileId }) =>
            provider === "demo" ? `Repair ${profileId}` : undefined,
          buildReplayPolicy,
          createEmbeddingProvider,
          createStreamFn,
          fetchUsageSnapshot,
          formatApiKey: (cred) =>
            cred.type === "oauth" ? JSON.stringify({ token: cred.access }) : "",
          id: DEMO_PROVIDER_ID,
          inspectToolSchemas,
          isBinaryThinking: () => true,
          isCacheTtlEligible: ({ modelId }) => modelId.startsWith("anthropic/"),
          isModernModelRef: ({ modelId }) => modelId.startsWith("gpt-5"),
          label: "Demo",
          normalizeConfig: ({ providerConfig }) => ({
            ...providerConfig,
            baseUrl: "https://normalized.example.com/v1",
          }),
          normalizeModelId: ({ modelId }) => modelId.replace("-legacy", ""),
          normalizeResolvedModel: ({ model }) => ({
            ...model,
            api: "openai-codex-responses",
          }),
          normalizeToolSchemas,
          normalizeTransport: ({ api, baseUrl }) => ({
            api,
            baseUrl: baseUrl ? `${baseUrl}/normalized` : undefined,
          }),
          prepareDynamicModel,
          prepareExtraParams: ({ extraParams }) => ({
            ...extraParams,
            transport: "auto",
          }),
          prepareRuntimeAuth,
          refreshOAuth,
          resolveConfigApiKey: () => "DEMO_PROFILE",
          resolveDefaultThinkingLevel: ({ reasoning }) => (reasoning ? "low" : "off"),
          resolveDynamicModel: () => MODEL,
          resolveExternalAuthProfiles: ({ store }): ProviderExternalAuthProfile[] =>
            store.profiles["demo:managed"]
              ? []
              : [
                  {
                    persistence: "runtime-only",
                    profileId: "demo:managed",
                    credential: {
                      type: "oauth",
                      provider: DEMO_PROVIDER_ID,
                      access: "external-access",
                      refresh: "external-refresh",
                      expires: Date.now() + 60_000,
                    },
                  },
                ],
          resolveReasoningOutputMode,
          resolveSyntheticAuth,
          resolveUsageAuth,
          sanitizeReplayHistory,
          shouldDeferSyntheticProfileAuth,
          supportsXHighThinking: ({ modelId }) => modelId === "gpt-5.4",
          validateReplayTurns,
          wrapStreamFn: ({ streamFn, model }) => {
            expect(model).toMatchObject(MODEL);
            return streamFn;
          },
        },
        {
          ...createOpenAiCatalogProviderPlugin({
            buildMissingAuthMessage: () =>
              'No API key found for provider "openai". Use openai-codex/gpt-5.4.',
            buildUnknownModelHint,
          }),
        } as ProviderPlugin,
      ]);

    expect(
      runProviderDynamicModel({
        context: createDemoRuntimeContext({
          modelRegistry: EMPTY_MODEL_REGISTRY,
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject(MODEL);

    expect(
      normalizeProviderModelIdWithPlugin({
        context: {
          modelId: "demo-model-legacy",
          provider: DEMO_PROVIDER_ID,
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBe("demo-model");

    expect(
      normalizeProviderTransportWithPlugin({
        context: {
          api: "openai-completions",
          baseUrl: "https://demo.example.com",
          provider: DEMO_PROVIDER_ID,
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).toEqual({
      api: "openai-completions",
      baseUrl: "https://demo.example.com/normalized",
    });

    expect(
      normalizeProviderConfigWithPlugin({
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            api: "openai-completions",
            baseUrl: "https://demo.example.com",
            models: [],
          },
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      baseUrl: "https://normalized.example.com/v1",
    });

    expect(
      applyProviderNativeStreamingUsageCompatWithPlugin({
        context: {
          provider: DEMO_PROVIDER_ID,
          providerConfig: {
            api: "openai-completions",
            baseUrl: "https://demo.example.com",
            models: [],
          },
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      compat: { supportsUsageInStreaming: true },
    });

    expect(
      resolveProviderConfigApiKeyWithPlugin({
        context: {
          env: { DEMO_PROFILE: "default" } as NodeJS.ProcessEnv,
          provider: DEMO_PROVIDER_ID,
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBe("DEMO_PROFILE");

    await prepareProviderDynamicModel({
      context: createDemoRuntimeContext({
        modelRegistry: EMPTY_MODEL_REGISTRY,
      }),
      provider: DEMO_PROVIDER_ID,
    });

    expect(
      resolveProviderReplayPolicyWithPlugin({
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      allowSyntheticToolResults: true,
      sanitizeMode: "full",
      toolCallIdMode: "strict9",
    });

    expect(
      resolveProviderReasoningOutputModeWithPlugin({
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBe("tagged");

    expect(
      prepareProviderExtraParams({
        context: createDemoRuntimeContext({
          extraParams: { temperature: 0.3 },
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      temperature: 0.3,
      transport: "auto",
    });

    expect(
      resolveProviderStreamFn({
        context: createDemoResolvedModelContext({}),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBeTypeOf("function");

    await expectResolvedMatches([
      {
        actual: () =>
          createProviderEmbeddingProvider({
            context: createDemoProviderContext({
              config: {} as never,
              model: "demo-embed",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          client: { token: "embed-token" },
          id: "demo",
          model: "demo-embed",
        },
      },
      {
        actual: () =>
          prepareProviderRuntimeAuth({
            context: createDemoResolvedModelContext({
              apiKey: "source-token",
              authMode: "api-key",
              env: process.env,
            }),
            env: process.env,
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          apiKey: "runtime-token",
          baseUrl: "https://runtime.example.com/v1",
          expiresAt: 123,
        },
      },
      {
        actual: () =>
          refreshProviderOAuthCredentialWithPlugin({
            context: createDemoProviderContext({
              access: "oauth-access",
              expires: Date.now() + 60_000,
              refresh: "oauth-refresh",
              type: "oauth",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          access: "refreshed-access-token",
        },
      },
      {
        actual: () =>
          resolveProviderUsageAuthWithPlugin({
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              resolveApiKeyFromConfigAndStore: () => "source-token",
              resolveOAuthToken: async () => null,
            }),
            env: process.env,
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          accountId: "usage-account",
          token: "usage-token",
        },
      },
      {
        actual: () =>
          resolveProviderUsageSnapshotWithPlugin({
            context: createDemoProviderContext({
              config: {} as never,
              env: process.env,
              fetchFn: vi.fn() as never,
              timeoutMs: 5_000,
              token: "usage-token",
            }),
            env: process.env,
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          provider: "zai",
          windows: [{ label: "Day", usedPercent: 25 }],
        },
      },
      {
        actual: () =>
          sanitizeProviderReplayHistoryWithPlugin({
            context: createDemoResolvedModelContext({
              messages: DEMO_REPLAY_MESSAGES,
              modelApi: MODEL.api,
              sessionId: "session-1",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          1: DEMO_SANITIZED_MESSAGE,
        },
      },
      {
        actual: () =>
          validateProviderReplayTurnsWithPlugin({
            context: createDemoResolvedModelContext({
              messages: DEMO_REPLAY_MESSAGES,
              modelApi: MODEL.api,
              sessionId: "session-1",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          0: DEMO_REPLAY_MESSAGES[0],
        },
      },
    ]);

    expect(
      wrapProviderStreamFn({
        context: createDemoResolvedModelContext({
          streamFn: vi.fn(),
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBeTypeOf("function");

    expect(
      normalizeProviderToolSchemasWithPlugin({
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
          tools: [DEMO_TOOL],
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toEqual([DEMO_TOOL]);

    expect(
      inspectProviderToolSchemasWithPlugin({
        context: createDemoResolvedModelContext({
          modelApi: MODEL.api,
          tools: [DEMO_TOOL],
        }),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toEqual([]);

    expect(
      normalizeProviderResolvedModelWithPlugin({
        context: createDemoResolvedModelContext({}),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toMatchObject({
      ...MODEL,
      api: "openai-codex-responses",
    });

    expect(
      applyProviderResolvedModelCompatWithPlugins({
        context: createDemoResolvedModelContext({}),
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBeUndefined();

    expect(
      formatProviderAuthProfileApiKeyWithPlugin({
        context: {
          access: "oauth-access",
          expires: Date.now() + 60_000,
          provider: DEMO_PROVIDER_ID,
          refresh: "oauth-refresh",
          type: "oauth",
        },
        provider: DEMO_PROVIDER_ID,
      }),
    ).toBe('{"token":"oauth-access"}');

    await expectResolvedAsyncValues([
      {
        actual: () =>
          buildProviderAuthDoctorHintWithPlugin({
            context: createDemoProviderContext({
              profileId: "demo:default",
              store: { profiles: {}, version: 1 },
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: "Repair demo:default",
      },
    ]);

    expectResolvedValues([
      {
        actual: () =>
          resolveProviderCacheTtlEligibility({
            context: createDemoProviderContext({
              modelId: "anthropic/claude-sonnet-4-6",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderBinaryThinking({
            context: createDemoProviderContext({
              modelId: "glm-5",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderXHighThinking({
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveProviderDefaultThinkingLevel({
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
              reasoning: true,
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: "low",
      },
      {
        actual: () =>
          resolveProviderModernModelRef({
            context: createDemoProviderContext({
              modelId: "gpt-5.4",
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: true,
      },
      {
        actual: () =>
          resolveExternalAuthProfilesWithPlugins({
            context: {
              env: process.env,
              store: { profiles: {}, version: 1 },
            },
            env: process.env,
          }),
        expected: [
          {
            credential: {
              access: "external-access",
              expires: expect.any(Number),
              provider: DEMO_PROVIDER_ID,
              refresh: "external-refresh",
              type: "oauth",
            },
            persistence: "runtime-only",
            profileId: "demo:managed",
          },
        ],
      },
      {
        actual: () =>
          resolveProviderSyntheticAuthWithPlugin({
            context: createDemoProviderContext({
              providerConfig: {
                api: "openai-completions",
                baseUrl: "http://localhost:11434",
                models: [],
              },
            }),
            provider: DEMO_PROVIDER_ID,
          }),
        expected: {
          apiKey: "demo-local",
          mode: "api-key",
          source: "models.providers.demo (synthetic local key)",
        },
      },
      {
        actual: () =>
          shouldDeferProviderSyntheticProfileAuthWithPlugin({
            context: {
              provider: DEMO_PROVIDER_ID,
              resolvedApiKey: "demo-local",
            },
            provider: DEMO_PROVIDER_ID,
          }),
        expected: true,
      },
      {
        actual: () =>
          buildProviderUnknownModelHintWithPlugin({
            context: {
              env: process.env,
              modelId: "gpt-5.4",
              provider: "openai",
            },
            env: process.env,
            provider: "openai",
          }),
        expected: "Use demo setup for gpt-5.4",
      },
    ]);

    expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin);
    expectCodexBuiltInSuppression(resolveProviderBuiltInModelSuppression);
    await expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins);

    expectCalledOnce(
      buildReplayPolicy,
      prepareDynamicModel,
      sanitizeReplayHistory,
      validateReplayTurns,
      normalizeToolSchemas,
      inspectToolSchemas,
      resolveReasoningOutputMode,
      refreshOAuth,
      resolveSyntheticAuth,
      shouldDeferSyntheticProfileAuth,
      buildUnknownModelHint,
      prepareRuntimeAuth,
      resolveUsageAuth,
      fetchUsageSnapshot,
    );
  });

  it("merges compat contributions from owner and foreign provider plugins", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          auth: [],
          contributeResolvedModelCompat: () => ({ supportsStrictMode: true }),
          id: "openrouter",
          label: "OpenRouter",
        },
        {
          auth: [],
          contributeResolvedModelCompat: ({ modelId }) =>
            modelId.startsWith("mistralai/") ? { supportsStore: false } : undefined,
          id: "mistral",
          label: "Mistral",
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      applyProviderResolvedModelCompatWithPlugins({
        context: createDemoResolvedModelContext({
          model: {
            ...MODEL,
            compat: { supportsDeveloperRole: false },
            id: "mistralai/mistral-small-3.2-24b-instruct",
            provider: "openrouter",
          },
          modelId: "mistralai/mistral-small-3.2-24b-instruct",
          provider: "openrouter",
        }),
        provider: "openrouter",
      }),
    ).toMatchObject({
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsStrictMode: true,
      },
    });
  });

  it("applies foreign transport normalization for custom provider hosts", () => {
    resolvePluginProvidersMock.mockImplementation((params) => {
      const onlyPluginIds = params.onlyPluginIds ?? [];
      const plugins: ProviderPlugin[] = [
        {
          auth: [],
          id: "openai",
          label: "OpenAI",
          normalizeTransport: ({ provider, api, baseUrl }) =>
            provider === "custom-openai" &&
            api === "openai-completions" &&
            baseUrl === "https://api.openai.com/v1"
              ? { api: "openai-responses", baseUrl }
              : undefined,
        },
      ];
      return onlyPluginIds.length > 0
        ? plugins.filter((plugin) => onlyPluginIds.includes(plugin.id))
        : plugins;
    });

    expect(
      applyProviderResolvedTransportWithPlugin({
        context: createDemoResolvedModelContext({
          model: {
            ...MODEL,
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
            id: "gpt-5.4",
            provider: "custom-openai",
          },
          modelId: "gpt-5.4",
          provider: "custom-openai",
        }),
        provider: "custom-openai",
      }),
    ).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      id: "gpt-5.4",
      provider: "custom-openai",
    });
  });

  it("resolves bundled catalog hooks through provider plugins", async () => {
    resolveCatalogHookProviderPluginIdsMock.mockReturnValue(["openai"]);
    resolvePluginProvidersMock.mockImplementation((params?: { onlyPluginIds?: string[] }) => {
      const onlyPluginIds = params?.onlyPluginIds;
      if (!onlyPluginIds || !onlyPluginIds.includes("openai")) {
        return [];
      }
      return [createOpenAiCatalogProviderPlugin()];
    });

    expect(
      resolveProviderBuiltInModelSuppression({
        context: {
          env: process.env,
          modelId: "gpt-5.3-codex-spark",
          provider: "openai",
        },
        env: process.env,
      }),
    ).toMatchObject({
      suppress: true,
    });

    await expect(
      augmentModelCatalogWithProviderPlugins({
        context: {
          entries: [
            { id: "gpt-5.4", name: "GPT-5.2", provider: "openai" },
            { id: "gpt-5.4-pro", name: "GPT-5.2 Pro", provider: "openai" },
            { id: "gpt-5.4-mini", name: "GPT-5 mini", provider: "openai" },
            { id: "gpt-5.4-nano", name: "GPT-5 nano", provider: "openai" },
            { id: "gpt-5.4", name: "GPT-5.4", provider: "openai-codex" },
          ],
          env: process.env,
        },
        env: process.env,
      }),
    ).resolves.toEqual(expectedAugmentedOpenaiCodexCatalogEntries);

    expect(resolvePluginProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        cache: false,
        onlyPluginIds: ["openai"],
      }),
    );
  });

  it("does not stack-overflow when provider hook resolution reenters the same plugin load", () => {
    let providerLoadInFlight = false;
    isPluginProvidersLoadInFlightMock.mockImplementation(() => providerLoadInFlight);
    resolvePluginProvidersMock.mockImplementation(() => {
      providerLoadInFlight = true;
      try {
        const reentrantResult = normalizeProviderConfigWithPlugin({
          context: {
            provider: "reentrant-provider",
            providerConfig: {
              api: "openai-completions",
              baseUrl: "https://example.com",
              models: [],
            },
          },
          provider: "reentrant-provider",
        });
        expect(reentrantResult).toBeUndefined();
        return [];
      } finally {
        providerLoadInFlight = false;
      }
    });

    const result = normalizeProviderConfigWithPlugin({
      context: {
        provider: "demo",
        providerConfig: { api: "openai-completions", baseUrl: "https://example.com", models: [] },
      },
      provider: "demo",
    });

    expect(result).toBeUndefined();
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("keeps cached provider hook results available during a nested provider load", () => {
    const cachedNormalizedConfig: ModelProviderConfig = {
      api: "openai-completions",
      baseUrl: "https://cached.example.com",
      models: [],
    };
    let providerLoadInFlight = false;
    isPluginProvidersLoadInFlightMock.mockImplementation(() => providerLoadInFlight);
    resolvePluginProvidersMock.mockImplementation((params) => {
      const providerRef = params?.providerRefs?.[0];
      if (providerRef === "cached-provider") {
        return [
          {
            auth: [],
            id: "cached-provider",
            label: "Cached Provider",
            normalizeConfig: () => cachedNormalizedConfig,
          },
        ];
      }
      providerLoadInFlight = true;
      try {
        const reentrantResult = normalizeProviderConfigWithPlugin({
          context: {
            provider: "cached-provider",
            providerConfig: {
              api: "openai-completions",
              baseUrl: "https://example.com",
              models: [],
            },
          },
          provider: "cached-provider",
        });
        expect(reentrantResult).toBe(cachedNormalizedConfig);
        return [];
      } finally {
        providerLoadInFlight = false;
      }
    });

    expect(
      normalizeProviderConfigWithPlugin({
        context: {
          provider: "cached-provider",
          providerConfig: { api: "openai-completions", baseUrl: "https://example.com", models: [] },
        },
        provider: "cached-provider",
      }),
    ).toBe(cachedNormalizedConfig);

    expect(
      normalizeProviderConfigWithPlugin({
        context: {
          provider: "outer-provider",
          providerConfig: {
            api: "openai-completions",
            baseUrl: "https://outer.example.com",
            models: [],
          },
        },
        provider: "outer-provider",
      }),
    ).toBeUndefined();

    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(3);
  });
});
