import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import {
  type WebSearchTestProviderParams,
  createWebSearchTestProvider,
} from "../test-utils/web-provider-runtime.test-helpers.js";

interface TestPluginWebSearchConfig {
  webSearch?: {
    apiKey?: unknown;
  };
}

const { resolvePluginWebSearchProvidersMock, resolveRuntimeWebSearchProvidersMock } = vi.hoisted(
  () => ({
    resolvePluginWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
    resolveRuntimeWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
  }),
);

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
  resolveRuntimeWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
}));

function createCustomSearchTool() {
  return {
    description: "custom",
    execute: async (args: Record<string, unknown>) => ({ ...args, ok: true }),
    parameters: {},
  };
}

function getCustomSearchApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.["custom-search"]?.config as
    | TestPluginWebSearchConfig
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function createCustomSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    autoDetectOrder: 1,
    createTool: createCustomSearchTool,
    credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
    getConfiguredCredentialValue: getCustomSearchApiKey,
    id: "custom",
    pluginId: "custom-search",
    ...overrides,
  });
}

function createCustomSearchConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "custom-search": {
          config: {
            webSearch: {
              apiKey,
            },
          },
          enabled: true,
        },
      },
    },
  };
}

function createGoogleSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    autoDetectOrder: 1,
    credentialPath: "tools.web.search.google.apiKey",
    getCredentialValue: () => "configured",
    id: "google",
    pluginId: "google",
    ...overrides,
  });
}

function createDuckDuckGoSearchProvider(
  overrides: Partial<WebSearchTestProviderParams> = {},
): PluginWebSearchProviderEntry {
  return createWebSearchTestProvider({
    autoDetectOrder: 100,
    credentialPath: "",
    id: "duckduckgo",
    pluginId: "duckduckgo",
    requiresCredential: false,
    ...overrides,
  });
}

describe("web search runtime", () => {
  let runWebSearch: typeof import("./runtime.js").runWebSearch;
  let activateSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").activateSecretsRuntimeSnapshot;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({ runWebSearch } = await import("./runtime.js"));
    ({ activateSecretsRuntimeSnapshot, clearSecretsRuntimeSnapshot } =
      await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockReset();
    resolveRuntimeWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("executes searches through the active plugin registry", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({
        credentialPath: "tools.web.search.custom.apiKey",
        getCredentialValue: () => "configured",
      }),
    ]);

    await expect(
      runWebSearch({
        args: { query: "hello" },
        config: {},
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { ok: true, query: "hello" },
    });
  });

  it("auto-detects a provider from canonical plugin-owned credentials", async () => {
    const provider = createCustomSearchProvider();
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    const config = createCustomSearchConfig("custom-config-key");

    await expect(
      runWebSearch({
        args: { query: "hello" },
        config,
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { ok: true, query: "hello" },
    });
  });

  it("treats non-env SecretRefs as configured credentials for provider auto-detect", async () => {
    const provider = createCustomSearchProvider();
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([provider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([provider]);

    const config = createCustomSearchConfig({
      id: "/providers/custom-search/apiKey",
      provider: "vault",
      source: "file",
    });

    await expect(
      runWebSearch({
        args: { query: "hello" },
        config,
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { ok: true, query: "hello" },
    });
  });

  it("falls back to a keyless provider when no credentials are available", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createDuckDuckGoSearchProvider({
        getCredentialValue: () => "duckduckgo-no-key-needed",
      }),
    ]);

    await expect(
      runWebSearch({
        args: { query: "fallback" },
        config: {},
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { provider: "duckduckgo", query: "fallback" },
    });
  });

  it("prefers the active runtime-selected provider when callers omit runtime metadata", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createWebSearchTestProvider({
        autoDetectOrder: 1,
        createTool: ({ runtimeMetadata }) => ({
          description: "alpha",
          execute: async (args) => ({
            ...args,
            provider: "alpha",
            runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
          }),
          parameters: {},
        }),
        credentialPath: "tools.web.search.alpha.apiKey",
        getCredentialValue: () => "alpha-configured",
        id: "alpha",
        pluginId: "alpha-search",
      }),
      createWebSearchTestProvider({
        autoDetectOrder: 2,
        createTool: ({ runtimeMetadata }) => ({
          description: "beta",
          execute: async (args) => ({
            ...args,
            provider: "beta",
            runtimeSelectedProvider: runtimeMetadata?.selectedProvider,
          }),
          parameters: {},
        }),
        credentialPath: "tools.web.search.beta.apiKey",
        getCredentialValue: () => "beta-configured",
        id: "beta",
        pluginId: "beta-search",
      }),
    ]);

    activateSecretsRuntimeSnapshot({
      authStores: [],
      config: {},
      sourceConfig: {},
      warnings: [],
      webTools: {
        diagnostics: [],
        fetch: {
          diagnostics: [],
          providerSource: "none",
        },
        search: {
          diagnostics: [],
          providerSource: "auto-detect",
          selectedProvider: "beta",
        },
      },
    });

    await expect(
      runWebSearch({
        args: { query: "runtime" },
        config: {},
      }),
    ).resolves.toEqual({
      provider: "beta",
      result: { provider: "beta", query: "runtime", runtimeSelectedProvider: "beta" },
    });
  });

  it("falls back to another provider when auto-selected search execution fails", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          execute: async () => {
            throw new Error("google aborted");
          },
          parameters: {},
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        args: { query: "fallback" },
        config: {},
      }),
    ).resolves.toEqual({
      provider: "duckduckgo",
      result: { provider: "duckduckgo", query: "fallback" },
    });
  });

  it("does not prebuild fallback provider tools before attempting the selected provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider(),
      createWebSearchTestProvider({
        autoDetectOrder: 100,
        createTool: () => {
          throw new Error("fallback createTool exploded");
        },
        credentialPath: "",
        id: "broken-fallback",
        pluginId: "broken-fallback",
        requiresCredential: false,
      }),
    ]);

    await expect(
      runWebSearch({
        args: { query: "selected-first" },
        config: {},
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { provider: "google", query: "selected-first" },
    });
  });

  it("does not fall back when the provider came from explicit config selection", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          execute: async () => {
            throw new Error("google aborted");
          },
          parameters: {},
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        args: { query: "configured" },
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
              },
            },
          },
        },
      }),
    ).rejects.toThrow("google aborted");
  });

  it("does not fall back when the caller explicitly selects a provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => ({
          description: "google",
          execute: async () => {
            throw new Error("google aborted");
          },
          parameters: {},
        }),
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        args: { query: "explicit" },
        config: {},
        providerId: "google",
      }),
    ).rejects.toThrow("google aborted");
  });

  it("fails fast when an explicit provider cannot create a tool", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => null,
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        args: { query: "explicit-null-tool" },
        config: {},
        providerId: "google",
      }),
    ).rejects.toThrow('web_search provider "google" is not available.');
  });

  it("fails fast when the caller explicitly selects an unknown provider", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider(),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        args: { query: "explicit-missing" },
        config: {},
        providerId: "missing-id",
      }),
    ).rejects.toThrow('Unknown web_search provider "missing-id".');
  });

  it("still falls back when config names an unknown provider id", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => {
          throw new Error("google aborted");
        },
      }),
      createDuckDuckGoSearchProvider(),
    ]);

    await expect(
      runWebSearch({
        args: { query: "config-typo" },
        config: {
          tools: {
            web: {
              search: {
                provider: "missing-id",
              },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      provider: "duckduckgo",
      result: expect.objectContaining({
        provider: "duckduckgo",
        query: "config-typo",
      }),
    });
  });

  it("honors preferRuntimeProviders during execution", async () => {
    const configuredProvider = createGoogleSearchProvider();
    const runtimeProvider = createWebSearchTestProvider({
      autoDetectOrder: 0,
      credentialPath: "",
      id: "runtime-search",
      pluginId: "runtime-search",
      requiresCredential: false,
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([configuredProvider, runtimeProvider]);
    resolvePluginWebSearchProvidersMock.mockReturnValue([configuredProvider]);

    await expect(
      runWebSearch({
        args: { query: "prefer-config" },
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
              },
            },
          },
        },
        preferRuntimeProviders: false,
        runtimeWebSearch: {
          diagnostics: [],
          providerConfigured: "runtime-search",
          providerSource: "configured",
          selectedProvider: "runtime-search",
        },
      }),
    ).resolves.toEqual({
      provider: "google",
      result: { provider: "google", query: "prefer-config" },
    });
  });

  it("returns a clear error when every fallback-capable provider is unavailable", async () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createGoogleSearchProvider({
        createTool: () => null,
      }),
      createDuckDuckGoSearchProvider({
        createTool: () => null,
      }),
    ]);

    await expect(
      runWebSearch({
        args: { query: "all-null-tools" },
        config: {},
      }),
    ).rejects.toThrow("web_search is enabled but no provider is currently available.");
  });
});
