import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const matrixSecrets = loadBundledChannelSecretContractApi("matrix");
if (!matrixSecrets?.collectRuntimeConfigAssignments) {
  throw new Error("Missing Matrix secret contract api");
}

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "matrix"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: matrixSecrets.collectRuntimeConfigAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "matrix"
      ? {
          collectRuntimeConfigAssignments: matrixSecrets.collectRuntimeConfigAssignments,
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

describe("secrets runtime snapshot matrix access token", () => {
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

  it("resolves top-level Matrix accessToken refs even when named accounts exist", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          matrix: {
            accessToken: {
              id: "MATRIX_ACCESS_TOKEN",
              provider: "default",
              source: "env",
            },
            accounts: {
              ops: {
                accessToken: "ops-token",
                homeserver: "https://matrix.example.org",
              },
            },
          },
        },
      }),
      env: {
        MATRIX_ACCESS_TOKEN: "default-matrix-token",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.channels?.matrix?.accessToken).toBe("default-matrix-token");
  });
});
