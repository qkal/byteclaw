import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
} from "../plugins/types.js";

type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity" | "duckduckgo";

const { resolvePluginWebSearchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebSearchProvidersMock: vi.fn(() => buildTestWebSearchProviders()),
}));

const { resolvePluginWebFetchProvidersMock } = vi.hoisted(() => ({
  resolvePluginWebFetchProvidersMock: vi.fn(() => buildTestWebFetchProviders()),
}));
const {
  resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
} = vi.hoisted(() => ({
  resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebFetchProviders(),
  ),
  resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebSearchProviders(),
  ),
}));
const {
  resolveBundledWebSearchProvidersFromPublicArtifactsMock,
  resolveBundledWebFetchProvidersFromPublicArtifactsMock,
} = vi.hoisted(() => ({
  resolveBundledWebFetchProvidersFromPublicArtifactsMock: vi.fn(() => buildTestWebFetchProviders()),
  resolveBundledWebSearchProvidersFromPublicArtifactsMock: vi.fn(() =>
    buildTestWebSearchProviders(),
  ),
}));
const { resolveManifestContractPluginIdsByCompatibilityRuntimePathMock } = vi.hoisted(() => ({
  resolveManifestContractPluginIdsByCompatibilityRuntimePathMock: vi.fn(() => ["brave"]),
}));
const { resolveManifestContractOwnerPluginIdMock, runtimeManifestActual } = vi.hoisted(() => ({
  resolveManifestContractOwnerPluginIdMock: vi.fn(),
  runtimeManifestActual: {
    resolveManifestContractOwnerPluginId: undefined as
      | typeof import("./runtime-web-tools-manifest.runtime.js").resolveManifestContractOwnerPluginId
      | undefined,
  },
}));
let secretResolve: typeof import("./resolve.js");
let createResolverContext: typeof import("./runtime-shared.js").createResolverContext;
let resolveRuntimeWebTools: typeof import("./runtime-web-tools.js").resolveRuntimeWebTools;

vi.mock("./runtime-web-tools-fallback.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-web-tools-fallback.runtime.js")>(
    "./runtime-web-tools-fallback.runtime.js",
  );
  return {
    ...actual,
    runtimeWebToolsFallbackProviders: {
      ...actual.runtimeWebToolsFallbackProviders,
      resolvePluginWebFetchProviders: resolvePluginWebFetchProvidersMock,
      resolvePluginWebSearchProviders: resolvePluginWebSearchProvidersMock,
    },
  };
});

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts:
    resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock,
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock,
}));

vi.mock("./runtime-web-tools-public-artifacts.runtime.js", () => ({
  resolveBundledWebFetchProvidersFromPublicArtifacts:
    resolveBundledWebFetchProvidersFromPublicArtifactsMock,
  resolveBundledWebSearchProvidersFromPublicArtifacts:
    resolveBundledWebSearchProvidersFromPublicArtifactsMock,
}));

vi.mock("../plugins/manifest-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/manifest-registry.js")>(
    "../plugins/manifest-registry.js",
  );
  return {
    ...actual,
    resolveManifestContractPluginIdsByCompatibilityRuntimePath:
      resolveManifestContractPluginIdsByCompatibilityRuntimePathMock,
  };
});

vi.mock("./runtime-web-tools-manifest.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-web-tools-manifest.runtime.js")>(
    "./runtime-web-tools-manifest.runtime.js",
  );
  runtimeManifestActual.resolveManifestContractOwnerPluginId =
    actual.resolveManifestContractOwnerPluginId;
  resolveManifestContractOwnerPluginIdMock.mockImplementation(
    actual.resolveManifestContractOwnerPluginId,
  );
  return {
    ...actual,
    resolveManifestContractOwnerPluginId: resolveManifestContractOwnerPluginIdMock,
  };
});

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function providerPluginId(provider: ProviderUnderTest): string {
  switch (provider) {
    case "duckduckgo": {
      return "duckduckgo";
    }
    case "gemini": {
      return "google";
    }
    case "grok": {
      return "xai";
    }
    case "kimi": {
      return "moonshot";
    }
    default: {
      return provider;
    }
  }
}

function ensureRecord(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = target[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function setConfiguredProviderKey(
  configTarget: OpenClawConfig,
  pluginId: string,
  value: unknown,
): void {
  const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const pluginEntry = ensureRecord(entries, pluginId);
  const config = ensureRecord(pluginEntry, "config");
  const webSearch = ensureRecord(config, "webSearch");
  webSearch.apiKey = value;
}

function setConfiguredFetchProviderKey(configTarget: OpenClawConfig, value: unknown): void {
  const plugins = ensureRecord(configTarget as Record<string, unknown>, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const pluginEntry = ensureRecord(entries, "firecrawl");
  const config = ensureRecord(pluginEntry, "config");
  const webFetch = ensureRecord(config, "webFetch");
  webFetch.apiKey = value;
}

function createTestProvider(params: {
  provider: ProviderUnderTest;
  pluginId: string;
  order: number;
}): PluginWebSearchProviderEntry {
  const credentialPath = `plugins.entries.${params.pluginId}.config.webSearch.apiKey`;
  return {
    autoDetectOrder: params.order,
    createTool: () => null,
    credentialPath: params.provider === "duckduckgo" ? "" : credentialPath,
    envVars: params.provider === "duckduckgo" ? [] : [`${params.provider.toUpperCase()}_API_KEY`],
    getConfiguredCredentialValue: (config) => {
      const entryConfig = config?.plugins?.entries?.[params.pluginId]?.config;
      return entryConfig && typeof entryConfig === "object"
        ? (entryConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
        : undefined;
    },
    getCredentialValue: (searchConfig) =>
      params.provider === "duckduckgo" ? "duckduckgo-no-key-needed" : searchConfig?.apiKey,
    hint: `${params.provider} test provider`,
    id: params.provider,
    inactiveSecretPaths: params.provider === "duckduckgo" ? [] : [credentialPath],
    label: params.provider,
    placeholder: params.provider === "duckduckgo" ? "(no key needed)" : `${params.provider}-...`,
    pluginId: params.pluginId,
    requiresCredential: params.provider === "duckduckgo" ? false : undefined,
    resolveRuntimeMetadata:
      params.provider === "perplexity"
        ? () => ({
            perplexityTransport: "search_api" as const,
          })
        : undefined,
    setConfiguredCredentialValue: (configTarget, value) => {
      setConfiguredProviderKey(configTarget, params.pluginId, value);
    },
    setCredentialValue: (searchConfigTarget, value) => {
      searchConfigTarget.apiKey = value;
    },
    signupUrl: `https://example.com/${params.provider}`,
  };
}

function buildTestWebSearchProviders(): PluginWebSearchProviderEntry[] {
  return [
    createTestProvider({ order: 10, pluginId: "brave", provider: "brave" }),
    createTestProvider({ order: 20, pluginId: "google", provider: "gemini" }),
    createTestProvider({ order: 30, pluginId: "xai", provider: "grok" }),
    createTestProvider({ order: 40, pluginId: "moonshot", provider: "kimi" }),
    createTestProvider({ order: 50, pluginId: "perplexity", provider: "perplexity" }),
    createTestProvider({ order: 100, pluginId: "duckduckgo", provider: "duckduckgo" }),
  ];
}

function buildTestWebFetchProviders(): PluginWebFetchProviderEntry[] {
  return [
    {
      autoDetectOrder: 50,
      createTool: () => null,
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      envVars: ["FIRECRAWL_API_KEY"],
      getConfiguredCredentialValue: (config) => {
        const entryConfig = config?.plugins?.entries?.firecrawl?.config;
        return entryConfig && typeof entryConfig === "object"
          ? (entryConfig as { webFetch?: { apiKey?: unknown } }).webFetch?.apiKey
          : undefined;
      },
      getCredentialValue: (fetchConfig) => fetchConfig?.apiKey,
      hint: "firecrawl test provider",
      id: "firecrawl",
      inactiveSecretPaths: ["plugins.entries.firecrawl.config.webFetch.apiKey"],
      label: "firecrawl",
      placeholder: "fc-...",
      pluginId: "firecrawl",
      setConfiguredCredentialValue: (configTarget, value) => {
        setConfiguredFetchProviderKey(configTarget, value);
      },
      setCredentialValue: (fetchConfigTarget, value) => {
        fetchConfigTarget.apiKey = value;
      },
      signupUrl: "https://example.com/firecrawl",
    },
  ];
}

async function runRuntimeWebTools(params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv }) {
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    env: params.env ?? {},
    sourceConfig,
  });
  const metadata = await resolveRuntimeWebTools({
    context,
    resolvedConfig,
    sourceConfig,
  });
  return { context, metadata, resolvedConfig };
}

function createProviderSecretRefConfig(
  provider: ProviderUnderTest,
  envRefId: string,
): OpenClawConfig {
  return asConfig({
    plugins: {
      entries: {
        [providerPluginId(provider)]: {
          config: {
            webSearch: {
              apiKey: { id: envRefId, provider: "default", source: "env" },
            },
          },
          enabled: true,
        },
      },
    },
    tools: {
      web: {
        search: {
          enabled: true,
          provider,
        },
      },
    },
  });
}

function readProviderKey(config: OpenClawConfig, provider: ProviderUnderTest): unknown {
  const pluginConfig = config.plugins?.entries?.[providerPluginId(provider)]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function expectInactiveWebFetchProviderSecretRef(params: {
  resolveSpy: ReturnType<typeof vi.spyOn>;
  metadata: Awaited<ReturnType<typeof runRuntimeWebTools>>["metadata"];
  context: Awaited<ReturnType<typeof runRuntimeWebTools>>["context"];
}) {
  expect(params.resolveSpy).not.toHaveBeenCalled();
  expect(params.metadata.fetch.selectedProvider).toBeUndefined();
  expect(params.metadata.fetch.selectedProviderKeySource).toBeUndefined();
  expect(params.context.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "plugins.entries.firecrawl.config.webFetch.apiKey",
      }),
    ]),
  );
}

describe("runtime web tools resolution", () => {
  beforeAll(async () => {
    secretResolve = await import("./resolve.js");
    ({ createResolverContext } = await import("./runtime-shared.js"));
    ({ resolveRuntimeWebTools } = await import("./runtime-web-tools.js"));
  });

  beforeEach(() => {
    resolvePluginWebSearchProvidersMock.mockClear();
    resolvePluginWebFetchProvidersMock.mockClear();
    resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledWebSearchProvidersFromPublicArtifactsMock.mockClear();
    resolveBundledWebFetchProvidersFromPublicArtifactsMock.mockClear();
    resolveManifestContractOwnerPluginIdMock.mockReset();
    resolveManifestContractOwnerPluginIdMock.mockImplementation(
      runtimeManifestActual.resolveManifestContractOwnerPluginId!,
    );
    resolveManifestContractOwnerPluginIdMock.mockClear();
    resolveManifestContractPluginIdsByCompatibilityRuntimePathMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps web search inactive when only web fetch is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { id: "FIRECRAWL_API_KEY_REF", provider: "default", source: "env" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("keeps web fetch inactive when only web search is configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { id: "XAI_API_KEY_REF", provider: "default", source: "env" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "grok",
            },
          },
        },
      }),
      env: {
        XAI_API_KEY_REF: "xai-runtime-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("grok");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(metadata.fetch.selectedProvider).toBeUndefined();
    expect(metadata.fetch.providerSource).toBe("none");
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("auto-selects a keyless provider when no credentials are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
    });

    expect(metadata.search.selectedProvider).toBe("duckduckgo");
    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_AUTODETECT_SELECTED",
          message: expect.stringContaining('keyless provider "duckduckgo"'),
        }),
      ]),
    );
  });

  it.each([
    {
      envRefId: "BRAVE_PROVIDER_REF",
      provider: "brave" as const,
      resolvedKey: "brave-provider-key",
    },
    {
      envRefId: "GEMINI_PROVIDER_REF",
      provider: "gemini" as const,
      resolvedKey: "gemini-provider-key",
    },
    {
      envRefId: "GROK_PROVIDER_REF",
      provider: "grok" as const,
      resolvedKey: "grok-provider-key",
    },
    {
      envRefId: "KIMI_PROVIDER_REF",
      provider: "kimi" as const,
      resolvedKey: "kimi-provider-key",
    },
    {
      envRefId: "PERPLEXITY_PROVIDER_REF",
      provider: "perplexity" as const,
      resolvedKey: "pplx-provider-key",
    },
  ])(
    "resolves configured provider SecretRef for $provider",
    async ({ provider, envRefId, resolvedKey }) => {
      const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
        config: createProviderSecretRefConfig(provider, envRefId),
        env: {
          [envRefId]: resolvedKey,
        },
      });

      expect(metadata.search.providerConfigured).toBe(provider);
      expect(metadata.search.providerSource).toBe("configured");
      expect(metadata.search.selectedProvider).toBe(provider);
      expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
      expect(readProviderKey(resolvedConfig, provider)).toBe(resolvedKey);
      expect(context.warnings.map((warning) => warning.code)).not.toContain(
        "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      );
      if (provider === "perplexity") {
        expect(metadata.search.perplexityTransport).toBe("search_api");
      }
    },
  );

  it("resolves selected provider SecretRef even when provider config is disabled", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
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
                  enabled: false,
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref",
      },
    });

    expect(metadata.search.providerConfigured).toBe("gemini");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("web-search-gemini-ref");
    expect(context.warnings.map((warning) => warning.path)).not.toContain(
      "plugins.entries.google.config.webSearch.apiKey",
    );
  });

  it("auto-detects provider precedence across all configured providers", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: { apiKey: { id: "BRAVE_REF", provider: "default", source: "env" } },
              },
              enabled: true,
            },
            google: {
              config: {
                webSearch: { apiKey: { id: "GEMINI_REF", provider: "default", source: "env" } },
              },
              enabled: true,
            },
            moonshot: {
              config: {
                webSearch: { apiKey: { id: "KIMI_REF", provider: "default", source: "env" } },
              },
              enabled: true,
            },
            perplexity: {
              config: {
                webSearch: { apiKey: { id: "PERPLEXITY_REF", provider: "default", source: "env" } },
              },
              enabled: true,
            },
            xai: {
              config: {
                webSearch: { apiKey: { id: "GROK_REF", provider: "default", source: "env" } },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
      env: {
        BRAVE_REF: "brave-precedence-key",
        GEMINI_REF: "gemini-precedence-key",
        GROK_REF: "grok-precedence-key",
        KIMI_REF: "kimi-precedence-key",
        PERPLEXITY_REF: "pplx-precedence-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-precedence-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "plugins.entries.google.config.webSearch.apiKey" }),
        expect.objectContaining({ path: "plugins.entries.xai.config.webSearch.apiKey" }),
        expect.objectContaining({ path: "plugins.entries.moonshot.config.webSearch.apiKey" }),
        expect.objectContaining({ path: "plugins.entries.perplexity.config.webSearch.apiKey" }),
      ]),
    );
  });

  it("auto-detects first available provider and keeps lower-priority refs inactive", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: {
                  apiKey: { id: "BRAVE_API_KEY_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
            google: {
              config: {
                webSearch: {
                  apiKey: { id: "MISSING_GEMINI_API_KEY_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY_REF: "brave-runtime-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-runtime-key");
    expect(readProviderKey(resolvedConfig, "gemini")).toEqual({
      id: "MISSING_GEMINI_API_KEY_REF",
      provider: "default",
      source: "env",
    });
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("auto-detects the next provider when a higher-priority ref is unresolved", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: {
                  apiKey: { id: "MISSING_BRAVE_API_KEY_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
            google: {
              config: {
                webSearch: {
                  apiKey: { id: "GEMINI_API_KEY_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.brave.config.webSearch.apiKey",
        }),
      ]),
    );
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("warns when provider is invalid and falls back to auto-detect", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: { id: "GEMINI_API_KEY_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              provider: "invalid-provider",
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBeUndefined();
    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expect(metadata.search.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
          path: "tools.web.search.provider",
        }),
      ]),
    );
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
          path: "tools.web.search.provider",
        }),
      ]),
    );
  });

  it("fails fast when configured provider ref is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          google: {
            config: {
              webSearch: {
                apiKey: { id: "MISSING_GEMINI_API_KEY_REF", provider: "default", source: "env" },
              },
            },
            enabled: true,
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
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      env: {},
      sourceConfig,
    });

    await expect(
      resolveRuntimeWebTools({
        context,
        resolvedConfig,
        sourceConfig,
      }),
    ).rejects.toThrow("[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
  });

  it("uses bundled-only runtime provider resolution for configured bundled providers", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: { id: "GEMINI_PROVIDER_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "gemini",
            },
          },
        },
      }),
      env: {
        GEMINI_PROVIDER_REF: "gemini-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["google"],
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses exact plugin-id hints for configured bundled provider entries without manifest owner lookup", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            brave: {
              config: {
                webSearch: {
                  apiKey: { id: "BRAVE_PROVIDER_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
            google: {
              config: {
                webSearch: {
                  apiKey: { id: "GOOGLE_PROVIDER_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
            },
          },
        },
      }),
      env: {
        BRAVE_PROVIDER_REF: "brave-provider-key",
        GOOGLE_PROVIDER_REF: "google-provider-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["brave"],
    });
    expect(resolveManifestContractOwnerPluginIdMock).not.toHaveBeenCalled();
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("limits legacy top-level web search apiKey auto-detect to compatibility owners", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              apiKey: { id: "LEGACY_WEB_SEARCH_REF", provider: "default", source: "env" },
            },
          },
        },
      }),
      env: {
        LEGACY_WEB_SEARCH_REF: "legacy-web-search-key",
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolveManifestContractPluginIdsByCompatibilityRuntimePathMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: "webSearchProviders",
        origin: "bundled",
        path: "tools.web.search.apiKey",
      }),
    );
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["brave"],
    });
    expect(resolveBundledWebSearchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("does not resolve web fetch provider SecretRef when web fetch is inactive", async () => {
    const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { id: "MISSING_FIRECRAWL_REF", provider: "default", source: "env" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              enabled: false,
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expectInactiveWebFetchProviderSecretRef({ context, metadata, resolveSpy });
  });

  it("keeps configured provider metadata and inactive warnings when search is disabled", async () => {
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: { id: "GEMINI_PROVIDER_REF", provider: "default", source: "env" },
                },
              },
              enabled: true,
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "gemini",
            },
          },
        },
      }),
    });

    expect(metadata.search.providerConfigured).toBe("gemini");
    expect(metadata.search.providerSource).toBe("configured");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
  });

  it("emits inactive warnings for configured and lower-priority web-search providers when search is disabled", async () => {
    const { context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    id: "DISABLED_WEB_SEARCH_GEMINI_API_KEY",
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
              apiKey: { id: "DISABLED_WEB_SEARCH_API_KEY", provider: "default", source: "env" },
              enabled: false,
            },
          },
        },
      }),
    });

    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.brave.config.webSearch.apiKey",
        }),
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
  });

  it("does not auto-enable search when tools.web.search is absent", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({}),
    });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.search.selectedProvider).toBeUndefined();
  });

  it("skips provider discovery when no web surfaces are configured", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({}),
    });

    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.providerSource).toBe("none");
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses bundled public artifacts for bundled web search provider discovery", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "brave-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.search.selectedProvider).toBe("brave");
    expect(resolvePluginWebSearchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses bundled public artifacts for bundled web fetch provider discovery", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });

  it("uses env fallback for unresolved web fetch provider SecretRef when active", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { id: "MISSING_FIRECRAWL_REF", provider: "default", source: "env" },
                },
              },
            },
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-fallback-key", // Pragma: allowlist secret
      },
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-fallback-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_FALLBACK_USED",
          path: "plugins.entries.firecrawl.config.webFetch.apiKey",
        }),
      ]),
    );
  });

  it("resolves plugin-owned web fetch SecretRefs without tools.web.fetch", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: { id: "FIRECRAWL_API_KEY", provider: "default", source: "env" },
                },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key",
      },
    });

    expect(metadata.fetch.providerSource).toBe("auto-detect");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("secretRef");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-runtime-key");
  });

  it("resolves legacy Firecrawl web fetch SecretRefs through the plugin-owned path", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                apiKey: { id: "FIRECRAWL_API_KEY", provider: "default", source: "env" },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-legacy-key",
      },
    });

    expect(metadata.fetch.providerSource).toBe("auto-detect");
    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(metadata.fetch.selectedProviderKeySource).toBe("env");
    expect(
      (
        resolvedConfig.plugins?.entries?.firecrawl?.config as
          | { webFetch?: { apiKey?: unknown } }
          | undefined
      )?.webFetch?.apiKey,
    ).toBe("firecrawl-legacy-key");
  });

  it("fails fast when active web fetch provider SecretRef is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { id: "MISSING_FIRECRAWL_REF", provider: "default", source: "env" },
              },
            },
          },
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      env: {},
      sourceConfig,
    });

    await expect(
      resolveRuntimeWebTools({
        context,
        resolvedConfig,
        sourceConfig,
      }),
    ).rejects.toThrow("[WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK]");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
          path: "plugins.entries.firecrawl.config.webFetch.apiKey",
        }),
      ]),
    );
  });

  it("rejects env SecretRefs for web fetch provider keys outside provider allowlists", async () => {
    const sourceConfig = asConfig({
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: { id: "AWS_SECRET_ACCESS_KEY", provider: "default", source: "env" },
              },
            },
          },
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      env: {
        AWS_SECRET_ACCESS_KEY: "not-allowed",
      },
      sourceConfig,
    });

    await expect(
      resolveRuntimeWebTools({
        context,
        resolvedConfig,
        sourceConfig,
      }),
    ).rejects.toThrow("[WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK]");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_FETCH_PROVIDER_KEY_UNRESOLVED_NO_FALLBACK",
          message: expect.stringContaining(
            'SecretRef env var "AWS_SECRET_ACCESS_KEY" is not allowed.',
          ),
          path: "plugins.entries.firecrawl.config.webFetch.apiKey",
        }),
      ]),
    );
  });

  it("keeps web fetch provider discovery bundled-only during runtime secret resolution", async () => {
    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        plugins: {
          entries: {
            firecrawl: {
              config: {
                webFetch: {
                  apiKey: "firecrawl-config-key",
                },
              },
              enabled: true,
            },
          },
          load: {
            paths: ["/tmp/malicious-plugin"],
          },
        },
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
    });

    expect(metadata.fetch.selectedProvider).toBe("firecrawl");
    expect(resolveBundledExplicitWebFetchProvidersFromPublicArtifactsMock).toHaveBeenCalledWith({
      onlyPluginIds: ["firecrawl"],
    });
    expect(resolveBundledWebFetchProvidersFromPublicArtifactsMock).not.toHaveBeenCalled();
    expect(resolvePluginWebFetchProvidersMock).not.toHaveBeenCalled();
  });
});
