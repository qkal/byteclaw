import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";

type LoaderModule = typeof import("./loader.js");
type ManifestRegistryModule = typeof import("./manifest-registry.js");
type RuntimeModule = typeof import("./runtime.js");
type WebFetchProvidersRuntimeModule = typeof import("./web-fetch-providers.runtime.js");
type WebFetchProvidersSharedModule = typeof import("./web-fetch-providers.shared.js");

let loaderModule: LoaderModule;
let manifestRegistryModule: ManifestRegistryModule;
let webFetchProvidersSharedModule: WebFetchProvidersSharedModule;
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let setActivePluginRegistry: RuntimeModule["setActivePluginRegistry"];
let resolvePluginWebFetchProviders: WebFetchProvidersRuntimeModule["resolvePluginWebFetchProviders"];
let resetWebFetchProviderSnapshotCacheForTests: WebFetchProvidersRuntimeModule["__testing"]["resetWebFetchProviderSnapshotCacheForTests"];

const DEFAULT_WORKSPACE = "/tmp/workspace";

function createWebFetchEnv(overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: "/tmp/openclaw-home",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createFirecrawlAllowConfig() {
  return {
    plugins: {
      allow: ["firecrawl"],
    },
  };
}

function createManifestRegistryFixture() {
  return {
    diagnostics: [],
    plugins: [
      {
        channels: [],
        configUiHints: { "webFetch.apiKey": { label: "key" } },
        hooks: [],
        id: "firecrawl",
        manifestPath: "/tmp/firecrawl/openclaw.plugin.json",
        origin: "bundled",
        providers: [],
        rootDir: "/tmp/firecrawl",
        skills: [],
        source: "/tmp/firecrawl/index.js",
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

function createRuntimeWebFetchProvider() {
  return {
    pluginId: "firecrawl",
    pluginName: "Firecrawl",
    provider: {
      createTool: () => ({
        description: "firecrawl",
        execute: async () => ({}),
        parameters: {},
      }),
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      envVars: ["FIRECRAWL_API_KEY"],
      getCredentialValue: () => "configured",
      hint: "Firecrawl runtime provider",
      id: "firecrawl",
      label: "Firecrawl",
      placeholder: "firecrawl-...",
      setCredentialValue: () => {},
      signupUrl: "https://example.com/firecrawl",
    },
    source: "test" as const,
  };
}

describe("resolvePluginWebFetchProviders", () => {
  beforeAll(async () => {
    loaderModule = await import("./loader.js");
    manifestRegistryModule = await import("./manifest-registry.js");
    webFetchProvidersSharedModule = await import("./web-fetch-providers.shared.js");
    ({ setActivePluginRegistry } = await import("./runtime.js"));
    ({
      resolvePluginWebFetchProviders,
      __testing: { resetWebFetchProviderSnapshotCacheForTests },
    } = await import("./web-fetch-providers.runtime.js"));
  });

  beforeEach(() => {
    resetWebFetchProviderSnapshotCacheForTests();
    vi.spyOn(manifestRegistryModule, "loadPluginManifestRegistry").mockReturnValue(
      createManifestRegistryFixture() as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
        ...args: unknown[]
      ) => infer R
        ? R
        : never,
    );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation(() => {
        const registry = createEmptyPluginRegistry();
        registry.webFetchProviders = [createRuntimeWebFetchProvider()];
        return registry;
      });
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it("falls back to the plugin loader when no compatible active registry exists", () => {
    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("does not force a fresh snapshot load when the same web-provider load is already in flight", () => {
    const inFlightSpy = vi
      .spyOn(loaderModule, "isPluginRegistryLoadInFlight")
      .mockReturnValue(true);
    loadOpenClawPluginsMock.mockImplementation(() => {
      throw new Error("resolvePluginWebFetchProviders should not bypass the in-flight guard");
    });

    const providers = resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config: createFirecrawlAllowConfig(),
      env: createWebFetchEnv(),
      workspaceDir: DEFAULT_WORKSPACE,
    });

    expect(providers).toEqual([]);
    expect(inFlightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        cache: false,
        onlyPluginIds: ["firecrawl"],
        workspaceDir: DEFAULT_WORKSPACE,
      }),
    );
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses a compatible active registry for snapshot resolution when config is provided", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();
    const { config, activationSourceConfig, autoEnabledReasons } =
      webFetchProvidersSharedModule.resolveBundledWebFetchResolutionConfig({
        bundledAllowlistCompat: true,
        config: rawConfig,
        env,
      });
    const { cacheKey } = loaderModule.__testing.resolvePluginLoadCacheContext({
      activate: false,
      activationSourceConfig,
      autoEnabledReasons,
      cache: false,
      config,
      env,
      onlyPluginIds: ["firecrawl"],
      workspaceDir: DEFAULT_WORKSPACE,
    });
    const registry = createEmptyPluginRegistry();
    registry.webFetchProviders.push(createRuntimeWebFetchProvider());
    setActivePluginRegistry(registry, cacheKey);

    const providers = resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
      workspaceDir: DEFAULT_WORKSPACE,
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("inherits workspaceDir from the active registry for compatible web-fetch snapshot reuse", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();
    const { config, activationSourceConfig, autoEnabledReasons } =
      webFetchProvidersSharedModule.resolveBundledWebFetchResolutionConfig({
        bundledAllowlistCompat: true,
        config: rawConfig,
        env,
        workspaceDir: DEFAULT_WORKSPACE,
      });
    const { cacheKey } = loaderModule.__testing.resolvePluginLoadCacheContext({
      activate: false,
      activationSourceConfig,
      autoEnabledReasons,
      cache: false,
      config,
      env,
      onlyPluginIds: ["firecrawl"],
      workspaceDir: DEFAULT_WORKSPACE,
    });
    const registry = createEmptyPluginRegistry();
    registry.webFetchProviders.push(createRuntimeWebFetchProvider());
    setActivePluginRegistry(registry, cacheKey, "default", DEFAULT_WORKSPACE);

    const providers = resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("uses the active registry workspace for candidate discovery and snapshot loads when workspaceDir is omitted", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/tmp/runtime-workspace",
    );

    resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config: rawConfig,
      env,
    });

    expect(manifestRegistryModule.loadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/runtime-workspace",
      }),
    );
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["firecrawl"],
        workspaceDir: "/tmp/runtime-workspace",
      }),
    );
  });

  it("invalidates web-fetch snapshot memoization when the active registry workspace changes", () => {
    const env = createWebFetchEnv();
    const config = createFirecrawlAllowConfig();

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-a");
    resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config,
      env,
    });

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-b");
    resolvePluginWebFetchProviders({
      bundledAllowlistCompat: true,
      config,
      env,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });
});
