import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearSecretsRuntimeSnapshot: typeof import("./runtime.js").clearSecretsRuntimeSnapshot;
let prepareSecretsRuntimeSnapshot: typeof import("./runtime.js").prepareSecretsRuntimeSnapshot;

describe("secrets runtime gateway local surfaces", () => {
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

  it("treats gateway.remote refs as inactive when local auth credentials are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          auth: {
            mode: "password",
            password: "local-password",
            token: "local-token",
          },
          mode: "local",
          remote: {
            enabled: true,
            password: { id: "MISSING_REMOTE_PASSWORD", provider: "default", source: "env" },
            token: { id: "MISSING_REMOTE_TOKEN", provider: "default", source: "env" },
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.remote?.token).toEqual({
      id: "MISSING_REMOTE_TOKEN",
      provider: "default",
      source: "env",
    });
    expect(snapshot.config.gateway?.remote?.password).toEqual({
      id: "MISSING_REMOTE_PASSWORD",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
      expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
    );
  });

  it("treats gateway.auth.password ref as active when mode is unset and no token is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          auth: {
            password: { id: "GATEWAY_PASSWORD_REF", provider: "default", source: "env" },
          },
        },
      }),
      env: {
        GATEWAY_PASSWORD_REF: "resolved-gateway-password",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.auth?.password).toBe("resolved-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.password");
  });

  it("treats gateway.auth.token ref as active when token mode is explicit", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: { id: "GATEWAY_TOKEN_REF", provider: "default", source: "env" },
          },
        },
      }),
      env: {
        GATEWAY_TOKEN_REF: "resolved-gateway-token",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.auth?.token).toBe("resolved-gateway-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.auth.token");
  });

  it("treats gateway.auth.token ref as inactive when password mode is explicit", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          auth: {
            mode: "password",
            token: { id: "GATEWAY_TOKEN_REF", provider: "default", source: "env" },
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.auth?.token).toEqual({
      id: "GATEWAY_TOKEN_REF",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.token");
  });

  it("fails when gateway.auth.token ref is active and unresolved", async () => {
    await expect(
      prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          gateway: {
            auth: {
              mode: "token",
              token: { id: "MISSING_GATEWAY_TOKEN_REF", provider: "default", source: "env" },
            },
          },
        }),
        env: {},
        loadAuthStore: () => ({ profiles: {}, version: 1 }),
      }),
    ).rejects.toThrow(/MISSING_GATEWAY_TOKEN_REF/);
  });

  it("treats gateway.auth.password ref as inactive when auth mode is trusted-proxy", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          auth: {
            mode: "trusted-proxy",
            password: { id: "GATEWAY_PASSWORD_REF", provider: "default", source: "env" },
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.auth?.password).toEqual({
      id: "GATEWAY_PASSWORD_REF",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.password");
  });

  it("treats gateway.auth.password ref as inactive when remote token is configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          auth: {
            password: { id: "GATEWAY_PASSWORD_REF", provider: "default", source: "env" },
          },
          mode: "local",
          remote: {
            enabled: true,
            token: "remote-token",
          },
        },
      }),
      env: {},
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.auth?.password).toEqual({
      id: "GATEWAY_PASSWORD_REF",
      provider: "default",
      source: "env",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain("gateway.auth.password");
  });

  it.each(["none", "trusted-proxy"] as const)(
    "treats gateway.remote refs as inactive in local mode when auth mode is %s",
    async (mode) => {
      const snapshot = await prepareSecretsRuntimeSnapshot({
        agentDirs: ["/tmp/openclaw-agent-main"],
        config: asConfig({
          gateway: {
            auth: { mode },
            mode: "local",
            remote: {
              enabled: true,
              password: {
                id: "REMOTE_GATEWAY_PASSWORD_REF",
                provider: "default",
                source: "env",
              },
              token: { id: "REMOTE_GATEWAY_TOKEN_REF", provider: "default", source: "env" },
            },
          },
        }),
        env: {},
        loadAuthStore: () => ({ profiles: {}, version: 1 }),
      });

      expect(snapshot.config.gateway?.remote?.token).toEqual({
        id: "REMOTE_GATEWAY_TOKEN_REF",
        provider: "default",
        source: "env",
      });
      expect(snapshot.config.gateway?.remote?.password).toEqual({
        id: "REMOTE_GATEWAY_PASSWORD_REF",
        provider: "default",
        source: "env",
      });
      expect(snapshot.warnings.map((warning) => warning.path)).toEqual(
        expect.arrayContaining(["gateway.remote.token", "gateway.remote.password"]),
      );
    },
  );

  it("treats gateway.remote.token ref as active in local mode when no local credentials are configured", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          mode: "local",
          remote: {
            enabled: true,
            token: { id: "REMOTE_GATEWAY_TOKEN_REF", provider: "default", source: "env" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_TOKEN_REF: "resolved-remote-gateway-token",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.remote?.token).toBe("resolved-remote-gateway-token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.remote.token");
  });

  it("treats gateway.remote.password ref as active in local mode when password can win", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          mode: "local",
          remote: {
            enabled: true,
            password: { id: "REMOTE_GATEWAY_PASSWORD_REF", provider: "default", source: "env" },
          },
        },
      }),
      env: {
        REMOTE_GATEWAY_PASSWORD_REF: "resolved-remote-gateway-password",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.remote?.password).toBe("resolved-remote-gateway-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });

  it("treats gateway.remote refs as active when tailscale serve is enabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      agentDirs: ["/tmp/openclaw-agent-main"],
      config: asConfig({
        gateway: {
          mode: "local",
          remote: {
            enabled: true,
            password: { id: "REMOTE_GATEWAY_PASSWORD", provider: "default", source: "env" },
            token: { id: "REMOTE_GATEWAY_TOKEN", provider: "default", source: "env" },
          },
          tailscale: { mode: "serve" },
        },
      }),
      env: {
        REMOTE_GATEWAY_PASSWORD: "tailscale-remote-password",
        REMOTE_GATEWAY_TOKEN: "tailscale-remote-token",
      },
      loadAuthStore: () => ({ profiles: {}, version: 1 }),
    });

    expect(snapshot.config.gateway?.remote?.token).toBe("tailscale-remote-token");
    expect(snapshot.config.gateway?.remote?.password).toBe("tailscale-remote-password");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain("gateway.remote.token");
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "gateway.remote.password",
    );
  });
});
