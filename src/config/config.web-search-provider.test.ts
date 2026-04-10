import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

vi.mock("../plugin-sdk/telegram-command-config.js", () => ({
  TELEGRAM_COMMAND_NAME_PATTERN: /^[a-z0-9_]+$/,
  normalizeTelegramCommandDescription: (value: string) => value.trim(),
  normalizeTelegramCommandName: (value: string) => value.trim().toLowerCase(),
  resolveTelegramCustomCommands: () => ({ commands: [], issues: [] }),
}));

const getScopedWebSearchCredential = (key: string) => (search?: Record<string, unknown>) =>
  (search?.[key] as { apiKey?: unknown } | undefined)?.apiKey;
const getConfiguredPluginWebSearchConfig =
  (pluginId: string) => (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | {
            entries?: Record<
              string,
              { config?: { webSearch?: { apiKey?: unknown; baseUrl?: unknown } } }
            >;
          }
        | undefined
    )?.entries?.[pluginId]?.config?.webSearch;
const getConfiguredPluginWebSearchCredential =
  (pluginId: string) => (config?: Record<string, unknown>) =>
    getConfiguredPluginWebSearchConfig(pluginId)(config)?.apiKey;

const mockWebSearchProviders = [
  {
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    envVars: ["BRAVE_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("brave"),
    getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
    id: "brave",
    pluginId: "brave",
  },
  {
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    envVars: ["FIRECRAWL_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("firecrawl"),
    getCredentialValue: getScopedWebSearchCredential("firecrawl"),
    id: "firecrawl",
    pluginId: "firecrawl",
  },
  {
    credentialPath: "plugins.entries.google.config.webSearch.apiKey",
    envVars: ["GEMINI_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("google"),
    getCredentialValue: getScopedWebSearchCredential("gemini"),
    id: "gemini",
    pluginId: "google",
  },
  {
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    envVars: ["XAI_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("xai"),
    getCredentialValue: getScopedWebSearchCredential("grok"),
    id: "grok",
    pluginId: "xai",
  },
  {
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("moonshot"),
    getCredentialValue: getScopedWebSearchCredential("kimi"),
    id: "kimi",
    pluginId: "moonshot",
  },
  {
    credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
    envVars: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("minimax"),
    getCredentialValue: getScopedWebSearchCredential("minimax"),
    id: "minimax",
    pluginId: "minimax",
  },
  {
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("perplexity"),
    getCredentialValue: getScopedWebSearchCredential("perplexity"),
    id: "perplexity",
    pluginId: "perplexity",
  },
  {
    credentialPath: "plugins.entries.searxng.config.webSearch.baseUrl",
    envVars: ["SEARXNG_BASE_URL"],
    getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
      getConfiguredPluginWebSearchConfig("searxng")(config)?.baseUrl,
    getCredentialValue: (search?: Record<string, unknown>) =>
      (search?.searxng as { baseUrl?: unknown } | undefined)?.baseUrl,
    id: "searxng",
    pluginId: "searxng",
  },
  {
    credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
    envVars: ["TAVILY_API_KEY"],
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("tavily"),
    getCredentialValue: getScopedWebSearchCredential("tavily"),
    id: "tavily",
    pluginId: "tavily",
  },
] as const;

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
    resolvePluginWebSearchProviders: () => mockWebSearchProviders,
  }));

vi.mock("../plugins/manifest-registry.js", () => {
  const buildSchema = () => ({
    additionalProperties: false,
    properties: {
      webSearch: {
        additionalProperties: false,
        properties: {
          apiKey: {
            oneOf: [
              { type: "string" },
              {
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  provider: { type: "string" },
                  source: { type: "string" },
                },
                required: ["source", "provider", "id"],
                type: "object",
              },
            ],
          },
          baseUrl: {
            oneOf: [
              { type: "string" },
              {
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  provider: { type: "string" },
                  source: { type: "string" },
                },
                required: ["source", "provider", "id"],
                type: "object",
              },
            ],
          },
          model: { type: "string" },
        },
        type: "object",
      },
    },
    type: "object",
  });

  return {
    loadPluginManifestRegistry: () => ({
      diagnostics: [],
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          channels: [],
          providers: [],
          contracts: {
            webSearchProviders: ["brave"],
          },
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: "/tmp/plugins/brave",
          source: "test",
          manifestPath: "/tmp/plugins/brave/openclaw.plugin.json",
          schemaCacheKey: "test:brave",
          configSchema: buildSchema(),
        },
        ...[
          "firecrawl",
          "google",
          "minimax",
          "moonshot",
          "perplexity",
          "searxng",
          "tavily",
          "xai",
        ].map((id) => ({
          id,
          origin: "bundled",
          channels: [],
          providers: [],
          contracts: {
            webSearchProviders: [id],
          },
          cliBackends: [],
          skills: [],
          hooks: [],
          rootDir: `/tmp/plugins/${id}`,
          source: "test",
          manifestPath: `/tmp/plugins/${id}/openclaw.plugin.json`,
          schemaCacheKey: `test:${id}`,
          configSchema: buildSchema(),
        })),
      ],
    }),
    resolveManifestContractOwnerPluginId: (params?: { contract?: string; value?: string }) =>
      params?.contract === "webSearchProviders"
        ? mockWebSearchProviders.find((provider) => provider.id === params.value)?.pluginId
        : undefined,
    resolveManifestContractPluginIds: (params?: { contract?: string; origin?: string }) =>
      params?.contract === "webSearchProviders" && params.origin === "bundled"
        ? mockWebSearchProviders
            .map((provider) => provider.pluginId)
            .filter((value, index, array) => array.indexOf(value) === index)
            .toSorted((left, right) => left.localeCompare(right))
        : [],
  };
});

let validateConfigObjectWithPlugins: typeof import("./config.js").validateConfigObjectWithPlugins;
let resolveSearchProvider: typeof import("../agents/tools/web-search.js").__testing.resolveSearchProvider;

beforeAll(async () => {
  vi.resetModules();
  ({ validateConfigObjectWithPlugins } = await import("./config.js"));
  ({
    __testing: { resolveSearchProvider },
  } = await import("../agents/tools/web-search.js"));
});

describe("web search provider config", () => {
  it("does not warn for brave plugin config when bundled web search allowlist compat applies", () => {
    const res = validateConfigObjectWithPlugins({
      plugins: {
        allow: ["bluebubbles", "memory-core"],
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "test-brave-key", // Pragma: allowlist secret
              },
            },
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
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).not.toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "plugin disabled (not in allowlist) but config is present",
        ),
        path: "plugins.entries.brave",
      }),
    );
  });

  it("accepts perplexity provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key", // Pragma: allowlist secret
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "gemini",
        providerConfig: {
          apiKey: "test-key", // Pragma: allowlist secret
          model: "gemini-2.5-flash",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts firecrawl provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "firecrawl",
        providerConfig: {
          apiKey: "fc-test-key", // Pragma: allowlist secret
          baseUrl: "https://api.firecrawl.dev",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts tavily provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "tavily",
        providerConfig: {
          apiKey: {
            id: "TAVILY_API_KEY",
            provider: "default",
            source: "env",
          },
          baseUrl: "https://api.tavily.com",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts minimax provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "minimax",
        providerConfig: {
          apiKey: {
            id: "MINIMAX_CODE_PLAN_KEY",
            provider: "default",
            source: "env",
          },
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts searxng provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "searxng",
        providerConfig: {
          baseUrl: {
            id: "SEARXNG_BASE_URL",
            provider: "default",
            source: "env",
          },
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("rejects legacy scoped Tavily config", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "tavily",
            tavily: {
              apiKey: "tvly-test-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("detects legacy scoped provider config for bundled providers", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            gemini: {
              apiKey: "legacy-key",
            },
            provider: "gemini",
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_CODE_PLAN_KEY;
    delete process.env.MINIMAX_CODING_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.TAVILY_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to brave when no keys available", () => {
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects tavily when only TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("tavily");
  });

  it("auto-detects firecrawl when only FIRECRAWL_API_KEY is set", () => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("firecrawl");
  });

  it("auto-detects searxng when only SEARXNG_BASE_URL is set", () => {
    process.env.SEARXNG_BASE_URL = "http://localhost:8080";
    expect(resolveSearchProvider({})).toBe("searxng");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects minimax when only MINIMAX_CODE_PLAN_KEY is set", () => {
    process.env.MINIMAX_CODE_PLAN_KEY = "sk-cp-test";
    expect(resolveSearchProvider({})).toBe("minimax");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects perplexity when only OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows alphabetical order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // Pragma: allowlist secret
    process.env.GEMINI_API_KEY = "test-gemini-key"; // Pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // Pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over grok, kimi, and perplexity when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // Pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // Pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("grok wins over kimi and perplexity when brave and gemini unavailable", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // Pragma: allowlist secret
    process.env.KIMI_API_KEY = "test-kimi-key"; // Pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // Pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // Pragma: allowlist secret
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });
});
