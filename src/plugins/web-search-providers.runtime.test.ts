import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RegistryModule = typeof import("./registry.js");
type RuntimeModule = typeof import("./runtime.js");
type WebSearchProvidersRuntimeModule = typeof import("./web-search-providers.runtime.js");
type ManifestRegistryModule = typeof import("./manifest-registry.js");
type PluginAutoEnableModule = typeof import("../config/plugin-auto-enable.js");
type WebSearchProvidersSharedModule = typeof import("./web-search-providers.shared.js");

const BUNDLED_WEB_SEARCH_PROVIDERS = [
  { id: "brave", order: 10, pluginId: "brave" },
  { id: "gemini", order: 20, pluginId: "google" },
  { id: "grok", order: 30, pluginId: "xai" },
  { id: "kimi", order: 40, pluginId: "moonshot" },
  { id: "perplexity", order: 50, pluginId: "perplexity" },
  { id: "firecrawl", order: 60, pluginId: "firecrawl" },
  { id: "exa", order: 65, pluginId: "exa" },
  { id: "tavily", order: 70, pluginId: "tavily" },
  { id: "duckduckgo", order: 100, pluginId: "duckduckgo" },
] as const;

let createEmptyPluginRegistry: RegistryModule["createEmptyPluginRegistry"];
let loadPluginManifestRegistryMock: ReturnType<typeof vi.fn>;
let setActivePluginRegistry: RuntimeModule["setActivePluginRegistry"];
let resolvePluginWebSearchProviders: WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"];
let resolveRuntimeWebSearchProviders: WebSearchProvidersRuntimeModule["resolveRuntimeWebSearchProviders"];
let resetWebSearchProviderSnapshotCacheForTests: WebSearchProvidersRuntimeModule["__testing"]["resetWebSearchProviderSnapshotCacheForTests"];
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let loaderModule: typeof import("./loader.js");
let manifestRegistryModule: ManifestRegistryModule;
let pluginAutoEnableModule: PluginAutoEnableModule;
let applyPluginAutoEnableSpy: ReturnType<typeof vi.fn>;
let webSearchProvidersSharedModule: WebSearchProvidersSharedModule;

const DEFAULT_WEB_SEARCH_WORKSPACE = "/tmp/workspace";
const EXPECTED_BUNDLED_RUNTIME_WEB_SEARCH_PROVIDER_KEYS = [
  "brave:brave",
  "duckduckgo:duckduckgo",
  "exa:exa",
  "firecrawl:firecrawl",
  "google:gemini",
  "xai:grok",
  "moonshot:kimi",
  "perplexity:perplexity",
  "tavily:tavily",
] as const;

function buildMockedWebSearchProviders(params?: {
  config?: { plugins?: Record<string, unknown> };
}) {
  const plugins = params?.config?.plugins as
    | {
        enabled?: boolean;
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      }
    | undefined;
  if (plugins?.enabled === false) {
    return [];
  }
  const allow = Array.isArray(plugins?.allow) && plugins.allow.length > 0 ? plugins.allow : null;
  const entries = plugins?.entries ?? {};
  const webSearchProviders = BUNDLED_WEB_SEARCH_PROVIDERS.filter((provider) => {
    if (allow && !allow.includes(provider.pluginId)) {
      return false;
    }
    if (entries[provider.pluginId]?.enabled === false) {
      return false;
    }
    return true;
  }).map((provider) => ({
    pluginId: provider.pluginId,
    pluginName: provider.pluginId,
    provider: {
      autoDetectOrder: provider.order,
      createTool: () => ({
        description: provider.id,
        execute: async () => ({}),
        parameters: {},
      }),
      credentialPath: `plugins.entries.${provider.pluginId}.config.webSearch.apiKey`,
      envVars: [`${provider.id.toUpperCase()}_API_KEY`],
      getCredentialValue: () => "configured",
      hint: `${provider.id} provider`,
      id: provider.id,
      label: provider.id,
      placeholder: `${provider.id}-...`,
      setCredentialValue: () => {},
      signupUrl: `https://example.com/${provider.id}`,
    },
    source: "test" as const,
  }));
  return webSearchProviders;
}

function createBraveAllowConfig() {
  return {
    plugins: {
      allow: ["brave"],
    },
  };
}

function createWebSearchEnv(overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: "/tmp/openclaw-home",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createSnapshotParams(params?: {
  config?: { plugins?: Record<string, unknown> };
  env?: NodeJS.ProcessEnv;
  bundledAllowlistCompat?: boolean;
  workspaceDir?: string;
}) {
  return {
    bundledAllowlistCompat: params?.bundledAllowlistCompat ?? true,
    config: params?.config ?? createBraveAllowConfig(),
    env: params?.env ?? createWebSearchEnv(),
    workspaceDir: params?.workspaceDir ?? DEFAULT_WEB_SEARCH_WORKSPACE,
  };
}

function toRuntimeProviderKeys(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"]>,
) {
  return providers.map((provider) => `${provider.pluginId}:${provider.id}`);
}

function expectBundledRuntimeProviderKeys(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"]>,
) {
  expect(toRuntimeProviderKeys(providers)).toEqual(
    EXPECTED_BUNDLED_RUNTIME_WEB_SEARCH_PROVIDER_KEYS,
  );
}

function createManifestRegistryFixture() {
  return {
    diagnostics: [],
    plugins: [
      {
        channels: [],
        configUiHints: { "webSearch.apiKey": { label: "key" } },
        hooks: [],
        id: "brave",
        manifestPath: "/tmp/brave/openclaw.plugin.json",
        origin: "bundled",
        providers: [],
        rootDir: "/tmp/brave",
        skills: [],
        source: "/tmp/brave/index.js",
      },
      {
        channels: [],
        configUiHints: { unrelated: { label: "nope" } },
        hooks: [],
        id: "noise",
        manifestPath: "/tmp/noise/openclaw.plugin.json",
        origin: "bundled",
        providers: [],
        rootDir: "/tmp/noise",
        skills: [],
        source: "/tmp/noise/index.js",
      },
    ],
  };
}

function expectLoaderCallCount(count: number) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(count);
}

function expectScopedWebSearchCandidates(pluginIds: readonly string[]) {
  expect(loadPluginManifestRegistryMock).toHaveBeenCalled();
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      onlyPluginIds: [...pluginIds],
    }),
  );
}

function expectSnapshotMemoization(params: {
  config: { plugins?: Record<string, unknown> };
  env: NodeJS.ProcessEnv;
  expectedLoaderCalls: number;
}) {
  const runtimeParams = createSnapshotParams({
    config: params.config,
    env: params.env,
  });

  const first = resolvePluginWebSearchProviders(runtimeParams);
  const second = resolvePluginWebSearchProviders(runtimeParams);

  if (params.expectedLoaderCalls === 1) {
    expect(second).toBe(first);
  } else {
    expect(second).not.toBe(first);
  }
  expectLoaderCallCount(params.expectedLoaderCalls);
}

function expectAutoEnabledWebSearchLoad(params: {
  rawConfig: { plugins?: Record<string, unknown> };
  expectedAllow: readonly string[];
}) {
  expect(applyPluginAutoEnableSpy).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: createWebSearchEnv(),
  });
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining([...params.expectedAllow]),
        }),
      }),
    }),
  );
}

function expectSnapshotLoaderCalls(params: {
  config: { plugins?: Record<string, unknown> };
  env: NodeJS.ProcessEnv;
  mutate: () => void;
  expectedLoaderCalls: number;
}) {
  resolvePluginWebSearchProviders(
    createSnapshotParams({
      config: params.config,
      env: params.env,
    }),
  );
  params.mutate();
  resolvePluginWebSearchProviders(
    createSnapshotParams({
      config: params.config,
      env: params.env,
    }),
  );
  expectLoaderCallCount(params.expectedLoaderCalls);
}

function createRuntimeWebSearchProvider(params: {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  hint: string;
  envVar: string;
  signupUrl: string;
  credentialPath: string;
}) {
  return {
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    provider: {
      autoDetectOrder: 1,
      createTool: () => ({
        description: params.id,
        execute: async () => ({}),
        parameters: {},
      }),
      credentialPath: params.credentialPath,
      envVars: [params.envVar],
      getCredentialValue: () => "configured",
      hint: params.hint,
      id: params.id,
      label: params.label,
      placeholder: `${params.id}-...`,
      setCredentialValue: () => {},
      signupUrl: params.signupUrl,
    },
    source: "test" as const,
  };
}

function createBraveRuntimeWebSearchProvider() {
  return createRuntimeWebSearchProvider({
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    envVar: "BRAVE_API_KEY",
    hint: "Brave runtime provider",
    id: "brave",
    label: "Brave Search",
    pluginId: "brave",
    pluginName: "Brave",
    signupUrl: "https://example.com/brave",
  });
}

function createActiveBraveRegistryFixture(params?: {
  includeResolutionWorkspaceDir?: boolean;
  activeWorkspaceDir?: string;
}) {
  const env = createWebSearchEnv();
  const rawConfig = createBraveAllowConfig();
  const { config, activationSourceConfig, autoEnabledReasons } =
    webSearchProvidersSharedModule.resolveBundledWebSearchResolutionConfig({
      config: rawConfig,
      bundledAllowlistCompat: true,
      ...(params?.includeResolutionWorkspaceDir
        ? { workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE }
        : {}),
      env,
    });
  const { cacheKey } = loaderModule.__testing.resolvePluginLoadCacheContext({
    activate: false,
    activationSourceConfig,
    autoEnabledReasons,
    cache: false,
    config,
    env,
    onlyPluginIds: ["brave"],
    workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
  });
  const registry = createEmptyPluginRegistry();
  registry.webSearchProviders.push(createBraveRuntimeWebSearchProvider());
  setActivePluginRegistry(registry, cacheKey, "default", params?.activeWorkspaceDir);

  return { env, rawConfig };
}

function expectRuntimeProviderResolution(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolveRuntimeWebSearchProviders"]>,
  expected: readonly string[],
) {
  expect(toRuntimeProviderKeys(providers)).toEqual([...expected]);
  expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
}

describe("resolvePluginWebSearchProviders", () => {
  beforeAll(async () => {
    ({ createEmptyPluginRegistry } = await import("./registry.js"));
    manifestRegistryModule = await import("./manifest-registry.js");
    loaderModule = await import("./loader.js");
    pluginAutoEnableModule = await import("../config/plugin-auto-enable.js");
    webSearchProvidersSharedModule = await import("./web-search-providers.shared.js");
    ({ setActivePluginRegistry } = await import("./runtime.js"));
    ({
      resolvePluginWebSearchProviders,
      resolveRuntimeWebSearchProviders,
      __testing: { resetWebSearchProviderSnapshotCacheForTests },
    } = await import("./web-search-providers.runtime.js"));
  });

  beforeEach(() => {
    resetWebSearchProviderSnapshotCacheForTests();
    applyPluginAutoEnableSpy?.mockRestore();
    applyPluginAutoEnableSpy = vi
      .spyOn(pluginAutoEnableModule, "applyPluginAutoEnable")
      .mockImplementation(
        (params) =>
          ({
            autoEnabledReasons: {},
            changes: [],
            config: params.config ?? {},
          }) as ReturnType<PluginAutoEnableModule["applyPluginAutoEnable"]>,
      );
    loadPluginManifestRegistryMock = vi
      .spyOn(manifestRegistryModule, "loadPluginManifestRegistry")
      .mockReturnValue(
        createManifestRegistryFixture() as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
          ...args: unknown[]
        ) => infer R
          ? R
          : never,
      );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation((params) => {
        const registry = createEmptyPluginRegistry();
        registry.webSearchProviders = buildMockedWebSearchProviders(params);
        return registry;
      });
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.useRealTimers();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it("loads bundled providers through the plugin loader in alphabetical order", () => {
    const providers = resolvePluginWebSearchProviders({});

    expectBundledRuntimeProviderKeys(providers);
    expectLoaderCallCount(1);
  });

  it("loads manifest-declared web-search providers in setup mode", () => {
    const providers = resolvePluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["perplexity"],
        },
      },
      mode: "setup",
    });

    expect(toRuntimeProviderKeys(providers)).toEqual(["brave:brave"]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["perplexity", "brave"],
            entries: {
              brave: { enabled: true },
            },
          }),
        }),
        onlyPluginIds: ["brave"],
      }),
    );
  });

  it("loads plugin web-search providers from the auto-enabled config snapshot", () => {
    const rawConfig = createBraveAllowConfig();
    const autoEnabledConfig = {
      plugins: {
        allow: ["brave", "perplexity"],
      },
    };
    applyPluginAutoEnableSpy.mockReturnValue({
      autoEnabledReasons: {},
      changes: [],
      config: autoEnabledConfig,
    });

    resolvePluginWebSearchProviders(createSnapshotParams({ config: rawConfig }));

    expectAutoEnabledWebSearchLoad({
      expectedAllow: ["brave", "perplexity"],
      rawConfig,
    });
  });

  it("scopes plugin loading to manifest-declared web-search candidates", () => {
    resolvePluginWebSearchProviders({});

    expectScopedWebSearchCandidates(["brave"]);
  });

  it("uses the active registry workspace for candidate discovery and snapshot loads when workspaceDir is omitted", () => {
    const env = createWebSearchEnv();
    const rawConfig = createBraveAllowConfig();

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/tmp/runtime-workspace",
    );

    resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
    });

    expect(loadPluginManifestRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/runtime-workspace",
      }),
    );
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["brave"],
        workspaceDir: "/tmp/runtime-workspace",
      }),
    );
  });
  it("memoizes snapshot provider resolution for the same config and env", () => {
    expectSnapshotMemoization({
      config: createBraveAllowConfig(),
      env: createWebSearchEnv(),
      expectedLoaderCalls: 1,
    });
  });

  it("reuses a compatible active registry for snapshot resolution when config is provided", () => {
    const { env, rawConfig } = createActiveBraveRegistryFixture();

    const providers = resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
      workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
    });

    expectRuntimeProviderResolution(providers, ["brave:brave"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("inherits workspaceDir from the active registry for compatible web-search snapshot reuse", () => {
    const { env, rawConfig } = createActiveBraveRegistryFixture({
      activeWorkspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
      includeResolutionWorkspaceDir: true,
    });

    const providers = resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
    });

    expectRuntimeProviderResolution(providers, ["brave:brave"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("keys web-search snapshot memoization by the inherited active workspace", () => {
    const env = createWebSearchEnv();
    const rawConfig = createBraveAllowConfig();

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-a");
    resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
    });

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-b");
    resolvePluginWebSearchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
    });

    expectLoaderCallCount(2);
  });

  it("retains the snapshot cache when config contents change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({ OPENCLAW_HOME: "/tmp/openclaw-home-a" });

    expectSnapshotLoaderCalls({
      config,
      env,
      expectedLoaderCalls: 1,
      mutate: () => {
        config.plugins = { allow: ["perplexity"] };
      },
    });
  });

  it("invalidates the snapshot cache when env contents change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({ OPENCLAW_HOME: "/tmp/openclaw-home-a" });

    expectSnapshotLoaderCalls({
      config,
      env,
      expectedLoaderCalls: 2,
      mutate: () => {
        env.OPENCLAW_HOME = "/tmp/openclaw-home-b";
      },
    });
  });

  it.each([
    {
      env: {
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
      },
      title: "skips web-search snapshot memoization when plugin cache opt-outs are set",
    },
    {
      env: {
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
      },
      title: "skips web-search snapshot memoization when discovery cache ttl is zero",
    },
  ])("$title", ({ env }) => {
    expectSnapshotMemoization({
      config: createBraveAllowConfig(),
      env: createWebSearchEnv(env),
      expectedLoaderCalls: 2,
    });
  });

  it("does not leak host Vitest env into an explicit non-Vitest cache key", () => {
    const originalVitest = process.env.VITEST;
    const config = {};
    const env = createWebSearchEnv();

    try {
      delete process.env.VITEST;
      resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));

      process.env.VITEST = "1";
      resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("expires web-search snapshot memoization after the shortest plugin cache ttl", () => {
    vi.useFakeTimers();
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "20",
    });
    const runtimeParams = createSnapshotParams({ config, env });

    resolvePluginWebSearchProviders(runtimeParams);
    vi.advanceTimersByTime(4);
    resolvePluginWebSearchProviders(runtimeParams);
    vi.advanceTimersByTime(2);
    resolvePluginWebSearchProviders(runtimeParams);

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates web-search snapshots when cache-control env values change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000",
    });

    expectSnapshotLoaderCalls({
      config,
      env,
      expectedLoaderCalls: 2,
      mutate: () => {
        env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "5";
      },
    });
  });

  it.each([
    {
      expected: ["custom-search:custom"],
      name: "prefers the active plugin registry for runtime resolution",
      params: {},
      setupRegistry: () => {
        const registry = createEmptyPluginRegistry();
        registry.webSearchProviders.push(
          createRuntimeWebSearchProvider({
            credentialPath: "tools.web.search.custom.apiKey",
            envVar: "CUSTOM_SEARCH_API_KEY",
            hint: "Custom runtime provider",
            id: "custom",
            label: "Custom Search",
            pluginId: "custom-search",
            pluginName: "Custom Search",
            signupUrl: "https://example.com/signup",
          }),
        );
        setActivePluginRegistry(registry);
      },
    },
    {
      expected: ["brave:brave"],
      name: "reuses a compatible active registry for runtime resolution when config is provided",
      setupRegistry: () => {
        const { env, rawConfig } = createActiveBraveRegistryFixture();
        return {
          bundledAllowlistCompat: true,
          config: rawConfig,
          env,
          workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
        };
      },
    },
  ] as const)("$name", ({ setupRegistry, params, expected }) => {
    const runtimeParams = setupRegistry() ?? params ?? {};
    const providers = resolveRuntimeWebSearchProviders(runtimeParams);

    expectRuntimeProviderResolution(providers, expected);
  });
});
