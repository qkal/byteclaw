import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AuthProfileStore, ensureAuthProfileStore } from "../agents/auth-profiles.js";
import {
  type OpenClawConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
} from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

type WebProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "firecrawl";

const { resolveExternalAuthProfilesWithPluginsMock, resolvePluginWebSearchProvidersMock } =
  vi.hoisted(() => ({
    resolveExternalAuthProfilesWithPluginsMock: vi.fn(() => []),
    resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
  }));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: resolveExternalAuthProfilesWithPluginsMock,
}));

const OPENAI_ENV_KEY_REF = {
  id: "OPENAI_API_KEY",
  provider: "default",
  source: "env",
} as const;

type SecretsRuntimeEnvSnapshot = ReturnType<typeof captureEnv>;

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function loadAuthStoreWithProfiles(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return {
    profiles,
    version: 1,
  };
}

function beginSecretsRuntimeIsolationForTest(): SecretsRuntimeEnvSnapshot {
  const envSnapshot = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE",
    "OPENCLAW_VERSION",
  ]);
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
  delete process.env.OPENCLAW_VERSION;
  return envSnapshot;
}

function endSecretsRuntimeIsolationForTest(envSnapshot: SecretsRuntimeEnvSnapshot) {
  vi.restoreAllMocks();
  envSnapshot.restore();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
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

describe("secrets runtime snapshot core lanes", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
    resolveExternalAuthProfilesWithPluginsMock.mockReset();
    resolveExternalAuthProfilesWithPluginsMock.mockReturnValue([]);
    resolvePluginWebSearchProvidersMock.mockReset();
    resolvePluginWebSearchProvidersMock.mockReturnValue(buildTestWebSearchProviders());
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  async function prepareOpenAiRuntimeSnapshot(params?: { includeAuthStoreRefs?: boolean }) {
    return withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_VERSION: undefined,
      },
      async () =>
        prepareSecretsRuntimeSnapshot({
          agentDirs: ["/tmp/openclaw-agent-main"],
          config: asConfig({
            models: {
              providers: {
                openai: {
                  apiKey: OPENAI_ENV_KEY_REF,
                  baseUrl: "https://api.openai.com/v1",
                  models: [],
                },
              },
            },
          }),
          env: { OPENAI_API_KEY: "sk-runtime" },
          includeAuthStoreRefs: params?.includeAuthStoreRefs,
          loadAuthStore: () =>
            loadAuthStoreWithProfiles({
              "openai:default": {
                keyRef: OPENAI_ENV_KEY_REF,
                provider: "openai",
                type: "api_key",
              },
            }),
          loadablePluginOrigins: new Map(),
        }),
    );
  }

  it("resolves config env refs for core config surfaces", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
              baseUrl: "https://api.openai.com/v1",
              headers: {
                Authorization: {
                  id: "OPENAI_PROVIDER_AUTH_HEADER",
                  provider: "default",
                  source: "env",
                },
              },
              models: [],
            },
          },
        },
        skills: {
          entries: {
            "review-pr": {
              apiKey: { id: "REVIEW_SKILL_API_KEY", provider: "default", source: "env" },
              enabled: true,
            },
          },
        },
      }),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
        OPENAI_PROVIDER_AUTH_HEADER: "Bearer sk-env-header",
        REVIEW_SKILL_API_KEY: "sk-skill-ref",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("sk-env-openai");
    expect(snapshot.config.models?.providers?.openai?.headers?.Authorization).toBe(
      "Bearer sk-env-header",
    );
    expect(snapshot.config.skills?.entries?.["review-pr"]?.apiKey).toBe("sk-skill-ref");
  });

  it("resolves env refs for memory, talk, and gateway surfaces", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        agents: {
          defaults: {
            memorySearch: {
              remote: {
                apiKey: { id: "MEMORY_REMOTE_API_KEY", provider: "default", source: "env" },
              },
            },
          },
        },
        gateway: {
          mode: "remote",
          remote: {
            password: { id: "REMOTE_GATEWAY_PASSWORD", provider: "default", source: "env" },
            token: { id: "REMOTE_GATEWAY_TOKEN", provider: "default", source: "env" },
            url: "wss://gateway.example",
          },
        },
        talk: {
          providers: {
            "acme-speech": {
              apiKey: { id: "TALK_PROVIDER_API_KEY", provider: "default", source: "env" },
            },
          },
        },
      }),
      env: {
        MEMORY_REMOTE_API_KEY: "mem-ref-key",
        REMOTE_GATEWAY_PASSWORD: "remote-password-ref",
        REMOTE_GATEWAY_TOKEN: "remote-token-ref",
        TALK_PROVIDER_API_KEY: "talk-provider-ref-key",
      },
      includeAuthStoreRefs: false,
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.config.agents?.defaults?.memorySearch?.remote?.apiKey).toBe("mem-ref-key");
    expect((snapshot.config.talk as { apiKey?: unknown } | undefined)?.apiKey).toBeUndefined();
    expect(snapshot.config.talk?.providers?.["acme-speech"]?.apiKey).toBe("talk-provider-ref-key");
    expect(snapshot.config.gateway?.remote?.token).toBe("remote-token-ref");
    expect(snapshot.config.gateway?.remote?.password).toBe("remote-password-ref");
  });

  it("resolves env-backed auth profile SecretRefs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({}),
      env: {
        GITHUB_TOKEN: "ghp-env-token",
        OPENAI_API_KEY: "sk-env-openai",
      },
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "github-copilot:default": {
            provider: "github-copilot",
            token: "old-gh",
            tokenRef: { id: "GITHUB_TOKEN", provider: "default", source: "env" },
            type: "token",
          },
          "openai:default": {
            key: "old-openai",
            keyRef: OPENAI_ENV_KEY_REF,
            provider: "openai",
            type: "api_key",
          },
        }),
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining([
        "/tmp/openclaw-agent-main.auth-profiles.openai:default.key",
        "/tmp/openclaw-agent-main.auth-profiles.github-copilot:default.token",
      ]),
    );
    expect(snapshot.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
      key: "sk-env-openai",
      type: "api_key",
    });
    expect(snapshot.authStores[0]?.store.profiles["github-copilot:default"]).toMatchObject({
      token: "ghp-env-token",
      type: "token",
    });
  });

  it("resolves inline placeholder auth profiles to env refs", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({}),
      env: {
        OPENAI_API_KEY: "sk-env-openai",
      },
      loadAuthStore: () =>
        loadAuthStoreWithProfiles({
          "openai:inline": {
            key: "${OPENAI_API_KEY}",
            provider: "openai",
            type: "api_key",
          },
        }),
      loadablePluginOrigins: new Map(),
    });

    expect(snapshot.authStores[0]?.store.profiles["openai:inline"]).toMatchObject({
      key: "sk-env-openai",
      type: "api_key",
    });
    const inlineProfile = snapshot.authStores[0]?.store.profiles["openai:inline"] as
      | Record<string, unknown>
      | undefined;
    expect(inlineProfile?.keyRef).toEqual({
      id: "OPENAI_API_KEY",
      provider: "default",
      source: "env",
    });
  });

  it("activates runtime snapshots for loadConfig", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot({ includeAuthStoreRefs: false });
    activateSecretsRuntimeSnapshot(prepared);

    expect(loadConfig().models?.providers?.openai?.apiKey).toBe("sk-runtime");
  });

  it("activates runtime snapshots for ensureAuthProfileStore", async () => {
    const prepared = await prepareOpenAiRuntimeSnapshot();
    activateSecretsRuntimeSnapshot(prepared);

    expect(
      ensureAuthProfileStore("/tmp/openclaw-agent-main").profiles["openai:default"],
    ).toMatchObject({
      key: "sk-runtime",
      type: "api_key",
    });
  });
});
