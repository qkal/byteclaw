import { beforeEach, describe, expect, it, vi } from "vitest";
import { bundledPluginRootAt } from "../../test/helpers/bundled-plugin-paths.js";
import type { OpenClawConfig } from "../config/config.js";

const APP_ROOT = "/app";

function appBundledPluginRoot(pluginId: string): string {
  return bundledPluginRootAt(APP_ROOT, pluginId);
}

const installPluginFromNpmSpecMock = vi.fn();
const installPluginFromMarketplaceMock = vi.fn();
const installPluginFromClawHubMock = vi.fn();
const resolveBundledPluginSourcesMock = vi.fn();

vi.mock("./install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpecMock(...args),
  resolvePluginInstallDir: (pluginId: string) => `/tmp/${pluginId}`,
}));

vi.mock("./marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => installPluginFromMarketplaceMock(...args),
}));

vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => installPluginFromClawHubMock(...args),
}));

vi.mock("./bundled-sources.js", () => ({
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSourcesMock(...args),
}));

const { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } = await import("./update.js");

function createSuccessfulNpmUpdateResult(params?: {
  pluginId?: string;
  targetDir?: string;
  version?: string;
  npmResolution?: {
    name: string;
    version: string;
    resolvedSpec: string;
  };
}) {
  return {
    extensions: ["index.ts"],
    ok: true,
    pluginId: params?.pluginId ?? "opik-openclaw",
    targetDir: params?.targetDir ?? "/tmp/opik-openclaw",
    version: params?.version ?? "0.2.6",
    ...(params?.npmResolution ? { npmResolution: params.npmResolution } : {}),
  };
}

function createNpmInstallConfig(params: {
  pluginId: string;
  spec: string;
  installPath: string;
  integrity?: string;
  resolvedName?: string;
  resolvedSpec?: string;
}) {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          installPath: params.installPath,
          source: "npm" as const,
          spec: params.spec,
          ...(params.integrity ? { integrity: params.integrity } : {}),
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
          ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
        },
      },
    },
  };
}

function createMarketplaceInstallConfig(params: {
  pluginId: string;
  installPath: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  marketplaceName?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          installPath: params.installPath,
          marketplacePlugin: params.marketplacePlugin,
          marketplaceSource: params.marketplaceSource,
          source: "marketplace" as const,
          ...(params.marketplaceName ? { marketplaceName: params.marketplaceName } : {}),
        },
      },
    },
  };
}

function createClawHubInstallConfig(params: {
  pluginId: string;
  installPath: string;
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: "bundle-plugin" | "code-plugin";
  clawhubChannel: "community" | "official" | "private";
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        [params.pluginId]: {
          clawhubChannel: params.clawhubChannel,
          clawhubFamily: params.clawhubFamily,
          clawhubPackage: params.clawhubPackage,
          clawhubUrl: params.clawhubUrl,
          installPath: params.installPath,
          source: "clawhub" as const,
          spec: `clawhub:${params.clawhubPackage}`,
        },
      },
    },
  };
}

function createBundledPathInstallConfig(params: {
  loadPaths: string[];
  installPath: string;
  sourcePath?: string;
  spec?: string;
}): OpenClawConfig {
  return {
    plugins: {
      installs: {
        feishu: {
          installPath: params.installPath,
          source: "path",
          sourcePath: params.sourcePath ?? appBundledPluginRoot("feishu"),
          ...(params.spec ? { spec: params.spec } : {}),
        },
      },
      load: { paths: params.loadPaths },
    },
  };
}

function createCodexAppServerInstallConfig(params: {
  spec: string;
  resolvedName?: string;
  resolvedSpec?: string;
}) {
  return {
    plugins: {
      installs: {
        "openclaw-codex-app-server": {
          installPath: "/tmp/openclaw-codex-app-server",
          source: "npm" as const,
          spec: params.spec,
          ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
          ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
        },
      },
    },
  };
}

function expectNpmUpdateCall(params: {
  spec: string;
  expectedIntegrity?: string;
  expectedPluginId?: string;
}) {
  expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedIntegrity: params.expectedIntegrity,
      spec: params.spec,
      ...(params.expectedPluginId ? { expectedPluginId: params.expectedPluginId } : {}),
    }),
  );
}

function createBundledSource(params?: { pluginId?: string; localPath?: string; npmSpec?: string }) {
  const pluginId = params?.pluginId ?? "feishu";
  return {
    localPath: params?.localPath ?? appBundledPluginRoot(pluginId),
    npmSpec: params?.npmSpec ?? `@openclaw/${pluginId}`,
    pluginId,
  };
}

function mockBundledSources(...sources: ReturnType<typeof createBundledSource>[]) {
  resolveBundledPluginSourcesMock.mockReturnValue(
    new Map(sources.map((source) => [source.pluginId, source])),
  );
}

function expectBundledPathInstall(params: {
  install: Record<string, unknown> | undefined;
  sourcePath: string;
  installPath: string;
  spec?: string;
}) {
  expect(params.install).toMatchObject({
    installPath: params.installPath,
    source: "path",
    sourcePath: params.sourcePath,
    ...(params.spec ? { spec: params.spec } : {}),
  });
}

function expectCodexAppServerInstallState(params: {
  result: Awaited<ReturnType<typeof updateNpmInstalledPlugins>>;
  spec: string;
  version: string;
  resolvedSpec?: string;
}) {
  expect(params.result.config.plugins?.installs?.["openclaw-codex-app-server"]).toMatchObject({
    installPath: "/tmp/openclaw-codex-app-server",
    source: "npm",
    spec: params.spec,
    version: params.version,
    ...(params.resolvedSpec ? { resolvedSpec: params.resolvedSpec } : {}),
  });
}

describe("updateNpmInstalledPlugins", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromMarketplaceMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
  });

  it.each([
    {
      config: createNpmInstallConfig({
        installPath: "/tmp/opik-openclaw",
        integrity: "sha512-old",
        pluginId: "opik-openclaw",
        spec: "@opik/opik-openclaw",
      }),
      dryRun: true,
      expectedCall: {
        expectedIntegrity: undefined,
        spec: "@opik/opik-openclaw",
      },
      name: "skips integrity drift checks for unpinned npm specs during dry-run updates",
      pluginIds: ["opik-openclaw"],
    },
    {
      config: createNpmInstallConfig({
        installPath: "/tmp/opik-openclaw",
        integrity: "sha512-old",
        pluginId: "opik-openclaw",
        spec: "@opik/opik-openclaw@0.2.5",
      }),
      dryRun: true,
      expectedCall: {
        expectedIntegrity: "sha512-old",
        spec: "@opik/opik-openclaw@0.2.5",
      },
      name: "keeps integrity drift checks for exact-version npm specs during dry-run updates",
      pluginIds: ["opik-openclaw"],
    },
    {
      config: createNpmInstallConfig({
        installPath: "/tmp/openclaw-codex-app-server",
        integrity: "sha512-old",
        pluginId: "openclaw-codex-app-server",
        spec: "openclaw-codex-app-server@0.2.0-beta.3",
      }),
      expectedCall: {
        expectedIntegrity: undefined,
        spec: "openclaw-codex-app-server@0.2.0-beta.4",
      },
      installerResult: createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      }),
      name: "skips recorded integrity checks when an explicit npm version override changes the spec",
      pluginIds: ["openclaw-codex-app-server"],
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@0.2.0-beta.4",
      },
    },
  ] as const)(
    "$name",
    async ({ config, pluginIds, dryRun, specOverrides, installerResult, expectedCall }) => {
      installPluginFromNpmSpecMock.mockResolvedValue(
        installerResult ?? createSuccessfulNpmUpdateResult(),
      );

      await updateNpmInstalledPlugins({
        config,
        pluginIds: [...pluginIds],
        ...(dryRun ? { dryRun: true } : {}),
        ...(specOverrides ? { specOverrides } : {}),
      });

      expectNpmUpdateCall(expectedCall);
    },
  );

  it.each([
    {
      config: createNpmInstallConfig({
        installPath: "/tmp/missing",
        pluginId: "missing",
        spec: "@openclaw/missing",
      }),
      expectedMessage: "Failed to check missing: npm package not found for @openclaw/missing.",
      installerResult: {
        code: "npm_package_not_found",
        error: "Package not found on npm: @openclaw/missing.",
        ok: false,
      },
      name: "formats package-not-found updates with a stable message",
      pluginId: "missing",
    },
    {
      config: createNpmInstallConfig({
        installPath: "/tmp/bad",
        pluginId: "bad",
        spec: "github:evil/evil",
      }),
      expectedMessage: "Failed to check bad: unsupported npm spec: github:evil/evil",
      installerResult: {
        code: "invalid_npm_spec",
        error: "unsupported npm spec: github:evil/evil",
        ok: false,
      },
      name: "falls back to raw installer error for unknown error codes",
      pluginId: "bad",
    },
  ] as const)("$name", async ({ installerResult, config, pluginId, expectedMessage }) => {
    installPluginFromNpmSpecMock.mockResolvedValue(installerResult);

    const result = await updateNpmInstalledPlugins({
      config,
      dryRun: true,
      pluginIds: [pluginId],
    });

    expect(result.outcomes).toEqual([
      {
        message: expectedMessage,
        pluginId,
        status: "error",
      },
    ]);
  });

  it.each([
    {
      config: createCodexAppServerInstallConfig({
        resolvedName: "openclaw-codex-app-server",
        resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.3",
        spec: "openclaw-codex-app-server@beta",
      }),
      expectedSpec: "openclaw-codex-app-server@beta",
      expectedVersion: "0.2.0-beta.4",
      installerResult: {
        extensions: ["index.ts"],
        ok: true,
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      },
      name: "reuses a recorded npm dist-tag spec for id-based updates",
    },
    {
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server",
      }),
      expectedResolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
      expectedSpec: "openclaw-codex-app-server@beta",
      expectedVersion: "0.2.0-beta.4",
      installerResult: {
        extensions: ["index.ts"],
        npmResolution: {
          name: "openclaw-codex-app-server",
          resolvedSpec: "openclaw-codex-app-server@0.2.0-beta.4",
          version: "0.2.0-beta.4",
        },
        ok: true,
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      },
      name: "uses and persists an explicit npm spec override during updates",
      specOverrides: {
        "openclaw-codex-app-server": "openclaw-codex-app-server@beta",
      },
    },
  ] as const)(
    "$name",
    async ({
      installerResult,
      config,
      specOverrides,
      expectedSpec,
      expectedVersion,
      expectedResolvedSpec,
    }) => {
      installPluginFromNpmSpecMock.mockResolvedValue(installerResult);

      const result = await updateNpmInstalledPlugins({
        config,
        pluginIds: ["openclaw-codex-app-server"],
        ...(specOverrides ? { specOverrides } : {}),
      });

      expectNpmUpdateCall({
        expectedPluginId: "openclaw-codex-app-server",
        spec: expectedSpec,
      });
      expectCodexAppServerInstallState({
        result,
        spec: expectedSpec,
        version: expectedVersion,
        ...(expectedResolvedSpec ? { resolvedSpec: expectedResolvedSpec } : {}),
      });
    },
  );

  it("updates ClawHub-installed plugins via recorded package metadata", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      clawhub: {
        clawhubChannel: "official",
        clawhubFamily: "code-plugin",
        clawhubPackage: "demo",
        clawhubUrl: "https://clawhub.ai",
        integrity: "sha256-next",
        resolvedAt: "2026-03-22T00:00:00.000Z",
        source: "clawhub",
      },
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/demo",
      version: "1.2.4",
    });

    const result = await updateNpmInstalledPlugins({
      config: createClawHubInstallConfig({
        clawhubChannel: "official",
        clawhubFamily: "code-plugin",
        clawhubPackage: "demo",
        clawhubUrl: "https://clawhub.ai",
        installPath: "/tmp/demo",
        pluginId: "demo",
      }),
      pluginIds: ["demo"],
    });

    expect(installPluginFromClawHubMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://clawhub.ai",
        expectedPluginId: "demo",
        mode: "update",
        spec: "clawhub:demo",
      }),
    );
    expect(result.config.plugins?.installs?.demo).toMatchObject({
      clawhubChannel: "official",
      clawhubFamily: "code-plugin",
      clawhubPackage: "demo",
      installPath: "/tmp/demo",
      integrity: "sha256-next",
      source: "clawhub",
      spec: "clawhub:demo",
      version: "1.2.4",
    });
  });

  it("migrates legacy unscoped install keys when a scoped npm package updates", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      extensions: ["index.ts"],
      ok: true,
      pluginId: "@openclaw/voice-call",
      targetDir: "/tmp/openclaw-voice-call",
      version: "0.0.2",
    });

    const result = await updateNpmInstalledPlugins({
      config: {
        plugins: {
          allow: ["voice-call"],
          deny: ["voice-call"],
          entries: {
            "voice-call": {
              enabled: false,
              hooks: { allowPromptInjection: false },
            },
          },
          installs: {
            "voice-call": {
              installPath: "/tmp/voice-call",
              source: "npm",
              spec: "@openclaw/voice-call",
            },
          },
          slots: { memory: "voice-call" },
        },
      },
      pluginIds: ["voice-call"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPluginId: "voice-call",
        spec: "@openclaw/voice-call",
      }),
    );
    expect(result.config.plugins?.allow).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.deny).toEqual(["@openclaw/voice-call"]);
    expect(result.config.plugins?.slots?.memory).toBe("@openclaw/voice-call");
    expect(result.config.plugins?.entries?.["@openclaw/voice-call"]).toEqual({
      enabled: false,
      hooks: { allowPromptInjection: false },
    });
    expect(result.config.plugins?.entries?.["voice-call"]).toBeUndefined();
    expect(result.config.plugins?.installs?.["@openclaw/voice-call"]).toMatchObject({
      installPath: "/tmp/openclaw-voice-call",
      source: "npm",
      spec: "@openclaw/voice-call",
      version: "0.0.2",
    });
    expect(result.config.plugins?.installs?.["voice-call"]).toBeUndefined();
  });

  it("checks marketplace installs during dry-run updates", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      extensions: ["index.ts"],
      marketplacePlugin: "claude-bundle",
      marketplaceSource: "vincentkoc/claude-marketplace",
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.2.0",
    });

    const result = await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        installPath: "/tmp/claude-bundle",
        marketplacePlugin: "claude-bundle",
        marketplaceSource: "vincentkoc/claude-marketplace",
        pluginId: "claude-bundle",
      }),
      dryRun: true,
      pluginIds: ["claude-bundle"],
    });

    expect(installPluginFromMarketplaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        expectedPluginId: "claude-bundle",
        marketplace: "vincentkoc/claude-marketplace",
        plugin: "claude-bundle",
      }),
    );
    expect(result.outcomes).toEqual([
      {
        currentVersion: undefined,
        message: "Would update claude-bundle: unknown -> 1.2.0.",
        nextVersion: "1.2.0",
        pluginId: "claude-bundle",
        status: "updated",
      },
    ]);
  });

  it("updates marketplace installs and preserves source metadata", async () => {
    installPluginFromMarketplaceMock.mockResolvedValue({
      extensions: ["index.ts"],
      marketplaceName: "Vincent's Claude Plugins",
      marketplacePlugin: "claude-bundle",
      marketplaceSource: "vincentkoc/claude-marketplace",
      ok: true,
      pluginId: "claude-bundle",
      targetDir: "/tmp/claude-bundle",
      version: "1.3.0",
    });

    const result = await updateNpmInstalledPlugins({
      config: createMarketplaceInstallConfig({
        installPath: "/tmp/claude-bundle",
        marketplaceName: "Vincent's Claude Plugins",
        marketplacePlugin: "claude-bundle",
        marketplaceSource: "vincentkoc/claude-marketplace",
        pluginId: "claude-bundle",
      }),
      pluginIds: ["claude-bundle"],
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.installs?.["claude-bundle"]).toMatchObject({
      installPath: "/tmp/claude-bundle",
      marketplaceName: "Vincent's Claude Plugins",
      marketplacePlugin: "claude-bundle",
      marketplaceSource: "vincentkoc/claude-marketplace",
      source: "marketplace",
      version: "1.3.0",
    });
  });

  it("forwards dangerous force unsafe install to plugin update installers", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue(
      createSuccessfulNpmUpdateResult({
        pluginId: "openclaw-codex-app-server",
        targetDir: "/tmp/openclaw-codex-app-server",
        version: "0.2.0-beta.4",
      }),
    );

    await updateNpmInstalledPlugins({
      config: createCodexAppServerInstallConfig({
        spec: "openclaw-codex-app-server@beta",
      }),
      dangerouslyForceUnsafeInstall: true,
      pluginIds: ["openclaw-codex-app-server"],
    });

    expect(installPluginFromNpmSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dangerouslyForceUnsafeInstall: true,
        expectedPluginId: "openclaw-codex-app-server",
        spec: "openclaw-codex-app-server@beta",
      }),
    );
  });
});

describe("syncPluginsForUpdateChannel", () => {
  beforeEach(() => {
    installPluginFromNpmSpecMock.mockReset();
    resolveBundledPluginSourcesMock.mockReset();
  });

  it.each([
    {
      config: createBundledPathInstallConfig({
        installPath: appBundledPluginRoot("feishu"),
        loadPaths: [appBundledPluginRoot("feishu")],
        spec: "@openclaw/feishu",
      }),
      expectedChanged: false,
      expectedInstallPath: appBundledPluginRoot("feishu"),
      expectedLoadPaths: [appBundledPluginRoot("feishu")],
      name: "keeps bundled path installs on beta without reinstalling from npm",
    },
    {
      config: createBundledPathInstallConfig({
        installPath: "/tmp/old-feishu",
        loadPaths: [],
        spec: "@openclaw/feishu",
      }),
      expectedChanged: true,
      expectedInstallPath: appBundledPluginRoot("feishu"),
      expectedLoadPaths: [appBundledPluginRoot("feishu")],
      name: "repairs bundled install metadata when the load path is re-added",
    },
  ] as const)(
    "$name",
    async ({ config, expectedChanged, expectedLoadPaths, expectedInstallPath }) => {
      mockBundledSources(createBundledSource());

      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        config,
      });

      expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
      expect(result.changed).toBe(expectedChanged);
      expect(result.summary.switchedToNpm).toEqual([]);
      expect(result.config.plugins?.load?.paths).toEqual(expectedLoadPaths);
      expectBundledPathInstall({
        install: result.config.plugins?.installs?.feishu,
        installPath: expectedInstallPath,
        sourcePath: appBundledPluginRoot("feishu"),
        spec: "@openclaw/feishu",
      });
    },
  );

  it("forwards an explicit env to bundled plugin source resolution", async () => {
    resolveBundledPluginSourcesMock.mockReturnValue(new Map());
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    await syncPluginsForUpdateChannel({
      channel: "beta",
      config: {},
      env,
      workspaceDir: "/workspace",
    });

    expect(resolveBundledPluginSourcesMock).toHaveBeenCalledWith({
      env,
      workspaceDir: "/workspace",
    });
  });

  it("uses the provided env when matching bundled load and install paths", async () => {
    const bundledHome = "/tmp/openclaw-home";
    mockBundledSources(
      createBundledSource({
        localPath: `${bundledHome}/plugins/feishu`,
      }),
    );

    const previousHome = process.env.HOME;
    process.env.HOME = "/tmp/process-home";
    try {
      const result = await syncPluginsForUpdateChannel({
        channel: "beta",
        config: {
          plugins: {
            installs: {
              feishu: {
                installPath: "~/plugins/feishu",
                source: "path",
                sourcePath: "~/plugins/feishu",
                spec: "@openclaw/feishu",
              },
            },
            load: { paths: ["~/plugins/feishu"] },
          },
        },
        env: {
          ...process.env,
          HOME: "/tmp/ignored-home",
          OPENCLAW_HOME: bundledHome,
        },
      });

      expect(result.changed).toBe(false);
      expect(result.config.plugins?.load?.paths).toEqual(["~/plugins/feishu"]);
      expectBundledPathInstall({
        install: result.config.plugins?.installs?.feishu,
        installPath: "~/plugins/feishu",
        sourcePath: "~/plugins/feishu",
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});
