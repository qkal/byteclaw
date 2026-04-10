import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => [
    {
      autoDetectOrder: 20,
      createTool: () => null,
      credentialPath: "plugins.entries.google.config.webSearch.apiKey",
      envVars: ["GEMINI_API_KEY"],
      getConfiguredCredentialValue: (config) =>
        (config?.plugins?.entries?.google?.config as { webSearch?: { apiKey?: unknown } })
          ?.webSearch?.apiKey,
      getCredentialValue: (searchConfig) => searchConfig?.apiKey,
      hint: "gemini test provider",
      id: "gemini",
      inactiveSecretPaths: ["plugins.entries.google.config.webSearch.apiKey"],
      label: "gemini",
      placeholder: "gemini-...",
      pluginId: "google",
      setConfiguredCredentialValue: (configTarget, value) => {
        const plugins = (configTarget.plugins ??= {}) as { entries?: Record<string, unknown> };
        const entries = (plugins.entries ??= {});
        const entry = (entries.google ??= {}) as { config?: Record<string, unknown> };
        const config = (entry.config ??= {});
        const webSearch = (config.webSearch ??= {}) as { apiKey?: unknown };
        webSearch.apiKey = value;
      },
      setCredentialValue: (searchConfigTarget, value) => {
        searchConfigTarget.apiKey = value;
      },
      signupUrl: "https://example.com/gemini",
    },
  ]),
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
}));

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let activateSecretsRuntimeSnapshot: typeof import("./runtime.js").activateSecretsRuntimeSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let getActiveRuntimeWebToolsMetadata: typeof import("./runtime.js").getActiveRuntimeWebToolsMetadata;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("runtime web tools state", () => {
  beforeAll(async () => {
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
    ({
      activateSecretsRuntimeSnapshot,
      clearSecretsRuntimeSnapshot,
      getActiveRuntimeWebToolsMetadata,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js"));
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  it("exposes active runtime web tool metadata as a defensive clone", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                    provider: "default",
                    source: "env",
                  },
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "gemini",
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    activateSecretsRuntimeSnapshot(snapshot);

    const first = getActiveRuntimeWebToolsMetadata();
    expect(first?.search.providerConfigured).toBe("gemini");
    expect(first?.search.selectedProvider).toBe("gemini");
    expect(first?.search.selectedProviderKeySource).toBe("secretRef");
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadata();
    expect(second?.search.providerConfigured).toBe("gemini");
    expect(second?.search.selectedProvider).toBe("gemini");
  });
});
