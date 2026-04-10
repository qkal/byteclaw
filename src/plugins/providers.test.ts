import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginAutoEnableResult } from "../config/plugin-auto-enable.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { ProviderPlugin } from "./types.js";

type ResolveRuntimePluginRegistry = typeof import("./loader.js").resolveRuntimePluginRegistry;
type LoadOpenClawPlugins = typeof import("./loader.js").loadOpenClawPlugins;
type IsPluginRegistryLoadInFlight = typeof import("./loader.js").isPluginRegistryLoadInFlight;
type LoadPluginManifestRegistry =
  typeof import("./manifest-registry.js").loadPluginManifestRegistry;
type ApplyPluginAutoEnable = typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable;
type SetActivePluginRegistry = typeof import("./runtime.js").setActivePluginRegistry;

const resolveRuntimePluginRegistryMock = vi.fn<ResolveRuntimePluginRegistry>();
const loadOpenClawPluginsMock = vi.fn<LoadOpenClawPlugins>();
const isPluginRegistryLoadInFlightMock = vi.fn<IsPluginRegistryLoadInFlight>((_) => false);
const loadPluginManifestRegistryMock = vi.fn<LoadPluginManifestRegistry>();
const applyPluginAutoEnableMock = vi.fn<ApplyPluginAutoEnable>();

let resolveOwningPluginIdsForProvider: typeof import("./providers.js").resolveOwningPluginIdsForProvider;
let resolveOwningPluginIdsForModelRef: typeof import("./providers.js").resolveOwningPluginIdsForModelRef;
let resolveEnabledProviderPluginIds: typeof import("./providers.js").resolveEnabledProviderPluginIds;
let resolvePluginProviders: typeof import("./providers.runtime.js").resolvePluginProviders;
let setActivePluginRegistry: SetActivePluginRegistry;

function createManifestProviderPlugin(params: {
  id: string;
  providerIds: string[];
  cliBackends?: string[];
  origin?: "bundled" | "workspace";
  enabledByDefault?: boolean;
  modelSupport?: { modelPrefixes?: string[]; modelPatterns?: string[] };
}): PluginManifestRecord {
  return {
    channels: [],
    cliBackends: params.cliBackends ?? [],
    enabledByDefault: params.enabledByDefault,
    hooks: [],
    id: params.id,
    manifestPath: `/tmp/${params.id}/openclaw.plugin.json`,
    modelSupport: params.modelSupport,
    origin: params.origin ?? "bundled",
    providers: params.providerIds,
    rootDir: `/tmp/${params.id}`,
    skills: [],
    source: params.origin ?? "bundled",
  };
}

function setManifestPlugins(plugins: PluginManifestRecord[]) {
  loadPluginManifestRegistryMock.mockReturnValue({
    diagnostics: [],
    plugins,
  });
}

function setOwningProviderManifestPlugins() {
  setManifestPlugins([
    createManifestProviderPlugin({
      id: "minimax",
      providerIds: ["minimax", "minimax-portal"],
    }),
    createManifestProviderPlugin({
      cliBackends: ["codex-cli"],
      id: "openai",
      modelSupport: {
        modelPrefixes: ["gpt-", "o1", "o3", "o4"],
      },
      providerIds: ["openai", "openai-codex"],
    }),
    createManifestProviderPlugin({
      cliBackends: ["claude-cli"],
      id: "anthropic",
      modelSupport: {
        modelPrefixes: ["claude-"],
      },
      providerIds: ["anthropic"],
    }),
  ]);
}

function setOwningProviderManifestPluginsWithWorkspace() {
  setManifestPlugins([
    createManifestProviderPlugin({
      id: "minimax",
      providerIds: ["minimax", "minimax-portal"],
    }),
    createManifestProviderPlugin({
      cliBackends: ["codex-cli"],
      id: "openai",
      modelSupport: {
        modelPrefixes: ["gpt-", "o1", "o3", "o4"],
      },
      providerIds: ["openai", "openai-codex"],
    }),
    createManifestProviderPlugin({
      cliBackends: ["claude-cli"],
      id: "anthropic",
      modelSupport: {
        modelPrefixes: ["claude-"],
      },
      providerIds: ["anthropic"],
    }),
    createManifestProviderPlugin({
      id: "workspace-provider",
      modelSupport: {
        modelPrefixes: ["workspace-model-"],
      },
      origin: "workspace",
      providerIds: ["workspace-provider"],
    }),
  ]);
}

function getLastRuntimeRegistryCall(): Record<string, unknown> {
  const call = resolveRuntimePluginRegistryMock.mock.calls.at(-1)?.[0];
  expect(call).toBeDefined();
  return (call ?? {}) as Record<string, unknown>;
}

function cloneOptions<T>(value: T): T {
  return structuredClone(value);
}

function expectResolvedProviders(providers: unknown, expected: unknown[]) {
  expect(providers).toEqual(expected);
}

function expectLastRuntimeRegistryLoad(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      activate: false,
      cache: false,
      ...(params?.env ? { env: params.env } : {}),
      ...(params?.onlyPluginIds ? { onlyPluginIds: params.onlyPluginIds } : {}),
    }),
  );
}

function expectLastSetupRegistryLoad(params?: {
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: readonly string[];
}) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      activate: false,
      cache: false,
      ...(params?.env ? { env: params.env } : {}),
      ...(params?.onlyPluginIds ? { onlyPluginIds: params.onlyPluginIds } : {}),
    }),
  );
}

function getLastResolvedPluginConfig() {
  return getLastRuntimeRegistryCall().config as
    | {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      }
    | undefined;
}

function getLastSetupLoadedPluginConfig() {
  const call = loadOpenClawPluginsMock.mock.calls.at(-1)?.[0];
  expect(call).toBeDefined();
  return (call?.config ?? undefined) as
    | {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      }
    | undefined;
}

function createBundledProviderCompatOptions(params?: { onlyPluginIds?: readonly string[] }) {
  return {
    bundledProviderAllowlistCompat: true,
    config: {
      plugins: {
        allow: ["openrouter"],
      },
    },
    ...(params?.onlyPluginIds ? { onlyPluginIds: params.onlyPluginIds } : {}),
  };
}

function createAutoEnabledProviderConfig() {
  const rawConfig: OpenClawConfig = {
    plugins: {},
  };
  const autoEnabledConfig: OpenClawConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        google: { enabled: true },
      },
    },
  };
  return { autoEnabledConfig, rawConfig };
}

function expectAutoEnabledProviderLoad(params: { rawConfig: unknown; autoEnabledConfig: unknown }) {
  expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expectProviderRuntimeRegistryLoad({ config: params.autoEnabledConfig });
}

function expectResolvedAllowlistState(params?: {
  expectedAllow?: readonly string[];
  unexpectedAllow?: readonly string[];
  expectedEntries?: Record<string, { enabled?: boolean }>;
  expectedOnlyPluginIds?: readonly string[];
}) {
  expectLastRuntimeRegistryLoad(
    params?.expectedOnlyPluginIds ? { onlyPluginIds: params.expectedOnlyPluginIds } : undefined,
  );

  const config = getLastResolvedPluginConfig();
  const allow = config?.plugins?.allow ?? [];

  if (params?.expectedAllow) {
    expect(allow).toEqual(expect.arrayContaining([...params.expectedAllow]));
  }
  if (params?.expectedEntries) {
    expect(config?.plugins?.entries).toEqual(expect.objectContaining(params.expectedEntries));
  }
  params?.unexpectedAllow?.forEach((disallowedPluginId) => {
    expect(allow).not.toContain(disallowedPluginId);
  });
}

function expectOwningPluginIds(provider: string, expectedPluginIds?: readonly string[]) {
  expect(resolveOwningPluginIdsForProvider({ provider })).toEqual(expectedPluginIds);
}

function expectModelOwningPluginIds(model: string, expectedPluginIds?: readonly string[]) {
  expect(resolveOwningPluginIdsForModelRef({ model })).toEqual(expectedPluginIds);
}

function expectProviderRuntimeRegistryLoad(params?: { config?: unknown; env?: NodeJS.ProcessEnv }) {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params?.config ? { config: params.config } : {}),
      ...(params?.env ? { env: params.env } : {}),
    }),
  );
}

describe("resolvePluginProviders", () => {
  beforeAll(async () => {
    vi.resetModules();
    loadPluginManifestRegistryMock.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });
    vi.doMock("./loader.js", () => ({
      isPluginRegistryLoadInFlight: (...args: Parameters<IsPluginRegistryLoadInFlight>) =>
        isPluginRegistryLoadInFlightMock(...args),
      loadOpenClawPlugins: (...args: Parameters<LoadOpenClawPlugins>) =>
        loadOpenClawPluginsMock(...args),
      resolveRuntimePluginRegistry: (...args: Parameters<ResolveRuntimePluginRegistry>) =>
        resolveRuntimePluginRegistryMock(...args),
    }));
    vi.doMock("../config/plugin-auto-enable.js", () => ({
      applyPluginAutoEnable: (...args: Parameters<ApplyPluginAutoEnable>) =>
        applyPluginAutoEnableMock(...args),
    }));
    vi.doMock("./manifest-registry.js", () => ({
      loadPluginManifestRegistry: (...args: Parameters<LoadPluginManifestRegistry>) =>
        loadPluginManifestRegistryMock(...args),
    }));
    ({
      resolveOwningPluginIdsForProvider,
      resolveOwningPluginIdsForModelRef,
      resolveEnabledProviderPluginIds,
    } = await import("./providers.js"));
    ({ resolvePluginProviders } = await import("./providers.runtime.js"));
    ({ setActivePluginRegistry } = await import("./runtime.js"));
  });

  it("maps cli backend ids to owning plugin ids via manifests", () => {
    setOwningProviderManifestPlugins();

    expectOwningPluginIds("claude-cli", ["anthropic"]);
    expectOwningPluginIds("codex-cli", ["openai"]);
  });

  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resolveRuntimePluginRegistryMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    isPluginRegistryLoadInFlightMock.mockReset();
    isPluginRegistryLoadInFlightMock.mockReturnValue(false);
    const provider: ProviderPlugin = {
      auth: [],
      id: "demo-provider",
      label: "Demo Provider",
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({ pluginId: "google", provider, source: "bundled" });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);
    loadOpenClawPluginsMock.mockReturnValue(registry);
    loadPluginManifestRegistryMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation(
      (params): PluginAutoEnableResult => ({
        autoEnabledReasons: {},
        changes: [],
        config: params.config ?? ({} as OpenClawConfig),
      }),
    );
    setManifestPlugins([
      createManifestProviderPlugin({
        enabledByDefault: true,
        id: "google",
        providerIds: ["google"],
      }),
      createManifestProviderPlugin({ id: "browser", providerIds: [] }),
      createManifestProviderPlugin({
        enabledByDefault: true,
        id: "kilocode",
        providerIds: ["kilocode"],
      }),
      createManifestProviderPlugin({
        enabledByDefault: true,
        id: "moonshot",
        providerIds: ["moonshot"],
      }),
      createManifestProviderPlugin({ id: "google-gemini-cli-auth", providerIds: [] }),
      createManifestProviderPlugin({
        id: "workspace-provider",
        modelSupport: {
          modelPrefixes: ["workspace-model-"],
        },
        origin: "workspace",
        providerIds: ["workspace-provider"],
      }),
    ]);
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const providers = resolvePluginProviders({
      env,
      workspaceDir: "/workspace/explicit",
    });

    expectResolvedProviders(providers, [
      { auth: [], id: "demo-provider", label: "Demo Provider", pluginId: "google" },
    ]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        cache: false,
        env,
        workspaceDir: "/workspace/explicit",
      }),
    );
  });

  it("keeps bundled provider plugins enabled when they default on outside Vitest compat", () => {
    expect(resolveEnabledProviderPluginIds({ config: {}, env: {} as NodeJS.ProcessEnv })).toEqual([
      "google",
      "kilocode",
      "moonshot",
    ]);
  });

  it.each([
    {
      expectedAllow: ["openrouter", "google", "kilocode", "moonshot"],
      expectedEntries: {
        google: { enabled: true },
        kilocode: { enabled: true },
        moonshot: { enabled: true },
      },
      name: "can augment restrictive allowlists for bundled provider compatibility",
      options: createBundledProviderCompatOptions(),
    },
    {
      expectedAllow: ["google"],
      name: "does not reintroduce the retired google auth plugin id into compat allowlists",
      options: createBundledProviderCompatOptions(),
      unexpectedAllow: ["google-gemini-cli-auth"],
    },
    {
      name: "does not inject non-bundled provider plugin ids into compat allowlists",
      options: createBundledProviderCompatOptions(),
      unexpectedAllow: ["workspace-provider"],
    },
    {
      expectedAllow: ["openrouter", "moonshot"],
      expectedOnlyPluginIds: ["moonshot"],
      name: "scopes bundled provider compat expansion to the requested plugin ids",
      options: createBundledProviderCompatOptions({
        onlyPluginIds: ["moonshot"],
      }),
      unexpectedAllow: ["google", "kilocode"],
    },
  ] as const)(
    "$name",
    ({ options, expectedAllow, expectedEntries, expectedOnlyPluginIds, unexpectedAllow }) => {
      resolvePluginProviders(
        cloneOptions(options) as unknown as Parameters<typeof resolvePluginProviders>[0],
      );

      expectResolvedAllowlistState({
        expectedAllow,
        expectedEntries,
        expectedOnlyPluginIds,
        unexpectedAllow,
      });
    },
  );

  it("can enable bundled provider plugins under Vitest when no explicit plugin config exists", () => {
    resolvePluginProviders({
      bundledProviderVitestCompat: true,
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
    });

    expectLastRuntimeRegistryLoad();
    expect(getLastResolvedPluginConfig()).toEqual(
      expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining(["google", "moonshot"]),
          enabled: true,
          entries: expect.objectContaining({
            google: { enabled: true },
            moonshot: { enabled: true },
          }),
        }),
      }),
    );
  });

  it("uses process env for Vitest compat when no explicit env is passed", () => {
    const previousVitest = process.env.VITEST;
    process.env.VITEST = "1";
    try {
      resolvePluginProviders({
        bundledProviderVitestCompat: true,
        onlyPluginIds: ["google"],
      });

      expectLastRuntimeRegistryLoad({
        onlyPluginIds: ["google"],
      });
      expect(getLastResolvedPluginConfig()).toEqual(
        expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["google"],
            enabled: true,
            entries: {
              google: { enabled: true },
            },
          }),
        }),
      );
    } finally {
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
    }
  });

  it("does not leak host Vitest env into an explicit non-Vitest env", () => {
    const previousVitest = process.env.VITEST;
    process.env.VITEST = "1";
    try {
      resolvePluginProviders({
        bundledProviderVitestCompat: true,
        env: {} as NodeJS.ProcessEnv,
      });

      expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: undefined,
          env: {},
        }),
      );
    } finally {
      if (previousVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = previousVitest;
      }
    }
  });

  it("loads only provider plugins on the provider runtime path", () => {
    resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
    });

    expectLastRuntimeRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("loads all discovered provider plugins in setup mode", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
          entries: {
            google: { enabled: false },
          },
        },
      },
      mode: "setup",
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot", "workspace-provider"],
    });
    expect(getLastSetupLoadedPluginConfig()).toEqual(
      expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining([
            "openrouter",
            "google",
            "kilocode",
            "moonshot",
            "workspace-provider",
          ]),
          entries: expect.objectContaining({
            google: { enabled: true },
            kilocode: { enabled: true },
            moonshot: { enabled: true },
            "workspace-provider": { enabled: true },
          }),
        }),
      }),
    );
  });

  it("excludes untrusted workspace provider plugins from setup discovery when requested", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      includeUntrustedWorkspacePlugins: false,
      mode: "setup",
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("keeps trusted but disabled workspace provider plugins eligible in setup discovery", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter", "workspace-provider"],
          entries: {
            "workspace-provider": { enabled: false },
          },
        },
      },
      includeUntrustedWorkspacePlugins: false,
      mode: "setup",
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot", "workspace-provider"],
    });
  });

  it("does not include trusted-but-disabled workspace providers when denylist blocks them", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter", "workspace-provider"],
          deny: ["workspace-provider"],
          entries: {
            "workspace-provider": { enabled: false },
          },
        },
      },
      includeUntrustedWorkspacePlugins: false,
      mode: "setup",
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("does not include workspace providers blocked by allowlist gating", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
          entries: {
            "workspace-provider": { enabled: true },
          },
        },
      },
      includeUntrustedWorkspacePlugins: false,
      mode: "setup",
    });

    expectLastSetupRegistryLoad({
      onlyPluginIds: ["google", "kilocode", "moonshot"],
    });
  });

  it("loads provider plugins from the auto-enabled config snapshot", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledProviderConfig();
    applyPluginAutoEnableMock.mockReturnValue({
      autoEnabledReasons: {
        google: ["google auth configured"],
      },
      changes: [],
      config: autoEnabledConfig,
    });

    resolvePluginProviders({ config: rawConfig });

    expectAutoEnabledProviderLoad({
      autoEnabledConfig,
      rawConfig,
    });
  });

  it("routes provider runtime resolution through the compatible active-registry seam", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["google"],
        },
      },
      onlyPluginIds: ["google"],
      workspaceDir: "/workspace/runtime",
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        cache: false,
        workspaceDir: "/workspace/runtime",
      }),
    );
  });

  it("inherits workspaceDir from the active registry when provider resolution omits it", () => {
    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/workspace/runtime",
    );

    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["google"],
        },
      },
      onlyPluginIds: ["google"],
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: false,
        cache: false,
        workspaceDir: "/workspace/runtime",
      }),
    );
  });
  it("activates owning plugins for explicit provider refs", () => {
    setOwningProviderManifestPlugins();

    resolvePluginProviders({
      activate: true,
      config: {},
      providerRefs: ["openai-codex"],
    });

    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: true,
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["openai"],
            entries: {
              openai: { enabled: true },
            },
          }),
        }),
        onlyPluginIds: ["openai"],
      }),
    );
  });
  it.each([
    {
      expectedPluginIds: ["minimax"],
      provider: "minimax-portal",
    },
    {
      expectedPluginIds: ["openai"],
      provider: "openai-codex",
    },
    {
      expectedPluginIds: undefined,
      provider: "gemini-cli",
    },
  ] as const)(
    "maps $provider to owning plugin ids via manifests",
    ({ provider, expectedPluginIds }) => {
      setOwningProviderManifestPlugins();

      expectOwningPluginIds(provider, expectedPluginIds);
    },
  );

  it.each([
    {
      expectedPluginIds: ["openai"],
      model: "gpt-5.4",
    },
    {
      expectedPluginIds: ["anthropic"],
      model: "claude-sonnet-4-6",
    },
    {
      expectedPluginIds: ["openai"],
      model: "openai/gpt-5.4",
    },
    {
      expectedPluginIds: ["workspace-provider"],
      model: "workspace-model-fast",
    },
    {
      expectedPluginIds: undefined,
      model: "unknown-model",
    },
  ] as const)(
    "maps $model to owning plugin ids via modelSupport",
    ({ model, expectedPluginIds }) => {
      setOwningProviderManifestPluginsWithWorkspace();

      expectModelOwningPluginIds(model, expectedPluginIds);
    },
  );

  it("refuses ambiguous bundled shorthand model ownership", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "openai",
        modelSupport: { modelPrefixes: ["gpt-"] },
        providerIds: ["openai"],
      }),
      createManifestProviderPlugin({
        id: "proxy-openai",
        modelSupport: { modelPrefixes: ["gpt-"] },
        providerIds: ["proxy-openai"],
      }),
    ]);

    expectModelOwningPluginIds("gpt-5.4", undefined);
  });

  it("prefers non-bundled shorthand model ownership over bundled matches", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "openai",
        modelSupport: { modelPrefixes: ["gpt-"] },
        providerIds: ["openai"],
      }),
      createManifestProviderPlugin({
        id: "workspace-openai",
        modelSupport: { modelPrefixes: ["gpt-"] },
        origin: "workspace",
        providerIds: ["workspace-openai"],
      }),
    ]);

    expectModelOwningPluginIds("gpt-5.4", ["workspace-openai"]);
  });

  it("auto-loads a model-owned provider plugin from shorthand model refs", () => {
    setManifestPlugins([
      createManifestProviderPlugin({
        id: "openai",
        modelSupport: {
          modelPrefixes: ["gpt-", "o1", "o3", "o4"],
        },
        providerIds: ["openai", "openai-codex"],
      }),
    ]);
    const provider: ProviderPlugin = {
      auth: [],
      id: "openai",
      label: "OpenAI",
    };
    const registry = createEmptyPluginRegistry();
    registry.providers.push({ pluginId: "openai", provider, source: "bundled" });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    const providers = resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
      config: {},
      modelRefs: ["gpt-5.4"],
    });

    expectResolvedProviders(providers, [
      { auth: [], id: "openai", label: "OpenAI", pluginId: "openai" },
    ]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: ["openai"],
            entries: {
              openai: { enabled: true },
            },
          }),
        }),
        onlyPluginIds: ["openai"],
      }),
    );
  });
});
