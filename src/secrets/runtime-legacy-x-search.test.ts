import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "telegram"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: () => {},
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "telegram"
      ? {
          collectRuntimeConfigAssignments: () => {},
        }
      : undefined,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function createTestProvider(params: {
  id: WebProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  const readSearchConfigKey = (searchConfig?: Record<string, unknown>): unknown => {
    const providerConfig =
      searchConfig?.[params.id] && typeof searchConfig[params.id] === "object"
        ? (searchConfig[params.id] as { apiKey?: unknown })
        : undefined;
    return providerConfig?.apiKey ?? searchConfig?.apiKey;
  };
  return {
    autoDetectOrder: params.order,
    createTool: () => null,
    credentialPath,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    getConfiguredCredentialValue: (config) =>
      (config?.plugins?.entries?.[params.pluginId]?.config as { webSearch?: { apiKey?: unknown } })
        ?.webSearch?.apiKey,
    getCredentialValue: readSearchConfigKey,
    hint: `${params.id} test provider`,
    id: params.id,
    inactiveSecretPaths: [credentialPath],
    label: params.id,
    placeholder: `${params.id}-...`,
    pluginId: params.pluginId,
    resolveRuntimeMetadata:
      params.id === "perplexity"
        ? () => ({
            perplexityTransport: "search_api" as const,
          })
        : undefined,
    setConfiguredCredentialValue: (configTarget, value) => {
      const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
      const entries = (plugins.entries ??= {});
      const entry = (entries[params.pluginId] ??= {}) as { config?: Record<string, unknown> };
      const config = (entry.config ??= {});
      const webSearch = (config.webSearch ??= {}) as { apiKey?: unknown };
      webSearch.apiKey = value;
    },
    setCredentialValue: (searchConfigTarget, value) => {
      const providerConfig =
        params.id === "brave" || params.id === "firecrawl"
          ? searchConfigTarget
          : ((searchConfigTarget[params.id] ??= {}) as { apiKey?: unknown });
      providerConfig.apiKey = value;
    },
    signupUrl: `https://example.com/${params.id}`,
  };
}

function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider({ id: "brave", order: 10, pluginId: "brave" }),
    createTestProvider({ id: "gemini", order: 20, pluginId: "google" }),
    createTestProvider({ id: "grok", order: 30, pluginId: "xai" }),
    createTestProvider({ id: "kimi", order: 40, pluginId: "moonshot" }),
    createTestProvider({ id: "perplexity", order: 50, pluginId: "perplexity" }),
    createTestProvider({ id: "firecrawl", order: 60, pluginId: "firecrawl" }),
  ];
}

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;
const EMPTY_LOADABLE_PLUGIN_ORIGINS = new Map();

describe("secrets runtime snapshot legacy x_search", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({ clearSecretsRuntimeSnapshot, prepareSecretsRuntimeSnapshot } = await import("./runtime.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("keeps legacy x_search SecretRefs in place until doctor repairs them", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              apiKey: { id: "X_SEARCH_KEY_REF", provider: "default", source: "env" },
              enabled: true,
              model: "grok-4-1-fast",
            },
          },
        },
      }),
      env: {
        X_SEARCH_KEY_REF: "xai-runtime-key",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      apiKey: "xai-runtime-key",
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("still resolves legacy x_search auth in place even when unrelated legacy config is present", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        session: {
          threadBindings: {
            ttlHours: 24,
          },
        },
        tools: {
          web: {
            x_search: {
              apiKey: { id: "X_SEARCH_KEY_REF", provider: "default", source: "env" },
              enabled: true,
            },
          },
        },
      }),
      env: {
        X_SEARCH_KEY_REF: "xai-runtime-key-invalid-config",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      apiKey: "xai-runtime-key-invalid-config",
      enabled: true,
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("does not force-enable xai at runtime for knob-only x_search config", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            x_search: {
              enabled: true,
              model: "grok-4-1-fast",
            },
          },
        },
      }),
      env: {},
      includeAuthStoreRefs: false,
      loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
    });

    expect((snapshot.config.tools?.web as Record<string, unknown> | undefined)?.x_search).toEqual({
      enabled: true,
      model: "grok-4-1-fast",
    });
    expect(snapshot.config.plugins?.entries?.xai).toBeUndefined();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });
});
