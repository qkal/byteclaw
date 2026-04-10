import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
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

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("secrets runtime snapshot request secret refs", () => {
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

  it("can skip auth-profile SecretRef resolution when includeAuthStoreRefs is false", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_SECRET_${Date.now()}`;
    delete process.env[missingEnvVar];

    const loadAuthStore = () =>
      loadAuthStoreWithProfiles({
        "custom:token": {
          provider: "custom",
          tokenRef: { id: missingEnvVar, provider: "default", source: "env" },
          type: "token",
        },
      });

    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({}),
        env: {},
        loadAuthStore,
      }),
    ).rejects.toThrow(`Environment variable "${missingEnvVar}" is missing or empty.`);

    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({}),
      env: {},
      includeAuthStoreRefs: false,
      loadAuthStore,
    });

    expect(snapshot.authStores).toEqual([]);
  });

  it("resolves model provider request secret refs for headers, auth, and tls material", async () => {
    const config = asConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            request: {
              auth: {
                mode: "authorization-bearer",
                token: { id: "OPENAI_PROVIDER_TOKEN", provider: "default", source: "env" },
              },
              headers: {
                "X-Tenant": { id: "OPENAI_PROVIDER_TENANT", provider: "default", source: "env" },
              },
              proxy: {
                mode: "explicit-proxy",
                tls: {
                  ca: { id: "OPENAI_PROVIDER_PROXY_CA", provider: "default", source: "env" },
                },
                url: "http://proxy.example:8080",
              },
              tls: {
                cert: { id: "OPENAI_PROVIDER_CERT", provider: "default", source: "env" },
                key: { id: "OPENAI_PROVIDER_KEY", provider: "default", source: "env" },
              },
            },
          },
        },
      },
    });

    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config,
      env: {
        OPENAI_PROVIDER_TENANT: "tenant-acme",
        OPENAI_PROVIDER_TOKEN: "sk-provider-runtime", // Pragma: allowlist secret
        OPENAI_PROVIDER_PROXY_CA: "proxy-ca",
        OPENAI_PROVIDER_CERT: "client-cert",
        OPENAI_PROVIDER_KEY: "client-key",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.models?.providers?.openai?.request).toEqual({
      auth: {
        mode: "authorization-bearer",
        token: "sk-provider-runtime",
      },
      headers: {
        "X-Tenant": "tenant-acme",
      },
      proxy: {
        mode: "explicit-proxy",
        tls: {
          ca: "proxy-ca",
        },
        url: "http://proxy.example:8080",
      },
      tls: {
        cert: "client-cert",
        key: "client-key",
      },
    });
  });

  it("resolves media request secret refs for provider headers, auth, and tls material", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        tools: {
          media: {
            audio: {
              enabled: true,
              models: [
                {
                  provider: "deepgram",
                  request: {
                    auth: {
                      mode: "header",
                      headerName: "x-api-key",
                      value: { source: "env", provider: "default", id: "MEDIA_AUDIO_MODEL_KEY" },
                    },
                    proxy: {
                      mode: "explicit-proxy",
                      url: "http://proxy.example:8080",
                      tls: {
                        ca: { source: "env", provider: "default", id: "MEDIA_AUDIO_PROXY_CA" },
                      },
                    },
                  },
                },
              ],
              request: {
                auth: {
                  mode: "authorization-bearer",
                  token: { id: "MEDIA_AUDIO_TOKEN", provider: "default", source: "env" },
                },
                headers: {
                  "X-Tenant": { id: "MEDIA_AUDIO_TENANT", provider: "default", source: "env" },
                },
                tls: {
                  cert: { id: "MEDIA_AUDIO_CERT", provider: "default", source: "env" },
                },
              },
            },
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe",
                capabilities: ["audio"],
                request: {
                  headers: {
                    "X-Shared-Tenant": {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_TENANT",
                    },
                  },
                  auth: {
                    mode: "header",
                    headerName: "x-shared-key",
                    value: {
                      source: "env",
                      provider: "default",
                      id: "MEDIA_SHARED_MODEL_KEY",
                    },
                  },
                },
              },
            ],
          },
        },
      }),
      env: {
        MEDIA_SHARED_TENANT: "tenant-shared",
        MEDIA_SHARED_MODEL_KEY: "shared-model-key", // Pragma: allowlist secret
        MEDIA_AUDIO_TENANT: "tenant-acme",
        MEDIA_AUDIO_TOKEN: "audio-token", // Pragma: allowlist secret
        MEDIA_AUDIO_CERT: "client-cert",
        MEDIA_AUDIO_MODEL_KEY: "model-key", // Pragma: allowlist secret
        MEDIA_AUDIO_PROXY_CA: "proxy-ca",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.tools?.media?.audio?.request?.headers?.["X-Tenant"]).toBe("tenant-acme");
    expect(snapshot.config.tools?.media?.audio?.request?.auth).toEqual({
      mode: "authorization-bearer",
      token: "audio-token",
    });
    expect(snapshot.config.tools?.media?.audio?.request?.tls).toEqual({
      cert: "client-cert",
    });
    expect(snapshot.config.tools?.media?.models?.[0]?.request).toEqual({
      auth: {
        headerName: "x-shared-key",
        mode: "header",
        value: "shared-model-key",
      },
      headers: {
        "X-Shared-Tenant": "tenant-shared",
      },
    });
    expect(snapshot.config.tools?.media?.audio?.models?.[0]?.request).toEqual({
      auth: {
        headerName: "x-api-key",
        mode: "header",
        value: "model-key",
      },
      proxy: {
        mode: "explicit-proxy",
        tls: {
          ca: "proxy-ca",
        },
        url: "http://proxy.example:8080",
      },
    });
  });
});
